export interface AppConfig {
  appBaseUrl: string;
  databaseUrl: string;
  redisUrl: string;
  redisKeyPrefix: string;
  redisConnectTimeoutMs: number;
  redisCommandTimeoutMs: number;
  redisMaxRetriesPerRequest: number;
  imageTaskQueueName: string;
  imageTaskWorkerConcurrency: number;
  imageTaskJobAttempts: number;
  imageTaskJobTimeoutMs: number;
  imageTaskRecoveryScanIntervalMs?: number;
  imageTaskStuckAfterMs?: number;
  imageTaskRecoveryBatchSize?: number;
  workerHeartbeatIntervalMs?: number;
  workerHeartbeatTtlSeconds?: number;
  queueBacklogAlertThreshold?: number;
  queueOldestWaitAlertMs?: number;
  outboxBacklogAlertThreshold?: number;
  healthProbeTimeoutMs?: number;
  healthReadinessCacheTtlMs?: number;
  imageTaskExecutionMode: "inline" | "queue";
  imageTaskOutboxPollIntervalMs: number;
  imageTaskOutboxBatchSize: number;
  imageTaskOutboxMaxWaitMs: number;
  imageTaskOutboxMaxBackoffMs: number;
  storageProvider: string;
  storageEndpoint: string;
  storageBucket: string;
  storageAccessKeyId: string;
  storageSecretAccessKey: string;
  storagePresignedUrlTtlSeconds: number;
  molingApiBaseUrl: string;
  molingAppId: number;
  molingProductId: number;
  aiGatewayBaseUrl: string;
  aiGatewayApiKey: string;
  imageModelCatalogJson: string;
  imageModelEnabledCapabilities: string[];
  imageModelRequiredCapabilities: string[];
  billingRulesJson: string;
  billingMockBalancePoints: string;
  riskControlWindowSeconds: number;
  riskControlUserLimit: number;
  riskControlIpLimit: number;
  riskControlDisabledTaskTypes: string[];
  riskControlDisabledCapabilities: string[];
  trustProxy: boolean;
  internalApiToken: string;
  adminUserIds?: number[];
  sessionStore: "memory" | "redis";
  sessionCookieName: string;
  sessionCookieSecure: boolean;
  sessionTtlSeconds: number;
  port: number;
}

export class ConfigError extends Error {
  constructor(public readonly missingKeys: string[]) {
    super(`缺少关键配置：${missingKeys.join(", ")}`);
    this.name = "ConfigError";
  }
}

const requiredEnvKeys = [
  "APP_BASE_URL",
  "DATABASE_URL",
  "REDIS_URL",
  "STORAGE_PROVIDER",
  "STORAGE_ENDPOINT",
  "STORAGE_BUCKET",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "MOLING_API_BASE_URL",
  "MOLING_APP_ID",
  "MOLING_PRODUCT_ID",
  "AI_GATEWAY_BASE_URL",
  "INTERNAL_API_TOKEN"
] as const;

type RequiredEnvKey = (typeof requiredEnvKeys)[number];

