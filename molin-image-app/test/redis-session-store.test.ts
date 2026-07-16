import assert from "node:assert/strict";
import test from "node:test";

import {
  createRedisSessionKey,
  RedisSessionStore,
  type RedisSessionClient,
  type RedisSessionLogger
} from "../src/modules/auth/redis-session-store.js";
import { SessionStoreError } from "../src/modules/auth/session-store.js";

const identity = {
  user_id: 479,
  app_id: 990008,
  product_id: 990107,
  entitlement_id: 990311
};

void test("Redis Session 使用 Token 哈希 Key 并按秒设置 TTL", async () => {
  const client = new FakeRedisSessionClient();
  const store = new RedisSessionStore(client, { redisKeyPrefix: "molinimage:test" });
  const created = await store.createSession(identity, 120);
  const expectedKey = createRedisSessionKey("molinimage:test", created.token);

  assert.match(expectedKey, /^molinimage:test:session:[a-f0-9]{64}$/u);
  assert.equal(expectedKey.includes(created.token), false);
  assert.equal(client.lastSet?.key, expectedKey);
  assert.equal(client.lastSet.expirationMode, "EX");
  assert.equal(client.lastSet.ttlSeconds, 120);
  assert.doesNotMatch(client.lastSet.value, /launch_ticket|one_time_ticket/iu);
});

void test("共享 Redis 的两个 Store 可以读取同一会话", async () => {
  const client = new FakeRedisSessionClient();
  const writer = new RedisSessionStore(client, { redisKeyPrefix: "molinimage:test" });
  const reader = new RedisSessionStore(client, { redisKeyPrefix: "molinimage:test" });
  const created = await writer.createSession(identity, 60);

  assert.deepEqual(await reader.getSession(created.token), created.session);
});

void test("损坏或字段非法的 Redis Session 按未登录处理并删除", async () => {
  const client = new FakeRedisSessionClient();
  const logger = new RecordingLogger();
  const store = new RedisSessionStore(client, { redisKeyPrefix: "molinimage:test" }, logger);
  const token = "sensitive_session_token";
  const key = createRedisSessionKey("molinimage:test", token);

  client.values.set(key, "{invalid-json");
  assert.equal(await store.getSession(token), undefined);
  assert.equal(client.values.has(key), false);
  assert.equal(logger.messages.length, 1);
  assert.doesNotMatch(
    logger.messages.join(" "),
    /sensitive_session_token|invalid-json|redis:\/\//iu
  );

  client.values.set(key, JSON.stringify({ user_id: 0, expires_at: "invalid" }));
  assert.equal(await store.getSession(token), undefined);
  assert.equal(client.values.has(key), false);
});

void test("应用层到期校验会拒绝并清理过期 Session", async () => {
  const client = new FakeRedisSessionClient();
  const store = new RedisSessionStore(client, { redisKeyPrefix: "molinimage:test" });
  const token = "expired_session_token";
  const key = createRedisSessionKey("molinimage:test", token);

  client.values.set(
    key,
    JSON.stringify({
      ...identity,
      session_id: "expired_session",
      created_at: new Date(Date.now() - 120_000).toISOString(),
      expires_at: new Date(Date.now() - 60_000).toISOString()
    })
  );

  assert.equal(await store.getSession(token), undefined);
  assert.equal(client.values.has(key), false);
});

void test("删除 Session 后立即失效", async () => {
  const client = new FakeRedisSessionClient();
  const store = new RedisSessionStore(client, { redisKeyPrefix: "molinimage:test" });
  const created = await store.createSession(identity, 60);

  await store.deleteSession(created.token);

  assert.equal(await store.getSession(created.token), undefined);
});

void test("Redis 命令错误统一封装且不泄露敏感信息", async () => {
  const error = new Error("redis://user:password@secret-host/session-token");
  const client = new FailingRedisSessionClient(error);
  const store = new RedisSessionStore(client, { redisKeyPrefix: "molinimage:test" });

  await assert.rejects(store.createSession(identity, 60), assertSafeSessionStoreError);
  await assert.rejects(store.getSession("session-token"), assertSafeSessionStoreError);
  await assert.rejects(store.deleteSession("session-token"), assertSafeSessionStoreError);
});

class FakeRedisSessionClient implements RedisSessionClient {
  readonly values = new Map<string, string>();
  lastSet: { key: string; value: string; expirationMode: "EX"; ttlSeconds: number } | undefined;

  set(key: string, value: string, expirationMode: "EX", ttlSeconds: number): Promise<"OK"> {
    this.lastSet = { key, value, expirationMode, ttlSeconds };
    this.values.set(key, value);
    return Promise.resolve("OK");
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.values.delete(key) ? 1 : 0);
  }
}

class FailingRedisSessionClient implements RedisSessionClient {
  constructor(private readonly error: Error) {}

  set(): Promise<"OK"> {
    return Promise.reject(this.error);
  }

  get(): Promise<string | null> {
    return Promise.reject(this.error);
  }

  del(): Promise<number> {
    return Promise.reject(this.error);
  }
}

class RecordingLogger implements RedisSessionLogger {
  readonly messages: string[] = [];

  warn(message: string): void {
    this.messages.push(message);
  }
}

function assertSafeSessionStoreError(error: unknown): boolean {
  assert.ok(error instanceof SessionStoreError);
  assert.equal(error.code, "SESSION_STORE_UNAVAILABLE");
  assert.equal(error.message, "会话服务暂不可用，请稍后重试。");
  assert.doesNotMatch(error.message, /password|secret-host|session-token|redis:\/\//iu);
  return true;
}
