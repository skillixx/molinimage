export interface ImageModelCatalogItem {
  id?: string;
  gateway_model_code: string;
  display_name: string;
  description: string;
  capability: string;
  status: "active" | "inactive";
  quality_tier: string;
  supported_task_types: string[];
  supported_image_sizes: string[];
  supported_input_types: string[];
  supported_output_types: string[];
  max_input_files: number;
  max_output_count: number;
  default_task_types?: string[];
  sort_order: number;
}

export interface AiGatewayModelCatalogClient {
  listImageModels(userId: number): Promise<ImageModelCatalogItem[]>;
}

export interface GenerateImageInput {
  prompt: string;
  negativePrompt?: string | null;
  model: string;
  size: string;
  count: number;
}

export interface GeneratedImage {
  mime_type: string;
  content_base64: string;
}

export interface GenerateImageResult {
  request_id: string;
  images: GeneratedImage[];
  usage: Record<string, unknown> | null;
}

export interface AiGatewayImageGenerationClient {
  generateImage(input: GenerateImageInput): Promise<GenerateImageResult>;
}

export interface EditImageInput {
  imageBase64: string;
  imageMimeType: string;
  prompt: string;
  model: string;
  size: string;
  count: number;
}

export type EditImageResult = GenerateImageResult;

export interface AiGatewayImageEditClient {
  editImage(input: EditImageInput): Promise<EditImageResult>;
}

export interface AnalyzeImageInput {
  imageBase64: string;
  imageMimeType: string;
  prompt: string;
  model: string;
}

export interface AnalyzeImageResult {
  request_id: string;
  text: string;
  usage: Record<string, unknown> | null;
}

export interface AiGatewayVisionTextClient {
  analyzeImage(input: AnalyzeImageInput): Promise<AnalyzeImageResult>;
}

export class EnvAiGatewayModelCatalogClient implements AiGatewayModelCatalogClient {
  constructor(private readonly catalogJson: string) {}

  listImageModels(userId: number): Promise<ImageModelCatalogItem[]> {
    // 当前 MVP 阶段先从服务端环境变量读取模型目录；保留 userId 参数，后续切换墨灵网关目录时接口不用改。
    void userId;

    return Promise.resolve(parseModelCatalog(this.catalogJson));
  }
}

export class HttpAiGatewayImageGenerationClient implements AiGatewayImageGenerationClient {
  constructor(
    private readonly config: {
      aiGatewayBaseUrl: string;
      aiGatewayApiKey: string;
    }
  ) {}

  async generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
    if (this.config.aiGatewayApiKey.trim().length === 0) {
      throw new Error("AI_GATEWAY_API_KEY 未配置，不能调用图片生成模型。");
    }

    if (isOpenRouterGateway(this.config.aiGatewayBaseUrl)) {
      return this.generateImageWithOpenRouterChat(input);
    }

    const response = await fetch(
      resolveGatewayUrl(this.config.aiGatewayBaseUrl, "images/generations"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.aiGatewayApiKey}`
        },
        // 这里使用 OpenAI 兼容图片生成协议；不同上游由墨灵 AI 网关负责适配。
        body: JSON.stringify({
          model: input.model,
          prompt: buildImagePrompt(input),
          size: input.size,
          n: input.count,
          response_format: "b64_json"
        })
      }
    );

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(readGatewayErrorMessage(payload));
    }

    return parseGenerateImageResult(payload, response.headers.get("x-request-id"));
  }

  private async generateImageWithOpenRouterChat(
    input: GenerateImageInput
  ): Promise<GenerateImageResult> {
    const response = await fetch(
      resolveGatewayUrl(this.config.aiGatewayBaseUrl, "chat/completions"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.aiGatewayApiKey}`
        },
        // OpenRouter 的 Gemini 图片模型是 text+image -> text+image，多模态生成需要走 chat/completions。
        body: JSON.stringify({
          model: input.model,
          modalities: ["image", "text"],
          messages: [
            {
              role: "user",
              content: buildOpenRouterImagePrompt(input)
            }
          ]
        })
      }
    );

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(readGatewayErrorMessage(payload));
    }

    return parseOpenRouterChatImageResult(payload, response.headers.get("x-request-id"));
  }
}

export class HttpAiGatewayImageEditClient implements AiGatewayImageEditClient {
  constructor(
    private readonly config: {
      aiGatewayBaseUrl: string;
      aiGatewayApiKey: string;
    }
  ) {}