type OptionalEnvKey =
  | "APP_ENV"
  | "PORT"
  | "REDIS_KEY_PREFIX"
  | "REDIS_CONNECT_TIMEOUT_MS"
  | "REDIS_COMMAND_TIMEOUT_MS"
  | "REDIS_MAX_RETRIES_PER_REQUEST"
  | "IMAGE_TASK_QUEUE_NAME"
  | "IMAGE_TASK_WORKER_CONCURRENCY"
  | "IMAGE_TASK_JOB_ATTEMPTS"
  | "IMAGE_TASK_JOB_TIMEOUT_MS"
  | "IMAGE_TASK_RECOVERY_SCAN_INTERVAL_MS"
  | "IMAGE_TASK_STUCK_AFTER_MS"
  | "IMAGE_TASK_RECOVERY_BATCH_SIZE"
  | "WORKER_HEARTBEAT_INTERVAL_MS"
  | "WORKER_HEARTBEAT_TTL_SECONDS"
  | "QUEUE_BACKLOG_ALERT_THRESHOLD"
  | "QUEUE_OLDEST_WAIT_ALERT_MS"
  | "OUTBOX_BACKLOG_ALERT_THRESHOLD"
  | "HEALTH_PROBE_TIMEOUT_MS"
  | "HEALTH_READINESS_CACHE_TTL_MS"
  | "IMAGE_TASK_EXECUTION_MODE"
  | "IMAGE_TASK_OUTBOX_POLL_INTERVAL_MS"
  | "IMAGE_TASK_OUTBOX_BATCH_SIZE"
  | "IMAGE_TASK_OUTBOX_MAX_WAIT_MS"
  | "IMAGE_TASK_OUTBOX_MAX_BACKOFF_MS"
  | "SESSION_STORE"
  | "SESSION_COOKIE_NAME"
  | "SESSION_COOKIE_SECURE"
  | "SESSION_TTL_SECONDS"
  | "STORAGE_PRESIGNED_URL_TTL_SECONDS"
  | "IMAGE_MODEL_CATALOG_JSON"
  | "IMAGE_MODEL_ENABLED_CAPABILITIES"
  | "IMAGE_MODEL_REQUIRED_CAPABILITIES"
  | "BILLING_RULES_JSON"
  | "BILLING_MOCK_BALANCE_POINTS"
  | "RISK_CONTROL_WINDOW_SECONDS"
  | "RISK_CONTROL_USER_LIMIT"
  | "RISK_CONTROL_IP_LIMIT"
  | "RISK_CONTROL_DISABLED_TASK_TYPES"
  | "RISK_CONTROL_DISABLED_CAPABILITIES"
  | "TRUST_PROXY"
  | "AI_GATEWAY_API_KEY"
  | "MOLINIMAGE_ADMIN_USER_IDS";

type AppEnv = Partial<Record<RequiredEnvKey | OptionalEnvKey, string>>;

