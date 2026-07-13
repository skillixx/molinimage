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
import { MolingTicketError } from "../src/infrastructure/moling/moling-client.js";
import { InMemorySessionStore } from "../src/modules/auth/session-store.js";

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
  sessionCookieName: "molinimage_session",
  sessionCookieSecure: false,
  sessionTtlSeconds: 86400,
  port: 0
};

void test("合法 ticket 可以创建 session，并通过 /api/me 读取当前用户", async () => {
  const app = await startTestApp(new FakeLaunchTicketVerifier("valid_ticket", validIdentity));

  try {
    const launchResponse = await fetch(`${app.baseUrl}/enter?ticket=valid_ticket`, {
      redirect: "manual"
    });
    const cookie = launchResponse.headers.get("set-cookie");

    assert.equal(launchResponse.status, 302);
    assert.equal(launchResponse.headers.get("location"), "/");
    assert.match(cookie ?? "", /molinimage_session=/);
    assert.doesNotMatch(cookie ?? "", /valid_ticket/);

    const meResponse = await fetch(`${app.baseUrl}/api/me`, {
      headers: {
        cookie: readCookieHeader(cookie)
      }
    });
    const meBody = (await meResponse.json()) as Record<string, unknown>;

    assert.equal(meResponse.status, 200);
    assert.equal(meBody.user_id, 479);
    assert.equal(meBody.app_id, 990008);
    assert.equal(meBody.product_id, 990107);
    assert.equal(meBody.entitlement_id, 990311);
  } finally {
    await app.close();
  }
});

void test("根路径携带 ticket 时同样可以创建 session", async () => {
  const app = await startTestApp(new FakeLaunchTicketVerifier("root_ticket", validIdentity));

  try {
    const launchResponse = await fetch(`${app.baseUrl}/?ticket=root_ticket`, {
      redirect: "manual"
    });

    assert.equal(launchResponse.status, 302);
    assert.match(launchResponse.headers.get("set-cookie") ?? "", /molinimage_session=/);
  } finally {
    await app.close();
  }
});

void test("缺少 ticket 的入口返回明确错误", async () => {
  const app = await startTestApp(new FakeLaunchTicketVerifier("unused", validIdentity));

  try {
    const response = await fetch(`${app.baseUrl}/enter`);
    const body = (await response.json()) as { error?: { code?: string; request_id?: string } };

    assert.equal(response.status, 400);
    assert.ok(body.error);
    assert.equal(body.error.code, "LAUNCH_TICKET_REQUIRED");
    assert.equal(body.error.request_id, response.headers.get("x-request-id"));
  } finally {
    await app.close();
  }
});

void test("无效 ticket 被拒绝，且不能创建 session", async () => {
  const app = await startTestApp(new FakeLaunchTicketVerifier("valid_ticket", validIdentity));

  try {
    const response = await fetch(`${app.baseUrl}/enter?ticket=bad_ticket`, {
      redirect: "manual"
    });
    const body = (await response.json()) as { error?: { code?: string } };

    assert.equal(response.status, 401);
    assert.equal(body.error?.code, "LAUNCH_TICKET_INVALID");
    assert.equal(response.headers.get("set-cookie"), null);
  } finally {
    await app.close();
  }
});

void test("ticket 绑定的 app 或 product 不匹配时拒绝进入", async () => {
  const app = await startTestApp(
    new FakeLaunchTicketVerifier("mismatch_ticket", {
      ...validIdentity,
      product_id: 1
    })
  );

  try {
    const response = await fetch(`${app.baseUrl}/enter?ticket=mismatch_ticket`, {
      redirect: "manual"
    });
    const body = (await response.json()) as { error?: { code?: string } };

    assert.equal(response.status, 403);
    assert.equal(body.error?.code, "LAUNCH_APP_MISMATCH");
  } finally {
    await app.close();
  }
});

void test("可选 entitlement_id 无效时不阻断合法 ticket 建立 session", async () => {
  const app = await startTestApp(
    new FakeLaunchTicketVerifier("valid_ticket", {
      ...validIdentity,
      entitlement_id: undefined
    })
  );

  try {
    const launchResponse = await fetch(`${app.baseUrl}/enter?ticket=valid_ticket`, {
      redirect: "manual"
    });
    const meResponse = await fetch(`${app.baseUrl}/api/me`, {
      headers: {
        cookie: readCookieHeader(launchResponse.headers.get("set-cookie"))
      }
    });
    const meBody = (await meResponse.json()) as Record<string, unknown>;

    assert.equal(launchResponse.status, 302);
    assert.equal(meBody.entitlement_id, null);
  } finally {
    await app.close();
  }
});

void test("登出后当前 session 失效", async () => {
  const app = await startTestApp(new FakeLaunchTicketVerifier("valid_ticket", validIdentity));

  try {
    const launchResponse = await fetch(`${app.baseUrl}/enter?ticket=valid_ticket`, {
      redirect: "manual"
    });
    const cookieHeader = readCookieHeader(launchResponse.headers.get("set-cookie"));
    const logoutResponse = await fetch(`${app.baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: {
        cookie: cookieHeader
      }
    });
    const meResponse = await fetch(`${app.baseUrl}/api/me`, {
      headers: {
        cookie: cookieHeader
      }
    });

    assert.equal(logoutResponse.status, 200);
    assert.match(logoutResponse.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal(meResponse.status, 401);
  } finally {
    await app.close();
  }
});

const validIdentity: MolingLaunchIdentity = {
  user_id: 479,
  app_id: 990008,
  product_id: 990107,
  entitlement_id: 990311
};

class FakeLaunchTicketVerifier implements LaunchTicketVerifier {
  constructor(
    private readonly validTicket: string,
    private readonly identity: MolingLaunchIdentity
  ) {}

  verifyLaunchTicket(ticket: string): Promise<MolingLaunchIdentity> {
    if (ticket !== this.validTicket) {
      // 测试替身模拟墨灵一次性票据失败，业务层只关心稳定的公开错误码。
      throw new MolingTicketError(
        "LAUNCH_TICKET_INVALID",
        "票据无效、已过期或已被使用，请从墨灵平台重新进入应用。"
      );
    }

    return Promise.resolve(this.identity);
  }
}

async function startTestApp(launchTicketVerifier: LaunchTicketVerifier): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer(
    createAppRequestHandler(testConfig, {
      launchTicketVerifier,
      sessionStore: new InMemorySessionStore()
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

function readCookieHeader(setCookieHeader: string | null): string {
  if (setCookieHeader === null) {
    throw new Error("测试响应缺少 Set-Cookie");
  }

  return setCookieHeader.split(";")[0] ?? "";
}
