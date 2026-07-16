import { createHash, randomUUID } from "node:crypto";

import type { ImageTaskCreationRepository } from "../../infrastructure/database/image-task-outbox-repository.js";
import type {
  CreateImageTaskRecordInput,
  ImageTaskRecord,
  ImageTasksRepository,
  ImageTaskStatus
} from "../../infrastructure/database/image-tasks-repository.js";
import type {
  BillingService,
  ReleaseBillingResult,
  SettleBillingResult
} from "../billing/billing-service.js";
import type { RiskControlService } from "../risk-control/risk-control-service.js";
import { isSupportedImageRestoreType, isSupportedImageTaskType } from "./image-task-types.js";

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
  upscaleFactor?: number;
  sourceTaskId?: string;
  sourceFileId?: string;
  idempotencyKey?: string;
  requestId?: string;
  requestIp?: string;
  entitlementId?: number;
  expectedPricingRuleId?: string | null;
  expectedPoints?: string;
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
  /** 仅供独立 Worker 使用，防止过期执行者结算或覆盖新执行者结果。 */
  workerLockToken?: string;
}

export interface RecordWorkerOutputRequest {
  ownerUserId: number;
  taskId: string;
  fileId: string;
  gatewayRequestId: string;
  workerLockToken?: string;
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

export interface ImageTaskAuditEvent {
  event_type: "source_task_access_denied";
  actor_user_id: number;
  source_task_id: string;
  reason: "owner_mismatch";
}

export interface ImageTaskAuditLogger {
  record(event: ImageTaskAuditEvent): void | Promise<void>;
}

export interface ImageTaskModelResolver {
  resolveTaskModel(
    userId: number,
    input: {
      taskType: string;
      gatewayModelCode?: string | null;
      gatewayCapability?: string | null;
      imageSize?: string | null;
      imageCount?: number;
      inputFileCount?: number;
    }
  ): Promise<{ gatewayModelCode: string; gatewayCapability: string } | null>;
}

export interface ImageTaskStylePresetResolver {
  getEnabledPresetForTask(
    taskType: string,
    presetId: string
  ): Promise<{ prompt_template: string } | undefined>;
}

export interface PublicImageTask {
  id: string;
  source_task_id: string | null;
  source_file_id: string | null;
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
  upscale_factor: number | null;
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

const allowedTransitions: Readonly<Record<ImageTaskStatus, readonly ImageTaskStatus[]>> = {
  pending: ["billing_reserved", "queued", "failed", "cancelled"],
  billing_reserved: ["queued", "billing_pending", "failed", "cancelled"],
  queued: ["running", "failed", "cancelled"],
  running: ["succeeded", "failed", "billing_pending"],
  billing_pending: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
  cancelled: []
};

export class ImageTaskService {
  constructor(
    private readonly repository: ImageTasksRepository,
    private readonly billingService?: Pick<BillingService, "release" | "reserve" | "settle">,
    private readonly auditLogger?: ImageTaskAuditLogger,
    private readonly modelResolver?: ImageTaskModelResolver,
    private readonly stylePresetResolver?: ImageTaskStylePresetResolver,
    private readonly riskControlService?: Pick<RiskControlService, "assertAllowed">,
    private readonly taskCreationRepository?: ImageTaskCreationRepository
  ) {}

