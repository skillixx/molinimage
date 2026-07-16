import "dotenv/config";

import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Queue } from "bullmq";

import { loadAppConfig } from "../src/config/app-config.js";
import {
  MySqlImageTasksRepository,
  type CreateImageTaskRecordInput
} from "../src/infrastructure/database/image-tasks-repository.js";
import { BullMqImageTaskQueue } from "../src/infrastructure/queue/bullmq-image-task-queue.js";
import {
  IMAGE_TASK_JOB_NAME,
  type ImageTaskJobData
} from "../src/infrastructure/queue/image-task-queue.js";
import { createBullMqRedisConnection } from "../src/infrastructure/redis/redis-connection.js";
import { ImageTaskService } from "../src/modules/image-tasks/image-task-service.js";
import { BullMqImageTaskWorker } from "../src/workers/bullmq-image-task-worker.js";
import type { ImageTaskWorkerExecutionContext } from "../src/workers/image-generation-worker-service.js";
import { ImageTaskJobProcessor } from "../src/workers/image-task-job-processor.js";
import { ImageTaskRecoveryScanner } from "../src/workers/image-task-recovery-scanner.js";
import { createIsolatedIntegrationPool } from "./support/isolated-integration-database.js";

const runQueueIntegrationTest =
  process.env.RUN_QUEUE_INTEGRATION_TESTS === "true" ? test : test.skip;

