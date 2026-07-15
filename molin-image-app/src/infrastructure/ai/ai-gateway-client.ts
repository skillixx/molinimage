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

export interface OptimizePromptInput {
  prompt: string;
  model: string;
  taskType?: string | null;
}

export interface OptimizePromptResult {
  request_id: string;
  optimized_prompt: string;
  usage: Record<string, unknown> | null;
}

export interface AiGatewayPromptOptimizerClient {
  optimizePrompt(input: OptimizePromptInput): Promise<OptimizePromptResult>;
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
      return OPENROUTER_ASPECT_RATIO_IMAGE_MODELS.has(input.model)
        ? this.generateImageWithOpenRouterAspectRatioApi(input)
        : this.generateImageWithGenericOpenRouterApi(input);
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

  private async generateImageWithOpenRouterAspectRatioApi(
    input: GenerateImageInput
  ): Promise<GenerateImageResult> {
    if (!Number.isSafeInteger(input.count) || input.count < 1) {
      throw new Error("OpenRouter 图片生成数量必须是正整数。");
    }

    const aspectRatio = resolveOpenRouterAspectRatio(input.size);
    const results: GenerateImageResult[] = [];

    // 当前 OpenRouter 图片模型每次只支持 n=1；多图任务逐张请求，避免整个请求被上游拒绝。
    for (let index = 0; index < input.count; index += 1) {
      results.push(await this.generateSingleOpenRouterImage(input, aspectRatio));
    }

    if (results.length === 1) {
      return results[0];
    }

    const firstResult = results[0];

    return {
      request_id: firstResult.request_id,
      images: results.flatMap((result) => result.images),
      // 多次上游调用的 request_id 和 usage 一并保留，便于成本核算与问题追踪。
      usage: {
        request_count: results.length,
        requests: results.map((result) => ({
          request_id: result.request_id,
          usage: result.usage
        }))
      }
    };
  }

  private async generateSingleOpenRouterImage(
    input: GenerateImageInput,
    aspectRatio: OpenRouterImageAspectRatio
  ): Promise<GenerateImageResult> {
    return await this.sendOpenRouterImageRequest({
      model: input.model,
      prompt: buildImagePrompt(input),
      resolution: "1K",
      aspect_ratio: aspectRatio,
      n: 1
    });
  }

  private async generateImageWithGenericOpenRouterApi(
    input: GenerateImageInput
  ): Promise<GenerateImageResult> {
    // 未声明比例协议能力的模型保留原有参数，避免错误套用 Gemini 图片模型约束。
    return await this.sendOpenRouterImageRequest({
      model: input.model,
      prompt: buildImagePrompt(input),
      size: input.size,
      n: input.count,
      response_format: "b64_json"
    });
  }

