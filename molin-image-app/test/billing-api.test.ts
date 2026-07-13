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
import type { PricingRuleRecord } from "../src/infrastructure/database/pricing-rules-repository.js";
import type { SavePricingRuleRequest } from "../src/modules/billing/pricing-rule-service.js";

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

void test("高清放大计费接口把倍率传给价格规则", async () => {
  const billingService = new FakeBillingService();
  const app = await startTestApp(billingService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/api/billing/estimate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie
      },
      body: JSON.stringify({
        task_type: "upscale",
        image_count: 1,
        upscale_factor: 4
      })
    });
    const body = (await response.json()) as BillingEstimateResult;

    assert.equal(response.status, 200);
    assert.equal(billingService.requests[0]?.upscaleFactor, 4);
    assert.equal(body.upscale_factor, 4);
    assert.equal(body.estimated_points, "8");
  } finally {
    await app.close();
  }
});

void test("价格规则管理接口要求内部令牌并支持创建和禁用规则", async () => {
  const billingService = new FakeBillingService();
  const pricingRuleService = new FakePricingRuleService();
  const app = await startTestApp(billingService, pricingRuleService);

  try {
    const unauthorized = await fetch(`${app.baseUrl}/api/internal/image/pricing-rules`);
    const headers = {
      authorization: "Bearer test_internal_token",
      "content-type": "application/json"
    };
    const created = await fetch(`${app.baseUrl}/api/internal/image/pricing-rules`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        task_type: "text_to_image",
        gateway_capability: "image_generation",
        quality: "hd",
        image_size: "1024x1536",
        usage_type: "image_text_to_image",
        points_per_unit: "10"
      })
    });
    const updated = await fetch(`${app.baseUrl}/api/internal/image/pricing-rules/price_api_001`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ active: false })
    });

    assert.equal(unauthorized.status, 401);
    assert.equal(created.status, 201);
    assert.equal(updated.status, 200);
    assert.equal(pricingRuleService.createRequests[0]?.quality, "hd");
    assert.equal(pricingRuleService.createRequests[0]?.imageSize, "1024x1536");
    assert.equal(pricingRuleService.updateRequests[0]?.request.active, false);
  } finally {
    await app.close();
  }
});

void test("管理员可通过墨灵会话打开价格页面并管理规则", async () => {
  const pricingRuleService = new FakePricingRuleService();
  const app = await startTestApp(new FakeBillingService(), pricingRuleService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const page = await fetch(`${app.baseUrl}/admin/pricing`, { headers: { cookie } });
    const list = await fetch(`${app.baseUrl}/api/admin/image/pricing-rules`, {
      headers: { cookie }
    });

    assert.equal(page.status, 200);
    assert.match(await page.text(), /价格规则管理/);
    assert.equal(list.status, 200);
  } finally {
    await app.close();
  }
});

class FakeBillingService {
  readonly requests: EstimateBillingRequest[] = [];

  estimate(request: EstimateBillingRequest): Promise<BillingEstimateResult> {
    this.requests.push(request);
    const unitPoints = request.taskType === "upscale" ? (request.upscaleFactor === 4 ? 8 : 4) : 6;

    return Promise.resolve({
      task_type: request.taskType,
      usage_type: request.taskType === "upscale" ? "image_upscale" : "image_text_to_image",
      unit: "credits",
      unit_points: String(unitPoints),
      quantity: request.imageCount ?? 1,
      estimated_points: String((request.imageCount ?? 1) * unitPoints),
      upscale_factor: request.upscaleFactor ?? null,
      balance_points: "100",
      enough_balance: true,
      rule_id: null,
      rule_source: "env"
    });
  }
}

class FakePricingRuleService {
  readonly createRequests: SavePricingRuleRequest[] = [];
  readonly updateRequests: { ruleId: string; request: Partial<SavePricingRuleRequest> }[] = [];

  listRules() {
    return Promise.resolve({ items: [], page: 1 as const, page_size: 0, total: 0 });
  }

  createRule(request: SavePricingRuleRequest): Promise<{ rule: PricingRuleRecord }> {
    this.createRequests.push(request);
    return Promise.resolve({ rule: createApiPricingRule("price_api_001", request) });
  }

  updateRule(
    ruleId: string,
    request: Partial<SavePricingRuleRequest>
  ): Promise<{ rule: PricingRuleRecord }> {
    this.updateRequests.push({ ruleId, request });
    return Promise.resolve({
      rule: {
        ...createApiPricingRule(ruleId, defaultApiPricingRequest),
        active: request.active ?? true
      }
    });
  }
}

const defaultApiPricingRequest: SavePricingRuleRequest = {
  taskType: "text_to_image",
  usageType: "image_text_to_image",
  pointsPerUnit: "6"
};

function createApiPricingRule(id: string, request: SavePricingRuleRequest): PricingRuleRecord {
  return {
    id,
    task_type: request.taskType,
    gateway_model_code: request.gatewayModelCode ?? null,
    gateway_capability: request.gatewayCapability ?? null,
    quality: request.quality ?? null,
    image_size: request.imageSize ?? null,
    upscale_factor: request.upscaleFactor ?? null,
    usage_type: request.usageType,
    unit: request.unit ?? "credits",
    points_per_unit: request.pointsPerUnit,
    active: request.active ?? true,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z"
  };
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

async function startTestApp(
  billingService: FakeBillingService,
  pricingRuleService?: FakePricingRuleService
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer(
    createAppRequestHandler(testConfig, {
      launchTicketVerifier: new FakeLaunchTicketVerifier(),
      billingService,
      pricingRuleService
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
