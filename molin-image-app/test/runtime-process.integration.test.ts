import "dotenv/config";

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { loadAppConfig } from "../src/config/app-config.js";
import { createRedisConnection } from "../src/infrastructure/redis/redis-connection.js";
import { createRedisSessionKey } from "../src/modules/auth/redis-session-store.js";

const runProcessIntegrationTest =
  process.env.RUN_QUEUE_INTEGRATION_TESTS === "true" ? test : test.skip;

void runProcessIntegrationTest(
  "两个独立 API 进程共享 Redis Session，实例重启后会话仍有效",
  { timeout: 30_000 },
  async () => {
    const baseConfig = loadAppConfig(process.env);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const molingServer = await startFakeMolingServer({
      user_id: 479,
      app_id: baseConfig.molingAppId,
      product_id: baseConfig.molingProductId,
      entitlement_id: 990311
    });
    const firstPort = await reservePort();
    let secondPort = await reservePort();
    while (secondPort === firstPort) {
      // Windows 可能连续复用刚释放的临时端口，两个 API 实例必须显式使用不同端口。
      secondPort = await reservePort();
    }
    const redisKeyPrefix = `molinimage-g09-process-${suffix}`;
    const sharedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      APP_ENV: "test",
      APP_BASE_URL: `http://127.0.0.1:${String(firstPort)}`,
      MOLING_API_BASE_URL: molingServer.baseUrl,
      REDIS_KEY_PREFIX: redisKeyPrefix,
      SESSION_STORE: "redis",
      SESSION_COOKIE_SECURE: "false",
      SESSION_TTL_SECONDS: "30",
      // Session 多进程验收不启动 Outbox，避免隔离测试误扫描共享数据库中的其他任务。
      IMAGE_TASK_EXECUTION_MODE: "inline"
    };
    let appA: ChildProcess | undefined;
    let appB: ChildProcess | undefined;
    let restartedA: ChildProcess | undefined;
    let sessionToken: string | undefined;

    try {
      appA = startApiProcess({ ...sharedEnv, PORT: String(firstPort) });
      appB = startApiProcess({
        ...sharedEnv,
        APP_BASE_URL: `http://127.0.0.1:${String(secondPort)}`,
        PORT: String(secondPort)
      });
      assert.notEqual(appA.pid, appB.pid);
      await Promise.all([waitForLive(firstPort, appA), waitForLive(secondPort, appB)]);

      const launchResponse = await fetch(
        `http://127.0.0.1:${String(firstPort)}/enter?ticket=g09_process_ticket`,
        { redirect: "manual" }
      );
      const cookie = readCookieHeader(launchResponse.headers.get("set-cookie"));
      sessionToken = readCookieValue(cookie);
      assert.equal(launchResponse.status, 302);

      const secondInstanceResponse = await fetch(`http://127.0.0.1:${String(secondPort)}/api/me`, {
        headers: { cookie }
      });
      assert.equal(secondInstanceResponse.status, 200);

      await stopProcess(appA);
      appA = undefined;
      restartedA = startApiProcess({ ...sharedEnv, PORT: String(firstPort) });
      await waitForLive(firstPort, restartedA);
      const restartedResponse = await fetch(`http://127.0.0.1:${String(firstPort)}/api/me`, {
        headers: { cookie }
      });
      assert.equal(restartedResponse.status, 200);
    } finally {
      await Promise.allSettled([
        appA === undefined ? Promise.resolve() : stopProcess(appA),
        appB === undefined ? Promise.resolve() : stopProcess(appB),
        restartedA === undefined ? Promise.resolve() : stopProcess(restartedA)
      ]);
      await molingServer.close();

      if (sessionToken !== undefined) {
        const cleanupConfig = loadAppConfig({ ...sharedEnv, PORT: String(firstPort) });
        const redis = createRedisConnection(cleanupConfig, "session", silentLogger);
        await redis.connect();
        await redis.client.del(createRedisSessionKey(cleanupConfig.redisKeyPrefix, sessionToken));
        await redis.close();
      }
    }
  }
);

function startApiProcess(env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(process.execPath, ["dist/src/app/server.js"], {
    cwd: process.cwd(),
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  // 子进程日志只用于防止管道阻塞；失败时也不回显环境路径或第三方端点。
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

async function waitForLive(port: number, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error("G09 API 测试进程提前退出。");
    }

    const response = await fetch(`http://127.0.0.1:${String(port)}/api/health/live`).catch(
      () => undefined
    );
    if (response?.ok === true) {
      return;
    }

    await delay(50);
  }

  throw new Error("等待 G09 API 测试进程启动超时。");
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
  child.kill("SIGTERM");
  const graceful = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);

  if (!graceful) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function startFakeMolingServer(identity: Record<string, number>): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/internal/app-launch/verify") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: identity }));
      return;
    }

    response.writeHead(404).end();
  });
  await listen(server);
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Fake Moling 服务监听失败。");
  }

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () => closeServer(server)
  };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("无法分配 API 测试端口。");
  }

  const port = address.port;
  await closeServer(server);
  return port;
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function closeServer(server: Server): Promise<void> {
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

function readCookieHeader(value: string | null): string {
  if (value === null) {
    throw new Error("API 测试响应缺少 Session Cookie。");
  }

  return value.split(";")[0] ?? "";
}

function readCookieValue(cookie: string): string {
  const separator = cookie.indexOf("=");
  if (separator < 0) {
    throw new Error("API 测试 Session Cookie 格式无效。");
  }

  return decodeURIComponent(cookie.slice(separator + 1));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

const silentLogger = {
  info(): void {
    // 多进程验收禁止输出真实 Redis 端点。
  },
  warn(): void {
    // 多进程验收禁止输出真实 Redis 端点。
  },
  error(): void {
    // 多进程验收禁止输出真实 Redis 端点。
  }
};
