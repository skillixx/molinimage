import assert from "node:assert/strict";
import test from "node:test";

import type {
  FailedImageTaskRecord,
  ImageTaskRecord
} from "../src/infrastructure/database/image-tasks-repository.js";
import { ImageTaskRecoveryService } from "../src/modules/image-tasks/image-task-recovery-service.js";

void test("管理端失败列表返回错误原因、尝试次数和计费状态", async () => {
  const task = createFailedTask();
  const service = new ImageTaskRecoveryService(
    {
      findById: () => Promise.resolve(task),
      findFailedTasks: () => Promise.resolve({ items: [task], total: 1 })
    },
    {
      retryTask: () => Promise.reject(new Error("不应重投"))
    }
  );

  const result = await service.listFailedTasks({ page: 1, pageSize: 20 });

  assert.equal(result.total, 1);
  assert.equal(result.items[0]?.error_code, "AI_GATEWAY_FAILED");
  assert.equal(result.items[0]?.worker_attempt_count, 3);
  assert.equal(result.items[0]?.billing_status, "released");
});

void test("人工重投沿用原任务所有者和权益并返回新 retry task", async () => {
  const task = createFailedTask();
  const calls: unknown[][] = [];
  const auditEvents: unknown[] = [];
  const removedFailedJobIds: string[] = [];
  const service = new ImageTaskRecoveryService(
    {
      findById: () => Promise.resolve(task),
      findFailedTasks: () => Promise.resolve({ items: [], total: 0 })
    },
    {
      retryTask(...args): Promise<{ task: never; retried_from_task_id: string }> {
        calls.push(args);
        return Promise.resolve({
          task: { id: "task_retry" } as never,
          retried_from_task_id: task.id
        });
      }
    },
    {
      record(event): void {
        auditEvents.push(event);
      }
    },
    {
      removeFailed(taskId): Promise<void> {
        removedFailedJobIds.push(taskId);
        return Promise.resolve();
      }
    }
  );

  const result = await service.replayFailedTask({
    taskId: task.id,
    actorUserId: 999,
    requestId: "req_admin"
  });

  assert.equal(result.retried_from_task_id, task.id);
  assert.deepEqual(calls[0], [479, task.id, 64, { requestId: "req_admin" }]);
  assert.deepEqual(removedFailedJobIds, [task.id]);
  assert.deepEqual(auditEvents, [
    {
      event_type: "image_task_manual_replay",
      actor_user_id: 999,
      owner_user_id: 479,
      source_task_id: "task_failed",
      retry_task_id: "task_retry",
      request_id: "req_admin"
    }
  ]);
});

void test("积分释放待对账任务禁止人工重投", async () => {
  const task = { ...createFailedTask(), error_code: "BILLING_RELEASE_PENDING" };
  const service = new ImageTaskRecoveryService(
    {
      findById: () => Promise.resolve(task),
      findFailedTasks: () => Promise.resolve({ items: [task], total: 1 })
    },
    {
      retryTask: () => Promise.reject(new Error("不应创建重试任务"))
    }
  );

  await assert.rejects(
    () => service.replayFailedTask({ taskId: task.id, actorUserId: 999 }),
    (error: unknown) =>
      error instanceof Error && error.message === "原任务积分仍在释放中，请先完成计费对账。"
  );
});

void test("旧 failed Job 清理失败时保留重投审计并记录清理失败", async () => {
  const task = createFailedTask();
  const auditEvents: unknown[] = [];
  const service = new ImageTaskRecoveryService(
    {
      findById: () => Promise.resolve(task),
      findFailedTasks: () => Promise.resolve({ items: [], total: 0 })
    },
    {
      retryTask: () =>
        Promise.resolve({
          task: { id: "task_retry" } as never,
          retried_from_task_id: task.id
        })
    },
    {
      record(event): void {
        auditEvents.push(event);
      }
    },
    {
      removeFailed: () => Promise.reject(new Error("redis unavailable"))
    }
  );

  await assert.rejects(
    () => service.replayFailedTask({ taskId: task.id, actorUserId: 999 }),
    /重试任务已创建，但旧失败记录尚未收敛/u
  );
  assert.deepEqual(
    auditEvents.map((event) => (event as { event_type: string }).event_type),
    ["image_task_manual_replay", "image_task_failed_job_cleanup_failed"]
  );
});

function createFailedTask(): FailedImageTaskRecord {
  const task: ImageTaskRecord = {
    id: "task_failed",
    source_task_id: null,
    source_file_id: null,
    owner_user_id: 479,
    entitlement_id: 64,
    task_type: "text_to_image",
    status: "failed",
    prompt: "测试",
    negative_prompt: null,
    style_preset_id: null,
    input_file_ids: [],
    output_file_ids: [],
    text_result: null,
    gateway_model_code: "image-model",
    gateway_capability: "image_generation",
    gateway_request_id: null,
    quality: "standard",
    image_size: "1024x1024",
    image_count: 1,
    upscale_factor: null,
    cost_points: "6.0000",
    billing_event_id: "billing_001",
    idempotency_key: "idem_failed",
    error_code: "AI_GATEWAY_FAILED",
    error_message: "AI 模型服务调用失败。",
    worker_attempt_count: 3,
    is_favorited: false,
    deleted_at: null,
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:05:00.000Z"
  };

  return { ...task, billing_status: "released" };
}
