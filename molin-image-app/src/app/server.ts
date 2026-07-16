import "dotenv/config";

import { createServer } from "node:http";

import { createAppRequestHandler } from "./create-app.js";
import { ConfigError, loadAppConfig } from "../config/app-config.js";
import {
  EnvAiGatewayModelCatalogClient,
  HttpAiGatewayImageEditClient,
  HttpAiGatewayImageGenerationClient,
  HttpAiGatewayPromptOptimizerClient,
  HttpAiGatewayVisionTextClient
} from "../infrastructure/ai/ai-gateway-client.js";
import { MySqlAiGatewayCallLogsRepository } from "../infrastructure/database/ai-gateway-call-logs-repository.js";
import { MySqlBillingReconciliationRepository } from "../infrastructure/database/billing-reconciliation-repository.js";
import { MySqlBillingEventsRepository } from "../infrastructure/database/billing-events-repository.js";
import { createDatabasePool } from "../infrastructure/database/database-pool.js";
import { MySqlFilesRepository } from "../infrastructure/database/files-repository.js";
import { MySqlImageModelConfigsRepository } from "../infrastructure/database/image-model-configs-repository.js";
import { MySqlImageTaskOutboxRepository } from "../infrastructure/database/image-task-outbox-repository.js";
import { MySqlImageTasksRepository } from "../infrastructure/database/image-tasks-repository.js";
import { MySqlPricingRulesRepository } from "../infrastructure/database/pricing-rules-repository.js";
import { MySqlRiskControlEventsRepository } from "../infrastructure/database/risk-control-events-repository.js";
import { MySqlStylePresetsRepository } from "../infrastructure/database/style-presets-repository.js";
import { MolingClient } from "../infrastructure/moling/moling-client.js";
import {
  createBullMqRedisConnection,
  createRedisConnection,
  RedisConnectionError
} from "../infrastructure/redis/redis-connection.js";
import {
  checkRedisHealth,
  RedisHealthCheckError
} from "../infrastructure/redis/redis-health-check.js";
import { BullMqImageTaskQueue } from "../infrastructure/queue/bullmq-image-task-queue.js";
import { ImageTaskOutboxDispatcher } from "../infrastructure/queue/image-task-outbox-dispatcher.js";
import { MinioStorageService } from "../infrastructure/storage/minio-storage-service.js";
import { BillingService } from "../modules/billing/billing-service.js";
import { BillingRecordService } from "../modules/billing/billing-record-service.js";
import { BillingReconciliationService } from "../modules/billing/billing-reconciliation-service.js";
import { PricingRuleService } from "../modules/billing/pricing-rule-service.js";
import { ConsoleImageTaskAuditLogger } from "../infrastructure/audit/console-image-task-audit-logger.js";
import { ConsolePricingRuleAuditLogger } from "../infrastructure/audit/console-pricing-rule-audit-logger.js";
import { FileService } from "../modules/files/file-service.js";
import { ImageModelService } from "../modules/image-models/image-model-service.js";
import { ImageTaskService } from "../modules/image-tasks/image-task-service.js";
import { RiskControlService } from "../modules/risk-control/risk-control-service.js";
import { StylePresetService } from "../modules/style-presets/style-preset-service.js";
import { PromptOptimizationService } from "../modules/prompts/prompt-optimization-service.js";
import { RedisSessionStore } from "../modules/auth/redis-session-store.js";
import { InMemorySessionStore } from "../modules/auth/session-store.js";
import { ImageGenerationWorkerService } from "../workers/image-generation-worker-service.js";
import { SharpImageOutputPostProcessor } from "../workers/image-output-post-processor.js";

const config = loadConfigOrExit();
const redisConnection = createRedisConnection(config, "api");
const molingClient = new MolingClient(config);
const databasePool = createDatabasePool(config);
const filesRepository = new MySqlFilesRepository(databasePool);
const imageTasksRepository = new MySqlImageTasksRepository(databasePool);
const imageTaskOutboxRepository = new MySqlImageTaskOutboxRepository(
  databasePool,
  imageTasksRepository
);
const imageModelConfigsRepository = new MySqlImageModelConfigsRepository(databasePool);
const billingEventsRepository = new MySqlBillingEventsRepository(databasePool);
const billingReconciliationRepository = new MySqlBillingReconciliationRepository(databasePool);
const pricingRulesRepository = new MySqlPricingRulesRepository(databasePool);
const stylePresetsRepository = new MySqlStylePresetsRepository(databasePool);
const riskControlEventsRepository = new MySqlRiskControlEventsRepository(databasePool);
const aiGatewayCallLogsRepository = new MySqlAiGatewayCallLogsRepository(databasePool);
const storageService = new MinioStorageService(config);
const fileService = new FileService(filesRepository, storageService, config);
const modelCatalogClient = new EnvAiGatewayModelCatalogClient(config.imageModelCatalogJson);
const imageModelService = new ImageModelService(
  modelCatalogClient,
  config.imageModelEnabledCapabilities,
  config.imageModelRequiredCapabilities,
  imageModelConfigsRepository
);
const billingService = new BillingService(
  config.billingRulesJson,
  billingEventsRepository,
  molingClient,
  pricingRulesRepository
);
const billingRecordService = new BillingRecordService(billingEventsRepository);
const pricingRuleAuditLogger = new ConsolePricingRuleAuditLogger();
const pricingRuleService = new PricingRuleService(pricingRulesRepository, pricingRuleAuditLogger);
const stylePresetService = new StylePresetService(stylePresetsRepository);
const imageTaskAuditLogger = new ConsoleImageTaskAuditLogger();
const riskControlService = new RiskControlService(riskControlEventsRepository, {
  windowSeconds: config.riskControlWindowSeconds,
  userLimit: config.riskControlUserLimit,
  ipLimit: config.riskControlIpLimit,
  disabledTaskTypes: config.riskControlDisabledTaskTypes,
  disabledCapabilities: config.riskControlDisabledCapabilities
});
const imageTaskService = new ImageTaskService(
  imageTasksRepository,
  billingService,
  imageTaskAuditLogger,
  imageModelService,
  stylePresetService,
  riskControlService,
  config.imageTaskExecutionMode === "queue" ? imageTaskOutboxRepository : undefined
);
const billingReconciliationService = new BillingReconciliationService(
  billingReconciliationRepository,
  imageTasksRepository,
  imageTaskService,
  billingService
);
const imageGenerationClient = new HttpAiGatewayImageGenerationClient(config);
const imageEditClient = new HttpAiGatewayImageEditClient(config);
const visionTextClient = new HttpAiGatewayVisionTextClient(config);
const promptOptimizerClient = new HttpAiGatewayPromptOptimizerClient(config);
const promptOptimizationService = new PromptOptimizationService(
  imageModelService,
  promptOptimizerClient
);
const imageOutputPostProcessor = new SharpImageOutputPostProcessor();
const imageGenerationWorkerService = new ImageGenerationWorkerService(
  imageTasksRepository,
  imageTaskService,
  fileService,
  imageGenerationClient,
  aiGatewayCallLogsRepository,
  visionTextClient,
  imageEditClient,
  stylePresetService,
  imageOutputPostProcessor
);
const sessionStore =
  config.sessionStore === "redis"
    ? new RedisSessionStore(redisConnection.client, config)
    : new InMemorySessionStore();
