export interface AppConfig {
  appBaseUrl: string;
  databaseUrl: string;
  redisUrl: string;
  storageProvider: string;
  storageEndpoint: string;
  storageBucket: string;
  molingApiBaseUrl: string;
  aiGatewayBaseUrl: string;
  internalApiToken: string;
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
  "MOLING_API_BASE_URL",
  "AI_GATEWAY_BASE_URL",
  "INTERNAL_API_TOKEN"
] as const;

type RequiredEnvKey = (typeof requiredEnvKeys)[number];

type AppEnv = Partial<Record<RequiredEnvKey | "PORT", string>>;

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
    molingApiBaseUrl: readRequiredEnv(env, "MOLING_API_BASE_URL"),
    aiGatewayBaseUrl: readRequiredEnv(env, "AI_GATEWAY_BASE_URL"),
    internalApiToken: readRequiredEnv(env, "INTERNAL_API_TOKEN"),
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

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}
