import assert from "node:assert/strict";
import test from "node:test";

import type {
  ImageTaskRecord,
  ImageTaskStatus
} from "../src/infrastructure/database/image-tasks-repository.js";
import { ImageTaskRecoveryScanner } from "../src/workers/image-task-recovery-scanner.js";

void test("恢复扫描器接管卡住任务并重新投递同一 task_id", async () => {
  const task = createTask("task_stuck", "running", 1);
  const enqueued: string[] = [];
  let recovered = false;
  const scanner = new ImageTaskRecoveryScanner(
    {
      findRecoverableStuckTasks: () => Promise.resolve([task]),
      recoverStuckExecution: () => {
        recovered = true;
        return Promise.resolve(true);
      },
      claimStuckTaskFinalization: () => Promise.resolve(undefined)
    },
    {
      requeue(taskId): Promise<void> {
        enqueued.push(taskId);
        return Promise.resolve();
      }
    },
    {
      finalizeClaimedFailure(): Promise<never> {
        return Promise.reject(new Error("不应进入最终失败"));
      }
    },
    { scanIntervalMs: 1000, staleAfterMs: 5000, batchSize: 20, maxAttempts: 3 }
  );

  const result = await scanner.scanOnce();

  assert.equal(recovered, true);
  assert.deepEqual(enqueued, ["task_stuck"]);
  assert.deepEqual(result, { scanned: 1, requeued: 1, finalized: 0, skipped: 0 });
});

void test("次数耗尽的卡住任务只进入最终失败，不再投递队列", async () => {
  const task = createTask("task_exhausted", "queued", 3);
  const finalizations: string[] = [];
  const scanner = new ImageTaskRecoveryScanner(
    {
      findRecoverableStuckTasks: () => Promise.resolve([task]),
      recoverStuckExecution: () => Promise.resolve(true),
      claimStuckTaskFinalization: (input) =>
        Promise.resolve({ task: { ...task, status: "running" }, lock_token: input.lockToken })
    },
    {
      requeue(): Promise<void> {
        return Promise.reject(new Error("不应重新投递"));
      }
    },
    {
      finalizeClaimedFailure(input): Promise<{ task: never }> {
        finalizations.push(`${input.taskId}:${input.errorCode}:${input.workerLockToken}`);
        return Promise.resolve({ task: undefined as never });
      }
    },
    {
      scanIntervalMs: 1000,
      staleAfterMs: 5000,
      batchSize: 20,
      maxAttempts: 3,
      finalizationLockDurationMs: 100
    }
  );

  const result = await scanner.scanOnce();

  assert.equal(finalizations.length, 1);
  assert.match(finalizations[0] ?? "", /^task_exhausted:IMAGE_TASK_RETRY_EXHAUSTED:recovery_/u);
  assert.deepEqual(result, { scanned: 1, requeued: 0, finalized: 1, skipped: 0 });
});

function createTask(
  id: string,
  status: ImageTaskStatus,
  workerAttemptCount: number
): ImageTaskRecord {
  return {
    id,
    source_task_id: null,
    source_file_id: null,
    owner_user_id: 479,
    entitlement_id: 64,
    task_type: "text_to_image",
    status,
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
    idempotency_key: `idem_${id}`,
    error_code: null,
    error_message: null,
    worker_attempt_count: workerAttemptCount,
    is_favorited: false,
    deleted_at: null,
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z"
  };
}
