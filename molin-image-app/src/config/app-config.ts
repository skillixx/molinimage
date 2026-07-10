export interface AppConfig {
  appBaseUrl: string;
  databaseUrl: string;
  redisUrl: string;
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
  internalApiToken: string;
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
  | "SESSION_COOKIE_NAME"
  | "SESSION_COOKIE_SECURE"
  | "SESSION_TTL_SECONDS"
  | "STORAGE_PRESIGNED_URL_TTL_SECONDS"
  | "IMAGE_MODEL_CATALOG_JSON"
  | "IMAGE_MODEL_ENABLED_CAPABILITIES"
  | "IMAGE_MODEL_REQUIRED_CAPABILITIES"
  | "BILLING_RULES_JSON"
  | "BILLING_MOCK_BALANCE_POINTS"
  | "AI_GATEWAY_API_KEY";

type AppEnv = Partial<Record<RequiredEnvKey | OptionalEnvKey, string>>;

export function loadAppConfig(env: AppEnv = process.env): AppConfig {
  // 配置统一在启动阶段校验，避免业务执行到一半才发现数据库、存储或网关配置缺失。
  const missingKeys = requiredEnvKeys.filter((key) => isBlank(env[key]));

  if (missingKeys.length > 0) {
    throw new ConfigError(missingKeys);
  }

  return {
    appBaseUrl: readRequiredEnv(env, "APP_BASE_URL"),
    databaseUrl: readRequiredEnv(env, "DATABASE_URL"),
    redisUrl: readRequiredEnv(env, "REDIS_URL"),
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
    internalApiToken: readRequiredEnv(env, "INTERNAL_API_TOKEN"),
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

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}
