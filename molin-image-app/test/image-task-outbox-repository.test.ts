import assert from "node:assert/strict";
import type { Pool } from "mysql2/promise";
import test from "node:test";

import { MySqlImageTaskOutboxRepository } from "../src/infrastructure/database/image-task-outbox-repository.js";
import type {
  CreateImageTaskRecordInput,
  ImageTaskRecord
} from "../src/infrastructure/database/image-tasks-repository.js";

void test("任务和 Outbox 在同一个事务中提交", async () => {
  const connection = new RecordingConnection();
  const taskRepository = new FakeTaskLookupRepository();
  const repository = new MySqlImageTaskOutboxRepository(createPool(connection), taskRepository);
  const input = createTaskInput();
  taskRepository.byId = createTaskRecord(input);

  const created = await repository.create(input);

  assert.equal(created.id, input.id);
  assert.deepEqual(connection.operations, [
    "begin",
    "insert:image_tasks",
    "insert:image_task_outbox",
    "commit",
    "release"
  ]);
});

void test("Outbox 写入失败时回滚图片任务事务", async () => {
  const connection = new RecordingConnection();
  connection.failOutboxInsert = true;
  const taskRepository = new FakeTaskLookupRepository();
  const repository = new MySqlImageTaskOutboxRepository(createPool(connection), taskRepository);

  await assert.rejects(repository.create(createTaskInput()), /模拟 Outbox 写入失败/);
  assert.deepEqual(connection.operations, [
    "begin",
    "insert:image_tasks",
    "insert:image_task_outbox",
    "rollback",
    "release"
  ]);
});

void test("Outbox 监控统计积压、死信和最老等待时间", async () => {
  const pool = {
    execute: () => Promise.resolve([[{ backlog: 7, dead_letter: 2, oldest_wait_ms: 45_000 }], []])
  } as unknown as Pool;
  const repository = new MySqlImageTaskOutboxRepository(pool, new FakeTaskLookupRepository());

  assert.deepEqual(await repository.getMonitoringSnapshot(), {
    backlog: 7,
    dead_letter: 2,
    oldest_wait_ms: 45_000
  });
});

void test("空 Outbox 的 MySQL 聚合 NULL 归一化为数字零", async () => {
  const pool = {
    execute: () =>
      Promise.resolve([[{ backlog: null, dead_letter: null, oldest_wait_ms: null }], []])
  } as unknown as Pool;
  const repository = new MySqlImageTaskOutboxRepository(pool, new FakeTaskLookupRepository());

  assert.deepEqual(await repository.getMonitoringSnapshot(), {
    backlog: 0,
    dead_letter: 0,
    oldest_wait_ms: 0
  });
});

class RecordingConnection {
  readonly operations: string[] = [];
  failOutboxInsert = false;

  beginTransaction(): Promise<void> {
    this.operations.push("begin");
    return Promise.resolve();
  }

  execute(sql: string): Promise<[Record<string, unknown>, unknown[]]> {
    if (/INSERT INTO image_tasks/iu.test(sql)) {
      this.operations.push("insert:image_tasks");
      return Promise.resolve([{ affectedRows: 1 }, []]);
    }

    if (/INSERT INTO image_task_outbox/iu.test(sql)) {
      this.operations.push("insert:image_task_outbox");

      if (this.failOutboxInsert) {
        return Promise.reject(new Error("模拟 Outbox 写入失败"));
      }

      return Promise.resolve([{ affectedRows: 1 }, []]);
    }

    return Promise.resolve([{}, []]);
  }

  commit(): Promise<void> {
    this.operations.push("commit");
    return Promise.resolve();
  }

  rollback(): Promise<void> {
    this.operations.push("rollback");
    return Promise.resolve();
  }

  release(): void {
    this.operations.push("release");
  }
}

class FakeTaskLookupRepository {
  byId: ImageTaskRecord | undefined;
  byIdempotencyKey: ImageTaskRecord | undefined;

  findById(): Promise<ImageTaskRecord | undefined> {
    return Promise.resolve(this.byId);
  }

  findByIdempotencyKey(): Promise<ImageTaskRecord | undefined> {
    return Promise.resolve(this.byIdempotencyKey);
  }
}

function createPool(connection: RecordingConnection): Pool {
  return {
    getConnection: () => Promise.resolve(connection)
  } as unknown as Pool;
}

function createTaskInput(): CreateImageTaskRecordInput {
  return {
    id: "task_transaction_001",
    owner_user_id: 479,
    entitlement_id: 62,
    task_type: "text_to_image",
    status: "billing_reserved",
    prompt: "事务测试图片",
    negative_prompt: null,
    style_preset_id: null,
    input_file_ids: [],
    gateway_model_code: "image-model",
    gateway_capability: "image_generation",
    quality: "standard",
    image_size: "1024x1024",
    image_count: 1,
    cost_points: "6",
    billing_event_id: "billing_transaction_001",
    idempotency_key: "transaction-create-001"
  };
}

function createTaskRecord(input: CreateImageTaskRecordInput): ImageTaskRecord {
  return {
    ...input,
    source_task_id: null,
    source_file_id: null,
    entitlement_id: input.entitlement_id ?? null,
    upscale_factor: null,
    output_file_ids: [],
    text_result: null,
    gateway_request_id: null,
    error_code: null,
    error_message: null,
    is_favorited: false,
    deleted_at: null,
    created_at: "2026-07-16T08:00:00.000Z",
    updated_at: "2026-07-16T08:00:00.000Z"
  };
}
