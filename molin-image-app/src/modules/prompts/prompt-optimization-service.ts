import type {
  AiGatewayPromptOptimizerClient,
  ImageModelCatalogItem
} from "../../infrastructure/ai/ai-gateway-client.js";
import type { ImageModelService } from "../image-models/image-model-service.js";

export interface OptimizePromptRequest {
  ownerUserId: number;
  prompt: string;
  taskType?: string | null;
}

export interface OptimizePromptResponse {
  original_prompt: string;
  optimized_prompt: string;
  gateway_model_code: string;
  request_id: string;
}

export class PromptOptimizationServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "PromptOptimizationServiceError";
  }
}

const maxPromptLength = 1200;

export class PromptOptimizationService {
  constructor(
    private readonly imageModelService: Pick<ImageModelService, "listVisibleImageModels">,
    private readonly promptOptimizerClient: AiGatewayPromptOptimizerClient
  ) {}

  async optimizePrompt(request: OptimizePromptRequest): Promise<OptimizePromptResponse> {
    const prompt = request.prompt.trim();

    if (prompt.length === 0) {
      throw new PromptOptimizationServiceError(
        "PROMPT_REQUIRED",
        "请输入需要优化的提示词。",
        400
      );
    }

    if (prompt.length > maxPromptLength) {
      throw new PromptOptimizationServiceError(
        "PROMPT_TOO_LONG",
        `提示词不能超过 ${String(maxPromptLength)} 个字符。`,
        400
      );
    }

    const model = await this.resolvePromptOptimizeModel(request.ownerUserId);

    try {
      const optimized = await this.promptOptimizerClient.optimizePrompt({
        prompt,
        model: model.gateway_model_code,
        taskType: request.taskType
      });

      return {
        original_prompt: prompt,
        optimized_prompt: optimized.optimized_prompt,
        gateway_model_code: model.gateway_model_code,
        request_id: optimized.request_id
      };
    } catch {
      // 网关原始错误可能包含上游模型、区域或供应商信息；用户端只暴露稳定中文提示。
      throw new PromptOptimizationServiceError(
        "PROMPT_OPTIMIZE_FAILED",
        "提示词优化失败，请稍后重试。",
        502
      );
    }
  }

  private async resolvePromptOptimizeModel(ownerUserId: number): Promise<ImageModelCatalogItem> {
    const models = await this.imageModelService.listVisibleImageModels(ownerUserId);
    const model = models.items.find(
      (item) =>
        item.capability === "prompt_optimize" &&
        item.status === "active" &&
        item.supported_task_types.includes("prompt_optimize")
    );

    if (model === undefined) {
      // 提示词优化必须遵守模型目录可见性和开关；没有可见模型时不允许前端指定任意模型绕过。
      throw new PromptOptimizationServiceError(
        "PROMPT_OPTIMIZE_MODEL_UNAVAILABLE",
        "当前暂无可用的提示词优化模型。",
        400
      );
    }

    return model;
  }
}