void runQueueIntegrationTest(
  "真实 BullMQ Worker 独立消费五类任务、恢复过期锁并优雅等待当前任务",
  { timeout: 30_000 },
  async () => {
    const config = loadAppConfig(process.env);
    const suffix = randomUUID().replaceAll("-", "");
    const queueName = `molinimage-g05-${suffix.slice(0, 16)}`;
    const pool = await createIsolatedIntegrationPool(config, ["image_tasks"]);
    const repository = new MySqlImageTasksRepository(pool);
    const taskService = new ImageTaskService(repository);
    const redisConnection = createBullMqRedisConnection(config, "worker", silentLogger);
    const taskTypes = [
      "text_to_image",
      "image_to_text",
      "image_to_image",
      "image_restore",
      "upscale"
    ];
    const taskIds = taskTypes.map(
      (taskType, index) => `task_g05_${String(index)}_${suffix.slice(0, 20)}`
    );
    const expiredTaskId = `task_g05_exp_${suffix.slice(0, 18)}`;
    const slowTaskId = `task_g05_slow_${suffix.slice(0, 17)}`;
    const postExitTaskId = `task_g09_post_exit_${suffix.slice(0, 14)}`;
    const fencedTaskId = `task_g05_fence_${suffix.slice(0, 16)}`;
    const recoveryTaskId = `task_g07_recover_${suffix.slice(0, 14)}`;
    const exhaustedTaskId = `task_g07_exhaust_${suffix.slice(0, 14)}`;
    const allTaskIds = [
      ...taskIds,
      expiredTaskId,
      slowTaskId,
      postExitTaskId,
      fencedTaskId,
      recoveryTaskId,
      exhaustedTaskId
    ];
    const callCounts = new Map<string, number>();
    const processedBy = new Map<string, string>();
    const slowStarted = createDeferred();
    const slowGate = createDeferred();
    let producer: BullMqImageTaskQueue | undefined;
    let inspector: Queue<ImageTaskJobData> | undefined;
    let workerA: BullMqImageTaskWorker | undefined;
    let workerB: BullMqImageTaskWorker | undefined;

    try {
      await redisConnection.connect();
      producer = new BullMqImageTaskQueue(queueName, redisConnection.client, 2);
      inspector = new Queue<ImageTaskJobData>(queueName, { connection: redisConnection.client });

      for (let index = 0; index < taskTypes.length; index += 1) {
        await repository.create(
          createTaskInput(
            taskIds[index] ?? "",
            taskTypes[index] ?? "",
            `g05:${suffix}:${String(index)}`
          )
        );
      }

      await repository.create(
        createTaskInput(expiredTaskId, "text_to_image", `g05:${suffix}:expired`)
      );
      await pool.execute(
        `UPDATE image_tasks
         SET status = 'running',
             worker_lock_token = 'expired-test-token',
             worker_lock_expires_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND)
         WHERE id = ?`,
        [expiredTaskId]
      );
      await repository.create(createTaskInput(slowTaskId, "text_to_image", `g05:${suffix}:slow`));
      await repository.create(
        createTaskInput(postExitTaskId, "text_to_image", `g09:${suffix}:post-exit`)
      );
      await repository.create(
        createTaskInput(fencedTaskId, "text_to_image", `g05:${suffix}:fence`)
      );
      await repository.create(
        createTaskInput(recoveryTaskId, "text_to_image", `g07:${suffix}:recovery`)
      );
      await repository.create(
        createTaskInput(exhaustedTaskId, "text_to_image", `g07:${suffix}:exhausted`)
      );
      await pool.execute(
        `UPDATE image_tasks
         SET updated_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 10 MINUTE),
             worker_attempt_count = 1
         WHERE id = ?`,
        [recoveryTaskId]
      );
      await pool.execute(
        `UPDATE image_tasks
         SET status = 'running',
             worker_lock_token = 'late-worker-token',
             worker_lock_expires_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND),
             worker_attempt_count = 3
         WHERE id = ?`,
        [exhaustedTaskId]
      );

      const recoveryScanner = new ImageTaskRecoveryScanner(repository, producer, taskService, {
        scanIntervalMs: 30_000,
        staleAfterMs: 1_000,
        batchSize: 20,
        maxAttempts: 3
      });
      const recoveryResult = await recoveryScanner.scanOnce();
      // 扫描器同时接管一个长时间 queued 任务和前面构造的过期 running 任务。
      assert.equal(recoveryResult.requeued, 2);
      assert.equal(recoveryResult.finalized, 1);
      assert.ok(await inspector.getJob(recoveryTaskId));
      assert.equal((await repository.findById(exhaustedTaskId))?.status, "failed");
      assert.equal(
        await repository.recordOutputFile({
          taskId: exhaustedTaskId,
          ownerUserId: 479,
          fileId: "file_late_worker",
          gatewayRequestId: "request_late_worker",
          workerLockToken: "late-worker-token"
        }),
        undefined
      );

      const firstClaim = await repository.claimExecution({
        taskId: fencedTaskId,
        lockToken: "first-test-token",
        lockDurationMs: 10_000
      });
      assert.ok(firstClaim);
      await pool.execute(
        `UPDATE image_tasks
         SET worker_lock_expires_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND)
         WHERE id = ?`,
        [fencedTaskId]
      );
      const secondClaim = await repository.claimExecution({
        taskId: fencedTaskId,
        lockToken: "second-test-token",
        lockDurationMs: 10_000
      });
      assert.ok(secondClaim);
      assert.equal(
        await repository.recordOutputFile({
          taskId: fencedTaskId,
          ownerUserId: 479,
          fileId: "file_stale_result",
          gatewayRequestId: "request_stale",
          workerLockToken: "first-test-token"
        }),
        undefined
      );
      const fencedResult = await repository.recordOutputFile({
        taskId: fencedTaskId,
        ownerUserId: 479,
        fileId: "file_current_result",
        gatewayRequestId: "request_current",
        workerLockToken: "second-test-token"
      });
      assert.deepEqual(fencedResult?.output_file_ids, ["file_current_result"]);
      await repository.releaseExecution({
        taskId: fencedTaskId,
        lockToken: "second-test-token"
      });

      const createProcessor = (workerId: string): ImageTaskJobProcessor =>
        new ImageTaskJobProcessor(
          repository,
          {
            async processTask(
              taskId: string,
              context: ImageTaskWorkerExecutionContext
            ): Promise<void> {
              callCounts.set(taskId, (callCounts.get(taskId) ?? 0) + 1);
              processedBy.set(taskId, workerId);
              await context.assertActive();

              if (taskId === slowTaskId) {
                slowStarted.resolve();
                await slowGate.promise;
              }

              const task = await repository.findById(taskId);

              if (task === undefined) {
                throw new Error("集成测试任务不存在。");
              }

              await taskService.transitionTask({
                ownerUserId: task.owner_user_id,
                taskId,
                toStatus: "succeeded",
                workerLockToken: context.workerLockToken
              });
            }
          },
          { jobTimeoutMs: 5_000, lockDurationMs: 10_000, heartbeatIntervalMs: 100 }
        );
      workerA = new BullMqImageTaskWorker(
        queueName,
        redisConnection.client,
        1,
        10_000,
        createProcessor("worker-a"),
        silentLogger
      );
      await workerA.waitUntilReady();

      for (const taskId of [...taskIds, expiredTaskId]) {
        await producer.enqueue(taskId);
      }

      // 使用不同 JobId 模拟至少一次重复投递，数据库租约应保证同一任务只执行业务逻辑一次。
      await inspector.add(
        IMAGE_TASK_JOB_NAME,
        { task_id: taskIds[0] ?? "" },
        { jobId: `duplicate-${taskIds[0] ?? "task"}` }
      );
      await waitForTasks(repository, [...taskIds, expiredTaskId, recoveryTaskId], "succeeded");

      for (const taskId of [...taskIds, expiredTaskId, recoveryTaskId]) {
        assert.equal(callCounts.get(taskId), 1);
      }

      await producer.enqueue(slowTaskId);
      await slowStarted.promise;
      workerB = new BullMqImageTaskWorker(
        queueName,
        redisConnection.client,
        1,
        10_000,
        createProcessor("worker-b"),
        silentLogger
      );
      await workerB.waitUntilReady();
      let closed = false;
      const closePromise = workerA.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(closed, false);
      slowGate.resolve();
      await closePromise;
      workerA = undefined;
      assert.equal((await repository.findById(slowTaskId))?.status, "succeeded");

      // A 实例退出后继续提交新任务，必须由仍在线的 B 实例完成，证明部署可逐实例滚动重启。
      await producer.enqueue(postExitTaskId);
      await waitForTasks(repository, [postExitTaskId], "succeeded");
      assert.equal(processedBy.get(postExitTaskId), "worker-b");
      assert.equal(callCounts.get(postExitTaskId), 1);
    } finally {
      slowGate.resolve();
      await Promise.allSettled([
        workerA?.close(),
        workerB?.close(),
        inspector?.obliterate({ force: true })
      ]);
      await Promise.allSettled([producer?.close(), inspector?.close()]);
      await redisConnection.close();
      await pool
        .execute(
          `DELETE FROM image_tasks WHERE id IN (${allTaskIds.map(() => "?").join(", ")})`,
          allTaskIds
        )
        .catch(() => undefined);
      await pool.end();
    }
  }
);

