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

export interface ProcessImageTaskResult {
  task: PublicImageTask;
}

export class ImageGenerationWorkerService {
  constructor(
    private readonly taskRepository: ImageTasksRepository,
    private readonly taskService: Pick<ImageTaskService, "transitionTask">,
    private readonly fileService: Pick<FileService, "uploadFile" | "readFileContentBase64">,
    private readonly aiGatewayClient: AiGatewayImageGenerationClient,
    private readonly aiGatewayLogsRepository: AiGatewayCallLogsRepository,
    private readonly visionTextClient?: AiGatewayVisionTextClient,
    private readonly imageEditClient?: AiGatewayImageEditClient
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
      const generated = await this.aiGatewayClient.generateImage({
        prompt: task.prompt,
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
        input_summary: summarizeText(task.prompt),
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
        input_summary: summarizeText(task.prompt),
        output_summary: null,
        error_code: errorCode,
        error_message: message
      });
      return await this.failTask(task, errorCode, message);
    }
  }

  private async processImageToImageTask(task: ImageTaskRecord): Promise<ProcessImageTaskResult> {
    return await this.processImageEditTask(task, {
      operation: "image_to_image",
      resolveRequest: () => ({
        prompt: buildImageEditPrompt(task.prompt, task.style_preset_id),
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
      resolveRequest: () => ({
        prompt: buildImageRestorePrompt(task.prompt, task.style_preset_id),
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

        return {
          prompt: buildUpscalePrompt(factor, targetWidth, targetHeight),
          size: `${String(targetWidth)}x${String(targetHeight)}`,
          count: 1,
          expectedWidth: targetWidth,
          expectedHeight: targetHeight
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
      resolveRequest: (inputFile: FileContentResult) => {
        prompt: string;
        size: string;
        count: number;
        expectedWidth?: number;
        expectedHeight?: number;
      };
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
      const editRequest = options.resolveRequest(inputFile);
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

      return await this.failTask(task, errorCode, message);
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
      return await this.failTask(task, "AI_GATEWAY_FAILED", message);
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
}

function buildImageEditPrompt(prompt: string | null, editMode: string | null): string {
  const userPrompt = prompt?.trim();
  const modeInstruction = resolveImageEditModeInstruction(editMode);

  if (userPrompt !== undefined && userPrompt.length > 0) {
    return `${modeInstruction}\n\n用户编辑要求：${userPrompt}`;
  }

  return modeInstruction;
}

function resolveImageEditModeInstruction(editMode: string | null): string {
  const instructions: Record<string, string> = {
    keep_subject: "请基于参考图生成新图，尽量保持主体身份、构图重点和核心视觉特征。",
    change_background: "请基于参考图生成新图，保持主体不变，重点替换或重绘背景环境。",
    change_style: "请基于参考图生成新图，保持主体和构图关系，重点转换整体艺术风格。",
    variation: "请基于参考图生成同主题变体，保留画面语义并提供新的细节变化。"
  };

  return instructions[editMode ?? ""] ?? "请基于参考图生成新图，并遵循用户补充的编辑要求。";
}

function buildImageRestorePrompt(prompt: string | null, restoreType: string | null): string {
  const userPrompt = prompt?.trim();
  const typeInstruction = resolveImageRestoreTypeInstruction(restoreType);
  const qualityInstruction =
    "请只修复图片质量问题，保留原始主体身份、构图、时代特征和真实纹理，避免改变人物五官或添加无关内容。";

  if (userPrompt !== undefined && userPrompt.length > 0) {
    return `${typeInstruction}\n${qualityInstruction}\n\n用户补充要求：${userPrompt}`;
  }

  return `${typeInstruction}\n${qualityInstruction}`;
}

function resolveImageRestoreTypeInstruction(restoreType: string | null): string {
  const instructions: Record<string, string> = {
    old_photo: "请修复老照片中的划痕、折痕、褪色、污渍和局部缺损，并自然恢复细节。",
    denoise: "请进行去噪增强，减少颗粒、压缩噪点和色块，同时保留边缘与细节。",
    deblur: "请将模糊图片变清晰，改善主体边缘和局部细节，避免过度锐化与伪影。",
    color_enhance: "请增强图片色彩，校正白平衡、饱和度和对比度，保持自然真实。"
  };

  return instructions[restoreType ?? ""] ?? "请修复图片质量问题并自然增强画面细节。";
}

function buildUpscalePrompt(factor: 2 | 4, targetWidth: number, targetHeight: number): string {
  return [
    `请将输入图片高清放大 ${String(factor)} 倍，输出尺寸必须为 ${String(targetWidth)}x${String(targetHeight)} 像素。`,
    "保持原始主体、构图、色彩和画面内容不变，增强真实细节，减少锯齿、噪点和压缩伪影。",
    "不要添加新主体、文字、水印或改变人物身份。"
  ].join("\n");
}

function resolveUpscaleTargetDimension(source: number, factor: 2 | 4): number {
  const target = source * factor;

  if (!Number.isSafeInteger(target) || target > 32_768) {
    throw new FileServiceError(
      "UPSCALE_TARGET_TOO_LARGE",
      "放大后的目标尺寸超过 32768 像素限制。",
      400
    );
  }

  return target;
}

function buildVisionTextPrompt(prompt: string | null): string {
  const userPrompt = prompt?.trim();

  if (userPrompt !== undefined && userPrompt.length > 0) {
    return userPrompt;
  }

  return [
    "请分析这张图片，输出适合用户直接复制使用的中文内容。",
    "请包含：1. 标题；2. 画面描述；3. 关键词标签；4. 可用于社交媒体或商品场景的短文案。"
  ].join("\n");
}

function summarizeText(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();

  return normalized.length > 120 ? `${normalized.slice(0, 120)}...` : normalized;
}
