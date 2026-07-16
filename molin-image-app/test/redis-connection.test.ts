import assert from "node:assert/strict";
import test from "node:test";

import {
  createBullMqRedisConnection,
  createRedisConnection,
  describeRedisEndpoint,
  RedisConnectionError,
  type RedisConnectionLogger
} from "../src/infrastructure/redis/redis-connection.js";
import {
  checkRedisHealth,
  RedisHealthCheckError
} from "../src/infrastructure/redis/redis-health-check.js";

const redisConfig = {
  redisUrl: "redis://127.0.0.1:6379/0",
  redisConnectTimeoutMs: 100,
  redisCommandTimeoutMs: 100,
  redisMaxRetriesPerRequest: 3
};

class MemoryRedisLogger implements RedisConnectionLogger {
  readonly messages: string[] = [];

  info(message: string): void {
    this.messages.push(message);
  }

  warn(message: string): void {
    this.messages.push(message);
  }

  error(message: string): void {
    this.messages.push(message);
  }
}

void test("合法 Redis URL 可以创建普通连接且重复关闭安全", async () => {
  const connection = createRedisConnection(redisConfig, "api", new MemoryRedisLogger());

  assert.equal(connection.client.status, "wait");
  assert.equal(connection.client.options.maxRetriesPerRequest, 3);
  assert.equal(connection.endpoint, "redis://127.*.*.1:6379/0");

  await connection.close();
  await connection.close();
  assert.equal(connection.client.status, "end");
});

void test("BullMQ 专用连接关闭单请求重试上限并限制重连速度", async () => {
  const connection = createBullMqRedisConnection(redisConfig, "worker", new MemoryRedisLogger());
  const retryStrategy = connection.client.options.retryStrategy;

  assert.equal(connection.client.options.maxRetriesPerRequest, null);
  assert.equal(typeof retryStrategy, "function");

  if (typeof retryStrategy !== "function") {
    assert.fail("BullMQ Redis 连接必须配置重连退避策略");
  }

  assert.equal(retryStrategy(1), 250);
  assert.equal(retryStrategy(100), 5000);

  await connection.close();
});

void test("连接日志不会包含 Redis 密码、用户名和完整主机", async () => {
  const logger = new MemoryRedisLogger();
  const connection = createRedisConnection(
    {
      ...redisConfig,
      redisUrl: "redis://redis_user:replace_secret@redis.internal.example:6380/2"
    },
    "api",
    logger
  );

  await connection.close();
  const output = logger.messages.join("\n");

  assert.doesNotMatch(output, /replace_secret/);
  assert.doesNotMatch(output, /redis_user/);
  assert.doesNotMatch(output, /redis\.internal\.example/);
  assert.match(output, /redis:\/\/r\*\*\*e:6380\/2/);
});

void test("Redis URL 非法时返回明确中文错误", () => {
  assert.throws(
    () => describeRedisEndpoint("http://127.0.0.1:6379/0"),
    (error: unknown) =>
      error instanceof RedisConnectionError && error.message.includes("redis:// 或 rediss://")
  );
});

void test("Redis 服务不可达时连接工厂返回稳定中文错误", async () => {
  const connection = createRedisConnection(
    {
      ...redisConfig,
      redisUrl: "redis://127.0.0.1:1/0",
      redisMaxRetriesPerRequest: 0
    },
    "api",
    new MemoryRedisLogger()
  );

  try {
    await assert.rejects(
      connection.connect(),
      (error: unknown) =>
        error instanceof RedisConnectionError &&
        error.message === "Redis 连接失败，请检查服务状态（redis://127.*.*.1:1/0）"
    );
  } finally {
    await connection.close();
  }
});

void test("Redis 不可达时健康检查返回稳定中文错误", async () => {
  await assert.rejects(
    checkRedisHealth({
      client: {
        ping(): Promise<string> {
          return Promise.reject(new Error("connect ECONNREFUSED redis://user:password@host"));
        }
      }
    }),
    (error: unknown) =>
      error instanceof RedisHealthCheckError &&
      error.message === "Redis 健康检查失败，请检查服务连接"
  );
});

void test("Redis PING 成功时返回健康状态和延迟", async () => {
  const result = await checkRedisHealth({
    client: {
      ping(): Promise<string> {
        return Promise.resolve("PONG");
      }
    }
  });

  assert.equal(result.status, "ok");
  assert.ok(result.latency_ms >= 0);
});