void runQueueIntegrationTest(
  "Worker 子进程崩溃后由另一实例接管同一 BullMQ 任务",
  { timeout: 20_000 },
  async () => {
    const config = loadAppConfig(process.env);
    const suffix = randomUUID().replaceAll("-", "");
    const queueName = `molinimage-g09-crash-${suffix.slice(0, 12)}`;
    const taskId = `task_g09_crash_${suffix.slice(0, 16)}`;
    const pool = await createIsolatedIntegrationPool(config, ["image_tasks"]);
    const repository = new MySqlImageTasksRepository(pool);
    const taskService = new ImageTaskService(repository);
    const redisConnection = createBullMqRedisConnection(config, "worker", silentLogger);
    let producer: BullMqImageTaskQueue | undefined;
    let inspector: Queue<ImageTaskJobData> | undefined;
    let replacementWorker: BullMqImageTaskWorker | undefined;
    let crashWorker: ChildProcess | undefined;

    try {
      await redisConnection.connect();
      producer = new BullMqImageTaskQueue(queueName, redisConnection.client, 2);
      inspector = new Queue<ImageTaskJobData>(queueName, { connection: redisConnection.client });
      await repository.create(createTaskInput(taskId, "text_to_image", `g09:crash:${suffix}`));

      crashWorker = fork(
        fileURLToPath(new URL("./fixtures/bullmq-crash-worker.js", import.meta.url)),
        [],
        {
          env: {
            ...process.env,
            G09_QUEUE_NAME: queueName,
            G09_REDIS_URL: config.redisUrl
          },
          stdio: ["ignore", "ignore", "ignore", "ipc"]
        }
      );
      const active = waitForChildActive(crashWorker, taskId);
      await producer.enqueue(taskId);
      await active;

      const crashedClaim = await repository.claimExecution({
        taskId,
        lockToken: "crashed-worker-database-token",
        lockDurationMs: 2_500
      });
      assert.ok(crashedClaim);

      // 强制终止已领取 Job 且持有 MySQL 租约的独立进程，模拟业务执行中突然崩溃。
      crashWorker.kill("SIGKILL");
      await waitForChildExit(crashWorker);
      crashWorker = undefined;

      const processor = new ImageTaskJobProcessor(
        repository,
        {
          async processTask(
            receivedTaskId: string,
            context: ImageTaskWorkerExecutionContext
          ): Promise<void> {
            const task = await repository.findById(receivedTaskId);
            assert.ok(task);
            await taskService.transitionTask({
              ownerUserId: task.owner_user_id,
              taskId: receivedTaskId,
              toStatus: "succeeded",
              workerLockToken: context.workerLockToken
            });
          }
        },
        { jobTimeoutMs: 5_000, lockDurationMs: 5_000, heartbeatIntervalMs: 100 }
      );
      replacementWorker = new BullMqImageTaskWorker(
        queueName,
        redisConnection.client,
        1,
        1_000,
        processor,
        silentLogger,
        { stalledIntervalMs: 250, maxStalledCount: 2 }
      );
      await replacementWorker.waitUntilReady();

      // BullMQ 首次重派发生时数据库租约仍有效，替代 Worker 必须跳过，不能并发执行模型。
      await waitForJobState(inspector, taskId, "completed");
      assert.equal((await repository.findById(taskId))?.status, "running");

      // 数据库租约到期后由恢复扫描器重置为 queued 并重投，在线 Worker 随后接管业务执行。
      await new Promise((resolve) => setTimeout(resolve, 2_700));
      const recoveryScanner = new ImageTaskRecoveryScanner(repository, producer, taskService, {
        scanIntervalMs: 30_000,
        staleAfterMs: 100,
        batchSize: 10,
        maxAttempts: 3
      });
      const recoveryResult = await recoveryScanner.scanOnce();
      assert.equal(recoveryResult.requeued, 1);
      await waitForTasks(repository, [taskId], "succeeded");
      assert.equal((await repository.findById(taskId))?.worker_attempt_count, 2);
    } finally {
      crashWorker?.kill("SIGKILL");
      await Promise.allSettled([
        replacementWorker?.close(),
        inspector?.obliterate({ force: true })
      ]);
      await Promise.allSettled([producer?.close(), inspector?.close()]);
      await redisConnection.close();
      await pool.end();
    }
  }
);

