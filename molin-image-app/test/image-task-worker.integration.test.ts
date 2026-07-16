import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Queue } from "bullmq";

import { loadAppConfig } from "../src/config/app-config.js";
import { createDatabasePool } from "../src/infrastructure/database/database-pool.js";
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

const runQueueIntegrationTest =
  process.env.RUN_QUEUE_INTEGRATION_TESTS === "true" ? test : test.skip;

void runQueueIntegrationTest(
  "真实 BullMQ Worker 独立消费五类任务、恢复过期锁并优雅等待当前任务",
  { timeout: 30_000 },
  async () => {
    const config = loadAppConfig(process.env);
    const suffix = randomUUID().replaceAll("-", "");
    const queueName = `molinimage-g05-${suffix.slice(0, 16)}`;
    const pool = createDatabasePool(config);
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
    const fencedTaskId = `task_g05_fence_${suffix.slice(0, 16)}`;
    const recoveryTaskId = `task_g07_recover_${suffix.slice(0, 14)}`;
    const exhaustedTaskId = `task_g07_exhaust_${suffix.slice(0, 14)}`;
    const allTaskIds = [
      ...taskIds,
      expiredTaskId,
      slowTaskId,
      fencedTaskId,
      recoveryTaskId,
      exhaustedTaskId
    ];
    const callCounts = new Map<string, number>();
    const slowStarted = createDeferred();
    const slowGate = createDeferred();
    let producer: BullMqImageTaskQueue | undefined;
    let inspector: Queue<ImageTaskJobData> | undefined;
    let worker: BullMqImageTaskWorker | undefined;

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

      const processor = new ImageTaskJobProcessor(
        repository,
        {
          async processTask(
            taskId: string,
            context: ImageTaskWorkerExecutionContext
          ): Promise<void> {
            callCounts.set(taskId, (callCounts.get(taskId) ?? 0) + 1);
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
      worker = new BullMqImageTaskWorker(
        queueName,
        redisConnection.client,
        3,
        10_000,
        processor,
        silentLogger
      );
      await worker.waitUntilReady();

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
      let closed = false;
      const closePromise = worker.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(closed, false);
      slowGate.resolve();
      await closePromise;
      worker = undefined;
      assert.equal((await repository.findById(slowTaskId))?.status, "succeeded");
    } finally {
      slowGate.resolve();
      await Promise.allSettled([worker?.close(), inspector?.obliterate({ force: true })]);
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
