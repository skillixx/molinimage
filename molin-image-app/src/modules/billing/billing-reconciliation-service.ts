import { randomUUID } from "node:crypto";

import type {
  BillingReconciliationAttemptRecord,
  BillingReconciliationRepository,
  BillingReconciliationTaskRecord
} from "../../infrastructure/database/billing-reconciliation-repository.js";
import type {
  ImageTaskRecord,
  ImageTasksRepository
} from "../../infrastructure/database/image-tasks-repository.js";
import type { BillingService } from "./billing-service.js";
import type { ImageTaskService } from "../image-tasks/image-task-service.js";

export interface BillingReconciliationListResult {
  items: BillingReconciliationTaskRecord[];
  page: number;
  page_size: number;
  total: number;
}

export interface BillingReconciliationActionResult {
  task: BillingReconciliationTaskRecord;
  attempt: BillingReconciliationAttemptRecord;
  attempts: BillingReconciliationAttemptRecord[];
}

export class BillingReconciliationServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "BillingReconciliationServiceError";
  }
}

export class BillingReconciliationService {
  constructor(
    private readonly reconciliationRepository: BillingReconciliationRepository,
    private readonly imageTasksRepository: Pick<ImageTasksRepository, "findById">,
    private readonly imageTaskService: Pick<ImageTaskService, "transitionTask">,
    private readonly billingService: Pick<BillingService, "release">
  ) {}

  async listPending(input: {
    page?: number;
    pageSize?: number;
  }): Promise<BillingReconciliationListResult> {
    const page = normalizePositiveInteger(input.page ?? 1, "page");
    const pageSize = normalizePageSize(input.pageSize ?? 20);
    const result = await this.reconciliationRepository.listPending({ page, pageSize });

    return {
      items: result.items,
      page,
      page_size: pageSize,
      total: result.total
    };
  }

  async retrySettle(input: {
    actorUserId: number;
    taskId: string;
    requestId: string;
  }): Promise<BillingReconciliationActionResult> {
    const task = await this.loadTask(input.taskId);
    const beforeStatus = task.status;
    const beforeErrorCode = task.error_code;

    if (task.status !== "billing_pending") {
      throw new BillingReconciliationServiceError(
        "RECONCILIATION_SETTLE_NOT_ALLOWED",
        "只有 billing_pending 任务可以重试结算。",
        409
      );
    }

    // 高风险对账操作先落一条 attempt，再触达计费状态流转，避免外部结算成功但审计记录缺失。
    const startedAttempt = await this.reconciliationRepository.createAttempt({
      id: createAttemptId(),
      task_id: task.id,
      owner_user_id: task.owner_user_id,
      actor_user_id: input.actorUserId,
      action: "retry_settle",
      before_task_status: beforeStatus,
      after_task_status: beforeStatus,
      before_error_code: beforeErrorCode,
      after_error_code: beforeErrorCode,
      billing_event_id: task.billing_event_id,
      billing_event_status: "settle_retrying",
      result: "pending",
      error_code: null,
      error_message: null,
      request_id: input.requestId
    });

    try {
      const transition = await this.imageTaskService.transitionTask({
        ownerUserId: task.owner_user_id,
        taskId: task.id,
        toStatus: "succeeded"
      });
      const attempt = await this.reconciliationRepository.updateAttemptResult({
        attemptId: startedAttempt.id,
        after_task_status: transition.task.status,
        after_error_code: transition.task.error_code,
        billing_event_id: transition.task.billing_event_id,
        billing_event_status: transition.task.status === "succeeded" ? "settled" : "settle_pending",
        result: transition.task.status === "succeeded" ? "succeeded" : "pending",
        error_code: transition.task.error_code,
        error_message: transition.task.error_message
      });

      return await this.buildActionResult(task.id, attempt);
    } catch (error: unknown) {
      const attempt = await this.updateFailedAttempt(startedAttempt, task, error);

      return await this.buildActionResult(task.id, attempt);
    }
  }

  async retryRelease(input: {
    actorUserId: number;
    taskId: string;
    requestId: string;
  }): Promise<BillingReconciliationActionResult> {
    const task = await this.loadTask(input.taskId);
    const beforeStatus = task.status;
    const beforeErrorCode = task.error_code;

    if (task.status !== "failed" || task.error_code !== "BILLING_RELEASE_PENDING") {
      throw new BillingReconciliationServiceError(
        "RECONCILIATION_RELEASE_NOT_ALLOWED",
        "只有释放失败的任务可以重试释放。",
        409
      );
    }

    if (task.billing_event_id === null) {
      throw new BillingReconciliationServiceError(
        "RECONCILIATION_BILLING_EVENT_MISSING",
        "任务缺少预占计费事件，无法重试释放。",
        409
      );
    }

    // release 重试同样先写 attempt，再重新触达墨灵释放接口；失败原因会写回同一条记录。
    const startedAttempt = await this.reconciliationRepository.createAttempt({
      id: createAttemptId(),
      task_id: task.id,
      owner_user_id: task.owner_user_id,
      actor_user_id: input.actorUserId,
      action: "retry_release",
      before_task_status: beforeStatus,
      after_task_status: beforeStatus,
      before_error_code: beforeErrorCode,
      after_error_code: beforeErrorCode,
      billing_event_id: task.billing_event_id,
      billing_event_status: "release_retrying",
      result: "pending",
      error_code: null,
      error_message: null,
      request_id: input.requestId
    });

    try {
      const release = await this.billingService.release({
        ownerUserId: task.owner_user_id,
        taskId: task.id,
        reserveBillingEventId: task.billing_event_id,
        idempotencyKey: `${task.id}:${task.task_type}:release`,
        reasonCode: task.error_code,
        reasonMessage: task.error_message ?? "任务失败，积分释放等待对账。",
        retryPending: true
      });

      if (release.released) {
        await this.reconciliationRepository.markReleaseReconciled({
          taskId: task.id,
          ownerUserId: task.owner_user_id,
          errorCode: "BILLING_RELEASED",
          errorMessage: "任务失败，积分已释放。"
        });
      }

      const latestTask = await this.loadTask(task.id);
      const attempt = await this.reconciliationRepository.updateAttemptResult({
        attemptId: startedAttempt.id,
        after_task_status: latestTask.status,
        after_error_code: latestTask.error_code,
        billing_event_id: release.billing_event.id,
        billing_event_status: release.billing_event.status,
        result: release.released ? "succeeded" : "pending",
        error_code: release.released ? null : release.billing_event.error_code,
        error_message: release.released ? null : release.billing_event.error_message
      });

      return await this.buildActionResult(task.id, attempt);
    } catch (error: unknown) {
      const attempt = await this.updateFailedAttempt(startedAttempt, task, error);

      return await this.buildActionResult(task.id, attempt);
    }
  }

