import "dotenv/config";

import { ConfigError, loadAppConfig } from "../config/app-config.js";
import {
  HttpAiGatewayImageEditClient,
  HttpAiGatewayImageGenerationClient,
  HttpAiGatewayVisionTextClient
} from "../infrastructure/ai/ai-gateway-client.js";
import { MySqlAiGatewayCallLogsRepository } from "../infrastructure/database/ai-gateway-call-logs-repository.js";
import { MySqlBillingEventsRepository } from "../infrastructure/database/billing-events-repository.js";
import { createDatabasePool } from "../infrastructure/database/database-pool.js";
import { MySqlFilesRepository } from "../infrastructure/database/files-repository.js";
import { MySqlImageTasksRepository } from "../infrastructure/database/image-tasks-repository.js";
import { MySqlPricingRulesRepository } from "../infrastructure/database/pricing-rules-repository.js";
import { MySqlStylePresetsRepository } from "../infrastructure/database/style-presets-repository.js";
import { MolingClient } from "../infrastructure/moling/moling-client.js";
import {
  createBullMqRedisConnection,
  RedisConnectionError
} from "../infrastructure/redis/redis-connection.js";
import {
  checkRedisHealth,
  RedisHealthCheckError
} from "../infrastructure/redis/redis-health-check.js";
import { MinioStorageService } from "../infrastructure/storage/minio-storage-service.js";
import { BullMqImageTaskQueue } from "../infrastructure/queue/bullmq-image-task-queue.js";
import { BillingService } from "../modules/billing/billing-service.js";
import { FileService } from "../modules/files/file-service.js";
import { ImageTaskService } from "../modules/image-tasks/image-task-service.js";
import { StylePresetService } from "../modules/style-presets/style-preset-service.js";
import { BullMqImageTaskWorker } from "./bullmq-image-task-worker.js";
import { ImageGenerationWorkerService } from "./image-generation-worker-service.js";
import { ImageTaskJobProcessor } from "./image-task-job-processor.js";
import { ImageTaskRecoveryScanner } from "./image-task-recovery-scanner.js";
import { SharpImageOutputPostProcessor } from "./image-output-post-processor.js";

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const redisConnection = createBullMqRedisConnection(config, "worker");
  const databasePool = createDatabasePool(config);
  let queueWorker: BullMqImageTaskWorker | undefined;
  let recoveryQueue: BullMqImageTaskQueue | undefined;
  let recoveryScanner: ImageTaskRecoveryScanner | undefined;

  try {
    await redisConnection.connect();
    await checkRedisHealth(redisConnection);

    const imageTasksRepository = new MySqlImageTasksRepository(databasePool);
    const billingService = new BillingService(
      config.billingRulesJson,
      new MySqlBillingEventsRepository(databasePool),
      new MolingClient(config),
      new MySqlPricingRulesRepository(databasePool)
    );
    const imageTaskService = new ImageTaskService(imageTasksRepository, billingService);
    const fileService = new FileService(
      new MySqlFilesRepository(databasePool),
      new MinioStorageService(config),
      config
    );
    const stylePresetService = new StylePresetService(
      new MySqlStylePresetsRepository(databasePool)
    );
    const imageGenerationWorkerService = new ImageGenerationWorkerService(
      imageTasksRepository,
      imageTaskService,
      fileService,
      new HttpAiGatewayImageGenerationClient(config),
      new MySqlAiGatewayCallLogsRepository(databasePool),
      new HttpAiGatewayVisionTextClient(config),
      new HttpAiGatewayImageEditClient(config),
      stylePresetService,
      new SharpImageOutputPostProcessor()
    );
    const workerLockDurationMs = Math.max(config.imageTaskJobTimeoutMs * 2, 30_000);
    const jobProcessor = new ImageTaskJobProcessor(
      imageTasksRepository,
      imageGenerationWorkerService,
      {
        jobTimeoutMs: config.imageTaskJobTimeoutMs,
        lockDurationMs: workerLockDurationMs
      },
      {
        async finalizeFailure(input): Promise<void> {
          // 最终失败必须经过业务服务释放积分；队列和 Worker 不直接调用计费 Provider。
          await imageTaskService.transitionTask({
            ownerUserId: input.task.owner_user_id,
            taskId: input.task.id,
            toStatus: "failed",
            errorCode: input.errorCode,
            errorMessage: input.errorMessage,
            workerLockToken: input.workerLockToken
          });
        }
      }
    );
    queueWorker = new BullMqImageTaskWorker(
      config.imageTaskQueueName,
      redisConnection.client,
      config.imageTaskWorkerConcurrency,
      workerLockDurationMs,
      jobProcessor
    );
    recoveryQueue = new BullMqImageTaskQueue(
      config.imageTaskQueueName,
      redisConnection.client,
      config.imageTaskJobAttempts
    );
    recoveryScanner = new ImageTaskRecoveryScanner(
      {
        findRecoverableStuckTasks: (input) => imageTasksRepository.findRecoverableStuckTasks(input),
        recoverStuckExecution: (input) => imageTasksRepository.recoverStuckExecution(input),
        claimStuckTaskFinalization: (input) =>
          imageTasksRepository.claimStuckTaskFinalization(input)
      },
      recoveryQueue,
      imageTaskService,
      {
        scanIntervalMs: config.imageTaskRecoveryScanIntervalMs ?? 30_000,
        staleAfterMs: config.imageTaskStuckAfterMs ?? 300_000,
        batchSize: config.imageTaskRecoveryBatchSize ?? 50,
        maxAttempts: config.imageTaskJobAttempts,
        finalizationLockDurationMs: workerLockDurationMs
      }
    );
    await queueWorker.waitUntilReady();
    recoveryScanner.start();
  } catch (error: unknown) {
    await Promise.allSettled([
      recoveryScanner?.stop(),
      queueWorker?.close(),
      recoveryQueue?.close(),
      redisConnection.close(),
      databasePool.end()
    ]);
    throw error;
  }

  console.log(
    `molin-image-app image task worker started, concurrency=${String(config.imageTaskWorkerConcurrency)}`
  );

  let shutdownPromise: Promise<void> | undefined;
  const requestShutdown = (signal: NodeJS.Signals): void => {
    // 重复退出信号共用同一关闭流程，先停 BullMQ 领取，再关闭 Redis 与 MySQL。
    shutdownPromise ??= shutdownWorker(
      queueWorker,
      recoveryScanner,
      recoveryQueue,
      async () => {
        await redisConnection.close();
      },
      async () => {
        await databasePool.end();
      },
      signal
    );
    void shutdownPromise;
  };

  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
}

