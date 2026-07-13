import type {
  AiGatewayModelCatalogClient,
  ImageModelCatalogItem
} from "../../infrastructure/ai/ai-gateway-client.js";
import type {
  ImageModelConfigRecord,
  ImageModelConfigsRepository,
  UpdateImageModelConfigInput
} from "../../infrastructure/database/image-model-configs-repository.js";

export interface ImageModelListResult {
  items: ImageModelCatalogItem[];
  required_capabilities: string[];
  missing_required_capabilities: string[];
  message: string | null;
  source: "env" | "managed";
}

export interface ManagedImageModelListResult {
  items: ImageModelConfigRecord[];
  page: 1;
  page_size: number;
  total: number;
}

export interface SyncImageModelCatalogResult {
  synced: number;
  total: number;
  items: ImageModelConfigRecord[];
}

export interface UpdateImageModelRequest {
  displayName?: string;
  description?: string;
  capability?: string;
  adminEnabled?: boolean;
  supportedTaskTypes?: string[];
  supportedImageSizes?: string[];
  maxInputFiles?: number;
  maxOutputCount?: number;
  sortOrder?: number;
  defaultTaskTypes?: string[];
}

export interface ResolveTaskModelInput {
  taskType: string;
  gatewayModelCode?: string | null;
  gatewayCapability?: string | null;
  imageSize?: string | null;
  imageCount?: number;
  inputFileCount?: number;
}

export interface ResolvedTaskModel {
  gatewayModelCode: string;
  gatewayCapability: string;
  modelId: string | null;
}

export class ImageModelServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "ImageModelServiceError";
  }
}

const supportedTaskTypes = new Set([
  "text_to_image",
  "image_to_text",
  "image_to_image",
  "image_restore",
  "upscale",
  "prompt_optimize",
  "moderation"
]);

export class ImageModelService {
  private readonly enabledCapabilities: Set<string>;

  constructor(
    private readonly modelCatalogClient: AiGatewayModelCatalogClient,
    enabledCapabilities: string[],
    private readonly requiredCapabilities: string[],
    private readonly repository?: ImageModelConfigsRepository
  ) {
    this.enabledCapabilities = new Set(enabledCapabilities);
  }

  async listVisibleImageModels(userId: number): Promise<ImageModelListResult> {
    if (this.repository !== undefined) {
      void userId;
      const managedItems = await this.repository.listAll();
      const items = managedItems
        .filter((item) => item.source_available)
        .filter((item) => item.source_status === "active")
        .filter((item) => item.admin_enabled)
        .filter((item) => this.enabledCapabilities.has(item.capability))
        .map(toCatalogItem)
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
        source: "managed"
      };
    }

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

  async listManagedModels(userId: number): Promise<ManagedImageModelListResult> {
    void userId;
    const items = await this.requireRepository().listAll();

    return {
      items,
      page: 1,
      page_size: items.length,
      total: items.length
    };
  }

  async syncModelCatalog(userId: number): Promise<SyncImageModelCatalogResult> {
    const repository = this.requireRepository();
    const catalogItems = await this.modelCatalogClient.listImageModels(userId);
    const modelIds: string[] = [];

    for (const item of catalogItems) {
      const modelId = buildModelConfigId(item);
      modelIds.push(modelId);
      await repository.upsertFromCatalog({
        id: modelId,
        gateway_model_code: item.gateway_model_code,
        display_name: item.display_name,
        description: item.description,
        capability: item.capability,
        source_capability: item.capability,
        source_status: item.status,
        source_available: true,
        admin_enabled: item.status === "active",
        quality_tier: item.quality_tier,
        supported_task_types: item.supported_task_types,
        supported_image_sizes: item.supported_image_sizes,
        supported_input_types: item.supported_input_types,
        supported_output_types: item.supported_output_types,
        max_input_files: item.max_input_files,
        max_output_count: item.max_output_count,
        sort_order: item.sort_order
      });
    }

    await repository.markMissingSourceModels(modelIds);
    const items = await repository.listAll();

    return {
      synced: modelIds.length,
      total: items.length,
      items
    };
  }

