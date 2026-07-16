import { randomUUID } from "node:crypto";

import type {
  AiGatewayImageEditClient,
  AiGatewayImageGenerationClient,
  AiGatewayVisionTextClient
} from "../infrastructure/ai/ai-gateway-client.js";
import type { AiGatewayCallLogsRepository } from "../infrastructure/database/ai-gateway-call-logs-repository.js";
import type {
  ImageTaskRecord,
  ImageTasksRepository
} from "../infrastructure/database/image-tasks-repository.js";
import {
  FileServiceError,
  type FileContentResult,
  type FileService
} from "../modules/files/file-service.js";
import type {
  ImageTaskService,
  PublicImageTask
} from "../modules/image-tasks/image-task-service.js";
import { ImageTaskServiceError } from "../modules/image-tasks/image-task-service.js";
import {
  buildImageEditPromptWithTemplate,
  buildImageRestorePromptWithTemplate,
  buildTextToImagePromptWithTemplate,
  buildUpscalePrompt,
  buildVisionTextPrompt,
  resolveUpscaleTargetDimension
} from "./image-mode-prompts.js";
import {
  NoopImageOutputPostProcessor,
  type ImageOutputPostProcessor
} from "./image-output-post-processor.js";

export interface ProcessImageTaskResult {
  task: PublicImageTask;
}

export interface WorkerStylePresetResolver {
  getEnabledPresetForTask(
    taskType: string,
    presetId: string
  ): Promise<{ prompt_template: string } | undefined>;
}

export interface ImageTaskWorkerExecutionContext {
  workerLockToken: string;
  signal: AbortSignal;
  assertActive(): Promise<void>;
}

export class ImageGenerationWorkerService {
  constructor(
    private readonly taskRepository: ImageTasksRepository,
    private readonly taskService: Pick<ImageTaskService, "transitionTask"> &
      Partial<Pick<ImageTaskService, "recordWorkerOutput">>,
    private readonly fileService: Pick<FileService, "uploadFile" | "readFileContentBase64">,
    private readonly aiGatewayClient: AiGatewayImageGenerationClient,
    private readonly aiGatewayLogsRepository: AiGatewayCallLogsRepository,
    private readonly visionTextClient?: AiGatewayVisionTextClient,
    private readonly imageEditClient?: AiGatewayImageEditClient,
    private readonly stylePresetResolver?: WorkerStylePresetResolver,
    private readonly imageOutputPostProcessor: ImageOutputPostProcessor = new NoopImageOutputPostProcessor()
  ) {}