  private async sendOpenRouterImageRequest(
    body: Record<string, unknown>
  ): Promise<GenerateImageResult> {
    const response = await fetch(resolveGatewayUrl(this.config.aiGatewayBaseUrl, "images"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.aiGatewayApiKey}`
      },
      body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(readGatewayErrorMessage(payload));
    }

    return parseGenerateImageResult(payload, response.headers.get("x-request-id"));
  }
}

const OPENROUTER_ASPECT_RATIO_IMAGE_MODELS = new Set(["google/gemini-3.1-flash-lite-image"]);

const OPENROUTER_IMAGE_ASPECT_RATIOS = [
  { value: "1:8", ratio: 1 / 8 },
  { value: "1:4", ratio: 1 / 4 },
  { value: "9:16", ratio: 9 / 16 },
  { value: "2:3", ratio: 2 / 3 },
  { value: "3:4", ratio: 3 / 4 },
  { value: "4:5", ratio: 4 / 5 },
  { value: "1:1", ratio: 1 },
  { value: "5:4", ratio: 5 / 4 },
  { value: "4:3", ratio: 4 / 3 },
  { value: "3:2", ratio: 3 / 2 },
  { value: "16:9", ratio: 16 / 9 },
  { value: "21:9", ratio: 21 / 9 },
  { value: "4:1", ratio: 4 },
  { value: "8:1", ratio: 8 }
] as const;

type OpenRouterImageAspectRatio = (typeof OPENROUTER_IMAGE_ASPECT_RATIOS)[number]["value"];

function resolveOpenRouterAspectRatio(size: string): OpenRouterImageAspectRatio {
  const matched = /^(\d+)x(\d+)$/u.exec(size.trim());
  const width = Number(matched?.[1]);
  const height = Number(matched?.[2]);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`OpenRouter 图片尺寸格式无效：${size}`);
  }

  const targetRatio = width / height;
  let nearest: (typeof OPENROUTER_IMAGE_ASPECT_RATIOS)[number] = OPENROUTER_IMAGE_ASPECT_RATIOS[0];
  let nearestDistance = Math.abs(Math.log(targetRatio / nearest.ratio));

  for (const candidate of OPENROUTER_IMAGE_ASPECT_RATIOS.slice(1)) {
    // 使用对数距离比较横竖比例，避免宽图和竖图因数值尺度不同产生选择偏差。
    const distance = Math.abs(Math.log(targetRatio / candidate.ratio));

    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }

  return nearest.value;
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

    if (isOpenRouterGateway(this.config.aiGatewayBaseUrl)) {
      return this.editImageWithOpenRouterChat(input);
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

  private async editImageWithOpenRouterChat(input: EditImageInput): Promise<EditImageResult> {
    const response = await fetch(
      resolveGatewayUrl(this.config.aiGatewayBaseUrl, "chat/completions"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.aiGatewayApiKey}`
        },
        // OpenRouter 图片编辑同样走多模态 chat：文本指令 + 输入图 data URI，由模型返回新的图片。
        body: JSON.stringify({
          model: input.model,
          modalities: ["image", "text"],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: buildOpenRouterEditPrompt(input)
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

    return parseOpenRouterChatImageResult(payload, response.headers.get("x-request-id"));
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

export class HttpAiGatewayPromptOptimizerClient implements AiGatewayPromptOptimizerClient {
  constructor(
    private readonly config: {
      aiGatewayBaseUrl: string;
      aiGatewayApiKey: string;
    }
  ) {}

  async optimizePrompt(input: OptimizePromptInput): Promise<OptimizePromptResult> {
    if (this.config.aiGatewayApiKey.trim().length === 0) {
      throw new Error("AI_GATEWAY_API_KEY 未配置，不能调用提示词优化模型。");
    }

    const response = await fetch(
      resolveGatewayUrl(this.config.aiGatewayBaseUrl, "chat/completions"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.aiGatewayApiKey}`
        },
        // 提示词优化只走服务端 AI 网关，前端不传模型密钥；要求模型只返回优化后的提示词，方便直接回填输入框。
        body: JSON.stringify({
          model: input.model,
          messages: [
            {
              role: "system",
              content:
                "你是 AI 图片生成提示词优化助手。请把用户的中文短提示词优化为适合图片生成模型的中文提示词，补充主体、场景、构图、光线、材质、风格和画面细节。只返回优化后的提示词，不要解释，不要使用 Markdown。"
            },
            {
              role: "user",
              content: buildPromptOptimizationInput(input)
            }
          ]
        })
      }
    );

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(readGatewayErrorMessage(payload));
    }

    return parseOptimizePromptResult(payload, response.headers.get("x-request-id"));
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

function buildPromptOptimizationInput(input: OptimizePromptInput): string {
  const taskTypeText =
    input.taskType === undefined || input.taskType === null || input.taskType.trim().length === 0
      ? "通用图片生成"
      : input.taskType.trim();

  return `任务类型：${taskTypeText}\n原始提示词：${input.prompt.trim()}`;
}

function buildOpenRouterEditPrompt(input: EditImageInput): string {
  const countText =
    input.count > 1
      ? `请生成 ${String(input.count)} 张编辑后的图片。`
      : "请生成 1 张编辑后的图片。";

  // 图生图/修复/放大共用 image_edit 能力，提示词里保留用户意图、目标尺寸和输出数量。
  return `${input.prompt}\n\n输出要求：${countText}目标尺寸 ${input.size}。请基于上传图片完成编辑，并直接返回图片结果。`;
}

function parseOptimizePromptResult(
  payload: unknown,
  fallbackRequestId: string | null
): OptimizePromptResult {
  if (!isRecord(payload)) {
    throw new Error("AI 网关提示词优化响应格式异常。");
  }

  const choices = payload.choices;

  if (!Array.isArray(choices) || choices.length === 0 || !isRecord(choices[0])) {
    throw new Error("AI 网关提示词优化响应缺少文本结果。");
  }

  const message = choices[0].message;
  const content = isRecord(message) && typeof message.content === "string" ? message.content : "";
  const optimizedPrompt = normalizeOptimizedPrompt(content);

  if (optimizedPrompt.length === 0) {
    throw new Error("AI 网关未返回可用的优化提示词。");
  }

  return {
    request_id:
      readOptionalString(payload, "request_id") ??
      readOptionalString(payload, "id") ??
      fallbackRequestId ??
      `ai_${String(Date.now())}`,
    optimized_prompt: optimizedPrompt,
    usage: isRecord(payload.usage) ? payload.usage : null
  };
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

function normalizeOptimizedPrompt(content: string): string {
  return content
    .trim()
    .replace(/^```[a-z]*\s*/iu, "")
    .replace(/```$/u, "")
    .replace(/^["“”']|["“”']$/gu, "")
    .trim();
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
