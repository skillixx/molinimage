import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Queue } from "bullmq";
import type { RowDataPacket } from "mysql2/promise";

import { loadAppConfig } from "../src/config/app-config.js";
import { createDatabasePool } from "../src/infrastructure/database/database-pool.js";
import { MySqlImageTaskOutboxRepository } from "../src/infrastructure/database/image-task-outbox-repository.js";
import {
  MySqlImageTasksRepository,
  type CreateImageTaskRecordInput
} from "../src/infrastructure/database/image-tasks-repository.js";
import { BullMqImageTaskQueue } from "../src/infrastructure/queue/bullmq-image-task-queue.js";
import { ImageTaskOutboxDispatcher } from "../src/infrastructure/queue/image-task-outbox-dispatcher.js";
import type { ImageTaskJobData } from "../src/infrastructure/queue/image-task-queue.js";
import { createBullMqRedisConnection } from "../src/infrastructure/redis/redis-connection.js";
import { ImageTaskService } from "../src/modules/image-tasks/image-task-service.js";

const runQueueIntegrationTest =
  process.env.RUN_QUEUE_INTEGRATION_TESTS === "true" ? test : test.skip;

void runQueueIntegrationTest(
  "真实 MySQL 与 Redis 保证 Outbox 原子性、崩溃恢复和 BullMQ 去重",
  { timeout: 30_000 },
  async () => {
    const config = loadAppConfig(process.env);
    const suffix = randomUUID().replaceAll("-", "");
    const taskId = `task_g04_${suffix.slice(0, 24)}`;
    const rollbackTaskId = `task_g04_rb_${suffix.slice(0, 20)}`;
    const queueName = `molinimage-g04-${suffix.slice(0, 16)}`;
    const pool = createDatabasePool(config);
    const taskRepository = new MySqlImageTasksRepository(pool);
    const outboxRepository = new MySqlImageTaskOutboxRepository(pool, taskRepository);
    const lifecycle = new ImageTaskService(taskRepository);
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
    const redisConnection = createBullMqRedisConnection(config, "queue", silentLogger);
    let queue: BullMqImageTaskQueue | undefined;
    let inspector: Queue<ImageTaskJobData> | undefined;

    try {
      await redisConnection.connect();
      queue = new BullMqImageTaskQueue(
        queueName,
        redisConnection.client,
        config.imageTaskJobAttempts
      );
      inspector = new Queue<ImageTaskJobData>(queueName, { connection: redisConnection.client });

      const created = await outboxRepository.create(createTaskInput(taskId, `g04:${suffix}`));
      assert.equal(created.id, taskId);
      assert.equal(await countRows(pool, "image_tasks", taskId), 1);
      assert.equal(await countRows(pool, "image_task_outbox", taskId), 1);

      // 模拟 API 在事务提交后退出：使用新建 Dispatcher 读取数据库遗留 Outbox 并恢复投递。
      const dispatcherAfterRestart = new ImageTaskOutboxDispatcher(
        outboxRepository,
        queue,
        lifecycle,
        { batchSize: 20, pollIntervalMs: 1000, maxWaitMs: 300_000, maxBackoffMs: 60_000 },
        silentLogger
      );
      await dispatcherAfterRestart.dispatchOnce();

      assert.equal(await readOutboxStatus(pool, taskId), "dispatched");
      assert.equal((await taskRepository.findById(taskId))?.status, "queued");
      await inspector.waitUntilReady();
      const job = await inspector.getJob(taskId);
      assert.ok(job);
      assert.equal(job.name, "process-image-task");
      assert.deepEqual(job.data, { task_id: taskId });
      assert.deepEqual(Object.keys(job.data), ["task_id"]);

      await queue.enqueue(taskId);
      const duplicateJobs = (
        await inspector.getJobs([
          "wait",
          "waiting-children",
          "active",
          "delayed",
          "completed",
          "failed",
          "paused"
        ])
      ).filter((item) => item.id === taskId);
      assert.equal(duplicateJobs.length, 1);

      // 预置同 task_id Outbox 让事务第二步触发唯一键冲突，验证第一步 image_tasks INSERT 被回滚。
      await pool.execute(
        `INSERT INTO image_task_outbox (id, task_id, status, next_attempt_at)
         VALUES (?, ?, 'pending', CURRENT_TIMESTAMP(3))`,
        [`outbox_g04_rb_${suffix.slice(0, 16)}`, rollbackTaskId]
      );
      await assert.rejects(
        outboxRepository.create(createTaskInput(rollbackTaskId, `g04:rollback:${suffix}`))
      );
      assert.equal(await countRows(pool, "image_tasks", rollbackTaskId), 0);
    } finally {
      await inspector?.obliterate({ force: true }).catch(() => undefined);
      await Promise.allSettled([queue?.close(), inspector?.close()]);
      await redisConnection.close();
      await pool
        .execute(`DELETE FROM image_task_outbox WHERE task_id IN (?, ?)`, [taskId, rollbackTaskId])
        .catch(() => undefined);
      await pool
        .execute(`DELETE FROM image_tasks WHERE id IN (?, ?)`, [taskId, rollbackTaskId])
        .catch(() => undefined);
      await pool.end();
    }
  }
);

function createTaskInput(taskId: string, idempotencyKey: string): CreateImageTaskRecordInput {
  return {
    id: taskId,
    owner_user_id: 479,
    task_type: "text_to_image",
    status: "pending",
    prompt: "G04 基础设施验收",
    negative_prompt: null,
    style_preset_id: null,
    input_file_ids: [],
    gateway_model_code: "integration-image-model",
    gateway_capability: "image_generation",
    quality: "standard",
    image_size: "1024x1024",
    image_count: 1,
    cost_points: null,
    billing_event_id: null,
    idempotency_key: idempotencyKey
  };
}

async function countRows(
  pool: ReturnType<typeof createDatabasePool>,
  table: "image_tasks" | "image_task_outbox",
  taskId: string
): Promise<number> {
  const [rows] = await pool.execute<(RowDataPacket & { total: number })[]>(
    `SELECT COUNT(*) AS total FROM ${table} WHERE ${table === "image_tasks" ? "id" : "task_id"} = ?`,
    [taskId]
  );

  return rows[0]?.total ?? 0;
}

async function readOutboxStatus(
  pool: ReturnType<typeof createDatabasePool>,
  taskId: string
): Promise<string | undefined> {
  const [rows] = await pool.execute<(RowDataPacket & { status: string })[]>(
    `SELECT status FROM image_task_outbox WHERE task_id = ? LIMIT 1`,
    [taskId]
  );

  return rows[0]?.status;
}