  private async loadTask(taskId: string) {
    const task = await this.imageTasksRepository.findById(
      normalizeRequiredString(taskId, "task_id")
    );

    if (task === undefined) {
      throw new BillingReconciliationServiceError(
        "RECONCILIATION_TASK_NOT_FOUND",
        "待对账任务不存在。",
        404
      );
    }

    return task;
  }

  private async buildActionResult(
    taskId: string,
    attempt: BillingReconciliationAttemptRecord
  ): Promise<BillingReconciliationActionResult> {
    const refreshed = await this.reconciliationRepository.listPending({ page: 1, pageSize: 100 });
    const currentTask = await this.imageTasksRepository.findById(taskId);
    const task =
      refreshed.items.find((item) => item.id === taskId) ??
      (currentTask === undefined
        ? toResolvedTask(attempt)
        : toReconciliationTask(currentTask, attempt));

    return {
      task,
      attempt,
      attempts: await this.reconciliationRepository.listAttempts(taskId)
    };
  }

  private async updateFailedAttempt(
    attempt: BillingReconciliationAttemptRecord,
    task: {
      status: string;
      error_code: string | null;
      billing_event_id: string | null;
    },
    error: unknown
  ): Promise<BillingReconciliationAttemptRecord> {
    const errorCode =
      error instanceof BillingReconciliationServiceError
        ? error.code
        : error instanceof Error
          ? error.name
          : "RECONCILIATION_FAILED";
    const errorMessage = error instanceof Error ? error.message : "对账处理失败。";

    return await this.reconciliationRepository.updateAttemptResult({
      attemptId: attempt.id,
      after_task_status: task.status,
      after_error_code: task.error_code,
      billing_event_id: task.billing_event_id,
      billing_event_status: null,
      result: "failed",
      error_code: errorCode,
      error_message: errorMessage
    });
  }
}

function toReconciliationTask(
  task: ImageTaskRecord,
  attempt: BillingReconciliationAttemptRecord
): BillingReconciliationTaskRecord {
  return {
    id: task.id,
    owner_user_id: task.owner_user_id,
    task_type: task.task_type,
    status: task.status,
    cost_points: task.cost_points,
    billing_event_id: task.billing_event_id,
    error_code: task.error_code,
    error_message: task.error_message,
    created_at: task.created_at,
    updated_at: task.updated_at,
    latest_billing_event_id: attempt.billing_event_id,
    latest_billing_event_type: null,
    latest_billing_event_status: attempt.billing_event_status,
    latest_billing_event_error_code: attempt.error_code,
    latest_billing_event_error_message: attempt.error_message,
    latest_reconciliation_result: attempt.result,
    latest_reconciliation_error_code: attempt.error_code,
    latest_reconciliation_error_message: attempt.error_message,
    latest_reconciliation_created_at: attempt.created_at
  };
}

function normalizeRequiredString(value: string, field: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new BillingReconciliationServiceError(
      "RECONCILIATION_FIELD_REQUIRED",
      `${field} 不能为空。`,
      400
    );
  }

  return normalized;
}

function normalizePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new BillingReconciliationServiceError(
      "RECONCILIATION_FIELD_INVALID",
      `${field} 必须是正整数。`,
      400
    );
  }

  return value;
}

function normalizePageSize(value: number): number {
  const pageSize = normalizePositiveInteger(value, "page_size");

  if (pageSize > 100) {
    throw new BillingReconciliationServiceError(
      "RECONCILIATION_FIELD_INVALID",
      "page_size 不能超过 100。",
      400
    );
  }

  return pageSize;
}

function createAttemptId(): string {
  return `reconcile_${randomUUID().replaceAll("-", "")}`;
}

function toResolvedTask(
  attempt: BillingReconciliationAttemptRecord
): BillingReconciliationTaskRecord {
  return {
    id: attempt.task_id,
    owner_user_id: attempt.owner_user_id,
    task_type: "",
    status: attempt.after_task_status as BillingReconciliationTaskRecord["status"],
    cost_points: null,
    billing_event_id: attempt.billing_event_id,
    error_code: attempt.after_error_code,
    error_message: attempt.error_message,
    created_at: attempt.created_at,
    updated_at: attempt.created_at,
    latest_billing_event_id: attempt.billing_event_id,
    latest_billing_event_type: null,
    latest_billing_event_status: attempt.billing_event_status,
    latest_billing_event_error_code: attempt.error_code,
    latest_billing_event_error_message: attempt.error_message,
    latest_reconciliation_result: attempt.result,
    latest_reconciliation_error_code: attempt.error_code,
    latest_reconciliation_error_message: attempt.error_message,
    latest_reconciliation_created_at: attempt.created_at
  };
}
