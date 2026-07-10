import { randomUUID } from "node:crypto";

import type {
  ImageTaskRecord,
  ImageTasksRepository,
  ImageTaskStatus
} from "../../infrastructure/database/image-tasks-repository.js";
import type { BillingService, ReleaseBillingResult } from "../billing/billing-service.js";

export type { ImageTaskStatus };

export interface CreateImageTaskRequest {
  ownerUserId: number;
  taskType: string;
  prompt?: string;
  negativePrompt?: string;
  stylePresetId?: string;
  inputFileIds?: string[];
  gatewayModelCode?: string;
  gatewayCapability?: string;
  quality?: string;
  imageSize?: string;
  imageCount?: number;
  idempotencyKey?: string;
  entitlementId?: number;
}

export interface TransitionImageTaskRequest {
  ownerUserId: number;
  taskId: string;
  toStatus: ImageTaskStatus;
  outputFileIds?: string[];
  textResult?: string;
  gatewayRequestId?: string;
  billingEventId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface ImageTaskResult {
  task: PublicImageTask;
}

export interface ImageTaskHistoryResult {
  items: PublicImageTask[];
  page: number;
  page_size: number;
  total: number;
}

export interface ImageTaskFavoriteResult {
  task: PublicImageTask;
}

export interface ImageTaskDeleteResult {
  deleted: true;
  task_id: string;
}

export interface ImageTaskRetryResult {
  task: PublicImageTask;
  retried_from_task_id: string;
}

export interface PublicImageTask {
  id: string;
  owner_user_id: number;
  task_type: string;
  status: ImageTaskStatus;
  prompt: string | null;
  negative_prompt: string | null;
  style_preset_id: string | null;
  input_file_ids: string[];
  output_file_ids: string[];
  text_result: string | null;
  gateway_model_code: string | null;
  gateway_capability: string | null;
  gateway_request_id: string | null;
  quality: string | null;
  image_size: string | null;
  image_count: number;
  cost_points: string | null;
  billing_event_id: string | null;
  error_code: string | null;
  error_message: string | null;
  is_favorited: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export class ImageTaskServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "ImageTaskServiceError";
  }
}

const imageTaskStatuses = new Set<ImageTaskStatus>([
  "pending",
  "billing_reserved",
  "queued",
  "running",
  "succeeded",
  "failed",
  "billing_pending",
  "cancelled"
]);

const supportedTaskTypes = new Set([
  "text_to_image",
  "image_to_text",
  "image_to_image",
  "image_restore",
  "upscale"
]);

const supportedImageRestoreTypes = new Set(["old_photo", "denoise", "deblur", "color_enhance"]);

const allowedTransitions: ReadonlyMap<ImageTaskStatus, readonly ImageTaskStatus[]> = new Map([
  ["pending", ["billing_reserved", "queued", "failed", "cancelled"]],
  ["billing_reserved", ["queued", "billing_pending", "failed", "cancelled"]],
  ["queued", ["running", "failed", "cancelled"]],
  ["running", ["succeeded", "failed", "billing_pending"]],
  ["billing_pending", ["succeeded", "failed"]],
  ["succeeded", []],
  ["failed", []],
  ["cancelled", []]
]);

export class ImageTaskService {
  constructor(
    private readonly repository: ImageTasksRepository,
    private readonly billingService?: Pick<BillingService, "release" | "reserve">
  ) {}