  async processTask(
    taskId: string,
    executionContext?: ImageTaskWorkerExecutionContext
  ): Promise<ProcessImageTaskResult> {
    const task = await this.taskRepository.findById(taskId);

    if (task === undefined) {
      throw new Error("图片任务不存在，worker 无法处理。");
    }

    await this.prepareTaskForExecution(task, executionContext);

    if (task.task_type === "image_to_text") {
      return await this.processImageToTextTask(task, executionContext);
    }

    if (task.task_type === "image_to_image") {
      return await this.processImageToImageTask(task, executionContext);
    }

    if (task.task_type === "image_restore") {
      return await this.processImageRestoreTask(task, executionContext);
    }

    if (task.task_type === "upscale") {
      return await this.processUpscaleTask(task, executionContext);
    }

    if (task.task_type !== "text_to_image") {
      throw new Error("当前 worker 只处理文生图、图生文、图生图、图片修复和高清放大任务。");
    }

    if (task.prompt === null || task.prompt.trim().length === 0) {
      return await this.failTask(
        task,
        "PROMPT_REQUIRED",
        "文生图任务缺少提示词。",
        executionContext
      );
    }

    const recovered = await this.completeRecoveredImageTask(
      task,
      task.image_count,
      executionContext
    );

    if (recovered !== undefined) {
      return recovered;
    }

    const startedAt = Date.now();
    let gatewayCompleted = false;

    try {
      await executionContext?.assertActive();
      const prompt = await this.buildTextToImagePrompt(task);
      const generated = await this.aiGatewayClient.generateImage({
        prompt,
        negativePrompt: task.negative_prompt,
        model: task.gateway_model_code ?? "image_generation",
        size: task.image_size ?? "1024x1024",
        count: task.image_count,
        signal: executionContext?.signal
      });
      gatewayCompleted = true;
      await executionContext?.assertActive();
      const outputFileIds: string[] = [];

      for (let index = 0; index < generated.images.length; index += 1) {
        const image = generated.images[index];
        await executionContext?.assertActive();
        // 文生图已由模型按目标宽高比完成构图，直接保存原图，避免 cover 裁切丢失主体或文字。
        const uploaded = await this.fileService.uploadFile({
          ownerUserId: task.owner_user_id,
          fileName: `${task.id}_${String(index + 1)}.png`,
          mimeType: image.mime_type,
          contentBase64: image.content_base64,
          fileType: "output",
          idempotencyKey: `${task.id}:text_to_image:${String(index + 1)}`
        });

        outputFileIds.push(uploaded.file.id);
        await this.recordOutputFile(task, uploaded.file.id, generated.request_id, executionContext);
      }

      await this.aiGatewayLogsRepository.create({
        id: `ailog_${randomUUID().replaceAll("-", "")}`,
        task_id: task.id,
        request_id: generated.request_id,
        gateway_model_code: task.gateway_model_code ?? "image_generation",
        gateway_capability: "image_generation",
        operation: "text_to_image",
        latency_ms: Date.now() - startedAt,
        success: true,
        usage_json: generated.usage,
        input_summary: summarizeText(prompt),
        output_summary: `generated_files=${String(outputFileIds.length)}`,
        error_code: null,
        error_message: null
      });

      return await this.taskService.transitionTask({
        ownerUserId: task.owner_user_id,
        taskId: task.id,
        toStatus: "succeeded",
        outputFileIds,
        gatewayRequestId: generated.request_id,
        workerLockToken: executionContext?.workerLockToken
      });
    } catch (error: unknown) {
      throwIfExecutionInterrupted(error, executionContext);
      const message = error instanceof Error ? error.message : "AI 网关图片生成失败。";
      const errorCode = gatewayCompleted ? "FILE_STORAGE_FAILED" : "AI_GATEWAY_FAILED";

      await this.aiGatewayLogsRepository.create({
        id: `ailog_${randomUUID().replaceAll("-", "")}`,
        task_id: task.id,
        request_id: `failed_${task.id}_${String(Date.now())}`,
        gateway_model_code: task.gateway_model_code ?? "image_generation",
        gateway_capability: "image_generation",
        operation: "text_to_image",
        latency_ms: Date.now() - startedAt,
        success: false,
        usage_json: null,
        input_summary: summarizeText(await this.buildTextToImagePrompt(task)),
        output_summary: null,
        error_code: errorCode,
        error_message: message
      });
      return await this.failTask(
        task,
        errorCode,
        resolvePublicWorkerErrorMessage(errorCode),
        executionContext
      );
    }
  }

  private async processImageToImageTask(
    task: ImageTaskRecord,
    executionContext?: ImageTaskWorkerExecutionContext
  ): Promise<ProcessImageTaskResult> {
    return await this.processImageEditTask(
      task,
      {
        operation: "image_to_image",
        resolveRequest: async () => ({
          prompt: await this.buildImageEditPrompt(task),
          size: task.image_size ?? "1024x1024",
          count: task.image_count
        }),
        unavailableMessage: "图生图模型服务暂不可用。",
        inputRequiredMessage: "图生图任务必须上传一张参考图。",
        gatewayFailedMessage: "AI 网关图生图调用失败。",
        outputFileLabel: "edit"
      },
      executionContext
    );
  }

  private async processImageRestoreTask(
    task: ImageTaskRecord,
    executionContext?: ImageTaskWorkerExecutionContext
  ): Promise<ProcessImageTaskResult> {
    return await this.processImageEditTask(
      task,
      {
        operation: "image_restore",
        resolveRequest: async () => ({
          prompt: await this.buildImageRestorePrompt(task),
          size: task.image_size ?? "1024x1024",
          count: task.image_count
        }),
        unavailableMessage: "图片修复模型服务暂不可用。",
        inputRequiredMessage: "图片修复任务必须上传一张原图。",
        gatewayFailedMessage: "AI 网关图片修复调用失败。",
        outputFileLabel: "restore"
      },
      executionContext
    );
  }

