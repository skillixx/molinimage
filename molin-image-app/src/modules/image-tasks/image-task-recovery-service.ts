import type {
  FailedImageTaskRecord,
  ImageTaskRecord
} from "../../infrastructure/database/image-tasks-repository.js";
import type { ImageTaskService } from "./image-task-service.js";

export interface ImageTaskRecoveryRepository {
  findById(taskId: string): Promise<ImageTaskRecord | undefined>;
  findFailedTasks(input: {
    page: number;
    pageSize: number;
  }): Promise<{ items: FailedImageTaskRecord[]; total: number }>;
}

export interface FailedImageTaskListItem {
  id: string;
  owner_user_id: number;
  task_type: string;
  error_code: string | null;
  error_message: string | null;
  worker_attempt_count: number;
  billing_event_id: string | null;
  billing_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface FailedImageTaskListResult {
  items: FailedImageTaskListItem[];
  page: number;
  page_size: number;
  total: number;
}

export interface ImageTaskRecoveryAuditEvent {
  event_type: "image_task_manual_replay";
  actor_user_id: number;
  owner_user_id: number;
  source_task_id: string;
  retry_task_id: string;
  request_id: string | null;
}

export interface ImageTaskRecoveryAuditLogger {
  record(event: ImageTaskRecoveryAuditEvent): void | Promise<void>;
}

export class ImageTaskRecoveryServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "ImageTaskRecoveryServiceError";
  }
}

export class ImageTaskRecoveryService {
  constructor(
    private readonly repository: ImageTaskRecoveryRepository,
    private readonly imageTaskService: Pick<ImageTaskService, "retryTask">,
    private readonly auditLogger?: ImageTaskRecoveryAuditLogger
  ) {}

  async listFailedTasks(input: {
    page?: number;
    pageSize?: number;
  }): Promise<FailedImageTaskListResult> {
    const page = normalizePositiveInteger(input.page ?? 1, "page");
    const pageSize = normalizePageSize(input.pageSize ?? 20);
    const result = await this.repository.findFailedTasks({ page, pageSize });

    return {
      items: result.items.map(toFailedListItem),
      page,
      page_size: pageSize,
      total: result.total
    };
  }

  async replayFailedTask(input: {
    taskId: string;
    actorUserId: number;
    requestId?: string;
  }): Promise<Awaited<ReturnType<ImageTaskService["retryTask"]>>> {
    const taskId = input.taskId.trim();

    if (taskId.length === 0 || taskId.length > 64) {
      throw new ImageTaskRecoveryServiceError("IMAGE_TASK_ID_INVALID", "图片任务 ID 不合法。", 400);
    }

    const sourceTask = await this.repository.findById(taskId);

    if (sourceTask?.deleted_at !== null) {
      throw new ImageTaskRecoveryServiceError("IMAGE_TASK_NOT_FOUND", "失败任务不存在。", 404);
    }

    if (sourceTask.status !== "failed") {
      throw new ImageTaskRecoveryServiceError(
        "IMAGE_TASK_REPLAY_NOT_ALLOWED",
        "只有最终失败的任务可以重新投递。",
        409
      );
    }

    if (sourceTask.error_code === "BILLING_RELEASE_PENDING") {
      // 原预占尚未释放时禁止创建新计费任务，必须先在对账中心完成释放。
      throw new ImageTaskRecoveryServiceError(
        "IMAGE_TASK_BILLING_RELEASE_PENDING",
        "原任务积分仍在释放中，请先完成计费对账。",
        409
      );
    }

    // 人工重投显式创建稳定 retry task，沿用原任务归属和权益，避免篡改已释放计费的终态记录。
    const result = await this.imageTaskService.retryTask(
      sourceTask.owner_user_id,
      sourceTask.id,
      sourceTask.entitlement_id ?? undefined,
      { requestId: input.requestId }
    );

    // 管理员代用户创建新计费任务属于高风险操作，必须同时记录操作者和真实任务所有者。
    await this.auditLogger?.record({
      event_type: "image_task_manual_replay",
      actor_user_id: input.actorUserId,
      owner_user_id: sourceTask.owner_user_id,
      source_task_id: sourceTask.id,
      retry_task_id: result.task.id,
      request_id: input.requestId ?? null
    });

    return result;
  }
}

function toFailedListItem(task: FailedImageTaskRecord): FailedImageTaskListItem {
  return {
    id: task.id,
    owner_user_id: task.owner_user_id,
    task_type: task.task_type,
    error_code: task.error_code,
    error_message: task.error_message,
    worker_attempt_count: task.worker_attempt_count ?? 0,
    billing_event_id: task.billing_event_id,
    billing_status: task.billing_status,
    created_at: task.created_at,
    updated_at: task.updated_at
  };
}

function normalizePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ImageTaskRecoveryServiceError("PAGINATION_INVALID", `${field} 必须是正整数。`, 400);
  }

  return value;
}

function normalizePageSize(value: number): number {
  const pageSize = normalizePositiveInteger(value, "page_size");

  if (pageSize > 100) {
    throw new ImageTaskRecoveryServiceError("PAGINATION_INVALID", "page_size 不能超过 100。", 400);
  }

  return pageSize;
}
