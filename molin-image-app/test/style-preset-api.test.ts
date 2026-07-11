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
import type { SaveStylePresetRequest } from "../src/modules/style-presets/style-preset-service.js";

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
  adminUserIds: [479],
  sessionCookieName: "molinimage_session",
  sessionCookieSecure: false,
  sessionTtlSeconds: 86400,
  port: 0
};

void test("风格模板用户接口必须登录，并只返回启用模板", async () => {
  const stylePresetService = new FakeStylePresetService();
  const app = await startTestApp(stylePresetService);

  try {
    const unauthorizedResponse = await fetch(`${app.baseUrl}/api/image/style-presets`);
    const cookie = await createSessionCookie(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/api/image/style-presets?task_type=text_to_image`, {
      headers: { cookie }
    });
    const body = (await response.json()) as { items: { id: string; enabled: boolean }[] };

    assert.equal(unauthorizedResponse.status, 401);
    assert.equal(response.status, 200);
    assert.deepEqual(
      body.items.map((item) => item.id),
      ["style_product"]
    );
    assert.equal(body.items[0]?.enabled, true);
    assert.equal(stylePresetService.visibleTaskTypes[0], "text_to_image");
  } finally {
    await app.close();
  }
});

void test("管理员可打开风格模板页、创建模板并停用模板", async () => {
  const stylePresetService = new FakeStylePresetService();
  const app = await startTestApp(stylePresetService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const pageResponse = await fetch(`${app.baseUrl}/admin/styles`, { headers: { cookie } });
    const createResponse = await fetch(`${app.baseUrl}/api/admin/image/style-presets`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name: "商品海报",
        category: "product",
        task_type: "text_to_image",
        prompt_template: "商业摄影风格",
        preview_image_url: "https://example.com/product.jpg",
        enabled: true,
        sort_order: 10
      })
    });
    const updateResponse = await fetch(
      `${app.baseUrl}/api/admin/image/style-presets/style_product`,
      {
        method: "PATCH",
        headers: {
          cookie,
          "content-type": "application/json"
        },
        body: JSON.stringify({ enabled: false })
      }
    );

    assert.equal(pageResponse.status, 200);
    assert.equal(createResponse.status, 201);
    assert.equal(updateResponse.status, 200);
    assert.equal(stylePresetService.createRequests[0]?.promptTemplate, "商业摄影风格");
    assert.deepEqual(stylePresetService.updateRequests[0], {
      presetId: "style_product",
      request: { enabled: false }
    });
  } finally {
    await app.close();
  }
});

class FakeStylePresetService {
  readonly visibleTaskTypes: (string | undefined)[] = [];
  readonly createRequests: SaveStylePresetRequest[] = [];
  readonly updateRequests: {
    presetId: string;
    request: Partial<SaveStylePresetRequest>;
  }[] = [];

  listVisiblePresets(taskType?: string) {
    this.visibleTaskTypes.push(taskType);

    return Promise.resolve({
      items: [createPreset("style_product", true)],
      page: 1 as const,
      page_size: 1,
      total: 1
    });
  }

  listManagedPresets() {
    return Promise.resolve({
      items: [createPreset("style_product", true), createPreset("style_disabled", false)],
      page: 1 as const,
      page_size: 2,
      total: 2
    });
  }

  createPreset(request: SaveStylePresetRequest) {
    this.createRequests.push(request);

    return Promise.resolve({ preset: createPreset("style_created", request.enabled !== false) });
  }

  updatePreset(presetId: string, request: Partial<SaveStylePresetRequest>) {
    this.updateRequests.push({ presetId, request });

    return Promise.resolve({ preset: createPreset(presetId, request.enabled !== false) });
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

async function startTestApp(stylePresetService: FakeStylePresetService): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer(
    createAppRequestHandler(testConfig, {
      launchTicketVerifier: new FakeLaunchTicketVerifier(),
      stylePresetService
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

function createPreset(id: string, enabled: boolean) {
  return {
    id,
    name: id,
    category: "product",
    task_type: "text_to_image",
    prompt_template: "商业摄影风格",
    preview_image_file_id: null,
    preview_image_url: "https://example.com/product.jpg",
    enabled,
    sort_order: 10,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z"
  };
}
