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
import type {
  BillingEstimateResult,
  EstimateBillingRequest
} from "../src/modules/billing/billing-service.js";

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

void test("计费估算接口必须登录，并按当前用户估算积分", async () => {
  const billingService = new FakeBillingService();
  const app = await startTestApp(billingService);

  try {
    const unauthorizedResponse = await fetch(`${app.baseUrl}/api/billing/estimate`, {
      method: "POST",
      body: "{}"
    });
    const cookie = await createSessionCookie(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/api/billing/estimate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie
      },
      body: JSON.stringify({
        task_type: "text_to_image",
        image_count: 3,
        image_size: "1024x1024"
      })
    });
    const body = (await response.json()) as BillingEstimateResult;

    assert.equal(unauthorizedResponse.status, 401);
    assert.equal(response.status, 200);
    assert.equal(billingService.requests[0]?.ownerUserId, 479);
    assert.equal(billingService.requests[0]?.imageCount, 3);
    assert.equal(body.estimated_points, "18");
    assert.equal(body.enough_balance, true);
  } finally {
    await app.close();
  }
});

class FakeBillingService {
  readonly requests: EstimateBillingRequest[] = [];

  estimate(request: EstimateBillingRequest): BillingEstimateResult {
    this.requests.push(request);

    return {
      task_type: request.taskType,
      usage_type: "image_text_to_image",
      unit: "credits",
      unit_points: "6",
      quantity: request.imageCount ?? 1,
      estimated_points: String((request.imageCount ?? 1) * 6),
      balance_points: "100",
      enough_balance: true,
      rule_source: "env"
    };
  }
}

class FakeLaunchTicketVerifier implements LaunchTicketVerifier {
  verifyLaunchTicket(): Promise<MolingLaunchIdentity> {
    return Promise.resolve({
      user_id: 479,
      app_id: 990008,
      product_id: 990107,
      entitlement_id: 62
    });
  }
}

async function startTestApp(billingService: FakeBillingService): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer(
    createAppRequestHandler(testConfig, {
      launchTicketVerifier: new FakeLaunchTicketVerifier(),
      billingService
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
