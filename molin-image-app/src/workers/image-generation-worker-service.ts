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
import {
  buildImageEditPromptWithTemplate,
  buildImageRestorePromptWithTemplate,
  buildTextToImagePromptWithTemplate,
  buildUpscalePrompt,
  buildVisionTextPrompt,
  resolveUpscaleTargetDimension
} from "./image-mode-prompts.js";

export interface ProcessImageTaskResult {
  task: PublicImageTask;
}

export interface WorkerStylePresetResolver {
  getEnabledPresetForTask(
    taskType: string,
    presetId: string
  ): Promise<{ prompt_template: string } | undefined>;
}

export class ImageGenerationWorkerService {
  constructor(
    private readonly taskRepository: ImageTasksRepository,
    private readonly taskService: Pick<ImageTaskService, "transitionTask">,
    private readonly fileService: Pick<FileService, "uploadFile" | "readFileContentBase64">,
    private readonly aiGatewayClient: AiGatewayImageGenerationClient,
    private readonly aiGatewayLogsRepository: AiGatewayCallLogsRepository,
    private readonly visionTextClient?: AiGatewayVisionTextClient,
    private readonly imageEditClient?: AiGatewayImageEditClient,
    private readonly stylePresetResolver?: WorkerStylePresetResolver
  ) {}

  async processTask(taskId: string): Promise<ProcessImageTaskResult> {
    const task = await this.taskRepository.findById(taskId);

    if (task === undefined) {
      throw new Error("图片任务不存在，worker 无法处理。");
    }

    if (task.task_type === "image_to_text") {
      return await this.processImageToTextTask(task);
    }

    if (task.task_type === "image_to_image") {
      return await this.processImageToImageTask(task);
    }

    if (task.task_type === "image_restore") {
      return await this.processImageRestoreTask(task);
    }

    if (task.task_type === "upscale") {
      return await this.processUpscaleTask(task);
    }

    if (task.task_type !== "text_to_image") {
      throw new Error("当前 worker 只处理文生图、图生文、图生图、图片修复和高清放大任务。");
    }

    if (task.prompt === null || task.prompt.trim().length === 0) {
      return await this.failTask(task, "PROMPT_REQUIRED", "文生图任务缺少提示词。");
    }

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

    const startedAt = Date.now();
    let gatewayCompleted = false;

    try {
      const prompt = await this.buildTextToImagePrompt(task);
      const generated = await this.aiGatewayClient.generateImage({
        prompt,
        negativePrompt: task.negative_prompt,
        model: task.gateway_model_code ?? "image_generation",
        size: task.image_size ?? "1024x1024",
        count: task.image_count
      });
      gatewayCompleted = true;
      const outputFileIds: string[] = [];

      for (let index = 0; index < generated.images.length; index += 1) {
        const image = generated.images[index];
        const uploaded = await this.fileService.uploadFile({
          ownerUserId: task.owner_user_id,
          fileName: `${task.id}_${String(index + 1)}.png`,
          mimeType: image.mime_type,
          contentBase64: image.content_base64,
          fileType: "output"
        });

        outputFileIds.push(uploaded.file.id);
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
        gatewayRequestId: generated.request_id
      });
    } catch (error: unknown) {
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
      return await this.failTask(task, errorCode, resolvePublicWorkerErrorMessage(errorCode));
    }
  }

  private async processImageToImageTask(task: ImageTaskRecord): Promise<ProcessImageTaskResult> {
    return await this.processImageEditTask(task, {
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
    });
  }

  private async processImageRestoreTask(task: ImageTaskRecord): Promise<ProcessImageTaskResult> {
    return await this.processImageEditTask(task, {
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
    });
  }

  private async processUpscaleTask(task: ImageTaskRecord): Promise<ProcessImageTaskResult> {
    const factor = task.upscale_factor;

    if (factor !== 2 && factor !== 4) {
      return await this.failTask(task, "UPSCALE_FACTOR_INVALID", "高清放大倍率只支持 2x 或 4x。");
    }

    return await this.processImageEditTask(task, {
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
    });
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
    }
  ): Promise<ProcessImageTaskResult> {
    if (this.imageEditClient === undefined) {
      return await this.failTask(task, "IMAGE_EDIT_CLIENT_UNAVAILABLE", options.unavailableMessage);
    }

    if (task.input_file_ids.length !== 1) {
      return await this.failTask(task, "INPUT_IMAGE_REQUIRED", options.inputRequiredMessage);
    }

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

    const startedAt = Date.now();
    let gatewayCompleted = false;

    try {
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
        count: editRequest.count
      });
      gatewayCompleted = true;
      const outputFileIds: string[] = [];

      for (let index = 0; index < edited.images.length; index += 1) {
        const image = edited.images[index];
        const uploaded = await this.fileService.uploadFile({
          ownerUserId: task.owner_user_id,
          fileName: `${task.id}_${options.outputFileLabel}_${String(index + 1)}.png`,
          mimeType: image.mime_type,
          contentBase64: image.content_base64,
          fileType: "output",
          generatedAsset: options.operation === "upscale",
          expectedWidth: editRequest.expectedWidth,
          expectedHeight: editRequest.expectedHeight
        });

        outputFileIds.push(uploaded.file.id);
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
        gatewayRequestId: edited.request_id
      });
    } catch (error: unknown) {
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

      return await this.failTask(task, errorCode, resolvePublicWorkerErrorMessage(errorCode));
    }
  }

  private async processImageToTextTask(task: ImageTaskRecord): Promise<ProcessImageTaskResult> {
    if (this.visionTextClient === undefined) {
      return await this.failTask(
        task,
        "VISION_TEXT_CLIENT_UNAVAILABLE",
        "图生文模型服务暂不可用。"
      );
    }

    if (task.input_file_ids.length !== 1) {
      return await this.failTask(task, "INPUT_IMAGE_REQUIRED", "图生文任务必须上传一张输入图片。");
    }

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

    const startedAt = Date.now();
    const prompt = buildVisionTextPrompt(task.prompt);

    try {
      // 读取输入图时再次按 owner_user_id 校验，防止队列重放或伪造 task 数据越权使用他人图片。
      const inputFile = await this.fileService.readFileContentBase64(
        task.owner_user_id,
        task.input_file_ids[0] ?? ""
      );
      const analyzed = await this.visionTextClient.analyzeImage({
        imageBase64: inputFile.content_base64,
        imageMimeType: inputFile.file.mime_type,
        prompt,
        model: task.gateway_model_code ?? "vision_text"
      });

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
        gatewayRequestId: analyzed.request_id
      });
    } catch (error: unknown) {
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
        resolvePublicWorkerErrorMessage("AI_GATEWAY_FAILED")
      );
    }
  }

  private async failTask(
    task: { id: string; owner_user_id: number },
    code: string,
    message: string
  ): Promise<ProcessImageTaskResult> {
    // 失败流转由 ImageTaskService 统一释放预占积分，worker 不直接操作计费模块。
    return await this.taskService.transitionTask({
      ownerUserId: task.owner_user_id,
      taskId: task.id,
      toStatus: "failed",
      errorCode: code,
      errorMessage: message
    });
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
