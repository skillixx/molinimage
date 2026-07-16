import assert from "node:assert/strict";
import test from "node:test";

import type {
  ClaimImageTaskExecutionInput,
  ImageTaskExecutionClaim,
  ImageTaskRecord,
  ImageTaskStatus
} from "../src/infrastructure/database/image-tasks-repository.js";
import {
  ImageTaskJobProcessor,
  ImageTaskJobTimeoutError,
  type ClaimedImageTaskProcessor,
  type ImageTaskExecutionRepository
} from "../src/workers/image-task-job-processor.js";

void test("两个 Worker 同时消费同一 task_id 时只有一个获得数据库执行权", async () => {
  const repository = new InMemoryExecutionRepository("queued");
  const gate = createDeferred();
  let calls = 0;
  const service: ClaimedImageTaskProcessor = {
    async processTask(_taskId, context): Promise<void> {
      calls += 1;
      await context.assertActive();
      await gate.promise;
    }
  };
  const processor = createProcessor(repository, service);
  const first = processor.process({ task_id: "task_same" });
  await waitFor(() => calls === 1);
  const second = await processor.process({ task_id: "task_same" });
  gate.resolve();

  assert.equal(await first, "processed");
  assert.equal(second, "skipped");
  assert.equal(calls, 1);
  assert.equal(repository.claimCount, 1);
});

void test("终态任务重复投递会跳过且不调用业务 Worker", async () => {
  const repository = new InMemoryExecutionRepository("succeeded");
  let calls = 0;
  const processor = createProcessor(repository, {
    processTask(): Promise<void> {
      calls += 1;
      return Promise.resolve();
    }
  });

  assert.equal(await processor.process({ task_id: "task_done" }), "skipped");
  assert.equal(calls, 0);
});

void test("Worker 重启后可以重新抢占租约已过期的 running 任务", async () => {
  const repository = new InMemoryExecutionRepository("running", true);
  let calls = 0;
  const processor = createProcessor(repository, {
    async processTask(_taskId, context): Promise<void> {
      calls += 1;
      await context.assertActive();
    }
  });

  assert.equal(await processor.process({ task_id: "task_expired" }), "processed");
  assert.equal(calls, 1);
  assert.equal(repository.claimCount, 1);
});

void test("任务执行超时会中止调用并按当前租约释放回 queued", async () => {
  const repository = new InMemoryExecutionRepository("queued");
  const service: ClaimedImageTaskProcessor = {
    processTask(_taskId, context): Promise<void> {
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => {
            const reason = context.signal.reason as unknown;
            reject(reason instanceof Error ? reason : new Error("测试任务被中止。"));
          },
          { once: true }
        );
      });
    }
  };
  const processor = new ImageTaskJobProcessor(repository, service, {
    jobTimeoutMs: 20,
    lockDurationMs: 100,
    heartbeatIntervalMs: 10
  });

  await assert.rejects(
    () => processor.process({ task_id: "task_timeout" }),
    (error: unknown) => error instanceof ImageTaskJobTimeoutError
  );
  assert.equal(repository.status, "queued");
  assert.equal(repository.releaseCount, 1);
});

void test("长任务会续期数据库租约并在处理完成后停止心跳", async () => {
  const repository = new InMemoryExecutionRepository("queued");
  const processor = new ImageTaskJobProcessor(
    repository,
    {
      async processTask(_taskId, context): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 45));
        await context.assertActive();
      }
    },
    { jobTimeoutMs: 200, lockDurationMs: 100, heartbeatIntervalMs: 10 }
  );

  assert.equal(await processor.process({ task_id: "task_heartbeat" }), "processed");
  assert.ok(repository.renewCount >= 2);
  const renewCountAfterCompletion = repository.renewCount;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(repository.renewCount, renewCountAfterCompletion);
});

class InMemoryExecutionRepository implements ImageTaskExecutionRepository {
  claimCount = 0;
  renewCount = 0;
  releaseCount = 0;
  currentToken: string | undefined;

  constructor(
    public status: ImageTaskStatus,
    private expired = false
  ) {}

  claimExecution(
    input: ClaimImageTaskExecutionInput
  ): Promise<ImageTaskExecutionClaim | undefined> {
    if (
      this.status !== "queued" &&
      this.status !== "billing_reserved" &&
      !(this.status === "running" && this.expired)
    ) {
      return Promise.resolve(undefined);
    }

    this.status = "running";
    this.expired = false;
    this.currentToken = input.lockToken;
    this.claimCount += 1;
    return Promise.resolve({
      task: createTask(input.taskId, "running"),
      lock_token: input.lockToken
    });
  }

  renewExecution(input: ClaimImageTaskExecutionInput): Promise<boolean> {
    this.renewCount += 1;
    return Promise.resolve(
      this.status === "running" && this.currentToken === input.lockToken && !this.expired
    );
  }

  releaseExecution(input: { taskId: string; lockToken: string }): Promise<boolean> {
    void input.taskId;

    if (this.status !== "running" || this.currentToken !== input.lockToken) {
      return Promise.resolve(false);
    }

    this.status = "queued";
    this.currentToken = undefined;
    this.releaseCount += 1;
    return Promise.resolve(true);
  }

  isExecutionActive(input: { taskId: string; lockToken: string }): Promise<boolean> {
    void input.taskId;
    return Promise.resolve(
      this.status === "running" && this.currentToken === input.lockToken && !this.expired
    );
  }
}

function createProcessor(
  repository: InMemoryExecutionRepository,
  service: ClaimedImageTaskProcessor
): ImageTaskJobProcessor {
  return new ImageTaskJobProcessor(repository, service, {
    jobTimeoutMs: 500,
    lockDurationMs: 200,
    heartbeatIntervalMs: 50
  });
}

function createTask(id: string, status: ImageTaskStatus): ImageTaskRecord {
  return {
    id,
    source_task_id: null,
    source_file_id: null,
    owner_user_id: 479,
    entitlement_id: null,
    task_type: "text_to_image",
    status,
    prompt: "测试图片",
    negative_prompt: null,
    style_preset_id: null,
    input_file_ids: [],
    output_file_ids: [],
    text_result: null,
    gateway_model_code: "test-image-model",
    gateway_capability: "image_generation",
    gateway_request_id: null,
    quality: "standard",
    image_size: "1024x1024",
    image_count: 1,
    upscale_factor: null,
    cost_points: null,
    billing_event_id: null,
    idempotency_key: `idem_${id}`,
    error_code: null,
    error_message: null,
    is_favorited: false,
    deleted_at: null,
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z"
  };
}

function createDeferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve(): void {
      resolvePromise?.();
    }
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  throw new Error("等待测试条件超时。");
}
