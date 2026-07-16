import assert from "node:assert/strict";
import test from "node:test";

import {
  HealthService,
  createHealthResponse,
  type HealthDependencyProbe,
  type QueueMonitoringSnapshot
} from "../src/modules/health/health.service.js";

void test("存活检查不访问外部依赖", () => {
  assert.deepEqual(createHealthResponse(), {
    status: "ok",
    service: "molin-image-app"
  });
});

void test("就绪检查返回依赖、队列、Outbox 和 Worker 状态", async () => {
  const service = createHealthService();

  const response = await service.getReadiness();

  assert.equal(response.status, "ok");
  assert.deepEqual(response.dependencies, {
    mysql: "ok",
    redis: "ok",
    minio: "ok",
    queue: "ok"
  });
  assert.deepEqual(response.queue, {
    waiting: 2,
    active: 1,
    delayed: 0,
    failed: 0,
    oldest_wait_ms: 1_000
  });
  assert.deepEqual(response.outbox, {
    backlog: 1,
    dead_letter: 0,
    oldest_wait_ms: 500
  });
  assert.deepEqual(response.worker, { status: "ok" });
  assert.deepEqual(response.alerts, []);
});

void test("Redis 断开时 readiness 失败且不暴露内部错误", async () => {
  const service = createHealthService({
    redisProbe: new FakeProbe(new Error("redis://user:secret@private-host:6379/0"))
  });

  const response = await service.getReadiness();
  const serialized = JSON.stringify(response);

  assert.equal(response.status, "error");
  assert.equal(response.dependencies.redis, "error");
  assert.doesNotMatch(serialized, /secret|private-host|stack/iu);
});

void test("Worker 全部离线时 readiness 失败并产生告警", async () => {
  const service = createHealthService({ workerAlive: false });

  const response = await service.getReadiness();

  assert.equal(response.status, "error");
  assert.deepEqual(response.worker, { status: "offline" });
  assert.equal(
    response.alerts.some((alert) => alert.code === "IMAGE_WORKER_OFFLINE"),
    true
  );
});

void test("Outbox 指标查询失败时 readiness 失败且不输出数据库错误", async () => {
  const service = new HealthService(
    {
      mysql: new FakeProbe(),
      redis: new FakeProbe(),
      minio: new FakeProbe(),
      queue: {
        checkWrite: () => Promise.resolve(),
        getSnapshot: () =>
          Promise.resolve({
            waiting: 0,
            active: 0,
            delayed: 0,
            failed: 0,
            oldest_wait_ms: 0
          })
      },
      worker: { isAlive: () => Promise.resolve(true) },
      outbox: {
        getSnapshot: () => Promise.reject(new Error("mysql://user:secret@private-host"))
      }
    },
    {
      sessionStore: "redis",
      queueEnabled: true,
      queueBacklogAlertThreshold: 10,
      queueOldestWaitAlertMs: 60_000,
      outboxBacklogAlertThreshold: 5
    }
  );

  const response = await service.getReadiness();

  assert.equal(response.status, "error");
  assert.doesNotMatch(JSON.stringify(response), /secret|private-host/iu);
});

void test("队列持续积压和 Outbox 死信会产生脱敏告警", async () => {
  const service = createHealthService({
    queueSnapshot: {
      waiting: 12,
      active: 1,
      delayed: 2,
      failed: 3,
      oldest_wait_ms: 90_000
    },
    outboxSnapshot: { backlog: 8, dead_letter: 2, oldest_wait_ms: 120_000 }
  });

  const response = await service.getReadiness();

  assert.equal(response.status, "degraded");
  assert.equal(
    response.alerts.some((alert) => alert.code === "IMAGE_QUEUE_BACKLOG"),
    true
  );
  assert.equal(
    response.alerts.some((alert) => alert.code === "IMAGE_OUTBOX_BACKLOG"),
    true
  );
  assert.equal(
    response.alerts.some((alert) => alert.code === "IMAGE_OUTBOX_DEAD_LETTER"),
    true
  );
});

void test("依赖探针超时会及时返回失败", async () => {
  let mysqlChecks = 0;
  const service = new HealthService(
    {
      mysql: {
        check: () => {
          mysqlChecks += 1;
          return new Promise<void>(() => undefined);
        }
      },
      redis: new FakeProbe(),
      minio: new FakeProbe()
    },
    {
      sessionStore: "memory",
      queueEnabled: false,
      queueBacklogAlertThreshold: 10,
      queueOldestWaitAlertMs: 60_000,
      outboxBacklogAlertThreshold: 5,
      probeTimeoutMs: 20,
      readinessCacheTtlMs: 10
    }
  );
  const startedAt = Date.now();

  const response = await service.getReadiness();

  assert.equal(response.status, "error");
  assert.equal(response.dependencies.mysql, "error");
  assert.equal(Date.now() - startedAt < 500, true);

  // 缓存过期后仍复用未结束的底层探针，避免每次健康检查都叠加一个悬挂查询。
  await new Promise((resolve) => setTimeout(resolve, 15));
  const repeatedResponse = await service.getReadiness();
  assert.equal(repeatedResponse.dependencies.mysql, "error");
  assert.equal(mysqlChecks, 1);
});

void test("readiness 短时缓存并合并重复依赖探测", async () => {
  let checks = 0;
  const countingProbe: HealthDependencyProbe = {
    check(): Promise<void> {
      checks += 1;
      return Promise.resolve();
    }
  };
  const service = new HealthService(
    { mysql: countingProbe, redis: countingProbe, minio: countingProbe },
    {
      sessionStore: "memory",
      queueEnabled: false,
      queueBacklogAlertThreshold: 10,
      queueOldestWaitAlertMs: 60_000,
      outboxBacklogAlertThreshold: 5,
      readinessCacheTtlMs: 1_000
    }
  );

  await Promise.all([service.getReadiness(), service.getReadiness(), service.getReadiness()]);
  await service.getReadiness();

  assert.equal(checks, 3);
});

function createHealthService(
  overrides: {
    redisProbe?: HealthDependencyProbe;
    workerAlive?: boolean;
    queueSnapshot?: QueueMonitoringSnapshot;
    outboxSnapshot?: { backlog: number; dead_letter: number; oldest_wait_ms: number };
  } = {}
): HealthService {
  return new HealthService(
    {
      mysql: new FakeProbe(),
      redis: overrides.redisProbe ?? new FakeProbe(),
      minio: new FakeProbe(),
      queue: {
        checkWrite: () => Promise.resolve(),
        getSnapshot: () =>
          Promise.resolve(
            overrides.queueSnapshot ?? {
              waiting: 2,
              active: 1,
              delayed: 0,
              failed: 0,
              oldest_wait_ms: 1_000
            }
          )
      },
      worker: {
        isAlive: () => Promise.resolve(overrides.workerAlive ?? true)
      },
      outbox: {
        getSnapshot: () =>
          Promise.resolve(
            overrides.outboxSnapshot ?? { backlog: 1, dead_letter: 0, oldest_wait_ms: 500 }
          )
      }
    },
    {
      sessionStore: "redis",
      queueEnabled: true,
      queueBacklogAlertThreshold: 10,
      queueOldestWaitAlertMs: 60_000,
      outboxBacklogAlertThreshold: 5
    }
  );
}

class FakeProbe implements HealthDependencyProbe {
  constructor(private readonly error?: Error) {}

  check(): Promise<void> {
    return this.error === undefined ? Promise.resolve() : Promise.reject(this.error);
  }
}
