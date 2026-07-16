import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { loadAppConfig } from "../src/config/app-config.js";
import { MySqlHealthProbe } from "../src/infrastructure/database/database-health-check.js";
import { createDatabasePool } from "../src/infrastructure/database/database-pool.js";
import { MySqlImageTaskOutboxRepository } from "../src/infrastructure/database/image-task-outbox-repository.js";
import { MySqlImageTasksRepository } from "../src/infrastructure/database/image-tasks-repository.js";
import { BullMqImageTaskQueue } from "../src/infrastructure/queue/bullmq-image-task-queue.js";
import {
  createBullMqRedisConnection,
  createRedisConnection
} from "../src/infrastructure/redis/redis-connection.js";
import { checkRedisHealth } from "../src/infrastructure/redis/redis-health-check.js";
import { createRedisKey } from "../src/infrastructure/redis/redis-key.js";
import {
  RedisWorkerHeartbeat,
  RedisWorkerHeartbeatReader
} from "../src/infrastructure/redis/worker-heartbeat.js";
import { MinioStorageService } from "../src/infrastructure/storage/minio-storage-service.js";
import { HealthService } from "../src/modules/health/health.service.js";

const runHealthIntegrationTest =
  process.env.RUN_QUEUE_INTEGRATION_TESTS === "true" ? test : test.skip;

void runHealthIntegrationTest(
  "真实 MySQL、Redis、MinIO、BullMQ 和 Worker 心跳通过 readiness 验证",
  { timeout: 30_000 },
  async () => {
    const config = loadAppConfig(process.env);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    const pool = createDatabasePool(config);
    const redis = createRedisConnection(config, "api", silentLogger);
    const queueRedis = createBullMqRedisConnection(config, "queue", silentLogger);
    const taskRepository = new MySqlImageTasksRepository(pool);
    const outbox = new MySqlImageTaskOutboxRepository(pool, taskRepository);
    const heartbeatBaseKey = createRedisKey(config.redisKeyPrefix, "health-integration", suffix);
    let queue: BullMqImageTaskQueue | undefined;
    let heartbeat: RedisWorkerHeartbeat | undefined;

    try {
      await redis.connect();
      await queueRedis.connect();
      queue = new BullMqImageTaskQueue(
        `${config.imageTaskQueueName}-g08-${suffix}`,
        queueRedis.client,
        config.imageTaskJobAttempts
      );
      heartbeat = new RedisWorkerHeartbeat(redis.client, heartbeatBaseKey, {
        workerId: `worker_${suffix}`,
        ttlSeconds: 5,
        intervalMs: 1_000
      });
      const storage = new MinioStorageService(config);
      const health = new HealthService(
        {
          mysql: new MySqlHealthProbe(pool),
          redis: {
            check: async () => {
              await checkRedisHealth(redis);
            }
          },
          minio: {
            check: async () => {
              await storage.checkHealth();
            }
          },
          queue,
          worker: new RedisWorkerHeartbeatReader(redis.client, heartbeatBaseKey),
          outbox
        },
        {
          queueEnabled: true,
          queueBacklogAlertThreshold: 1_000,
          queueOldestWaitAlertMs: 600_000,
          outboxBacklogAlertThreshold: 1_000,
          readinessCacheTtlMs: 1
        }
      );

      const offline = await health.getReadiness();
      assert.equal(offline.status, "error");
      assert.equal(offline.worker.status, "offline");
      assert.deepEqual(offline.dependencies, {
        mysql: "ok",
        redis: "ok",
        minio: "ok",
        queue: "ok"
      });

      await heartbeat.start();
      // 等待极短缓存过期，验证 Worker 恢复后 readiness 能及时刷新为在线状态。
      await new Promise((resolve) => setTimeout(resolve, 5));
      const online = await health.getReadiness();
      assert.equal(online.status, "ok");
      assert.equal(online.worker.status, "ok");
      assert.equal(typeof online.outbox.backlog, "number");
      assert.equal(typeof online.queue.waiting, "number");
    } finally {
      await Promise.allSettled([
        heartbeat?.stop(),
        queue?.close(),
        queueRedis.close(),
        redis.close(),
        pool.end()
      ]);
    }
  }
);

const silentLogger = {
  info(): void {
    // 集成测试禁止输出真实基础设施端点。
  },
  warn(): void {
    // 集成测试禁止输出真实基础设施端点。
  },
  error(): void {
    // 集成测试禁止输出真实基础设施端点。
  }
};