const queueRedisConnection =
  config.imageTaskExecutionMode === "queue"
    ? createBullMqRedisConnection(config, "queue")
    : undefined;
const imageTaskQueue =
  queueRedisConnection === undefined
    ? undefined
    : new BullMqImageTaskQueue(
        config.imageTaskQueueName,
        queueRedisConnection.client,
        config.imageTaskJobAttempts
      );
const outboxDispatcher =
  imageTaskQueue === undefined
    ? undefined
    : new ImageTaskOutboxDispatcher(imageTaskOutboxRepository, imageTaskQueue, imageTaskService, {
        batchSize: config.imageTaskOutboxBatchSize,
        pollIntervalMs: config.imageTaskOutboxPollIntervalMs,
        maxWaitMs: config.imageTaskOutboxMaxWaitMs,
        maxBackoffMs: config.imageTaskOutboxMaxBackoffMs
      });

const server = createServer(
  createAppRequestHandler(config, {
    launchTicketVerifier: molingClient,
    // 生产配置会强制选择 Redis；memory 仅用于开发、测试和灰度回退验证。
    sessionStore,
    fileService,
    imageModelService,
    imageTaskService,
    billingService,
    billingRecordService,
    billingReconciliationService,
    pricingRuleService,
    stylePresetService,
    promptOptimizationService,
    imageGenerationWorkerService
  })
);

void startServer().catch(async (error: unknown) => {
  await outboxDispatcher?.stop();
  await Promise.allSettled([
    imageTaskQueue?.close(),
    queueRedisConnection?.close(),
    redisConnection.close(),
    databasePool.end()
  ]);
  // 启动失败只输出稳定公开信息，不把 Redis 驱动错误、连接串或堆栈写入部署日志。
  console.error(toPublicStartupError(error));
  process.exitCode = 1;
});

async function startServer(): Promise<void> {
  await redisConnection.connect();
  await checkRedisHealth(redisConnection);
  await queueRedisConnection?.connect();
  outboxDispatcher?.start();

  server.listen(config.port, () => {
    // 启动日志不输出任何敏感配置，后续接入墨灵 ticket 和 AI 网关时也保持同样约束。
    console.log(`molin-image-app api listening on http://localhost:${String(config.port)}`);
  });

  let shutdownPromise: Promise<void> | undefined;
  const requestShutdown = (signal: NodeJS.Signals): void => {
    // 多个系统信号可能连续到达，共用同一个 Promise，避免重复关闭 Redis 和数据库连接。
    shutdownPromise ??= shutdownServer(signal);
    void shutdownPromise;
  };

  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);
}

async function shutdownServer(signal: NodeJS.Signals): Promise<void> {
  console.log(`molin-image-app api 收到 ${signal}，正在优雅关闭`);

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  // 先停止扫描并等待正在执行的一轮结束，再关闭 Queue 和底层连接，避免半途丢失状态回写。
  await outboxDispatcher?.stop();
  const closeResults = await Promise.allSettled([
    imageTaskQueue?.close(),
    queueRedisConnection?.close(),
    redisConnection.close(),
    databasePool.end()
  ]);

  if (closeResults.some((result) => result.status === "rejected")) {
    // 关闭阶段不输出第三方错误详情，部署系统通过非零退出码识别需要人工检查。
    console.error("molin-image-app api 关闭资源失败");
    process.exitCode = 1;
  }
}

function toPublicStartupError(error: unknown): string {
  if (error instanceof RedisConnectionError || error instanceof RedisHealthCheckError) {
    return error.message;
  }

  return "molin-image-app api 启动失败";
}

function loadConfigOrExit() {
  try {
    return loadAppConfig();
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      // 配置错误只输出缺失键名，不输出任何环境变量值，避免密钥或连接串泄漏到日志。
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  }
}
