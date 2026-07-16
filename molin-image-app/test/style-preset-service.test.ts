import assert from "node:assert/strict";
import test from "node:test";

import type {
  SaveStylePresetInput,
  StylePresetRecord,
  StylePresetsRepository
} from "../src/infrastructure/database/style-presets-repository.js";
import {
  StylePresetService,
  StylePresetServiceError
} from "../src/modules/style-presets/style-preset-service.js";

void test("风格模板服务只向用户端返回启用模板并按任务类型过滤", async () => {
  const repository = new InMemoryStylePresetsRepository();
  const service = new StylePresetService(repository);
  await service.createPreset({
    name: "商品海报",
    category: "product",
    taskType: "text_to_image",
    promptTemplate: "商业摄影风格",
    previewImageUrl: "https://example.com/product.jpg",
    sortOrder: 20
  });
  const disabled = await service.createPreset({
    name: "停用模板",
    category: "archive",
    taskType: "text_to_image",
    promptTemplate: "不应展示",
    enabled: false,
    sortOrder: 10
  });

  const visible = await service.listVisiblePresets("text_to_image");
  const managed = await service.listManagedPresets();

  assert.deepEqual(
    visible.items.map((item) => item.name),
    ["商品海报"]
  );
  assert.equal(managed.total, 2);
  assert.equal(
    await service.getEnabledPresetForTask("text_to_image", disabled.preset.id),
    undefined
  );
});

void test("风格模板服务支持编辑名称、分类、prompt、预览图、排序和启停", async () => {
  const repository = new InMemoryStylePresetsRepository();
  const service = new StylePresetService(repository);
  const created = await service.createPreset({
    name: "旧名称",
    category: "general",
    taskType: "image_to_image",
    promptTemplate: "旧 prompt",
    previewImageUrl: "https://example.com/old.jpg",
    enabled: true,
    sortOrder: 30
  });
  const updated = await service.updatePreset(created.preset.id, {
    name: "换背景",
    category: "edit",
    promptTemplate: "保持主体，替换背景",
    previewImageUrl: "https://example.com/new.jpg",
    enabled: false,
    sortOrder: 5
  });

  assert.equal(updated.preset.name, "换背景");
  assert.equal(updated.preset.category, "edit");
  assert.equal(updated.preset.prompt_template, "保持主体，替换背景");
  assert.equal(updated.preset.preview_image_url, "https://example.com/new.jpg");
  assert.equal(updated.preset.enabled, false);
  assert.equal(updated.preset.sort_order, 5);
});

void test("风格模板服务按文生图、图生图和图片修复任务类型分别过滤", async () => {
  const repository = new InMemoryStylePresetsRepository();
  const service = new StylePresetService(repository);

  await service.createPreset({
    name: "小红书封面",
    category: "social",
    taskType: "text_to_image",
    promptTemplate: "小红书封面风格"
  });
  await service.createPreset({
    name: "换服装",
    category: "portrait",
    taskType: "image_to_image",
    promptTemplate: "保持人物身份，只调整服装"
  });
  await service.createPreset({
    name: "人像增强",
    category: "portrait",
    taskType: "image_restore",
    promptTemplate: "保持人物身份并增强清晰度"
  });

  assert.deepEqual(
    (await service.listVisiblePresets("text_to_image")).items.map((item) => item.name),
    ["小红书封面"]
  );
  assert.deepEqual(
    (await service.listVisiblePresets("image_to_image")).items.map((item) => item.name),
    ["换服装"]
  );
  assert.deepEqual(
    (await service.listVisiblePresets("image_restore")).items.map((item) => item.name),
    ["人像增强"]
  );
});

void test("风格模板预览图 URL 必须是 http 或 https", async () => {
  const service = new StylePresetService(new InMemoryStylePresetsRepository());

  await assert.rejects(
    () =>
      service.createPreset({
        name: "非法预览",
        category: "general",
        taskType: "text_to_image",
        promptTemplate: "测试",
        previewImageUrl: "javascript:alert(1)"
      }),
    (error: unknown) =>
      error instanceof StylePresetServiceError && error.code === "STYLE_PRESET_PREVIEW_URL_INVALID"
  );
});

void test("风格模板只允许工作台可展示的任务类型", async () => {
  const service = new StylePresetService(new InMemoryStylePresetsRepository());

  await assert.rejects(
    () =>
      service.createPreset({
        name: "图生文模板",
        category: "vision",
        taskType: "image_to_text",
        promptTemplate: "不应该允许"
      }),
    (error: unknown) =>
      error instanceof StylePresetServiceError &&
      error.code === "STYLE_PRESET_TASK_TYPE_UNSUPPORTED"
  );
});

class InMemoryStylePresetsRepository implements StylePresetsRepository {
  private readonly records = new Map<string, StylePresetRecord>();

  listAll(): Promise<StylePresetRecord[]> {
    return Promise.resolve(this.sorted([...this.records.values()]));
  }

  listEnabled(taskType?: string): Promise<StylePresetRecord[]> {
    return Promise.resolve(
      this.sorted(
        [...this.records.values()].filter(
          (record) => record.enabled && (taskType === undefined || record.task_type === taskType)
        )
      )
    );
  }

  findById(presetId: string): Promise<StylePresetRecord | undefined> {
    return Promise.resolve(this.records.get(presetId));
  }

  findEnabledByTaskAndId(
    taskType: string,
    presetId: string
  ): Promise<StylePresetRecord | undefined> {
    const record = this.records.get(presetId);

    return Promise.resolve(
      record?.enabled === true && record.task_type === taskType ? record : undefined
    );
  }

  create(input: SaveStylePresetInput): Promise<StylePresetRecord> {
    const record = toRecord(input);
    this.records.set(record.id, record);
    return Promise.resolve(record);
  }

  update(input: SaveStylePresetInput): Promise<StylePresetRecord | undefined> {
    if (!this.records.has(input.id)) {
      return Promise.resolve(undefined);
    }

    const record = toRecord(input);
    this.records.set(record.id, record);
    return Promise.resolve(record);
  }

  private sorted(records: StylePresetRecord[]): StylePresetRecord[] {
    return records.sort(
      (left, right) =>
        left.task_type.localeCompare(right.task_type) ||
        left.category.localeCompare(right.category) ||
        left.sort_order - right.sort_order
    );
  }
}

function toRecord(input: SaveStylePresetInput): StylePresetRecord {
  return {
    ...input,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z"
  };
}