  private async processUpscaleTask(
    task: ImageTaskRecord,
    executionContext?: ImageTaskWorkerExecutionContext
  ): Promise<ProcessImageTaskResult> {
    const factor = task.upscale_factor;

    if (factor !== 2 && factor !== 4) {
      return await this.failTask(
        task,
        "UPSCALE_FACTOR_INVALID",
        "高清放大倍率只支持 2x 或 4x。",
        executionContext
      );
    }

    return await this.processImageEditTask(
      task,
      {
        operation: "upscale",
        resolveRequest: (inputFile) => {
          const inputWidth = inputFile.file.width;
          const inputHeight = inputFile.file.height;

          if (inputWidth === null || inputHeight === null) {
            throw new FileServiceError(
              "INPUT_IMAGE_DIMENSIONS_MISSING",
              "无法识别原图宽高，不能执行高清放大。",
              400
            );
          }

          const targetWidth = resolveUpscaleTargetDimension(inputWidth, factor);
          const targetHeight = resolveUpscaleTargetDimension(inputHeight, factor);
          const strictDimensions = task.gateway_capability === "upscale";

          return {
            prompt: buildUpscalePrompt(factor, targetWidth, targetHeight),
            size: `${String(targetWidth)}x${String(targetHeight)}`,
            count: 1,
            // 专用 upscale 模型必须按目标尺寸验收；OpenRouter/Gemini 这类 image_edit 通用模型会返回平台允许尺寸，先保存实际尺寸。
            expectedWidth: strictDimensions ? targetWidth : undefined,
            expectedHeight: strictDimensions ? targetHeight : undefined
          };
        },
        unavailableMessage: "高清放大模型服务暂不可用。",
        inputRequiredMessage: "高清放大任务必须上传一张原图。",
        gatewayFailedMessage: "AI 网关高清放大调用失败。",
        outputFileLabel: `upscale_${String(factor)}x`
      },
      executionContext
    );
  }