export function loadAppConfig(env: AppEnv = process.env): AppConfig {
  // 配置统一在启动阶段校验，避免业务执行到一半才发现数据库、存储或网关配置缺失。
  const missingKeys = requiredEnvKeys.filter((key) => isBlank(env[key]));

  if (missingKeys.length > 0) {
    throw new ConfigError(missingKeys);
  }

  const appEnv = readAppEnvironment(env.APP_ENV);

  return {
    appBaseUrl: readRequiredEnv(env, "APP_BASE_URL"),
    databaseUrl: readRequiredEnv(env, "DATABASE_URL"),
    redisUrl: readRequiredEnv(env, "REDIS_URL"),
    // 环境名进入实际 Key 前缀，防止开发、测试和生产误用同一 Redis 时互相覆盖数据。
    redisKeyPrefix: `${readRedisIdentifier(env.REDIS_KEY_PREFIX, "molinimage", "REDIS_KEY_PREFIX")}:${appEnv}`,
    redisConnectTimeoutMs: readPositiveInteger(
      env.REDIS_CONNECT_TIMEOUT_MS?.trim() ?? "10000",
      "REDIS_CONNECT_TIMEOUT_MS"
    ),
    redisCommandTimeoutMs: readPositiveInteger(
      env.REDIS_COMMAND_TIMEOUT_MS?.trim() ?? "5000",
      "REDIS_COMMAND_TIMEOUT_MS"
    ),
    redisMaxRetriesPerRequest: readNonNegativeInteger(
      env.REDIS_MAX_RETRIES_PER_REQUEST?.trim() ?? "3",
      "REDIS_MAX_RETRIES_PER_REQUEST"
    ),
    imageTaskQueueName: readRedisIdentifier(
      env.IMAGE_TASK_QUEUE_NAME,
      "molinimage-image-tasks",
      "IMAGE_TASK_QUEUE_NAME"
    ),
    imageTaskWorkerConcurrency: readPositiveInteger(
      env.IMAGE_TASK_WORKER_CONCURRENCY?.trim() ?? "2",
      "IMAGE_TASK_WORKER_CONCURRENCY"
    ),
    imageTaskJobAttempts: readPositiveInteger(
      env.IMAGE_TASK_JOB_ATTEMPTS?.trim() ?? "3",
      "IMAGE_TASK_JOB_ATTEMPTS"
    ),
    imageTaskJobTimeoutMs: readPositiveInteger(
      env.IMAGE_TASK_JOB_TIMEOUT_MS?.trim() ?? "120000",
      "IMAGE_TASK_JOB_TIMEOUT_MS"
    ),
    imageTaskRecoveryScanIntervalMs: readPositiveInteger(
      env.IMAGE_TASK_RECOVERY_SCAN_INTERVAL_MS?.trim() ?? "30000",
      "IMAGE_TASK_RECOVERY_SCAN_INTERVAL_MS"
    ),
    imageTaskStuckAfterMs: readPositiveInteger(
      env.IMAGE_TASK_STUCK_AFTER_MS?.trim() ?? "300000",
      "IMAGE_TASK_STUCK_AFTER_MS"
    ),
    imageTaskRecoveryBatchSize: readPositiveInteger(
      env.IMAGE_TASK_RECOVERY_BATCH_SIZE?.trim() ?? "50",
      "IMAGE_TASK_RECOVERY_BATCH_SIZE"
    ),
    workerHeartbeatIntervalMs: readPositiveInteger(
      env.WORKER_HEARTBEAT_INTERVAL_MS?.trim() ?? "5000",
      "WORKER_HEARTBEAT_INTERVAL_MS"
    ),
    workerHeartbeatTtlSeconds: readPositiveInteger(
      env.WORKER_HEARTBEAT_TTL_SECONDS?.trim() ?? "15",
      "WORKER_HEARTBEAT_TTL_SECONDS"
    ),
    queueBacklogAlertThreshold: readPositiveInteger(
      env.QUEUE_BACKLOG_ALERT_THRESHOLD?.trim() ?? "20",
      "QUEUE_BACKLOG_ALERT_THRESHOLD"
    ),
    queueOldestWaitAlertMs: readPositiveInteger(
      env.QUEUE_OLDEST_WAIT_ALERT_MS?.trim() ?? "60000",
      "QUEUE_OLDEST_WAIT_ALERT_MS"
    ),
    outboxBacklogAlertThreshold: readPositiveInteger(
      env.OUTBOX_BACKLOG_ALERT_THRESHOLD?.trim() ?? "10",
      "OUTBOX_BACKLOG_ALERT_THRESHOLD"
    ),
    healthProbeTimeoutMs: readPositiveInteger(
      env.HEALTH_PROBE_TIMEOUT_MS?.trim() ?? "5000",
      "HEALTH_PROBE_TIMEOUT_MS"
    ),
    healthReadinessCacheTtlMs: readPositiveInteger(
      env.HEALTH_READINESS_CACHE_TTL_MS?.trim() ?? "1000",
      "HEALTH_READINESS_CACHE_TTL_MS"
    ),
    imageTaskExecutionMode: readImageTaskExecutionMode(env.IMAGE_TASK_EXECUTION_MODE, appEnv),
    imageTaskOutboxPollIntervalMs: readPositiveInteger(
      env.IMAGE_TASK_OUTBOX_POLL_INTERVAL_MS?.trim() ?? "1000",
      "IMAGE_TASK_OUTBOX_POLL_INTERVAL_MS"
    ),
    imageTaskOutboxBatchSize: readPositiveInteger(
      env.IMAGE_TASK_OUTBOX_BATCH_SIZE?.trim() ?? "20",
      "IMAGE_TASK_OUTBOX_BATCH_SIZE"
    ),
    imageTaskOutboxMaxWaitMs: readPositiveInteger(
      env.IMAGE_TASK_OUTBOX_MAX_WAIT_MS?.trim() ?? "300000",
      "IMAGE_TASK_OUTBOX_MAX_WAIT_MS"
    ),
    imageTaskOutboxMaxBackoffMs: readPositiveInteger(
      env.IMAGE_TASK_OUTBOX_MAX_BACKOFF_MS?.trim() ?? "60000",
      "IMAGE_TASK_OUTBOX_MAX_BACKOFF_MS"
    ),
    storageProvider: readRequiredEnv(env, "STORAGE_PROVIDER"),
    storageEndpoint: readRequiredEnv(env, "STORAGE_ENDPOINT"),
    storageBucket: readRequiredEnv(env, "STORAGE_BUCKET"),
    storageAccessKeyId: readRequiredEnv(env, "STORAGE_ACCESS_KEY_ID"),
    storageSecretAccessKey: readRequiredEnv(env, "STORAGE_SECRET_ACCESS_KEY"),
    storagePresignedUrlTtlSeconds: readPositiveInteger(
      env.STORAGE_PRESIGNED_URL_TTL_SECONDS?.trim() ?? "300",
      "STORAGE_PRESIGNED_URL_TTL_SECONDS"
    ),
    molingApiBaseUrl: readRequiredEnv(env, "MOLING_API_BASE_URL"),
    molingAppId: readPositiveInteger(readRequiredEnv(env, "MOLING_APP_ID"), "MOLING_APP_ID"),
    molingProductId: readPositiveInteger(
      readRequiredEnv(env, "MOLING_PRODUCT_ID"),
      "MOLING_PRODUCT_ID"
    ),
    aiGatewayBaseUrl: readRequiredEnv(env, "AI_GATEWAY_BASE_URL"),
    // OpenRouter 等 OpenAI 兼容网关密钥是可选配置；当前模型目录只读 env，真正调用模型时再强校验。
    aiGatewayApiKey: readOptionalText(env.AI_GATEWAY_API_KEY, ""),
    imageModelCatalogJson: readOptionalText(env.IMAGE_MODEL_CATALOG_JSON, "[]"),
    imageModelEnabledCapabilities: readCsvList(
      env.IMAGE_MODEL_ENABLED_CAPABILITIES,
      "image_generation,vision_text,moderation,image_edit,image_restore,upscale,prompt_optimize"
    ),
    imageModelRequiredCapabilities: readCsvList(
      env.IMAGE_MODEL_REQUIRED_CAPABILITIES,
      "image_generation,vision_text,moderation"
    ),
    billingRulesJson: readOptionalText(
      env.BILLING_RULES_JSON,
      `[{"task_type":"text_to_image","usage_type":"image_text_to_image","unit":"credits","points_per_unit":"6","active":true},{"task_type":"image_to_image","usage_type":"image_to_image","unit":"credits","points_per_unit":"8","active":true},{"task_type":"image_restore","usage_type":"image_restore","unit":"credits","points_per_unit":"5","active":true},{"task_type":"image_to_text","usage_type":"image_to_text","unit":"credits","points_per_unit":"1","active":true},{"task_type":"upscale","usage_type":"image_upscale","unit":"credits","points_per_unit":"4","upscale_factor":2,"active":true},{"task_type":"upscale","usage_type":"image_upscale","unit":"credits","points_per_unit":"8","upscale_factor":4,"active":true}]`
    ),
    billingMockBalancePoints: readOptionalText(env.BILLING_MOCK_BALANCE_POINTS, "1000000"),
    riskControlWindowSeconds: readPositiveInteger(
      env.RISK_CONTROL_WINDOW_SECONDS?.trim() ?? "60",
      "RISK_CONTROL_WINDOW_SECONDS"
    ),
    riskControlUserLimit: readNonNegativeInteger(
      env.RISK_CONTROL_USER_LIMIT?.trim() ?? "20",
      "RISK_CONTROL_USER_LIMIT"
    ),
    riskControlIpLimit: readNonNegativeInteger(
      env.RISK_CONTROL_IP_LIMIT?.trim() ?? "60",
      "RISK_CONTROL_IP_LIMIT"
    ),
    riskControlDisabledTaskTypes: readCsvList(env.RISK_CONTROL_DISABLED_TASK_TYPES, ""),
    riskControlDisabledCapabilities: readCsvList(env.RISK_CONTROL_DISABLED_CAPABILITIES, ""),
    trustProxy: readBoolean(env.TRUST_PROXY, false),
    internalApiToken: readRequiredEnv(env, "INTERNAL_API_TOKEN"),
    adminUserIds: readPositiveIntegerList(env.MOLINIMAGE_ADMIN_USER_IDS),
    sessionStore: readSessionStore(env.SESSION_STORE, appEnv),
    sessionCookieName: readOptionalText(env.SESSION_COOKIE_NAME, "molinimage_session"),
    sessionCookieSecure: readSessionCookieSecure(env),
    sessionTtlSeconds: readPositiveInteger(
      env.SESSION_TTL_SECONDS?.trim() ?? "86400",
      "SESSION_TTL_SECONDS"
    ),
    port: readPort(env.PORT)
  };
}

