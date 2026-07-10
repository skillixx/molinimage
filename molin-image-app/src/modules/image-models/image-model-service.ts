import type {
  AiGatewayModelCatalogClient,
  ImageModelCatalogItem
} from "../../infrastructure/ai/ai-gateway-client.js";

export interface ImageModelListResult {
  items: ImageModelCatalogItem[];
  required_capabilities: string[];
  missing_required_capabilities: string[];
  message: string | null;
  source: "env";
}

export class ImageModelService {
  private readonly enabledCapabilities: Set<string>;

  constructor(
    private readonly modelCatalogClient: AiGatewayModelCatalogClient,
    enabledCapabilities: string[],
    private readonly requiredCapabilities: string[]
  ) {
    this.enabledCapabilities = new Set(enabledCapabilities);
  }

  async listVisibleImageModels(userId: number): Promise<ImageModelListResult> {
    const catalogItems = await this.modelCatalogClient.listImageModels(userId);
    const items = catalogItems
      .filter((item) => item.status === "active")
      .filter((item) => this.enabledCapabilities.has(item.capability))
      .sort((left, right) => left.sort_order - right.sort_order);
    const availableCapabilities = new Set(items.map((item) => item.capability));
    const missingRequiredCapabilities = this.requiredCapabilities.filter(
      (capability) => !availableCapabilities.has(capability)
    );

    return {
      items,
      required_capabilities: this.requiredCapabilities,
      missing_required_capabilities: missingRequiredCapabilities,
      message: buildModelCatalogMessage(items, missingRequiredCapabilities),
      source: "env"
    };
  }
}

function buildModelCatalogMessage(
  items: ImageModelCatalogItem[],
  missingRequiredCapabilities: string[]
): string | null {
  if (items.length === 0) {
    return "当前暂无可用图片模型，请检查 IMAGE_MODEL_CATALOG_JSON 或稍后再试。";
  }

  if (missingRequiredCapabilities.length > 0) {
    return `MVP 必备模型能力未配置完整：${missingRequiredCapabilities.join(", ")}。`;
  }

  return null;
}