  async createTask(request: CreateImageTaskRequest): Promise<ImageTaskResult> {
    const taskType = normalizeRequiredString(request.taskType, "task_type");

    if (!isSupportedImageTaskType(taskType)) {
      throw new ImageTaskServiceError("TASK_TYPE_UNSUPPORTED", "当前不支持该图片任务类型。", 400);
    }

    const imageCount = request.imageCount ?? 1;

    if (!Number.isInteger(imageCount) || imageCount < 1 || imageCount > 8) {
      throw new ImageTaskServiceError("IMAGE_COUNT_INVALID", "图片数量必须在 1 到 8 之间。", 400);
    }

    const inputFileIds = normalizeStringArray(request.inputFileIds ?? [], "input_file_ids");
    const prompt = normalizeOptionalString(request.prompt);
    const negativePrompt = normalizeOptionalString(request.negativePrompt);
    const stylePresetId = normalizeOptionalString(request.stylePresetId);
    const requestedGatewayModelCode = normalizeOptionalString(request.gatewayModelCode);
    const requestedGatewayCapability = normalizeOptionalString(request.gatewayCapability);
    const quality = normalizeOptionalString(request.quality);
    const imageSize = normalizeOptionalString(request.imageSize);
    const resolvedModel =
      this.modelResolver === undefined
        ? null
        : await this.modelResolver.resolveTaskModel(request.ownerUserId, {
            taskType,
            gatewayModelCode: requestedGatewayModelCode,
            gatewayCapability: requestedGatewayCapability,
            imageSize,
            imageCount,
            inputFileCount: inputFileIds.length
          });
    const gatewayModelCode =
      this.modelResolver === undefined
        ? requestedGatewayModelCode
        : (resolvedModel?.gatewayModelCode ?? null);
    const gatewayCapability =
      this.modelResolver === undefined
        ? requestedGatewayCapability
        : (resolvedModel?.gatewayCapability ?? null);
    const upscaleFactor = request.upscaleFactor ?? null;
    const sourceTaskId = normalizeOptionalString(request.sourceTaskId);
    const sourceFileId = normalizeOptionalString(request.sourceFileId);
    const entitlementId = request.entitlementId ?? null;

    if (sourceTaskId === null && sourceFileId !== null) {
      // 来源文件必须绑定来源任务，避免客户端提交无法验证归属的孤立文件链路。
      throw new ImageTaskServiceError(
        "SOURCE_FILE_WITHOUT_TASK",
        "来源文件必须与来源任务同时提供。",
        400
      );
    }

    if (entitlementId !== null && (!Number.isInteger(entitlementId) || entitlementId < 1)) {
      throw new ImageTaskServiceError("ENTITLEMENT_ID_INVALID", "权益 ID 必须是正整数。", 400);
    }

    if (this.modelResolver !== undefined && resolvedModel === null) {
      // 模型可见性和能力匹配必须在计费预占前完成，避免关闭模型或错误能力消耗用户积分。
      throw new ImageTaskServiceError(
        "IMAGE_MODEL_UNAVAILABLE",
        "当前模型不可用，或模型能力不支持该任务类型。",
        400
      );
    }

    if (stylePresetId !== null && this.stylePresetResolver !== undefined) {
      const stylePreset = await this.stylePresetResolver.getEnabledPresetForTask(
        taskType,
        stylePresetId
      );

      if (stylePreset === undefined) {
        // 风格模板必须在计费前确认仍启用，停用模板不能继续产生新任务或占用额度。
        throw new ImageTaskServiceError(
          "STYLE_PRESET_UNAVAILABLE",
          "风格模板不可用或已停用。",
          400
        );
      }
    }

    const taskCreateIdempotencyKey =
      normalizeOptionalString(request.idempotencyKey) ?? `task_create_${randomUUID()}`;
    const existingTask = await this.repository.findByIdempotencyKey(taskCreateIdempotencyKey);

    if (existingTask !== undefined) {
      if (existingTask.owner_user_id !== request.ownerUserId) {
        throw new ImageTaskServiceError("IMAGE_TASK_FORBIDDEN", "不能访问他人的图片任务。", 403);
      }

      assertIdempotentTaskMatches(existingTask, {
        taskType,
        prompt,
        negativePrompt,
        stylePresetId,
        inputFileIds,
        gatewayModelCode,
        gatewayCapability,
        quality,
        imageSize,
        imageCount,
        upscaleFactor,
        sourceTaskId,
        sourceFileId,
        entitlementId
      });

      // 幂等键命中时直接返回已有任务；来源后来被删除也不能改变首次成功请求的结果。
      return {
        task: toPublicImageTask(existingTask)
      };
    }

    if (taskType === "image_restore") {
      if (inputFileIds.length !== 1) {
        throw new ImageTaskServiceError(
          "INPUT_IMAGE_REQUIRED",
          "图片修复任务必须关联一张原图。",
          400
        );
      }

      if (
        stylePresetId === null ||
        (this.stylePresetResolver === undefined && !isSupportedImageRestoreType(stylePresetId))
      ) {
        // 修复类型在计费预占前收紧，防止非法字符串进入 worker 后静默降级并占用额度。
        throw new ImageTaskServiceError("IMAGE_RESTORE_TYPE_INVALID", "图片修复类型不合法。", 400);
      }
    }

    if (taskType === "upscale") {
      if (inputFileIds.length !== 1) {
        throw new ImageTaskServiceError(
          "INPUT_IMAGE_REQUIRED",
          "高清放大任务必须关联一张原图。",
          400
        );
      }

      if (upscaleFactor !== 2 && upscaleFactor !== 4) {
        // 倍率在计费预占前校验，避免非法任务占用用户额度或进入 AI 网关。
        throw new ImageTaskServiceError(
          "UPSCALE_FACTOR_INVALID",
          "高清放大倍率只支持 2x 或 4x。",
          400
        );
      }

      if (imageCount !== 1) {
        throw new ImageTaskServiceError(
          "UPSCALE_IMAGE_COUNT_INVALID",
          "高清放大任务每次只能生成一张结果图。",
          400
        );
      }
    }

    if (sourceTaskId !== null) {
      await this.assertReeditSource({
        ownerUserId: request.ownerUserId,
        taskType,
        sourceTaskId,
        sourceFileId,
        inputFileIds
      });
    }

    if (this.riskControlService !== undefined) {
      // 风控必须在预占积分和写入任务之前完成，命中限流或高风险开关时不能产生计费事件，也不能让 worker 调用 AI 网关。
      await this.riskControlService.assertAllowed({
        requestId: normalizeOptionalString(request.requestId) ?? undefined,
        ownerUserId: request.ownerUserId,
        ipAddress: normalizeOptionalString(request.requestIp) ?? undefined,
        taskType,
        gatewayModelCode,
        gatewayCapability
      });
    }

    // 任务 ID 由用户与创建幂等键稳定派生，并发重复请求会复用同一个 reserve 幂等键。
    const taskId = createStableTaskId(request.ownerUserId, taskCreateIdempotencyKey);
    const reserveIdempotencyKey = `${taskId}:${taskType}:reserve`;
    const reservedBilling =
      this.billingService === undefined
        ? undefined
        : await this.billingService.reserve({
            ownerUserId: request.ownerUserId,
            taskId,
            taskType,
            imageCount,
            quality: quality ?? undefined,
            imageSize: imageSize ?? undefined,
            upscaleFactor: upscaleFactor ?? undefined,
            gatewayModelCode: gatewayModelCode ?? undefined,
            gatewayCapability: gatewayCapability ?? undefined,
            entitlementId: entitlementId ?? undefined,
            expectedRuleId: request.expectedPricingRuleId,
            expectedPoints: request.expectedPoints,
            idempotencyKey: reserveIdempotencyKey
          });
    const taskInput: CreateImageTaskRecordInput = {
      id: taskId,
      source_task_id: sourceTaskId,
      source_file_id: sourceFileId,
      owner_user_id: request.ownerUserId,
      entitlement_id: entitlementId,
      task_type: taskType,
      // 接入计费后，任务创建成功即表示预占已完成；余额不足会在写任务前抛错。
      status: reservedBilling === undefined ? "pending" : "billing_reserved",
      prompt,
      negative_prompt: negativePrompt,
      style_preset_id: stylePresetId,
      input_file_ids: inputFileIds,
      gateway_model_code: gatewayModelCode,
      gateway_capability: gatewayCapability,
      quality,
      image_size: imageSize,
      image_count: imageCount,
      upscale_factor: upscaleFactor,
      cost_points: reservedBilling?.estimate.estimated_points ?? null,
      billing_event_id: reservedBilling?.billing_event.id ?? null,
      idempotency_key: taskCreateIdempotencyKey
    };
    let task: ImageTaskRecord;

    try {
      task = await (this.taskCreationRepository ?? this.repository).create(taskInput);
    } catch (error: unknown) {
      if (reservedBilling !== undefined && this.billingService !== undefined) {
        // 预占已成功但任务与 Outbox 事务失败时，用稳定 release 幂等键补偿，避免形成孤立 hold。
        await this.billingService.release({
          ownerUserId: request.ownerUserId,
          taskId,
          reserveBillingEventId: reservedBilling.billing_event.id,
          idempotencyKey: `${taskId}:${taskType}:release`,
          reasonCode: "IMAGE_TASK_PERSISTENCE_FAILED",
          reasonMessage: "图片任务保存失败，已释放预占积分。"
        });
      }

      throw error;
    }

    // 并发唯一键冲突可能返回首次事务的任务，仍要核对参数，不能让相同幂等键代表不同请求。
    assertIdempotentTaskMatches(task, {
      taskType,
      prompt,
      negativePrompt,
      stylePresetId,
      inputFileIds,
      gatewayModelCode,
      gatewayCapability,
      quality,
      imageSize,
      imageCount,
      upscaleFactor,
      sourceTaskId,
      sourceFileId,
      entitlementId
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
    entitlementId?: number,
    requestContext?: { requestId?: string; requestIp?: string }
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
      upscaleFactor: sourceTask.upscale_factor ?? undefined,
      sourceTaskId: sourceTask.source_task_id ?? undefined,
      sourceFileId: sourceTask.source_file_id ?? undefined,
      entitlementId,
      requestId: requestContext?.requestId,
      requestIp: requestContext?.requestIp,
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

    if (taskType !== null && !isSupportedImageTaskType(taskType)) {
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

    if (request.workerLockToken !== undefined) {
      const executionActive = await this.repository.isExecutionActive?.({
        taskId: request.taskId,
        lockToken: request.workerLockToken
      });

      if (executionActive !== true) {
        // 先验证数据库租约再触发结算或释放，过期 Worker 不得改变计费与任务终态。
        throw new ImageTaskServiceError(
          "IMAGE_TASK_WORKER_LEASE_LOST",
          "任务执行权已转移，当前 Worker 不能继续提交结果。",
          409
        );
      }
    }

    assertTransitionAllowed(currentTask.status, request.toStatus);
    assertFailureReason(request);
    const settleResult =
      request.toStatus === "succeeded"
        ? await this.settleReservedBilling(currentTask, request)
        : undefined;
    const releaseResult =
      request.toStatus === "failed" || request.toStatus === "cancelled"
        ? await this.releaseReservedBilling(currentTask, request)
        : undefined;
    const persistedStatus = settleResult?.settled === false ? "billing_pending" : request.toStatus;

    const updatedTask = await this.repository.updateStatus({
      taskId: request.taskId,
      ownerUserId: request.ownerUserId,
      fromStatus: currentTask.status,
      toStatus: persistedStatus,
      outputFileIds:
        request.outputFileIds === undefined
          ? undefined
          : normalizeStringArray(request.outputFileIds, "output_file_ids"),
      textResult: normalizeOptionalString(request.textResult),
      gatewayRequestId: normalizeOptionalString(request.gatewayRequestId),
      // 任务始终保留 reserve 事件 ID，待对账重试或最终释放都需要原 hold 关联。
      billingEventId: normalizeOptionalString(request.billingEventId),
      errorCode:
        settleResult?.settled === false
          ? "BILLING_SETTLE_PENDING"
          : releaseResult?.released === false
            ? "BILLING_RELEASE_PENDING"
            : normalizeOptionalString(request.errorCode),
      errorMessage:
        settleResult?.settled === false
          ? "图片已生成，积分结算等待对账。"
          : releaseResult?.released === false
            ? "任务失败，积分释放等待对账。"
            : normalizeOptionalString(request.errorMessage),
      workerLockToken: request.workerLockToken
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

  async recordWorkerOutput(request: RecordWorkerOutputRequest): Promise<ImageTaskResult> {
    if (this.repository.recordOutputFile === undefined) {
      if (request.workerLockToken !== undefined) {
        throw new ImageTaskServiceError(
          "IMAGE_TASK_WORKER_STORAGE_UNAVAILABLE",
          "任务仓储不支持 Worker 结果登记。",
          500
        );
      }

      // 内存测试仓储和旧 inline 适配器仍由最终 succeeded 流转一次性写入 output_file_ids。
      const currentTask = await this.repository.findById(request.taskId);

      if (currentTask?.owner_user_id !== request.ownerUserId) {
        throw new ImageTaskServiceError("IMAGE_TASK_NOT_FOUND", "图片任务不存在。", 404);
      }

      return { task: toPublicImageTask(currentTask) };
    }

    const updatedTask = await this.repository.recordOutputFile({
      taskId: request.taskId,
      ownerUserId: request.ownerUserId,
      fileId: request.fileId,
      gatewayRequestId: request.gatewayRequestId,
      workerLockToken: request.workerLockToken
    });

    if (updatedTask === undefined) {
      // 文件已进入对象存储后立即登记；若租约已失效则拒绝把它挂到其他执行者的任务上。
      throw new ImageTaskServiceError(
        "IMAGE_TASK_WORKER_LEASE_LOST",
        "任务执行权已转移，结果文件登记失败。",
        409
      );
    }

    return { task: toPublicImageTask(updatedTask) };
  }

  async markTaskQueued(taskId: string): Promise<void> {
    const task = await this.repository.findById(taskId);

    if (task === undefined) {
      throw new ImageTaskServiceError("IMAGE_TASK_NOT_FOUND", "图片任务不存在。", 404);
    }

    if (task.status === "queued" || task.status === "running" || task.status === "succeeded") {
      // Dispatcher 重放时已推进的任务直接视为成功，不能反向修改状态。
      return;
    }

    if (task.status !== "pending" && task.status !== "billing_reserved") {
      throw new ImageTaskServiceError(
        "IMAGE_TASK_QUEUE_STATUS_INVALID",
        "当前任务状态不能进入队列。",
        409
      );
    }

    await this.transitionTask({
      ownerUserId: task.owner_user_id,
      taskId: task.id,
      toStatus: "queued"
    });
  }

  async cancelTaskForDispatchTimeout(taskId: string): Promise<void> {
    const task = await this.repository.findById(taskId);

    if (task === undefined || task.status === "cancelled" || task.status === "failed") {
      return;
    }

    if (
      task.status !== "pending" &&
      task.status !== "billing_reserved" &&
      task.status !== "queued"
    ) {
      // 已开始运行或进入终态的任务不再按 Outbox 超时取消，避免与 Worker 竞争结果。
      return;
    }

    await this.transitionTask({
      ownerUserId: task.owner_user_id,
      taskId: task.id,
      toStatus: "cancelled",
      errorCode: "OUTBOX_DISPATCH_TIMEOUT",
      errorMessage: "任务等待入队超时，已取消。"
    });
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

  private async settleReservedBilling(
    currentTask: ImageTaskRecord,
    request: TransitionImageTaskRequest
  ): Promise<SettleBillingResult | undefined> {
    if (this.billingService === undefined || currentTask.billing_event_id === null) {
      return undefined;
    }

    // 成功任务必须先结算预占积分；失败时保留结果并进入 billing_pending 等待对账。
    return await this.billingService.settle({
      ownerUserId: request.ownerUserId,
      taskId: request.taskId,
      reserveBillingEventId: currentTask.billing_event_id,
      idempotencyKey: `${request.taskId}:${currentTask.task_type}:settle`,
      actualAmount: currentTask.cost_points ?? undefined,
      retryPending: currentTask.status === "billing_pending"
    });
  }

  private async assertReeditSource(input: {
    ownerUserId: number;
    taskType: string;
    sourceTaskId: string;
    sourceFileId: string | null;
    inputFileIds: string[];
  }): Promise<void> {
    if (input.taskType !== "image_to_image") {
      throw new ImageTaskServiceError(
        "SOURCE_TASK_TYPE_INVALID",
        "再次编辑只能创建图生图任务。",
        400
      );
    }

    const sourceTask = await this.repository.findById(input.sourceTaskId);

    if (sourceTask === undefined) {
      throw new ImageTaskServiceError("SOURCE_TASK_NOT_FOUND", "来源任务不存在。", 404);
    }

    // 来源任务必须归属当前会话用户，不能借 source_task_id 枚举或复用他人的生成结果。
    if (sourceTask.owner_user_id !== input.ownerUserId) {
      await this.recordAuditEvent({
        event_type: "source_task_access_denied",
        actor_user_id: input.ownerUserId,
        source_task_id: input.sourceTaskId,
        reason: "owner_mismatch"
      });
      throw new ImageTaskServiceError("SOURCE_TASK_FORBIDDEN", "不能再次编辑他人的任务。", 403);
    }

    // 只有仍在历史中可用的成功作品才能再次编辑，失败、处理中或已删除任务一律拒绝。
    if (sourceTask.status !== "succeeded" || sourceTask.deleted_at !== null) {
      throw new ImageTaskServiceError(
        "SOURCE_TASK_NOT_AVAILABLE",
        "来源任务尚未成功或已被删除。",
        409
      );
    }

    if (input.inputFileIds.length !== 1) {
      throw new ImageTaskServiceError(
        "SOURCE_TASK_FILE_MISMATCH",
        "输入图片不是来源任务的生成结果。",
        400
      );
    }

    const sourceFileId = input.sourceFileId ?? input.inputFileIds[0];

    if (!sourceTask.output_file_ids.includes(sourceFileId)) {
      // 标注图是新上传文件，不能再要求其 ID 等于原结果；改为单独校验声明的来源文件。
      throw new ImageTaskServiceError(
        "SOURCE_TASK_FILE_MISMATCH",
        "输入图片不是来源任务的生成结果。",
        400
      );
    }
  }

  private async recordAuditEvent(event: ImageTaskAuditEvent): Promise<void> {
    try {
      await this.auditLogger?.record(event);
    } catch {
      // 审计旁路故障不能改变权限拒绝结果，避免日志系统异常放大为接口可用性问题。
    }
  }
}

function assertTransitionAllowed(fromStatus: ImageTaskStatus, toStatus: ImageTaskStatus): void {
  const nextStatuses = allowedTransitions[fromStatus];

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

interface NormalizedTaskCreationParameters {
  taskType: string;
  prompt: string | null;
  negativePrompt: string | null;
  stylePresetId: string | null;
  inputFileIds: string[];
  gatewayModelCode: string | null;
  gatewayCapability: string | null;
  quality: string | null;
  imageSize: string | null;
  imageCount: number;
  upscaleFactor: number | null;
  sourceTaskId: string | null;
  sourceFileId: string | null;
  entitlementId: number | null;
}

function assertIdempotentTaskMatches(
  existingTask: ImageTaskRecord,
  input: NormalizedTaskCreationParameters
): void {
  const matches =
    existingTask.task_type === input.taskType &&
    existingTask.prompt === input.prompt &&
    existingTask.negative_prompt === input.negativePrompt &&
    existingTask.style_preset_id === input.stylePresetId &&
    arraysEqual(existingTask.input_file_ids, input.inputFileIds) &&
    existingTask.gateway_model_code === input.gatewayModelCode &&
    existingTask.gateway_capability === input.gatewayCapability &&
    existingTask.quality === input.quality &&
    existingTask.image_size === input.imageSize &&
    existingTask.image_count === input.imageCount &&
    existingTask.upscale_factor === input.upscaleFactor &&
    existingTask.source_task_id === input.sourceTaskId &&
    existingTask.source_file_id === input.sourceFileId &&
    existingTask.entitlement_id === input.entitlementId;

  if (!matches) {
    // 同一幂等键不能代表两组不同参数，否则调用方可能误以为新参数已经生效。
    throw new ImageTaskServiceError(
      "IMAGE_TASK_IDEMPOTENCY_CONFLICT",
      "幂等键已被其他任务参数使用。",
      409
    );
  }
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function createStableTaskId(ownerUserId: number, idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(`${String(ownerUserId)}:${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32);

  return `task_${digest}`;
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
    source_task_id: task.source_task_id,
    source_file_id: task.source_file_id,
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
    upscale_factor: task.upscale_factor,
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