function readRequiredEnv(env: AppEnv, key: RequiredEnvKey): string {
  const value = env[key]?.trim();

  if (value === undefined || value.length === 0) {
    // 正常情况下这里不会被触发，因为 loadAppConfig 已经统一收集缺失项；保留兜底方便单独测试。
    throw new ConfigError([key]);
  }

  return value;
}

function readPort(value: string | undefined): number {
  const portText = value?.trim();

  if (portText === undefined || portText.length === 0) {
    return 3000;
  }

  const port = Number(portText);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    // 端口不是核心交付配置，但错误也要清晰，避免启动后监听到不可预期的位置。
    throw new Error("PORT 必须是 1 到 65535 之间的整数");
  }

  return port;
}

function readPositiveInteger(value: string, key: string): number {
  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    // ID 与 TTL 都参与安全边界判断，启动期直接失败比运行时误放行更安全。
    throw new Error(`${key} 必须是正整数`);
  }

  return parsedValue;
}

function readNonNegativeInteger(value: string, key: string): number {
  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    // 风控限额允许配置为 0 表示完全关闭对应维度，但不能接受负数，避免误配置导致限流失效。
    throw new Error(`${key} 必须是非负整数`);
  }

  return parsedValue;
}

function readOptionalText(value: string | undefined, defaultValue: string): string {
  const text = value?.trim();

  return text === undefined || text.length === 0 ? defaultValue : text;
}

