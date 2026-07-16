import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { createAppRequestHandler } from "../src/app/create-app.js";
import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";
import type {
  LaunchTicketVerifier,
  MolingLaunchIdentity
} from "../src/infrastructure/moling/moling-client.js";
import { createRedisConnection } from "../src/infrastructure/redis/redis-connection.js";
import {
  createRedisSessionKey,
  RedisSessionStore
} from "../src/modules/auth/redis-session-store.js";

const runRedisIntegrationTest =
  process.env.RUN_REDIS_INTEGRATION_TESTS === "true" ? test : test.skip;

void runRedisIntegrationTest(
  "真实 Redis 支持多实例、重启、TTL、注销和 ticket 脱敏",
  { timeout: 30_000 },
  async () => {
    const baseConfig = loadAppConfig(process.env);
    const testPrefix = `${baseConfig.redisKeyPrefix}:g03:${randomUUID()}`;
    const config: AppConfig = {
      ...baseConfig,
      appBaseUrl: "http://127.0.0.1",
      redisKeyPrefix: testPrefix,
      sessionStore: "redis",
      sessionCookieSecure: false,
      sessionTtlSeconds: 30,
      port: 0
    };
    const silentLogger = {
      info(): void {
        // 集成测试禁止输出真实 Redis 端点。
      },
      warn(): void {
        // 集成测试禁止输出真实 Redis 端点。
      },
      error(): void {
        // 集成测试禁止输出真实 Redis 端点。
      }
    };
    const connectionA = createRedisConnection(config, "session", silentLogger);
    const connectionB = createRedisConnection(config, "session", silentLogger);
    let appA: TestApp | undefined;
    let appB: TestApp | undefined;
    let appAfterRestart: TestApp | undefined;
    let sessionToken: string | undefined;

    try {
      await Promise.all([connectionA.connect(), connectionB.connect()]);

      const storeA = new RedisSessionStore(connectionA.client, config, silentLogger);
      const storeB = new RedisSessionStore(connectionB.client, config, silentLogger);
      const verifier = new FixedLaunchTicketVerifier(validIdentity);
      appA = await startTestApp(config, verifier, storeA);
      appB = await startTestApp(config, verifier, storeB);

      const launchResponse = await fetch(`${appA.baseUrl}/enter?ticket=one_time_launch_ticket`, {
        redirect: "manual"
      });
      const cookie = readCookieHeader(launchResponse.headers.get("set-cookie"));
      sessionToken = readCookieValue(cookie);

      assert.equal(launchResponse.status, 302);

      const secondInstanceResponse = await fetch(`${appB.baseUrl}/api/me`, {
        headers: { cookie }
      });
      assert.equal(secondInstanceResponse.status, 200);

      const redisPayload = await connectionA.client.get(
        createRedisSessionKey(testPrefix, sessionToken)
      );
      assert.ok(redisPayload);
      assert.doesNotMatch(redisPayload, /one_time_launch_ticket/iu);

      // 关闭首个 HTTP 实例后重新创建处理器，验证会话事实保存在 Redis 而不是进程内存。
      await appA.close();
      appA = undefined;
      appAfterRestart = await startTestApp(config, verifier, storeA);
      const restartedResponse = await fetch(`${appAfterRestart.baseUrl}/api/me`, {
        headers: { cookie }
      });
      assert.equal(restartedResponse.status, 200);

      const logoutResponse = await fetch(`${appB.baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { cookie }
      });
      assert.equal(logoutResponse.status, 200);
      assert.equal(await storeA.getSession(sessionToken), undefined);

      const shortLived = await storeA.createSession(validIdentity, 1);
      assert.ok(await storeB.getSession(shortLived.token));
      await delay(1_500);
      assert.equal(await storeB.getSession(shortLived.token), undefined);
      assert.equal(
        await connectionA.client.exists(createRedisSessionKey(testPrefix, shortLived.token)),
        0
      );
    } finally {
      if (sessionToken !== undefined) {
        await connectionA.client
          .del(createRedisSessionKey(testPrefix, sessionToken))
          .catch(() => undefined);
      }
      await Promise.allSettled([
        appA?.close(),
        appB?.close(),
        appAfterRestart?.close(),
        connectionA.close(),
        connectionB.close()
      ]);
    }
  }
);

const validIdentity: MolingLaunchIdentity = {
  user_id: 479,
  app_id: 990008,
  product_id: 990107,
  entitlement_id: 990311
};

class FixedLaunchTicketVerifier implements LaunchTicketVerifier {
  constructor(private readonly identity: MolingLaunchIdentity) {}

  verifyLaunchTicket(): Promise<MolingLaunchIdentity> {
    return Promise.resolve(this.identity);
  }
}

interface TestApp {
  baseUrl: string;
  close(): Promise<void>;
}

async function startTestApp(
  config: AppConfig,
  launchTicketVerifier: LaunchTicketVerifier,
  sessionStore: RedisSessionStore
): Promise<TestApp> {
  const server = createServer(
    createAppRequestHandler(config, { launchTicketVerifier, sessionStore })
  );

  await listen(server);
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("测试服务监听地址异常");
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
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
  if (!server.listening) {
    return;
  }

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

function readCookieValue(cookieHeader: string): string {
  const separatorIndex = cookieHeader.indexOf("=");

  if (separatorIndex < 0) {
    throw new Error("测试 Cookie 格式无效");
  }

  return decodeURIComponent(cookieHeader.slice(separatorIndex + 1));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
