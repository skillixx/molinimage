import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import type { BillingService } from "../src/modules/billing/billing-service.js";
import { ImageTaskService } from "../src/modules/image-tasks/image-task-service.js";
import { BullMqImageTaskWorker } from "../src/workers/bullmq-image-task-worker.js";
import type { ImageTaskWorkerExecutionContext } from "../src/workers/image-generation-worker-service.js";
import { ImageTaskJobProcessor } from "../src/workers/image-task-job-processor.js";
import { ImageTaskProcessingError } from "../src/workers/image-task-processing-error.js";
import { createIsolatedIntegrationPool } from "./support/isolated-integration-database.js";

const runCommercializationIntegrationTest =
  process.env.RUN_QUEUE_INTEGRATION_TESTS === "true" ? test : test.skip;

void runCommercializationIntegrationTest(
  "真实 MySQL 与 BullMQ 覆盖 AI 重试、永久失败释放和结算待对账",
  { timeout: 20_000 },
  async () => {
    const config = loadAppConfig(process.env);
    const suffix = randomUUID().replaceAll("-", "");
    const queueName = `molinimage-g09-commercial-${suffix.slice(0, 12)}`;
    const transientTaskId = `task_g09_transient_${suffix.slice(0, 12)}`;
    const permanentTaskId = `task_g09_permanent_${suffix.slice(0, 12)}`;
    const settlePendingTaskId = `task_g09_settle_${suffix.slice(0, 12)}`;
    const taskIds = [transientTaskId, permanentTaskId, settlePendingTaskId];
    const pool = await createIsolatedIntegrationPool(config, ["image_tasks"]);
    const repository = new MySqlImageTasksRepository(pool);
    const billing = new ControllableBillingGateway(settlePendingTaskId);
    const taskService = new ImageTaskService(repository, billing.asBillingService());
    const aiGateway = new ControllableFakeAiGateway(transientTaskId, permanentTaskId);
    const redisConnection = createBullMqRedisConnection(config, "worker", silentLogger);
    let producer: BullMqImageTaskQueue | undefined;
    let inspector: Queue<ImageTaskJobData> | undefined;
    let worker: BullMqImageTaskWorker | undefined;

    try {
      await redisConnection.connect();
      producer = new BullMqImageTaskQueue(queueName, redisConnection.client, 2);
      inspector = new Queue<ImageTaskJobData>(queueName, { connection: redisConnection.client });

      for (const taskId of taskIds) {
        await repository.create(createBillableTask(taskId, `g09:commercial:${taskId}`));
      }

      const processor = new ImageTaskJobProcessor(
        repository,
        {
          async processTask(
            taskId: string,
            context: ImageTaskWorkerExecutionContext
          ): Promise<void> {
            await aiGateway.generate(taskId);
            const task = await repository.findById(taskId);
            assert.ok(task);
            await taskService.transitionTask({
              ownerUserId: task.owner_user_id,
              taskId,
              toStatus: "succeeded",
              workerLockToken: context.workerLockToken
            });
          }
        },
        { jobTimeoutMs: 5_000, lockDurationMs: 5_000, heartbeatIntervalMs: 100 },
        {
          async finalizeFailure(input): Promise<void> {
            await taskService.finalizeClaimedFailure({
              ownerUserId: input.task.owner_user_id,
              taskId: input.task.id,
              workerLockToken: input.workerLockToken,
              errorCode: input.errorCode,
              errorMessage: input.errorMessage
            });
          }
        }
      );
      worker = new BullMqImageTaskWorker(
        queueName,
        redisConnection.client,
        2,
        5_000,
        processor,
        silentLogger
      );
      await worker.waitUntilReady();

      await Promise.all(taskIds.map(async (taskId) => await producer?.enqueue(taskId)));
      await waitForTerminalTasks(repository, {
        [transientTaskId]: "succeeded",
        [permanentTaskId]: "failed",
        [settlePendingTaskId]: "billing_pending"
      });

      assert.equal(aiGateway.calls.get(transientTaskId), 2);
      assert.equal(aiGateway.calls.get(permanentTaskId), 1);
      assert.equal(billing.settleCalls.get(transientTaskId), 1);
      assert.equal(billing.settleCalls.get(settlePendingTaskId), 1);
      assert.equal(billing.releaseCalls.get(permanentTaskId), 1);
      assert.equal(
        (await repository.findById(settlePendingTaskId))?.error_code,
        "BILLING_SETTLE_PENDING"
      );

      // 重复投递永久失败任务必须由数据库终态幂等跳过，不能再次调用模型或释放积分。
      await inspector.add(
        IMAGE_TASK_JOB_NAME,
        { task_id: permanentTaskId },
        { jobId: `duplicate-${permanentTaskId}` }
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(aiGateway.calls.get(permanentTaskId), 1);
      assert.equal(billing.releaseCalls.get(permanentTaskId), 1);
    } finally {
      await Promise.allSettled([worker?.close(), inspector?.obliterate({ force: true })]);
      await Promise.allSettled([producer?.close(), inspector?.close()]);
      await redisConnection.close();
      await pool.end();
    }
  }
);

class ControllableFakeAiGateway {
  readonly calls = new Map<string, number>();

  constructor(
    private readonly transientTaskId: string,
    private readonly permanentTaskId: string
  ) {}

  generate(taskId: string): Promise<void> {
    const callCount = (this.calls.get(taskId) ?? 0) + 1;
    this.calls.set(taskId, callCount);

    if (taskId === this.transientTaskId && callCount === 1) {
      throw new ImageTaskProcessingError({
        code: "AI_GATEWAY_TEMPORARY_FAILURE",
        message: "AI 模型服务暂时不可用。",
        retryable: true
      });
    }

    if (taskId === this.permanentTaskId) {
      throw new ImageTaskProcessingError({
        code: "CONTENT_MODERATION_REJECTED",
        message: "内容审核未通过。",
        retryable: false
      });
    }

    return Promise.resolve();
  }
}

class ControllableBillingGateway {
  readonly settleCalls = new Map<string, number>();
  readonly releaseCalls = new Map<string, number>();

  constructor(private readonly settlePendingTaskId: string) {}

  asBillingService(): Pick<BillingService, "release" | "reserve" | "settle"> {
    return {
      reserve: () => Promise.reject(new Error("集成测试不会重复执行积分预占。")),
      settle: (input) => {
        this.settleCalls.set(input.taskId, (this.settleCalls.get(input.taskId) ?? 0) + 1);
        return Promise.resolve({
          settled: input.taskId !== this.settlePendingTaskId,
          billing_event: createBillingEvent(input.taskId, "settle")
        });
      },
      release: (input) => {
        this.releaseCalls.set(input.taskId, (this.releaseCalls.get(input.taskId) ?? 0) + 1);
        return Promise.resolve({
          released: true,
          billing_event: createBillingEvent(input.taskId, "release")
        });
      }
    };
  }
}

function createBillingEvent(taskId: string, eventType: string) {
  return {
    id: `billing_${eventType}_${taskId}`,
    owner_user_id: 479,
    task_id: taskId,
    event_type: eventType,
    amount_points: "6.000000",
    status: eventType === "settle" ? "settled" : "released",
    idempotency_key: `${eventType}:${taskId}`,
    moling_reserve_id: `reserve_${taskId}`,
    moling_entitlement_id: 62,
    error_code: null,
    error_message: null,
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z"
  };
}

function createBillableTask(taskId: string, idempotencyKey: string): CreateImageTaskRecordInput {
  return {
    id: taskId,
    owner_user_id: 479,
    task_type: "text_to_image",
    status: "queued",
    prompt: "G09 商业化异常链路验收",
    negative_prompt: null,
    style_preset_id: null,
    input_file_ids: [],
    gateway_model_code: "fake-ai-gateway",
    gateway_capability: "image_generation",
    quality: "standard",
    image_size: "1024x1024",
    image_count: 1,
    cost_points: "6.000000",
    billing_event_id: `reserve_${taskId}`,
    idempotency_key: idempotencyKey
  };
}

async function waitForTerminalTasks(
  repository: MySqlImageTasksRepository,
  expected: Record<string, string>
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const statuses = await Promise.all(
      Object.keys(expected).map(async (taskId) => (await repository.findById(taskId))?.status)
    );

    if (Object.keys(expected).every((taskId, index) => statuses[index] === expected[taskId])) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("等待商业化异常链路进入终态超时。");
}

const silentLogger = {
  info(): void {
    // 集成测试不输出基础设施端点。
  },
  warn(): void {
    // 集成测试不输出基础设施端点。
  },
  error(): void {
    // 集成测试不输出基础设施端点。
  }
};
