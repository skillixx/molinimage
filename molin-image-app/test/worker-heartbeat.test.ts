import assert from "node:assert/strict";
import test from "node:test";

import {
  RedisWorkerHeartbeat,
  RedisWorkerHeartbeatReader
} from "../src/infrastructure/redis/worker-heartbeat.js";

void test("Worker 心跳使用短 TTL 并可被 API 读取", async () => {
  const redis = new FakeHeartbeatRedis();
  const heartbeat = new RedisWorkerHeartbeat(redis, "molinimage:test:worker:heartbeat", {
    workerId: "worker_test_001",
    ttlSeconds: 15,
    intervalMs: 5_000
  });

  await heartbeat.start();

  assert.equal(redis.values.get(`${redis.baseKey}:worker_test_001`), "worker_test_001");
  assert.equal(redis.ttlSeconds, 15);
  assert.equal(await new RedisWorkerHeartbeatReader(redis, redis.baseKey).isAlive(), true);
  await heartbeat.stop();
  assert.equal(await new RedisWorkerHeartbeatReader(redis, redis.baseKey).isAlive(), false);
});

void test("一个 Worker 退出不会把其他在线 Worker 误报为离线", async () => {
  const redis = new FakeHeartbeatRedis();
  const first = createHeartbeat(redis, "worker_first");
  const second = createHeartbeat(redis, "worker_second");
  const reader = new RedisWorkerHeartbeatReader(redis, redis.baseKey);

  await first.start();
  await second.start();
  await first.stop();

  assert.equal(await reader.isAlive(), true);
  await second.stop();
  assert.equal(await reader.isAlive(), false);
});

void test("清理过期注册项失败时仍识别其他在线 Worker", async () => {
  const redis = new FakeHeartbeatRedis();
  const heartbeat = createHeartbeat(redis, "worker_online");
  await heartbeat.start();
  await redis.sadd(`${redis.baseKey}:registry`, "worker_stale");
  redis.failCleanup = true;

  assert.equal(await new RedisWorkerHeartbeatReader(redis, redis.baseKey).isAlive(), true);
  redis.failCleanup = false;
  await heartbeat.stop();
});

class FakeHeartbeatRedis {
  readonly baseKey = "molinimage:test:worker:heartbeat";
  readonly values = new Map<string, string>();
  readonly registries = new Map<string, Set<string>>();
  ttlSeconds = 0;
  failCleanup = false;

  set(key: string, value: string, _mode: "EX", ttlSeconds: number): Promise<"OK"> {
    this.values.set(key, value);
    this.ttlSeconds = ttlSeconds;
    return Promise.resolve("OK");
  }

  sadd(key: string, member: string): Promise<number> {
    const members = this.registries.get(key) ?? new Set<string>();
    members.add(member);
    this.registries.set(key, members);
    return Promise.resolve(1);
  }

  smembers(key: string): Promise<string[]> {
    return Promise.resolve([...(this.registries.get(key) ?? [])]);
  }

  mget(...keys: string[]): Promise<(string | null)[]> {
    return Promise.resolve(keys.map((key) => this.values.get(key) ?? null));
  }

  srem(key: string, ...members: string[]): Promise<number> {
    if (this.failCleanup) {
      return Promise.reject(new Error("模拟注册表清理失败"));
    }

    const registered = this.registries.get(key);
    let removed = 0;

    for (const member of members) {
      removed += registered?.delete(member) === true ? 1 : 0;
    }

    return Promise.resolve(removed);
  }

  eval(_script: string, _keyCount: number, key: string, workerId: string): Promise<number> {
    if (this.values.get(key) === workerId) {
      this.values.delete(key);
      return Promise.resolve(1);
    }

    return Promise.resolve(0);
  }
}

function createHeartbeat(redis: FakeHeartbeatRedis, workerId: string): RedisWorkerHeartbeat {
  return new RedisWorkerHeartbeat(redis, redis.baseKey, {
    workerId,
    ttlSeconds: 15,
    intervalMs: 5_000
  });
}