  async editImage(input: EditImageInput): Promise<EditImageResult> {
    if (this.config.aiGatewayApiKey.trim().length === 0) {
      throw new Error("AI_GATEWAY_API_KEY 未配置，不能调用图生图模型。");
    }

    const form = new FormData();
    const imageBuffer = Buffer.from(input.imageBase64, "base64");
    const imageBlob = new Blob([imageBuffer], { type: input.imageMimeType });

    form.append("model", input.model);
    form.append("prompt", input.prompt);
    form.append("size", input.size);
    form.append("n", String(input.count));
    form.append("response_format", "b64_json");
    // 图生图输入图只在服务端读取和转发，浏览器端不会拿到 MinIO 写权限或 AI 网关密钥。
    form.append("image", imageBlob, `input.${resolveImageExtension(input.imageMimeType)}`);

    const response = await fetch(resolveGatewayUrl(this.config.aiGatewayBaseUrl, "images/edits"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.aiGatewayApiKey}`
      },
      body: form
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(readGatewayErrorMessage(payload));
    }

    return parseGenerateImageResult(payload, response.headers.get("x-request-id"));
  }
}

export class HttpAiGatewayVisionTextClient implements AiGatewayVisionTextClient {
  constructor(
    private readonly config: {
      aiGatewayBaseUrl: string;
      aiGatewayApiKey: string;
    }
  ) {}

  async analyzeImage(input: AnalyzeImageInput): Promise<AnalyzeImageResult> {
    if (this.config.aiGatewayApiKey.trim().length === 0) {
      throw new Error("AI_GATEWAY_API_KEY 未配置，不能调用图生文模型。");
    }

    const response = await fetch(
      resolveGatewayUrl(this.config.aiGatewayBaseUrl, "chat/completions"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.aiGatewayApiKey}`
        },
        // 图生文统一走 OpenAI 兼容 vision messages；具体模型适配交给墨灵 AI 网关处理。
        body: JSON.stringify({
          model: input.model,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: input.prompt
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:${input.imageMimeType};base64,${input.imageBase64}`
                  }
                }
              ]
            }
          ]
        })
      }
    );

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(readGatewayErrorMessage(payload));
    }

    return parseAnalyzeImageResult(payload, response.headers.get("x-request-id"));
  }
}

function buildImagePrompt(input: GenerateImageInput): string {
  if (input.negativePrompt === undefined || input.negativePrompt === null) {
    return input.prompt;
  }

  const negativePrompt = input.negativePrompt.trim();

  if (negativePrompt.length === 0) {
    return input.prompt;
  }

  return `${input.prompt}\n\n反向提示词：${negativePrompt}`;
}

function buildOpenRouterImagePrompt(input: GenerateImageInput): string {
  const prompt = buildImagePrompt(input);
  const countText =
    input.count > 1 ? `请生成 ${String(input.count)} 张彼此有差异的图片。` : "请生成 1 张图片。";

  // OpenRouter chat 图片模型没有统一的 size/n 字段，这里把尺寸和数量写入用户消息，让模型按目标规格输出。
  return `${prompt}\n\n输出要求：${countText}目标尺寸 ${input.size}。请直接返回图片结果。`;
}

function parseGenerateImageResult(
  payload: unknown,
  fallbackRequestId: string | null
): GenerateImageResult {
  if (!isRecord(payload)) {
    throw new Error("AI 网关图片生成响应格式异常。");
  }

  const data = payload.data;

  if (!Array.isArray(data)) {
    throw new Error("AI 网关图片生成响应缺少图片数据。");
  }

  const images = data.map((item) => {
    if (!isRecord(item)) {
      throw new Error("AI 网关图片生成响应图片项格式异常。");
    }

    const contentBase64 = typeof item.b64_json === "string" ? item.b64_json : undefined;

    if (contentBase64 === undefined || contentBase64.trim().length === 0) {
      throw new Error("AI 网关未返回 base64 图片。");
    }

    return {
      mime_type: typeof item.mime_type === "string" ? item.mime_type : "image/png",
      content_base64: contentBase64
    };
  });

  return {
    request_id:
      readOptionalString(payload, "request_id") ?? fallbackRequestId ?? `ai_${String(Date.now())}`,
    images,
    usage: isRecord(payload.usage) ? payload.usage : null
  };
}

function parseOpenRouterChatImageResult(
  payload: unknown,
  fallbackRequestId: string | null
): GenerateImageResult {
  if (!isRecord(payload)) {
    throw new Error("AI 网关图片生成响应格式异常。");
  }

  const images = extractChatGeneratedImages(payload);

  if (images.length === 0) {
    throw new Error("AI 网关图片生成响应缺少图片数据。");
  }

  return {
    request_id:
      readOptionalString(payload, "request_id") ??
      readOptionalString(payload, "id") ??
      fallbackRequestId ??
      `ai_${String(Date.now())}`,
    images,
    usage: isRecord(payload.usage) ? payload.usage : null
  };
}

function extractChatGeneratedImages(payload: Record<string, unknown>): GeneratedImage[] {
  const choices = payload.choices;

  if (!Array.isArray(choices)) {
    return [];
  }

  return choices.flatMap((choice) => {
    if (!isRecord(choice) || !isRecord(choice.message)) {
      return [];
    }

    // OpenRouter 图片模型常把生成图放在 message.images[].image_url.url，兼容 content 数组和文本里的 data URI。
    return [
      ...extractImagesFromMessageImages(choice.message),
      ...extractImagesFromMessageContent(choice.message.content)
    ];
  });
}

function extractImagesFromMessageImages(message: Record<string, unknown>): GeneratedImage[] {
  const images = message.images;

  if (!Array.isArray(images)) {
    return [];
  }

  return images
    .map((item) => extractImageUrlFromRecord(item))
    .filter((url): url is string => url !== undefined)
    .map(parseGeneratedImageUrl);
}

function extractImagesFromMessageContent(content: unknown): GeneratedImage[] {
  if (typeof content === "string") {
    return extractDataImageUrls(content).map(parseGeneratedImageUrl);
  }

  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .map((item) => extractImageUrlFromRecord(item))
    .filter((url): url is string => url !== undefined)
    .map(parseGeneratedImageUrl);
}

function extractImageUrlFromRecord(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (typeof value.url === "string") {
    return value.url;
  }

  if (typeof value.image_url === "string") {
    return value.image_url;
  }

  if (isRecord(value.image_url) && typeof value.image_url.url === "string") {
    return value.image_url.url;
  }

  return undefined;
}

function extractDataImageUrls(content: string): string[] {
  return Array.from(
    content.matchAll(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/giu),
    (match) => match[0]
  );
}

function parseGeneratedImageUrl(url: string): GeneratedImage {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/iu.exec(url.trim());

  if (match === null || match[2].trim().length === 0) {
    throw new Error("AI 网关未返回 base64 图片。");
  }

  return {
    mime_type: match[1].toLowerCase(),
    content_base64: match[2]
  };
}

function parseAnalyzeImageResult(
  payload: unknown,
  fallbackRequestId: string | null
): AnalyzeImageResult {
  if (!isRecord(payload)) {
    throw new Error("AI 网关图生文响应格式异常。");
  }

  const choices = payload.choices;

  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
    throw new Error("AI 网关图生文响应缺少文本结果。");
  }

  const message = choices[0].message;
  const content = isRecord(message) && typeof message.content === "string" ? message.content : "";
  const text = content.trim();

  if (text.length === 0) {
    throw new Error("AI 网关未返回可用的图生文文本。");
  }

  return {
    request_id:
      readOptionalString(payload, "request_id") ??
      readOptionalString(payload, "id") ??
      fallbackRequestId ??
      `ai_${String(Date.now())}`,
    text,
    usage: isRecord(payload.usage) ? payload.usage : null
  };
}

function readGatewayErrorMessage(payload: unknown): string {
  if (!isRecord(payload)) {
    return "AI 网关图片生成失败。";
  }

  const error = payload.error;

  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }

  if (typeof payload.message === "string") {
    return payload.message;
  }

  return "AI 网关图片生成失败。";
}

function readOptionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];

  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isOpenRouterGateway(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith("openrouter.ai");
  } catch {
    return false;
  }
}

function resolveGatewayUrl(baseUrl: string, path: string): URL {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

  // AI 网关 base URL 通常已经包含 /api/v1；不能用以 / 开头的 URL 覆盖掉这个前缀。
  return new URL(path, normalizedBase);
}

function resolveImageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") {
    return "jpg";
  }

  if (mimeType === "image/webp") {
    return "webp";
  }

  if (mimeType === "image/gif") {
    return "gif";
  }

  return "png";
}

export function parseModelCatalog(catalogJson: string): ImageModelCatalogItem[] {
  const parsedCatalog = JSON.parse(catalogJson) as unknown;

  if (!Array.isArray(parsedCatalog)) {
    throw new Error("IMAGE_MODEL_CATALOG_JSON 必须是数组 JSON。");
  }

  return parsedCatalog.map((item) => parseModelCatalogItem(item));
}

function parseModelCatalogItem(item: unknown): ImageModelCatalogItem {
  if (!isRecord(item)) {
    throw new Error("模型目录项必须是对象。");
  }

  return {
    gateway_model_code: readString(item, "gateway_model_code"),
    display_name: readString(item, "display_name"),
    description: readString(item, "description"),
    capability: readString(item, "capability"),
    status: readStatus(item),
    quality_tier: readString(item, "quality_tier"),
    supported_task_types: readStringArray(item, "supported_task_types"),
    supported_image_sizes: readStringArray(item, "supported_image_sizes"),
    supported_input_types: readStringArray(item, "supported_input_types"),
    supported_output_types: readStringArray(item, "supported_output_types"),
    max_input_files: readNonNegativeInteger(item, "max_input_files"),
    max_output_count: readNonNegativeInteger(item, "max_output_count"),
    sort_order: readNonNegativeInteger(item, "sort_order")
  };
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`模型目录项缺少字段 ${key}。`);
  }

  return value.trim();
}

function readStatus(source: Record<string, unknown>): "active" | "inactive" {
  const status = readString(source, "status");

  if (status !== "active" && status !== "inactive") {
    throw new Error("模型 status 只支持 active 或 inactive。");
  }

  return status;
}

function readStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];

  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`模型目录项字段 ${key} 必须是字符串数组。`);
  }

  return value.map((item) => item.trim()).filter((item) => item.length > 0);
}

function readNonNegativeInteger(source: Record<string, unknown>, key: string): number {
  const value = source[key];

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`模型目录项字段 ${key} 必须是非负整数。`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
