import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createAppRequestHandler } from "../src/app/create-app.js";
import type { AppConfig } from "../src/config/app-config.js";
import type {
  LaunchTicketVerifier,
  MolingLaunchIdentity
} from "../src/infrastructure/moling/moling-client.js";
import type { ImageModelListResult } from "../src/modules/image-models/image-model-service.js";

const testConfig: AppConfig = {
  appBaseUrl: "http://127.0.0.1",
  databaseUrl: "mysql://user:password@127.0.0.1:3306/molinimage",
  redisUrl: "redis://127.0.0.1:6379/0",
  storageProvider: "minio",
  storageEndpoint: "http://127.0.0.1:9000",
  storageBucket: "molinimage",
  storageAccessKeyId: "test_storage_access_key",
  storageSecretAccessKey: "test_storage_secret_key",
  storagePresignedUrlTtlSeconds: 300,
  molingApiBaseUrl: "http://127.0.0.1:8080",
  molingAppId: 990008,
  molingProductId: 990107,
  aiGatewayBaseUrl: "http://127.0.0.1:8080/v1",
  aiGatewayApiKey: "test_ai_gateway_api_key",
  imageModelCatalogJson: "[]",
  imageModelEnabledCapabilities: ["image_generation", "vision_text", "moderation"],
  imageModelRequiredCapabilities: ["image_generation", "vision_text", "moderation"],
  billingRulesJson: "[]",
  billingMockBalancePoints: "100",
  internalApiToken: "test_internal_token",
  sessionCookieName: "molinimage_session",
  sessionCookieSecure: false,
  sessionTtlSeconds: 86400,
  port: 0
};

void test("模型目录接口必须登录，并按当前用户读取模型目录", async () => {
  const imageModelService = new FakeImageModelService();
  const app = await startTestApp(imageModelService);

  try {
    const unauthorizedResponse = await fetch(`${app.baseUrl}/api/image/models`);
    const cookie = await createSessionCookie(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/api/image/models`, {
      headers: {
        cookie
      }
    });
    const body = (await response.json()) as ImageModelListResult;

    assert.equal(unauthorizedResponse.status, 401);
    assert.equal(response.status, 200);
    assert.equal(imageModelService.userIds[0], 479);
    assert.deepEqual(
      body.items.map((item) => item.gateway_model_code),
      ["image-gen-default", "vision-text-default", "moderation-text"]
    );
    assert.deepEqual(body.missing_required_capabilities, []);
    assert.equal(body.message, null);
  } finally {
    await app.close();
  }
});

class FakeImageModelService {
  readonly userIds: number[] = [];

  listVisibleImageModels(userId: number): Promise<ImageModelListResult> {
    this.userIds.push(userId);

    return Promise.resolve({
      items: [
        createModel("image-gen-default", "image_generation", 10),
        createModel("vision-text-default", "vision_text", 20),
        createModel("moderation-text", "moderation", 30)
      ],
      required_capabilities: ["image_generation", "vision_text", "moderation"],
      missing_required_capabilities: [],
      message: null,
      source: "env"
    });
  }
}

class FakeLaunchTicketVerifier implements LaunchTicketVerifier {
  verifyLaunchTicket(): Promise<MolingLaunchIdentity> {
    return Promise.resolve({
      user_id: 479,
      app_id: 990008,
      product_id: 990107
    });
  }
}

async function startTestApp(imageModelService: FakeImageModelService): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer(
    createAppRequestHandler(testConfig, {
      launchTicketVerifier: new FakeLaunchTicketVerifier(),
      imageModelService
    })
  );

  await listen(server);

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("测试服务监听地址异常");
  }

  const tcpAddress: AddressInfo = address;

  return {
    baseUrl: `http://127.0.0.1:${String(tcpAddress.port)}`,
    close: () => close(server)
  };
}

async function createSessionCookie(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/enter?ticket=valid_ticket`, {
    redirect: "manual"
  });
  const setCookieHeader = response.headers.get("set-cookie");

  if (setCookieHeader === null) {
    throw new Error("测试响应缺少 Set-Cookie");
  }

  return setCookieHeader.split(";")[0] ?? "";
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }

      reject(error);
    });
  });
}

function createModel(gatewayModelCode: string, capability: string, sortOrder: number) {
  return {
    gateway_model_code: gatewayModelCode,
    display_name: gatewayModelCode,
    description: "测试模型",
    capability,
    status: "active" as const,
    quality_tier: "standard",
    supported_task_types: ["text_to_image"],
    supported_image_sizes: ["1024x1024"],
    supported_input_types: ["text"],
    supported_output_types: ["image"],
    max_input_files: 0,
    max_output_count: 1,
    sort_order: sortOrder
  };
}
