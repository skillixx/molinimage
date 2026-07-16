import { randomUUID } from "node:crypto";

import type {
  SaveStylePresetInput,
  StylePresetRecord,
  StylePresetsRepository
} from "../../infrastructure/database/style-presets-repository.js";
import { supportsStylePreset } from "../image-tasks/image-task-types.js";

export interface SaveStylePresetRequest {
  name: string;
  category: string;
  taskType: string;
  promptTemplate: string;
  previewImageFileId?: string | null;
  previewImageUrl?: string | null;
  enabled?: boolean;
  sortOrder?: number;
}

export class StylePresetServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "StylePresetServiceError";
  }
}

export class StylePresetService {
  constructor(private readonly repository: StylePresetsRepository) {}

  // 用户端只读取启用模板；停用模板必须在服务层过滤，避免前端绕过管理开关。
  async listVisiblePresets(taskType?: string): Promise<{
    items: StylePresetRecord[];
    page: 1;
    page_size: number;
    total: number;
  }> {
    const normalizedTaskType =
      taskType === undefined ? undefined : normalizeTaskType(taskType, "task_type");
    const items = await this.repository.listEnabled(normalizedTaskType);

    return { items, page: 1, page_size: items.length, total: items.length };
  }

  async listManagedPresets(): Promise<{
    items: StylePresetRecord[];
    page: 1;
    page_size: number;
    total: number;
  }> {
    const items = await this.repository.listAll();

    return { items, page: 1, page_size: items.length, total: items.length };
  }

  async createPreset(request: SaveStylePresetRequest): Promise<{ preset: StylePresetRecord }> {
    const input = normalizePresetInput(`style_${randomUUID().replaceAll("-", "")}`, request);
    const preset = await this.repository.create(input);

    return { preset };
  }

  async updatePreset(
    presetId: string,
    request: Partial<SaveStylePresetRequest>
  ): Promise<{ preset: StylePresetRecord }> {
    const existing = await this.repository.findById(normalizeRequiredString(presetId, "preset_id"));

    if (existing === undefined) {
      throw new StylePresetServiceError("STYLE_PRESET_NOT_FOUND", "风格模板不存在。", 404);
    }

    // PATCH 只更新传入字段；未传字段沿用旧值，便于管理端单独启停或调整排序。
    const merged: SaveStylePresetRequest = {
      name: request.name ?? existing.name,
      category: request.category ?? existing.category,
      taskType: request.taskType ?? existing.task_type,
      promptTemplate: request.promptTemplate ?? existing.prompt_template,
      previewImageFileId:
        request.previewImageFileId === undefined
          ? existing.preview_image_file_id
          : request.previewImageFileId,
      previewImageUrl:
        request.previewImageUrl === undefined
          ? existing.preview_image_url
          : request.previewImageUrl,
      enabled: request.enabled ?? existing.enabled,
      sortOrder: request.sortOrder ?? existing.sort_order
    };
    const updated = await this.repository.update(normalizePresetInput(existing.id, merged));

    if (updated === undefined) {
      throw new StylePresetServiceError("STYLE_PRESET_NOT_FOUND", "风格模板不存在。", 404);
    }

    return { preset: updated };
  }

  async getEnabledPresetForTask(
    taskType: string,
    presetId: string
  ): Promise<StylePresetRecord | undefined> {
    return await this.repository.findEnabledByTaskAndId(
      normalizeTaskType(taskType, "task_type"),
      normalizeRequiredString(presetId, "style_preset_id")
    );
  }
}

function normalizePresetInput(id: string, request: SaveStylePresetRequest): SaveStylePresetInput {
  // 管理端写入前统一做字段清洗，保证数据库中不会出现空名称、非法任务类型或负数排序。
  return {
    id,
    name: normalizeRequiredString(request.name, "name"),
    category: normalizeRequiredString(request.category, "category"),
    task_type: normalizeTaskType(request.taskType, "task_type"),
    prompt_template: normalizeRequiredString(request.promptTemplate, "prompt_template"),
    preview_image_file_id: normalizeOptionalString(request.previewImageFileId),
    preview_image_url: normalizeOptionalUrl(request.previewImageUrl),
    enabled: request.enabled !== false,
    sort_order: normalizeNonNegativeInteger(request.sortOrder ?? 0, "sort_order")
  };
}

function normalizeTaskType(value: string, field: string): string {
  const normalized = normalizeRequiredString(value, field);

  // 只允许图片应用已经支持的任务类型，避免管理端误建无法被 worker 消费的模板。
  if (!supportsStylePreset(normalized)) {
    throw new StylePresetServiceError(
      "STYLE_PRESET_TASK_TYPE_UNSUPPORTED",
      "模板任务类型不支持。",
      400
    );
  }

  return normalized;
}

function normalizeRequiredString(value: string, field: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new StylePresetServiceError("STYLE_PRESET_FIELD_REQUIRED", `${field} 不能为空。`, 400);
  }

  return normalized;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const normalized = value?.trim();

  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function normalizeOptionalUrl(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);

  if (normalized === null) {
    return null;
  }

  try {
    const url = new URL(normalized);

    // 预览图会直接渲染到浏览器，限制为 http/https，避免写入 javascript: 等危险协议。
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new StylePresetServiceError(
      "STYLE_PRESET_PREVIEW_URL_INVALID",
      "预览图 URL 必须是 http 或 https 地址。",
      400
    );
  }

  return normalized;
}

function normalizeNonNegativeInteger(value: number, field: string): number {
  // 排序值必须稳定且非负，保证管理端拖动/编辑后前端展示顺序可预测。
  if (!Number.isInteger(value) || value < 0) {
    throw new StylePresetServiceError(
      "STYLE_PRESET_FIELD_INVALID",
      `${field} 必须是非负整数。`,
      400
    );
  }

  return value;
}
