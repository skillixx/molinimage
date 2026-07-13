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
  riskControlWindowSeconds: 60,
  riskControlUserLimit: 20,
  riskControlIpLimit: 60,
  riskControlDisabledTaskTypes: [],
  riskControlDisabledCapabilities: [],
  trustProxy: false,
  internalApiToken: "test_internal_token",
  adminUserIds: [479],
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

void test("管理员可打开模型页、同步目录并更新模型配置", async () => {
  const imageModelService = new FakeImageModelService();
  const app = await startTestApp(imageModelService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const pageResponse = await fetch(`${app.baseUrl}/admin/models`, { headers: { cookie } });
    const syncResponse = await fetch(`${app.baseUrl}/api/admin/image/models/sync`, {
      method: "POST",
      headers: { cookie }
    });
    const updateResponse = await fetch(`${app.baseUrl}/api/admin/image/models/model_image_gen`, {
      method: "PATCH",
      headers: {
        cookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        admin_enabled: false,
        capability: "image_generation",
        default_task_types: ["text_to_image"]
      })
    });

    assert.equal(pageResponse.status, 200);
    assert.equal(syncResponse.status, 200);
    assert.equal(updateResponse.status, 200);
    assert.equal(imageModelService.syncUserIds[0], 479);
    assert.equal(imageModelService.updateRequests[0]?.modelId, "model_image_gen");
    assert.deepEqual(imageModelService.updateRequests[0]?.request.defaultTaskTypes, [
      "text_to_image"
    ]);
  } finally {
    await app.close();
  }
});

class FakeImageModelService {
  readonly userIds: number[] = [];
  readonly syncUserIds: number[] = [];
  readonly updateRequests: {
    modelId: string;
    request: {
      adminEnabled?: boolean;
      capability?: string;
      defaultTaskTypes?: string[];
    };
  }[] = [];

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

  listManagedModels() {
    return Promise.resolve({
      items: [createManagedModel()],
      page: 1 as const,
      page_size: 1,
      total: 1
    });
  }

  syncModelCatalog(userId: number) {
    this.syncUserIds.push(userId);

    return Promise.resolve({
      synced: 1,
      total: 1,
      items: [createManagedModel()]
    });
  }

  updateManagedModel(
    modelId: string,
    request: {
      adminEnabled?: boolean;
      capability?: string;
      defaultTaskTypes?: string[];
    }
  ) {
    this.updateRequests.push({ modelId, request });

    return Promise.resolve({ model: createManagedModel() });
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
    default_task_types: [],
    sort_order: sortOrder
  };
}

function createManagedModel() {
  return {
    id: "model_image_gen",
    gateway_model_code: "image-gen-default",
    display_name: "默认图片模型",
    description: "测试模型",
    capability: "image_generation",
    source_capability: "image_generation",
    source_status: "active" as const,
    source_available: true,
    admin_enabled: true,
    quality_tier: "standard",
    supported_task_types: ["text_to_image"],
    supported_image_sizes: ["1024x1024"],
    supported_input_types: ["text"],
    supported_output_types: ["image"],
    max_input_files: 0,
    max_output_count: 1,
    sort_order: 10,
    default_task_types: ["text_to_image"],
    synced_at: "2026-07-11T00:00:00.000Z",
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z"
  };
}