  private async processImageEditTask(
    task: ImageTaskRecord,
    options: {
      operation: "image_to_image" | "image_restore" | "upscale";
      resolveRequest: (inputFile: FileContentResult) =>
        | {
            prompt: string;
            size: string;
            count: number;
            expectedWidth?: number;
            expectedHeight?: number;
          }
        | Promise<{
            prompt: string;
            size: string;
            count: number;
            expectedWidth?: number;
            expectedHeight?: number;
          }>;
      unavailableMessage: string;
      inputRequiredMessage: string;
      gatewayFailedMessage: string;
      outputFileLabel: string;
    },
    executionContext?: ImageTaskWorkerExecutionContext
  ): Promise<ProcessImageTaskResult> {
    if (this.imageEditClient === undefined) {
      return await this.failTask(
        task,
        "IMAGE_EDIT_CLIENT_UNAVAILABLE",
        options.unavailableMessage,
        executionContext
      );
    }

    if (task.input_file_ids.length !== 1) {
      return await this.failTask(
        task,
        "INPUT_IMAGE_REQUIRED",
        options.inputRequiredMessage,
        executionContext
      );
    }

    const expectedOutputCount = options.operation === "upscale" ? 1 : task.image_count;
    const recovered = await this.completeRecoveredImageTask(
      task,
      expectedOutputCount,
      executionContext
    );

    if (recovered !== undefined) {
      return recovered;
    }

    const startedAt = Date.now();
    let gatewayCompleted = false;

    try {
      await executionContext?.assertActive();
      // worker 处理前再次按 owner_user_id 读取输入图，防止队列重放或伪造任务引用他人文件。
      const inputFile = await this.fileService.readFileContentBase64(
        task.owner_user_id,
        task.input_file_ids[0] ?? ""
      );
      const editRequest = await options.resolveRequest(inputFile);
      const edited = await this.imageEditClient.editImage({
        imageBase64: inputFile.content_base64,
        imageMimeType: inputFile.file.mime_type,
        prompt: editRequest.prompt,
        model: task.gateway_model_code ?? "image_edit",
        size: editRequest.size,
        count: editRequest.count,
        signal: executionContext?.signal
      });
      gatewayCompleted = true;
      await executionContext?.assertActive();
      const outputFileIds: string[] = [];

      for (let index = 0; index < edited.images.length; index += 1) {
        const image = edited.images[index];
        await executionContext?.assertActive();
        const normalizedImage = await this.normalizeOutputImage(image, editRequest.size);
        const uploaded = await this.fileService.uploadFile({
          ownerUserId: task.owner_user_id,
          fileName: `${task.id}_${options.outputFileLabel}_${String(index + 1)}.png`,
          mimeType: normalizedImage.mime_type,
          contentBase64: normalizedImage.content_base64,
          fileType: "output",
          generatedAsset: options.operation === "upscale",
          expectedWidth: editRequest.expectedWidth,
          expectedHeight: editRequest.expectedHeight,
          idempotencyKey: `${task.id}:${options.operation}:${String(index + 1)}`
        });

        outputFileIds.push(uploaded.file.id);
        await this.recordOutputFile(task, uploaded.file.id, edited.request_id, executionContext);
      }

      await this.aiGatewayLogsRepository.create({
        id: `ailog_${randomUUID().replaceAll("-", "")}`,
        task_id: task.id,
        request_id: edited.request_id,
        gateway_model_code: task.gateway_model_code ?? "image_edit",
        gateway_capability: task.gateway_capability ?? "image_edit",
        operation: options.operation,
        latency_ms: Date.now() - startedAt,
        success: true,
        usage_json: edited.usage,
        input_summary: `input_file=${task.input_file_ids[0] ?? ""}; mode=${task.style_preset_id ?? "custom"}; prompt=${summarizeText(editRequest.prompt)}`,
        output_summary: `generated_files=${String(outputFileIds.length)}`,
        error_code: null,
        error_message: null
      });

      return await this.taskService.transitionTask({
        ownerUserId: task.owner_user_id,
        taskId: task.id,
        toStatus: "succeeded",
        outputFileIds,
        gatewayRequestId: edited.request_id,
        workerLockToken: executionContext?.workerLockToken
      });
    } catch (error: unknown) {
      throwIfExecutionInterrupted(error, executionContext);
      const message = error instanceof Error ? error.message : options.gatewayFailedMessage;
      const errorCode =
        error instanceof FileServiceError
          ? error.code
          : gatewayCompleted
            ? "FILE_STORAGE_FAILED"
            : "AI_GATEWAY_FAILED";

      try {
        await this.aiGatewayLogsRepository.create({
          id: `ailog_${randomUUID().replaceAll("-", "")}`,
          task_id: task.id,
          request_id: `failed_${task.id}_${String(Date.now())}`,
          gateway_model_code: task.gateway_model_code ?? "image_edit",
          gateway_capability: task.gateway_capability ?? "image_edit",
          operation: options.operation,
          latency_ms: Date.now() - startedAt,
          success: false,
          usage_json: null,
          input_summary: `input_file=${task.input_file_ids[0] ?? ""}; mode=${task.style_preset_id ?? "custom"}`,
          output_summary: null,
          error_code: errorCode,
          error_message: message
        });
      } catch {
        // 审计日志属于旁路能力，写入失败不能阻断任务失败流转和预占积分释放。
      }

      return await this.failTask(
        task,
        errorCode,
        resolvePublicWorkerErrorMessage(errorCode),
        executionContext
      );
    }
  }