  async updateManagedModel(
    modelId: string,
    request: UpdateImageModelRequest,
    userId = 0
  ): Promise<{ model: ImageModelConfigRecord }> {
    const repository = this.requireRepository();
    await this.syncModelCatalog(userId);
    const existing = await repository.findById(normalizeRequiredString(modelId, "model_id"));

    if (existing === undefined) {
      throw new ImageModelServiceError("IMAGE_MODEL_NOT_FOUND", "模型配置不存在。", 404);
    }

    const updateInput = normalizeUpdateInput(existing, request);
    const updated = await repository.update(updateInput);

    if (updated === undefined) {
      throw new ImageModelServiceError("IMAGE_MODEL_NOT_FOUND", "模型配置不存在。", 404);
    }

    return { model: updated };
  }

  async resolveTaskModel(
    userId: number,
    input: ResolveTaskModelInput
  ): Promise<ResolvedTaskModel | null> {
    const taskType = normalizeRequiredString(input.taskType, "task_type");
    const modelCode = normalizeOptionalString(input.gatewayModelCode);
    const capability = normalizeOptionalString(input.gatewayCapability);
    const imageSize = normalizeOptionalString(input.imageSize);
    const imageCount = input.imageCount ?? 1;
    const inputFileCount = input.inputFileCount ?? 0;

    if (!supportedTaskTypes.has(taskType)) {
      return null;
    }

    const visibleModels = (await this.listVisibleImageModels(userId)).items.filter((item) =>
      isModelCompatibleWithTask(item, {
        taskType,
        imageSize,
        imageCount,
        inputFileCount
      })
    );
    const matchedModel =
      modelCode === null
        ? await this.resolveDefaultModel(userId, taskType, visibleModels)
        : visibleModels.find(
            (item) =>
              item.gateway_model_code === modelCode &&
              (capability === null || item.capability === capability)
          );

    if (matchedModel === undefined) {
      return null;
    }

    return {
      gatewayModelCode: matchedModel.gateway_model_code,
      gatewayCapability: matchedModel.capability,
      modelId: "id" in matchedModel && typeof matchedModel.id === "string" ? matchedModel.id : null
    };
  }

  private async resolveDefaultModel(
    userId: number,
    taskType: string,
    visibleModels: ImageModelCatalogItem[]
  ): Promise<ImageModelCatalogItem | undefined> {
    if (this.repository === undefined) {
      return visibleModels.at(0);
    }

    const managedItems = (await this.listManagedModels(userId)).items;
    const defaultModel = managedItems.find(
      (item) =>
        item.default_task_types.includes(taskType) &&
        item.source_available &&
        item.source_status === "active" &&
        item.admin_enabled &&
        this.enabledCapabilities.has(item.capability) &&
        item.supported_task_types.includes(taskType)
    );

    return defaultModel === undefined ? visibleModels.at(0) : toCatalogItem(defaultModel);
  }

