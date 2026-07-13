import "dotenv/config";

import { createServer } from "node:http";

import { createAppRequestHandler } from "./create-app.js";
import { ConfigError, loadAppConfig } from "../config/app-config.js";
import {
  EnvAiGatewayModelCatalogClient,
  HttpAiGatewayImageEditClient,
  HttpAiGatewayImageGenerationClient,
  HttpAiGatewayVisionTextClient
} from "../infrastructure/ai/ai-gateway-client.js";
import { MySqlAiGatewayCallLogsRepository } from "../infrastructure/database/ai-gateway-call-logs-repository.js";
import { MySqlBillingReconciliationRepository } from "../infrastructure/database/billing-reconciliation-repository.js";
import { MySqlBillingEventsRepository } from "../infrastructure/database/billing-events-repository.js";
import { createDatabasePool } from "../infrastructure/database/database-pool.js";
import { MySqlFilesRepository } from "../infrastructure/database/files-repository.js";
import { MySqlImageModelConfigsRepository } from "../infrastructure/database/image-model-configs-repository.js";
import { MySqlImageTasksRepository } from "../infrastructure/database/image-tasks-repository.js";
import { MySqlPricingRulesRepository } from "../infrastructure/database/pricing-rules-repository.js";
import { MySqlRiskControlEventsRepository } from "../infrastructure/database/risk-control-events-repository.js";
import { MySqlStylePresetsRepository } from "../infrastructure/database/style-presets-repository.js";
import { MolingClient } from "../infrastructure/moling/moling-client.js";
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
import { ImageGenerationWorkerService } from "../workers/image-generation-worker-service.js";

const config = loadConfigOrExit();
const molingClient = new MolingClient(config);
const databasePool = createDatabasePool(config);
const filesRepository = new MySqlFilesRepository(databasePool);
const imageTasksRepository = new MySqlImageTasksRepository(databasePool);
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
  riskControlService
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
const imageGenerationWorkerService = new ImageGenerationWorkerService(
  imageTasksRepository,
  imageTaskService,
  fileService,
  imageGenerationClient,
  aiGatewayCallLogsRepository,
  visionTextClient,
  imageEditClient,
  stylePresetService
);

const server = createServer(
  createAppRequestHandler(config, {
    launchTicketVerifier: molingClient,
    fileService,
    imageModelService,
    imageTaskService,
    billingService,
    billingRecordService,
    billingReconciliationService,
    pricingRuleService,
    stylePresetService,
    imageGenerationWorkerService
  })
);

server.listen(config.port, () => {
  // 启动日志不输出任何敏感配置，后续接入墨灵 ticket 和 AI 网关时也保持同样约束。
  console.log(`molin-image-app api listening on http://localhost:${String(config.port)}`);
});

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
