import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, loadAppConfig } from "../src/config/app-config.js";

const completeEnv = {
  APP_BASE_URL: "https://molin-image.example.com",
  DATABASE_URL: "mysql://user:password@127.0.0.1:3306/molin_image",
  REDIS_URL: "redis://127.0.0.1:6379/0",
  STORAGE_PROVIDER: "minio",
  STORAGE_ENDPOINT: "http://127.0.0.1:9000",
  STORAGE_BUCKET: "molin-image-dev",
  STORAGE_ACCESS_KEY_ID: "replace_with_storage_access_key",
  STORAGE_SECRET_ACCESS_KEY: "replace_with_storage_secret_key",
  STORAGE_PRESIGNED_URL_TTL_SECONDS: "300",
  MOLING_API_BASE_URL: "https://moling-api.example.com",
  MOLING_APP_ID: "990008",
  MOLING_PRODUCT_ID: "990107",
  AI_GATEWAY_BASE_URL: "https://ai-gateway.example.com",
  AI_GATEWAY_API_KEY: "replace_with_ai_gateway_api_key",
  IMAGE_MODEL_ENABLED_CAPABILITIES: "image_generation,vision_text,moderation",
  IMAGE_MODEL_REQUIRED_CAPABILITIES: "image_generation,vision_text,moderation",
  IMAGE_MODEL_CATALOG_JSON: "[]",
  BILLING_RULES_JSON:
    '[{"task_type":"text_to_image","usage_type":"image_text_to_image","unit":"credits","points_per_unit":"6","active":true}]',
  BILLING_MOCK_BALANCE_POINTS: "100",
  INTERNAL_API_TOKEN: "replace_with_internal_api_token",
  SESSION_COOKIE_NAME: "molinimage_session",
  SESSION_COOKIE_SECURE: "false",
  SESSION_TTL_SECONDS: "86400",
  PORT: "3100"
};

void test("配置完整时可以加载应用配置", () => {
  // 使用测试占位值验证配置映射，真实密钥不能写入测试用例或仓库。
  assert.deepEqual(loadAppConfig(completeEnv), {
    appBaseUrl: "https://molin-image.example.com",
    databaseUrl: "mysql://user:password@127.0.0.1:3306/molin_image",
    redisUrl: "redis://127.0.0.1:6379/0",
    storageProvider: "minio",
    storageEndpoint: "http://127.0.0.1:9000",
    storageBucket: "molin-image-dev",
    storageAccessKeyId: "replace_with_storage_access_key",
    storageSecretAccessKey: "replace_with_storage_secret_key",
    storagePresignedUrlTtlSeconds: 300,
    molingApiBaseUrl: "https://moling-api.example.com",
    molingAppId: 990008,
    molingProductId: 990107,
    aiGatewayBaseUrl: "https://ai-gateway.example.com",
    aiGatewayApiKey: "replace_with_ai_gateway_api_key",
    imageModelCatalogJson: "[]",
    imageModelEnabledCapabilities: ["image_generation", "vision_text", "moderation"],
    imageModelRequiredCapabilities: ["image_generation", "vision_text", "moderation"],
    billingRulesJson:
      '[{"task_type":"text_to_image","usage_type":"image_text_to_image","unit":"credits","points_per_unit":"6","active":true}]',
    billingMockBalancePoints: "100",
    internalApiToken: "replace_with_internal_api_token",
    adminUserIds: [],
    sessionCookieName: "molinimage_session",
    sessionCookieSecure: false,
    sessionTtlSeconds: 86400,
    port: 3100
  });
});

void test("缺少关键配置时返回明确缺失项", () => {
  // 缺失项一次性全部返回，方便部署或本地启动时快速补齐配置。
  assert.throws(
    () => loadAppConfig({ APP_BASE_URL: "https://molin-image.example.com" }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes("DATABASE_URL") &&
      error.message.includes("MOLING_APP_ID") &&
      error.message.includes("INTERNAL_API_TOKEN")
  );
});

void test("端口配置非法时给出明确错误", () => {
  assert.throws(
    () => loadAppConfig({ ...completeEnv, PORT: "70000" }),
    /PORT 必须是 1 到 65535 之间的整数/
  );
});

void test("墨灵应用 ID 非法时启动失败", () => {
  assert.throws(
    () => loadAppConfig({ ...completeEnv, MOLING_APP_ID: "abc" }),
    /MOLING_APP_ID 必须是正整数/
  );
});

void test("管理员用户白名单支持多个墨灵用户 ID", () => {
  const config = loadAppConfig({ ...completeEnv, MOLINIMAGE_ADMIN_USER_IDS: "696,479" });

  assert.deepEqual(config.adminUserIds, [696, 479]);
});