function readCsvList(value: string | undefined, defaultValue: string): string[] {
  const text = readOptionalText(value, defaultValue);

  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readPositiveIntegerList(value: string | undefined): number[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }

  return value
    .split(",")
    .map((item) => readPositiveInteger(item.trim(), "MOLINIMAGE_ADMIN_USER_IDS"));
}

function readSessionCookieSecure(env: AppEnv): boolean {
  const configuredValue = env.SESSION_COOKIE_SECURE?.trim().toLowerCase();

  if (configuredValue === "true") {
    return true;
  }

  if (configuredValue === "false") {
    return false;
  }

  // 生产默认打开 Secure，本地开发仍允许 HTTP 访问，避免联调时 cookie 写不进去。
  return env.APP_ENV?.trim() === "production";
}

function readSessionStore(
  value: string | undefined,
  appEnv: "development" | "test" | "production"
): "memory" | "redis" {
  const configuredStore = value?.trim().toLowerCase();
  const sessionStore =
    configuredStore === undefined || configuredStore.length === 0
      ? appEnv === "production"
        ? "redis"
        : "memory"
      : configuredStore;

  if (sessionStore !== "memory" && sessionStore !== "redis") {
    throw new Error("SESSION_STORE 只能填写 memory 或 redis");
  }

  if (appEnv === "production" && sessionStore !== "redis") {
    // 生产环境禁止内存会话，避免重启或多实例部署导致用户随机掉线。
    throw new Error("生产环境 SESSION_STORE 必须配置为 redis");
  }

  return sessionStore;
}

function readImageTaskExecutionMode(
  value: string | undefined,
  appEnv: "development" | "test" | "production"
): "inline" | "queue" {
  const configuredMode = value?.trim().toLowerCase();
  const executionMode =
    configuredMode === undefined || configuredMode.length === 0
      ? appEnv === "production"
        ? "queue"
        : "inline"
      : configuredMode;

  if (executionMode !== "inline" && executionMode !== "queue") {
    throw new Error("IMAGE_TASK_EXECUTION_MODE 只能填写 inline 或 queue");
  }

  if (appEnv === "production" && executionMode !== "queue") {
    // 生产环境禁止在 API 进程内执行模型，避免请求超时和多实例任务行为不一致。
    throw new Error("生产环境 IMAGE_TASK_EXECUTION_MODE 必须配置为 queue");
  }

  return executionMode;
}

function readBoolean(envValue: string | undefined, defaultValue: boolean): boolean {
  const normalized = envValue?.trim().toLowerCase();

  if (normalized === undefined || normalized.length === 0) {
    return defaultValue;
  }

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  throw new Error("布尔配置只能填写 true 或 false");
}

function readAppEnvironment(value: string | undefined): "development" | "test" | "production" {
  const appEnv = readOptionalText(value, "development");

  if (appEnv === "development" || appEnv === "test" || appEnv === "production") {
    return appEnv;
  }

  throw new Error("APP_ENV 只能填写 development、test 或 production");
}

function readRedisIdentifier(value: string | undefined, defaultValue: string, key: string): string {
  const identifier = readOptionalText(value, defaultValue);

  if (!/^[a-zA-Z0-9_-]+$/.test(identifier)) {
    // Redis 命名只允许稳定的 ASCII 标识，避免空格和分隔符破坏统一 Key 与队列命名。
    throw new Error(`${key} 只能包含字母、数字、下划线和连字符`);
  }

  return identifier;
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}
