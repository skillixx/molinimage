import assert from "node:assert/strict";
import test from "node:test";

import type {
  BillingReconciliationAttemptInput,
  BillingReconciliationAttemptRecord,
  BillingReconciliationRepository,
  BillingReconciliationTaskRecord
} from "../src/infrastructure/database/billing-reconciliation-repository.js";
import type { ImageTaskRecord } from "../src/infrastructure/database/image-tasks-repository.js";
import { BillingReconciliationService } from "../src/modules/billing/billing-reconciliation-service.js";
import type {
  ReleaseBillingRequest,
  ReleaseBillingResult
} from "../src/modules/billing/billing-service.js";
import type { TransitionImageTaskRequest } from "../src/modules/image-tasks/image-task-service.js";

void test("对账服务列出 billing_pending 和释放失败任务", async () => {
  const repository = new InMemoryBillingReconciliationRepository([
    createPendingTask("task_settle", "billing_pending", "BILLING_SETTLE_PENDING"),
    createPendingTask("task_release", "failed", "BILLING_RELEASE_PENDING")
  ]);
  const service = createService(repository);

  const result = await service.listPending({});

  assert.equal(result.total, 2);
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["task_settle", "task_release"]
  );
});

void test("对账服务可以重试结算并记录结果", async () => {
  const task = createImageTask("task_settle", "billing_pending", "BILLING_SETTLE_PENDING");
  const repository = new InMemoryBillingReconciliationRepository([
    createPendingTask(task.id, task.status, task.error_code)
  ]);
  const imageTasks = new InMemoryImageTasksRepository([task]);
  const imageTaskService = new FakeImageTaskService(imageTasks);
  const service = createService(repository, imageTasks, imageTaskService);

  const result = await service.retrySettle({
    actorUserId: 479,
    taskId: task.id,
    requestId: "req_001"
  });

  assert.equal(result.attempt.action, "retry_settle");
  assert.equal(result.attempt.result, "succeeded");
  assert.equal(result.attempt.before_error_code, "BILLING_SETTLE_PENDING");
  assert.equal(imageTaskService.transitionRequests[0]?.toStatus, "succeeded");
});

void test("对账服务可以重试释放并记录结果", async () => {
  const task = createImageTask("task_release", "failed", "BILLING_RELEASE_PENDING");
  const repository = new InMemoryBillingReconciliationRepository([
    createPendingTask(task.id, task.status, task.error_code)
  ]);
  const imageTasks = new InMemoryImageTasksRepository([task]);
  const billingService = new FakeBillingService(true);
  const service = createService(
    repository,
    imageTasks,
    new FakeImageTaskService(imageTasks),
    billingService
  );

  const result = await service.retryRelease({
    actorUserId: 479,
    taskId: task.id,
    requestId: "req_002"
  });

  assert.equal(result.attempt.action, "retry_release");
  assert.equal(result.attempt.result, "succeeded");
  assert.equal(result.attempt.billing_event_status, "released");
  assert.equal(billingService.releaseRequests[0]?.retryPending, true);
  assert.equal(result.attempt.before_error_code, "BILLING_RELEASE_PENDING");
});

function createService(
  reconciliationRepository = new InMemoryBillingReconciliationRepository([]),
  imageTasksRepository = new InMemoryImageTasksRepository([]),
  imageTaskService = new FakeImageTaskService(imageTasksRepository),
  billingService = new FakeBillingService(true)
) {
  return new BillingReconciliationService(
    reconciliationRepository,
    imageTasksRepository,
    imageTaskService,
    billingService
  );
}

class InMemoryBillingReconciliationRepository implements BillingReconciliationRepository {
  readonly attempts: BillingReconciliationAttemptRecord[] = [];

  constructor(private readonly tasks: BillingReconciliationTaskRecord[]) {}

  listPending(input: {
    page: number;
    pageSize: number;
  }): Promise<{ items: BillingReconciliationTaskRecord[]; total: number }> {
    const offset = (input.page - 1) * input.pageSize;
    const items = this.tasks
      .filter(
        (task) =>
          task.status === "billing_pending" ||
          (task.status === "failed" && task.error_code === "BILLING_RELEASE_PENDING")
      )
      .slice(offset, offset + input.pageSize);

    return Promise.resolve({ items, total: items.length });
  }

  createAttempt(input: BillingReconciliationAttemptInput) {
    const attempt: BillingReconciliationAttemptRecord = {
      ...input,
      created_at: "2026-07-12T00:00:00.000Z"
    };
    this.attempts.push(attempt);

    return Promise.resolve(attempt);
  }

  updateAttemptResult(input: {
    attemptId: string;
    after_task_status: string;
    after_error_code: string | null;
    billing_event_id: string | null;
    billing_event_status: string | null;
    result: "succeeded" | "pending" | "failed";
    error_code: string | null;
    error_message: string | null;
  }) {
    const attempt = this.attempts.find((item) => item.id === input.attemptId);

    if (attempt === undefined) {
      return Promise.reject(new Error("对账记录不存在"));
    }

    attempt.after_task_status = input.after_task_status;
    attempt.after_error_code = input.after_error_code;
    attempt.billing_event_id = input.billing_event_id;
    attempt.billing_event_status = input.billing_event_status;
    attempt.result = input.result;
    attempt.error_code = input.error_code;
    attempt.error_message = input.error_message;

    return Promise.resolve(attempt);
  }