  async createTask(request: CreateImageTaskRequest): Promise<ImageTaskResult> {
    const taskType = normalizeRequiredString(request.taskType, "task_type");

    if (!supportedTaskTypes.has(taskType)) {
      throw new ImageTaskServiceError("TASK_TYPE_UNSUPPORTED", "当前不支持该图片任务类型。", 400);
    }

    const imageCount = request.imageCount ?? 1;

    if (!Number.isInteger(imageCount) || imageCount < 1 || imageCount > 8) {
      throw new ImageTaskServiceError("IMAGE_COUNT_INVALID", "图片数量必须在 1 到 8 之间。", 400);
    }

    const inputFileIds = normalizeStringArray(request.inputFileIds ?? [], "input_file_ids");
    const stylePresetId = normalizeOptionalString(request.stylePresetId);

    if (taskType === "image_restore") {
      if (inputFileIds.length !== 1) {
        throw new ImageTaskServiceError(
          "INPUT_IMAGE_REQUIRED",
          "图片修复任务必须关联一张原图。",
          400
        );
      }

      if (stylePresetId === null || !supportedImageRestoreTypes.has(stylePresetId)) {
        // 修复类型在计费预占前收紧，防止非法字符串进入 worker 后静默降级并占用额度。
        throw new ImageTaskServiceError("IMAGE_RESTORE_TYPE_INVALID", "图片修复类型不合法。", 400);
      }
    }

    const taskId = `task_${randomUUID().replaceAll("-", "")}`;
    const taskCreateIdempotencyKey =
      normalizeOptionalString(request.idempotencyKey) ?? `task_create_${randomUUID()}`;

    const existingTask = await this.repository.findByIdempotencyKey(taskCreateIdempotencyKey);

    if (existingTask !== undefined) {
      if (existingTask.owner_user_id !== request.ownerUserId) {
        throw new ImageTaskServiceError("IMAGE_TASK_FORBIDDEN", "不能访问他人的图片任务。", 403);
      }

      // 幂等键命中时直接返回已有任务，避免重试接口或浏览器重复提交再次预占积分。
      return {
        task: toPublicImageTask(existingTask)
      };
    }

    const reserveIdempotencyKey = `${taskId}:${taskType}:reserve`;
    const reservedBilling =
      this.billingService === undefined
        ? undefined
        : await this.billingService.reserve({
            ownerUserId: request.ownerUserId,
            taskId,
            taskType,
            imageCount,
            quality: request.quality,
            imageSize: request.imageSize,
            entitlementId: request.entitlementId,
            idempotencyKey: reserveIdempotencyKey
          });
    const task = await this.repository.create({
      id: taskId,
      owner_user_id: request.ownerUserId,
      task_type: taskType,
      // 接入计费后，任务创建成功即表示预占已完成；余额不足会在写任务前抛错。
      status: reservedBilling === undefined ? "pending" : "billing_reserved",
      prompt: normalizeOptionalString(request.prompt),
      negative_prompt: normalizeOptionalString(request.negativePrompt),
      style_preset_id: stylePresetId,
      input_file_ids: inputFileIds,
      gateway_model_code: normalizeOptionalString(request.gatewayModelCode),
      gateway_capability: normalizeOptionalString(request.gatewayCapability),
      quality: normalizeOptionalString(request.quality),
      image_size: normalizeOptionalString(request.imageSize),
      image_count: imageCount,
      cost_points: reservedBilling?.estimate.estimated_points ?? null,
      billing_event_id: reservedBilling?.billing_event.id ?? null,
      idempotency_key: taskCreateIdempotencyKey
    });

    return {
      task: toPublicImageTask(task)
    };
  }

  async getTask(ownerUserId: number, taskId: string): Promise<ImageTaskResult> {
    const task = await this.repository.findById(taskId);

    if (task === undefined) {
      throw new ImageTaskServiceError("IMAGE_TASK_NOT_FOUND", "图片任务不存在。", 404);
    }

    if (task.deleted_at !== null) {
      throw new ImageTaskServiceError("IMAGE_TASK_NOT_FOUND", "图片任务不存在。", 404);
    }

    if (task.owner_user_id !== ownerUserId) {
      // 任务查询必须以 owner_user_id 为权限边界，避免用户通过 task_id 枚举他人任务。
      throw new ImageTaskServiceError("IMAGE_TASK_FORBIDDEN", "不能访问他人的图片任务。", 403);
    }

    return {
      task: toPublicImageTask(task)
    };
  }

  async favoriteHistoryItem(ownerUserId: number, taskId: string): Promise<ImageTaskFavoriteResult> {
    const normalizedTaskId = normalizeRequiredString(taskId, "task_id");
    const collectionId = `collection_${randomUUID().replaceAll("-", "")}`;
    const task = await this.repository.markFavorite({
      ownerUserId,
      taskId: normalizedTaskId,
      collectionId
    });

    if (task === undefined) {
      // 收藏只允许当前用户对自己的成功作品操作，软删除或未完成任务统一按不存在处理。
      throw new ImageTaskServiceError("IMAGE_TASK_NOT_FOUND", "作品不存在或不可收藏。", 404);
    }

    return {
      task: toPublicImageTask(task)
    };
  }

  async deleteHistoryItem(ownerUserId: number, taskId: string): Promise<ImageTaskDeleteResult> {
    const normalizedTaskId = normalizeRequiredString(taskId, "task_id");
    const task = await this.repository.softDeleteHistoryItem({
      ownerUserId,
      taskId: normalizedTaskId
    });

    if (task === undefined) {
      // 删除采用软删除，只影响历史列表可见性；对象存储清理交给后续异步任务。
      throw new ImageTaskServiceError("IMAGE_TASK_NOT_FOUND", "作品不存在或不可删除。", 404);
    }

    return {
      deleted: true,
      task_id: normalizedTaskId
    };
  }