  private requireRepository(): ImageModelConfigsRepository {
    if (this.repository === undefined) {
      throw new ImageModelServiceError(
        "IMAGE_MODEL_CONFIG_REPOSITORY_UNAVAILABLE",
        "模型管理配置仓储未启用。",
        503
      );
    }

    return this.repository;
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

function toCatalogItem(item: ImageModelConfigRecord): ImageModelCatalogItem {
  return {
    id: item.id,
    gateway_model_code: item.gateway_model_code,
    display_name: item.display_name,
    description: item.description,
    capability: item.capability,
    status: item.source_status,
    quality_tier: item.quality_tier,
    supported_task_types: item.supported_task_types,
    supported_image_sizes: item.supported_image_sizes,
    supported_input_types: item.supported_input_types,
    supported_output_types: item.supported_output_types,
    max_input_files: item.max_input_files,
    max_output_count: item.max_output_count,
    default_task_types: item.default_task_types,
    sort_order: item.sort_order
  };
}

function isModelCompatibleWithTask(
  item: ImageModelCatalogItem,
  input: {
    taskType: string;
    imageSize: string | null;
    imageCount: number;
    inputFileCount: number;
  }
): boolean {
  if (!item.supported_task_types.includes(input.taskType)) {
    return false;
  }

  if (input.inputFileCount > item.max_input_files) {
    return false;
  }

  if (input.imageCount > item.max_output_count) {
    return false;
  }

  // 图生文等文本输出任务通常没有图片尺寸；只有请求带尺寸时才按模型尺寸白名单校验。
  return (
    input.imageSize === null ||
    item.supported_image_sizes.length === 0 ||
    item.supported_image_sizes.includes(input.imageSize)
  );
}

function normalizeUpdateInput(
  existing: ImageModelConfigRecord,
  request: UpdateImageModelRequest
): UpdateImageModelConfigInput {
  const supportedTaskTypesValue =
    request.supportedTaskTypes === undefined
      ? existing.supported_task_types
      : normalizeStringArray(request.supportedTaskTypes, "supported_task_types");
  const defaultTaskTypes =
    request.defaultTaskTypes === undefined
      ? undefined
      : normalizeStringArray(request.defaultTaskTypes, "default_task_types");

  if (
    defaultTaskTypes !== undefined &&
    !defaultTaskTypes.every((taskType) => supportedTaskTypesValue.includes(taskType))
  ) {
    // 默认模型必须同时支持对应任务类型，否则前端不传模型时会解析到一个不可执行的模型。
    throw new ImageModelServiceError(
      "IMAGE_MODEL_DEFAULT_TASK_UNSUPPORTED",
      "默认任务类型必须包含在模型支持的任务类型中。",
      400
    );
  }

  return {
    id: existing.id,
    display_name: normalizeOptionalPatchString(request.displayName),
    description: normalizeOptionalPatchString(request.description),
    capability: normalizeOptionalPatchString(request.capability),
    admin_enabled: request.adminEnabled,
    supported_task_types:
      request.supportedTaskTypes === undefined ? undefined : supportedTaskTypesValue,
    supported_image_sizes:
      request.supportedImageSizes === undefined
        ? undefined
        : normalizeStringArray(request.supportedImageSizes, "supported_image_sizes"),
    max_input_files:
      request.maxInputFiles === undefined
        ? undefined
        : normalizeNonNegativeInteger(request.maxInputFiles, "max_input_files"),
    max_output_count:
      request.maxOutputCount === undefined
        ? undefined
        : normalizeNonNegativeInteger(request.maxOutputCount, "max_output_count"),
    sort_order:
      request.sortOrder === undefined
        ? undefined
        : normalizeNonNegativeInteger(request.sortOrder, "sort_order"),
    default_task_types: defaultTaskTypes
  };
}

function buildModelConfigId(item: ImageModelCatalogItem): string {
  const rawId = `${item.gateway_model_code}__${item.capability}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");

  return rawId.length > 0 ? rawId.slice(0, 128) : `model_${String(item.sort_order)}`;
}

function normalizeRequiredString(value: string, field: string): string {
  const normalized = normalizeOptionalString(value);

  if (normalized === null) {
    throw new ImageModelServiceError("IMAGE_MODEL_FIELD_REQUIRED", `${field} 不能为空。`, 400);
  }

  return normalized;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const normalized = value?.trim();

  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function normalizeOptionalPatchString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  return normalizeRequiredString(value, "model_config");
}

function normalizeStringArray(value: string[], field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ImageModelServiceError("IMAGE_MODEL_FIELD_INVALID", `${field} 格式不正确。`, 400);
  }

  return [...new Set(value.map((item) => normalizeRequiredString(item, field)))];
}

function normalizeNonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ImageModelServiceError("IMAGE_MODEL_FIELD_INVALID", `${field} 必须是非负整数。`, 400);
  }

  return value;
}