  private async processImageToTextTask(
    task: ImageTaskRecord,
    executionContext?: ImageTaskWorkerExecutionContext
  ): Promise<ProcessImageTaskResult> {
    if (this.visionTextClient === undefined) {
      return await this.failTask(
        task,
        "VISION_TEXT_CLIENT_UNAVAILABLE",
        "图生文模型服务暂不可用。",
        executionContext
      );
    }

    if (task.input_file_ids.length !== 1) {
      return await this.failTask(
        task,
        "INPUT_IMAGE_REQUIRED",
        "图生文任务必须上传一张输入图片。",
        executionContext
      );
    }

    const startedAt = Date.now();
    const prompt = buildVisionTextPrompt(task.prompt);

    try {
      await executionContext?.assertActive();
      // 读取输入图时再次按 owner_user_id 校验，防止队列重放或伪造 task 数据越权使用他人图片。
      const inputFile = await this.fileService.readFileContentBase64(
        task.owner_user_id,
        task.input_file_ids[0] ?? ""
      );
      const analyzed = await this.visionTextClient.analyzeImage({
        imageBase64: inputFile.content_base64,
        imageMimeType: inputFile.file.mime_type,
        prompt,
        model: task.gateway_model_code ?? "vision_text",
        signal: executionContext?.signal
      });
      await executionContext?.assertActive();

      await this.aiGatewayLogsRepository.create({
        id: `ailog_${randomUUID().replaceAll("-", "")}`,
        task_id: task.id,
        request_id: analyzed.request_id,
        gateway_model_code: task.gateway_model_code ?? "vision_text",
        gateway_capability: "vision_text",
        operation: "image_to_text",
        latency_ms: Date.now() - startedAt,
        success: true,
        usage_json: analyzed.usage,
        input_summary: `input_file=${task.input_file_ids[0] ?? ""}; prompt=${summarizeText(prompt)}`,
        output_summary: summarizeText(analyzed.text),
        error_code: null,
        error_message: null
      });

      return await this.taskService.transitionTask({
        ownerUserId: task.owner_user_id,
        taskId: task.id,
        toStatus: "succeeded",
        textResult: analyzed.text,
        gatewayRequestId: analyzed.request_id,
        workerLockToken: executionContext?.workerLockToken
      });
    } catch (error: unknown) {
      throwIfExecutionInterrupted(error, executionContext);
      const message = error instanceof Error ? error.message : "AI 网关图生文调用失败。";

      await this.aiGatewayLogsRepository.create({
        id: `ailog_${randomUUID().replaceAll("-", "")}`,
        task_id: task.id,
        request_id: `failed_${task.id}_${String(Date.now())}`,
        gateway_model_code: task.gateway_model_code ?? "vision_text",
        gateway_capability: "vision_text",
        operation: "image_to_text",
        latency_ms: Date.now() - startedAt,
        success: false,
        usage_json: null,
        input_summary: `input_file=${task.input_file_ids[0] ?? ""}; prompt=${summarizeText(prompt)}`,
        output_summary: null,
        error_code: "AI_GATEWAY_FAILED",
        error_message: message
      });
      return await this.failTask(
        task,
        "AI_GATEWAY_FAILED",
        resolvePublicWorkerErrorMessage("AI_GATEWAY_FAILED"),
        executionContext
      );
    }
  }

  private async failTask(
    task: { id: string; owner_user_id: number },
    code: string,
    message: string,
    executionContext?: ImageTaskWorkerExecutionContext
  ): Promise<ProcessImageTaskResult> {
    await executionContext?.assertActive();
    // 失败流转由 ImageTaskService 统一释放预占积分，worker 不直接操作计费模块。
    return await this.taskService.transitionTask({
      ownerUserId: task.owner_user_id,
      taskId: task.id,
      toStatus: "failed",
      errorCode: code,
      errorMessage: message,
      workerLockToken: executionContext?.workerLockToken
    });
  }

  private async prepareTaskForExecution(
    task: ImageTaskRecord,
    executionContext?: ImageTaskWorkerExecutionContext
  ): Promise<void> {
    if (executionContext !== undefined) {
      if (task.status !== "running") {
        throw new Error("独立 Worker 只能处理已原子抢占的 running 任务。");
      }

      await executionContext.assertActive();
      return;
    }

    // inline 模式暂时保留既有同步行为；队列模式必须在调用本服务前由数据库原子抢占。
    if (task.status === "billing_reserved") {
      await this.taskService.transitionTask({
        ownerUserId: task.owner_user_id,
        taskId: task.id,
        toStatus: "queued"
      });
      await this.taskService.transitionTask({
        ownerUserId: task.owner_user_id,
        taskId: task.id,
        toStatus: "running"
      });
      return;
    }

    if (task.status === "queued") {
      await this.taskService.transitionTask({
        ownerUserId: task.owner_user_id,
        taskId: task.id,
        toStatus: "running"
      });
      return;
    }

    if (task.status !== "running") {
      throw new Error(`图片任务状态 ${task.status} 不能开始执行。`);
    }
  }