  async retryTask(
    ownerUserId: number,
    taskId: string,
    entitlementId?: number
  ): Promise<ImageTaskRetryResult> {
    const sourceTask = await this.repository.findById(normalizeRequiredString(taskId, "task_id"));

    if (sourceTask?.deleted_at !== null) {
      throw new ImageTaskServiceError("IMAGE_TASK_NOT_FOUND", "图片任务不存在。", 404);
    }

    if (sourceTask.owner_user_id !== ownerUserId) {
      throw new ImageTaskServiceError("IMAGE_TASK_FORBIDDEN", "不能重试他人的图片任务。", 403);
    }

    if (sourceTask.status !== "failed") {
      throw new ImageTaskServiceError(
        "IMAGE_TASK_RETRY_NOT_ALLOWED",
        "只有失败任务可以重试。",
        409
      );
    }

    const retryResult = await this.createTask({
      ownerUserId,
      taskType: sourceTask.task_type,
      prompt: sourceTask.prompt ?? undefined,
      negativePrompt: sourceTask.negative_prompt ?? undefined,
      stylePresetId: sourceTask.style_preset_id ?? undefined,
      inputFileIds: sourceTask.input_file_ids,
      gatewayModelCode: sourceTask.gateway_model_code ?? undefined,
      gatewayCapability: sourceTask.gateway_capability ?? undefined,
      quality: sourceTask.quality ?? undefined,
      imageSize: sourceTask.image_size ?? undefined,
      imageCount: sourceTask.image_count,
      entitlementId,
      // 一个失败任务只生成一个稳定 retry task；重复点击重试按钮会返回同一个任务，防止重复扣费。
      idempotencyKey: `retry:${sourceTask.id}`
    });

    return {
      task: retryResult.task,
      retried_from_task_id: sourceTask.id
    };
  }

  async listHistory(input: {
    ownerUserId: number;
    taskType?: string;
    page?: number;
    pageSize?: number;
  }): Promise<ImageTaskHistoryResult> {
    const page = normalizePositiveInteger(input.page ?? 1, "page");
    const pageSize = normalizePageSize(input.pageSize ?? 20);
    const taskType = normalizeOptionalString(input.taskType);

    if (taskType !== null && !supportedTaskTypes.has(taskType)) {
      throw new ImageTaskServiceError("TASK_TYPE_UNSUPPORTED", "当前不支持该图片任务类型。", 400);
    }

    // 作品历史只按 owner_user_id 查询已成功任务，避免用户枚举他人任务或文本结果。
    const result = await this.repository.findHistoryByOwner({
      ownerUserId: input.ownerUserId,
      taskType: taskType ?? undefined,
      page,
      pageSize
    });

    return {
      items: result.items.map((task) => toPublicImageTask(task)),
      page,
      page_size: pageSize,
      total: result.total
    };
  }

  async transitionTask(request: TransitionImageTaskRequest): Promise<ImageTaskResult> {
    if (!imageTaskStatuses.has(request.toStatus)) {
      throw new ImageTaskServiceError("IMAGE_TASK_STATUS_INVALID", "目标状态不合法。", 400);
    }

    const currentTask = await this.repository.findById(request.taskId);

    if (currentTask === undefined) {
      throw new ImageTaskServiceError("IMAGE_TASK_NOT_FOUND", "图片任务不存在。", 404);
    }

    if (currentTask.owner_user_id !== request.ownerUserId) {
      throw new ImageTaskServiceError("IMAGE_TASK_FORBIDDEN", "不能修改他人的图片任务。", 403);
    }

    assertTransitionAllowed(currentTask.status, request.toStatus);
    assertFailureReason(request);
    const releaseResult =
      request.toStatus === "failed"
        ? await this.releaseReservedBilling(currentTask, request)
        : undefined;

    const updatedTask = await this.repository.updateStatus({
      taskId: request.taskId,
      ownerUserId: request.ownerUserId,
      fromStatus: currentTask.status,
      toStatus: request.toStatus,
      outputFileIds:
        request.outputFileIds === undefined
          ? undefined
          : normalizeStringArray(request.outputFileIds, "output_file_ids"),
      textResult: normalizeOptionalString(request.textResult),
      gatewayRequestId: normalizeOptionalString(request.gatewayRequestId),
      billingEventId: normalizeOptionalString(request.billingEventId),
      errorCode:
        releaseResult?.released === false
          ? "BILLING_RELEASE_PENDING"
          : normalizeOptionalString(request.errorCode),
      errorMessage:
        releaseResult?.released === false
          ? "任务失败，积分释放等待对账。"
          : normalizeOptionalString(request.errorMessage)
    });

    if (updatedTask === undefined) {
      // 并发 worker 或接口已推进状态时，不猜测最终状态，要求调用方重新查询后再决策。
      throw new ImageTaskServiceError(
        "IMAGE_TASK_STATUS_CONFLICT",
        "任务状态已变化，请刷新后重试。",
        409
      );
    }

    return {
      task: toPublicImageTask(updatedTask)
    };
  }