const silentLogger = {
  info(): void {
    // 集成测试禁止输出真实基础设施端点。
  },
  warn(): void {
    // 集成测试禁止输出真实基础设施端点。
  },
  error(): void {
    // 集成测试禁止输出真实基础设施端点。
  }
};

async function waitForChildActive(child: ChildProcess, taskId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("等待故障 Worker 领取任务超时。"));
    }, 5_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      reject(new Error(`故障 Worker 提前退出：${String(code)}`));
    });
    child.on("message", (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        "task_id" in message &&
        message.type === "active" &&
        message.task_id === taskId
      ) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) =>
    child.once("exit", () => {
      resolve();
    })
  );
}

async function waitForJobState(
  queue: Queue<ImageTaskJobData>,
  taskId: string,
  expectedState: string
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await queue.getJob(taskId).then(async (job) => await job?.getState());
    if (state === expectedState) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("等待崩溃任务首次重派完成超时。");
}

function createTaskInput(
  taskId: string,
  taskType: string,
  idempotencyKey: string
): CreateImageTaskRecordInput {
  return {
    id: taskId,
    owner_user_id: 479,
    task_type: taskType,
    status: "queued",
    prompt: "G05 独立 Worker 验收",
    negative_prompt: null,
    style_preset_id: null,
    input_file_ids: [],
    gateway_model_code: "integration-image-model",
    gateway_capability: taskType === "image_to_text" ? "vision_text" : "image_generation",
    quality: "standard",
    image_size: "1024x1024",
    image_count: 1,
    upscale_factor: taskType === "upscale" ? 2 : null,
    cost_points: null,
    billing_event_id: null,
    idempotency_key: idempotencyKey
  };
}

async function waitForTasks(
  repository: MySqlImageTasksRepository,
  taskIds: string[],
  status: string
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const tasks = await Promise.all(
      taskIds.map(async (taskId) => await repository.findById(taskId))
    );

    if (tasks.every((task) => task?.status === status)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("等待真实 Worker 完成任务超时。");
}

function createDeferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve(): void {
      resolvePromise?.();
    }
  };
}