  markReleaseReconciled(input: {
    taskId: string;
    ownerUserId: number;
    errorCode: string;
    errorMessage: string;
  }): Promise<void> {
    const task = this.tasks.find(
      (item) => item.id === input.taskId && item.owner_user_id === input.ownerUserId
    );

    if (task !== undefined) {
      task.error_code = input.errorCode;
      task.error_message = input.errorMessage;
    }

    return Promise.resolve();
  }

  listAttempts(taskId: string): Promise<BillingReconciliationAttemptRecord[]> {
    return Promise.resolve(this.attempts.filter((attempt) => attempt.task_id === taskId));
  }
}

class InMemoryImageTasksRepository {
  constructor(private readonly tasks: ImageTaskRecord[]) {}

  findById(taskId: string): Promise<ImageTaskRecord | undefined> {
    return Promise.resolve(this.tasks.find((task) => task.id === taskId));
  }

  updateTask(taskId: string, updater: (task: ImageTaskRecord) => void): void {
    const task = this.tasks.find((item) => item.id === taskId);

    if (task !== undefined) {
      updater(task);
    }
  }
}

class FakeImageTaskService {
  readonly transitionRequests: TransitionImageTaskRequest[] = [];

  constructor(private readonly tasks: InMemoryImageTasksRepository) {}

  transitionTask(request: TransitionImageTaskRequest) {
    this.transitionRequests.push(request);
    this.tasks.updateTask(request.taskId, (task) => {
      task.status = request.toStatus;
      task.error_code = null;
      task.error_message = null;
    });

    return Promise.resolve({
      task: {
        ...createImageTask(request.taskId, request.toStatus, null),
        owner_user_id: request.ownerUserId,
        billing_event_id: "billing_reserve_001"
      }
    });
  }
}

class FakeBillingService {
  readonly releaseRequests: ReleaseBillingRequest[] = [];

  constructor(private readonly shouldRelease: boolean) {}

  release(request: ReleaseBillingRequest): Promise<ReleaseBillingResult> {
    this.releaseRequests.push(request);

    return Promise.resolve({
      released: this.shouldRelease,
      billing_event: {
        id: "billing_release_001",
        owner_user_id: request.ownerUserId,
        task_id: request.taskId,
        event_type: "release",
        amount_points: "6",
        status: this.shouldRelease ? "released" : "release_pending",
        idempotency_key: request.idempotencyKey,
        moling_reserve_id: "hold_001",
        moling_entitlement_id: 62,
        error_code: this.shouldRelease ? null : "BILLING_RELEASE_FAILED",
        error_message: this.shouldRelease ? null : "模拟释放失败",
        created_at: "2026-07-12T00:00:00.000Z",
        updated_at: "2026-07-12T00:00:00.000Z"
      }
    });
  }
}

function createPendingTask(
  id: string,
  status: BillingReconciliationTaskRecord["status"],
  errorCode: string | null
): BillingReconciliationTaskRecord {
  return {
    id,
    owner_user_id: 479,
    task_type: "text_to_image",
    status,
    cost_points: "6",
    billing_event_id: "billing_reserve_001",
    error_code: errorCode,
    error_message: errorCode === null ? null : "等待对账",
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z",
    latest_billing_event_id: "billing_event_001",
    latest_billing_event_type: status === "billing_pending" ? "settle" : "release",
    latest_billing_event_status:
      status === "billing_pending" ? "settle_pending" : "release_pending",
    latest_billing_event_error_code: errorCode,
    latest_billing_event_error_message: "等待对账",
    latest_reconciliation_result: null,
    latest_reconciliation_error_code: null,
    latest_reconciliation_error_message: null,
    latest_reconciliation_created_at: null
  };
}

function createImageTask(
  id: string,
  status: ImageTaskRecord["status"],
  errorCode: string | null
): ImageTaskRecord {
  return {
    id,
    source_task_id: null,
    owner_user_id: 479,
    entitlement_id: 62,
    task_type: "text_to_image",
    status,
    prompt: "测试",
    negative_prompt: null,
    style_preset_id: null,
    input_file_ids: [],
    output_file_ids: ["file_001"],
    text_result: null,
    gateway_model_code: "model",
    gateway_capability: "image_generation",
    gateway_request_id: "gateway_001",
    quality: "standard",
    image_size: "1024x1024",
    image_count: 1,
    upscale_factor: null,
    cost_points: "6",
    billing_event_id: "billing_reserve_001",
    idempotency_key: `create:${id}`,
    error_code: errorCode,
    error_message: errorCode === null ? null : "等待对账",
    is_favorited: false,
    deleted_at: null,
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z"
  };
}