  private async recordOutputFile(
    task: ImageTaskRecord,
    fileId: string,
    gatewayRequestId: string,
    executionContext?: ImageTaskWorkerExecutionContext
  ): Promise<void> {
    await this.taskService.recordWorkerOutput?.({
      ownerUserId: task.owner_user_id,
      taskId: task.id,
      fileId,
      gatewayRequestId,
      workerLockToken: executionContext?.workerLockToken
    });
  }

  private async completeRecoveredImageTask(
    task: ImageTaskRecord,
    expectedOutputCount: number,
    executionContext?: ImageTaskWorkerExecutionContext
  ): Promise<ProcessImageTaskResult | undefined> {
    if (task.output_file_ids.length < expectedOutputCount || task.gateway_request_id === null) {
      return undefined;
    }

    // 上次进程若已保存并登记全部文件，恢复消费只补终态与结算，不再次调用模型。
    await executionContext?.assertActive();
    return await this.taskService.transitionTask({
      ownerUserId: task.owner_user_id,
      taskId: task.id,
      toStatus: "succeeded",
      outputFileIds: task.output_file_ids.slice(0, expectedOutputCount),
      gatewayRequestId: task.gateway_request_id,
      workerLockToken: executionContext?.workerLockToken
    });
  }

  private async normalizeOutputImage(
    image: { mime_type: string; content_base64: string },
    targetSize: string
  ): Promise<{ mime_type: string; content_base64: string }> {
    const normalized = await this.imageOutputPostProcessor.normalizeToTargetSize({
      mimeType: image.mime_type,
      contentBase64: image.content_base64,
      targetSize
    });

    return {
      mime_type: normalized.mimeType,
      content_base64: normalized.contentBase64
    };
  }

  private async buildTextToImagePrompt(task: ImageTaskRecord): Promise<string> {
    const template = await this.resolveStylePromptTemplate(task);

    return buildTextToImagePromptWithTemplate(task.prompt, template);
  }

  private async buildImageEditPrompt(task: ImageTaskRecord): Promise<string> {
    const template = await this.resolveStylePromptTemplate(task);

    return buildImageEditPromptWithTemplate(task.prompt, task.style_preset_id, template);
  }

  private async buildImageRestorePrompt(task: ImageTaskRecord): Promise<string> {
    const template = await this.resolveStylePromptTemplate(task);

    return buildImageRestorePromptWithTemplate(task.prompt, task.style_preset_id, template);
  }

  private async resolveStylePromptTemplate(task: ImageTaskRecord): Promise<string | null> {
    if (task.style_preset_id === null || this.stylePresetResolver === undefined) {
      return null;
    }

    const preset = await this.stylePresetResolver.getEnabledPresetForTask(
      task.task_type,
      task.style_preset_id
    );

    // 模板停用不阻断已进入 worker 的历史任务；缺失时使用内置提示词兜底。
    return preset?.prompt_template ?? null;
  }
}

function resolvePublicWorkerErrorMessage(errorCode: string): string {
  // Provider 原始异常只写审计日志；任务记录使用稳定中文原因，避免向前端暴露英文内部错误。
  if (errorCode === "FILE_STORAGE_FAILED" || errorCode === "IMAGE_DIMENSIONS_MISMATCH") {
    return "结果文件保存失败，请稍后重试。";
  }

  return "AI 模型服务调用失败，请稍后重试。";
}

function summarizeText(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();

  return normalized.length > 120 ? `${normalized.slice(0, 120)}...` : normalized;
}

function throwIfExecutionInterrupted(
  error: unknown,
  executionContext?: ImageTaskWorkerExecutionContext
): void {
  if (executionContext?.signal.aborted === true) {
    const reason = executionContext.signal.reason as unknown;
    throw reason instanceof Error ? reason : new Error("图片任务执行已中止。");
  }

  if (error instanceof ImageTaskServiceError && error.code === "IMAGE_TASK_WORKER_LEASE_LOST") {
    // 租约丢失属于可恢复的 Worker 基础设施异常，交回 BullMQ 重试，不能误标为永久业务失败。
    throw error;
  }
}
