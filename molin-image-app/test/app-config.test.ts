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
  MOLING_API_BASE_URL: "https://moling-api.example.com",
  AI_GATEWAY_BASE_URL: "https://ai-gateway.example.com",
  INTERNAL_API_TOKEN: "replace_with_internal_api_token",
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
    molingApiBaseUrl: "https://moling-api.example.com",
    aiGatewayBaseUrl: "https://ai-gateway.example.com",
    internalApiToken: "replace_with_internal_api_token",
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
      error.message.includes("INTERNAL_API_TOKEN")
  );
});

void test("端口配置非法时给出明确错误", () => {
  assert.throws(
    () => loadAppConfig({ ...completeEnv, PORT: "70000" }),
    /PORT 必须是 1 到 65535 之间的整数/
  );
});