void main().catch((error: unknown) => {
  // Worker 启动失败必须显式退出，并且不能把连接串、Token 或第三方原始异常写入日志。
  console.error(toPublicStartupError(error));
  process.exitCode = 1;
});

async function shutdownWorker(
  queueWorker: BullMqImageTaskWorker,
  recoveryScanner: ImageTaskRecoveryScanner | undefined,
  recoveryQueue: BullMqImageTaskQueue | undefined,
  closeRedis: () => Promise<void>,
  closeDatabase: () => Promise<void>,
  signal: NodeJS.Signals
): Promise<void> {
  console.log(`molin-image-app image task worker 收到 ${signal}，正在等待当前任务完成`);
  const closeResults: PromiseSettledResult<void>[] = [];

  // 必须先等待 BullMQ 当前处理函数结束，不能并行关闭它仍在使用的 Redis、MySQL 和 MinIO 依赖。
  closeResults.push(
    ...(await Promise.allSettled([
      recoveryScanner?.stop(),
      queueWorker.close(),
      recoveryQueue?.close()
    ]))
  );
  closeResults.push(...(await Promise.allSettled([closeRedis(), closeDatabase()])));

  if (closeResults.some((result) => result.status === "rejected")) {
    console.error("molin-image-app image task worker 关闭资源失败");
    process.exitCode = 1;
  }
}

function toPublicStartupError(error: unknown): string {
  if (error instanceof RedisConnectionError || error instanceof RedisHealthCheckError) {
    return error.message;
  }

  return "image task worker 启动失败";
}

function loadConfigOrExit() {
  try {
    return loadAppConfig();
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      // Worker 与 API 使用同一套配置校验，缺少队列、存储或网关配置时直接拒绝启动。
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  }
}