  private async releaseReservedBilling(
    currentTask: ImageTaskRecord,
    request: TransitionImageTaskRequest
  ): Promise<ReleaseBillingResult | undefined> {
    if (this.billingService === undefined || currentTask.billing_event_id === null) {
      return undefined;
    }

    // 失败状态落库前先释放预占积分；release 使用任务级稳定幂等键，worker 重放不会重复释放。
    return await this.billingService.release({
      ownerUserId: request.ownerUserId,
      taskId: request.taskId,
      reserveBillingEventId: currentTask.billing_event_id,
      idempotencyKey: `${request.taskId}:${currentTask.task_type}:release`,
      reasonCode: normalizeOptionalString(request.errorCode) ?? "IMAGE_TASK_FAILED",
      reasonMessage: normalizeOptionalString(request.errorMessage) ?? "图片任务失败。"
    });
  }
}

function assertTransitionAllowed(fromStatus: ImageTaskStatus, toStatus: ImageTaskStatus): void {
  const nextStatuses = allowedTransitions.get(fromStatus) ?? [];

  if (!nextStatuses.includes(toStatus)) {
    throw new ImageTaskServiceError(
      "IMAGE_TASK_STATUS_TRANSITION_INVALID",
      `不能从 ${fromStatus} 流转到 ${toStatus}。`,
      409
    );
  }
}

function assertFailureReason(request: TransitionImageTaskRequest): void {
  if (request.toStatus !== "failed" && request.toStatus !== "billing_pending") {
    return;
  }

  if (
    normalizeOptionalString(request.errorCode) === null ||
    normalizeOptionalString(request.errorMessage) === null
  ) {
    // 失败和待对账状态必须记录公开错误原因，方便前端展示、客服排查和后续对账。
    throw new ImageTaskServiceError(
      "IMAGE_TASK_FAILURE_REASON_REQUIRED",
      "失败或待对账状态必须填写错误码和错误信息。",
      400
    );
  }
}

function normalizeRequiredString(value: string, fieldName: string): string {
  const normalized = normalizeOptionalString(value);

  if (normalized === null) {
    throw new ImageTaskServiceError("REQUEST_FIELD_REQUIRED", `缺少字段 ${fieldName}。`, 400);
  }

  return normalized;
}

function normalizeOptionalString(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length === 0 ? null : trimmed;
}

function normalizeStringArray(value: string[], fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new ImageTaskServiceError("REQUEST_FIELD_INVALID", `字段 ${fieldName} 格式不正确。`, 400);
  }

  const normalized = value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new ImageTaskServiceError(
        "REQUEST_FIELD_INVALID",
        `字段 ${fieldName} 格式不正确。`,
        400
      );
    }

    return item.trim();
  });

  return [...new Set(normalized)];
}

function normalizePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ImageTaskServiceError(
      "REQUEST_FIELD_INVALID",
      `字段 ${fieldName} 必须是正整数。`,
      400
    );
  }

  return value;
}

function normalizePageSize(value: number): number {
  const pageSize = normalizePositiveInteger(value, "page_size");

  if (pageSize > 100) {
    throw new ImageTaskServiceError("REQUEST_FIELD_INVALID", "page_size 不能超过 100。", 400);
  }

  return pageSize;
}

function toPublicImageTask(task: ImageTaskRecord): PublicImageTask {
  return {
    id: task.id,
    owner_user_id: task.owner_user_id,
    task_type: task.task_type,
    status: task.status,
    prompt: task.prompt,
    negative_prompt: task.negative_prompt,
    style_preset_id: task.style_preset_id,
    input_file_ids: task.input_file_ids,
    output_file_ids: task.output_file_ids,
    text_result: task.text_result,
    gateway_model_code: task.gateway_model_code,
    gateway_capability: task.gateway_capability,
    gateway_request_id: task.gateway_request_id,
    quality: task.quality,
    image_size: task.image_size,
    image_count: task.image_count,
    cost_points: task.cost_points,
    billing_event_id: task.billing_event_id,
    error_code: task.error_code,
    error_message: task.error_message,
    is_favorited: task.is_favorited,
    deleted_at: task.deleted_at,
    created_at: task.created_at,
    updated_at: task.updated_at
  };
}
