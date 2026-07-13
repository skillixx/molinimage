import assert from "node:assert/strict";
import test from "node:test";

import { EnvAiGatewayModelCatalogClient } from "../src/infrastructure/ai/ai-gateway-client.js";
import type {
  ImageModelConfigRecord,
  ImageModelConfigsRepository,
  SaveImageModelConfigInput,
  UpdateImageModelConfigInput
} from "../src/infrastructure/database/image-model-configs-repository.js";
import { ImageModelService } from "../src/modules/image-models/image-model-service.js";

void test("env 模型目录只返回 active 且 capability 被图片应用支持的模型", async () => {
  const service = new ImageModelService(
    new EnvAiGatewayModelCatalogClient(
      JSON.stringify([
        createModel("image-gen-default", "image_generation", "active", 20),
        createModel("vision-text-default", "vision_text", "active", 10),
        createModel("inactive-model", "image_generation", "inactive", 30),
        createModel("audio-model", "audio_generation", "active", 40)
      ])
    ),
    ["image_generation", "vision_text", "moderation"],
    ["image_generation", "vision_text", "moderation"]
  );

  const result = await service.listVisibleImageModels(479);

  assert.deepEqual(
    result.items.map((item) => item.gateway_model_code),
    ["vision-text-default", "image-gen-default"]
  );
  assert.deepEqual(result.missing_required_capabilities, ["moderation"]);
  assert.match(result.message ?? "", /moderation/);
  assert.equal(result.source, "env");
});

void test("没有可用模型时返回空列表和中文提示", async () => {
  const service = new ImageModelService(
    new EnvAiGatewayModelCatalogClient("[]"),
    ["image_generation", "vision_text", "moderation"],
    ["image_generation", "vision_text", "moderation"]
  );

  const result = await service.listVisibleImageModels(479);

  assert.deepEqual(result.items, []);
  assert.match(result.message ?? "", /当前暂无可用图片模型/);
});

void test("管理态关闭模型后用户端不可见，默认模型会跳过关闭项", async () => {
  const repository = new InMemoryImageModelConfigsRepository();
  const service = new ImageModelService(
    new EnvAiGatewayModelCatalogClient(
      JSON.stringify([
        createModel("image-gen-primary", "image_generation", "active", 10),
        createModel("image-gen-backup", "image_generation", "active", 20)
      ])
    ),
    ["image_generation"],
    ["image_generation"],
    repository
  );

  await service.syncModelCatalog(479);
  const managed = await service.listManagedModels(479);
  const primary = managed.items.find((item) => item.gateway_model_code === "image-gen-primary");

  assert.notEqual(primary, undefined);
  await service.updateManagedModel(
    primary?.id ?? "",
    { adminEnabled: false, defaultTaskTypes: ["text_to_image"] },
    479
  );

  const visible = await service.listVisibleImageModels(479);
  const resolved = await service.resolveTaskModel(479, {
    taskType: "text_to_image",
    gatewayModelCode: undefined
  });

  assert.deepEqual(
    visible.items.map((item) => item.gateway_model_code),
    ["image-gen-backup"]
  );
  assert.deepEqual(visible.items[0]?.default_task_types, []);
  assert.equal(resolved?.gatewayModelCode, "image-gen-backup");
  assert.equal(visible.source, "managed");
});

void test("模型能力或任务类型不匹配时解析为空", async () => {
  const repository = new InMemoryImageModelConfigsRepository();
  const service = new ImageModelService(
    new EnvAiGatewayModelCatalogClient(
      JSON.stringify([createModel("vision-model", "vision_text", "active", 10, ["image_to_text"])])
    ),
    ["vision_text"],
    ["vision_text"],
    repository
  );

  await service.syncModelCatalog(479);

  assert.equal(
    await service.resolveTaskModel(479, {
      taskType: "text_to_image",
      gatewayModelCode: "vision-model",
      gatewayCapability: "vision_text"
    }),
    null
  );
  assert.equal(
    await service.resolveTaskModel(479, {
      taskType: "image_to_text",
      gatewayModelCode: "vision-model",
      gatewayCapability: "image_generation"
    }),
    null
  );
});

void test("模型尺寸、输入文件数或输出数量不匹配时解析为空", async () => {
  const repository = new InMemoryImageModelConfigsRepository();
  const service = new ImageModelService(
    new EnvAiGatewayModelCatalogClient(
      JSON.stringify([createModel("strict-model", "image_generation", "active", 10)])
    ),
    ["image_generation"],
    ["image_generation"],
    repository
  );

  await service.syncModelCatalog(479);
  const managed = await service.listManagedModels(479);
  const model = managed.items[0];
  assert.notEqual(model, undefined);
  await service.updateManagedModel(
    model.id,
    {
      supportedImageSizes: ["1024x1024"],
      maxInputFiles: 0,
      maxOutputCount: 1
    },
    479
  );

  assert.equal(
    await service.resolveTaskModel(479, {
      taskType: "text_to_image",
      gatewayModelCode: "strict-model",
      gatewayCapability: "image_generation",
      imageSize: "1536x1024",
      imageCount: 1,
      inputFileCount: 0
    }),
    null
  );
  assert.equal(
    await service.resolveTaskModel(479, {
      taskType: "text_to_image",
      gatewayModelCode: "strict-model",
      gatewayCapability: "image_generation",
      imageSize: "1024x1024",
      imageCount: 2,
      inputFileCount: 0
    }),
    null
  );
});

function createModel(
  gatewayModelCode: string,
  capability: string,
  status: "active" | "inactive",
  sortOrder: number,
  supportedTaskTypes = ["text_to_image"]
) {
  return {
    gateway_model_code: gatewayModelCode,
    display_name: gatewayModelCode,
    description: "测试模型",
    capability,
    status,
    quality_tier: "standard",
    supported_task_types: supportedTaskTypes,
    supported_image_sizes: ["1024x1024"],
    supported_input_types: ["text"],
    supported_output_types: ["image"],
    max_input_files: 0,
    max_output_count: 1,
    sort_order: sortOrder
  };
}

class InMemoryImageModelConfigsRepository implements ImageModelConfigsRepository {
  private readonly records = new Map<string, ImageModelConfigRecord>();
  private readonly defaults = new Map<string, string>();

  listAll(): Promise<ImageModelConfigRecord[]> {
    return Promise.resolve(
      [...this.records.values()]
        .map((record) => this.withDefaults(record))
        .sort((left, right) => left.sort_order - right.sort_order)
    );
  }

  findById(modelId: string): Promise<ImageModelConfigRecord | undefined> {
    const record = this.records.get(modelId);
    return Promise.resolve(record === undefined ? undefined : this.withDefaults(record));
  }

  upsertFromCatalog(input: SaveImageModelConfigInput): Promise<void> {
    const existing = this.records.get(input.id);
    const now = "2026-07-11T00:00:00.000Z";

    // 同步只刷新来源元数据，管理员配置的能力、任务类型和开关保持稳定。
    this.records.set(input.id, {
      ...(existing ?? input),
      id: input.id,
      gateway_model_code: input.gateway_model_code,
      display_name: input.display_name,
      description: input.description,
      capability: existing?.capability ?? input.capability,
      source_capability: input.source_capability,
      source_status: input.source_status,
      source_available: true,
      admin_enabled: existing?.admin_enabled ?? input.admin_enabled,
      quality_tier: input.quality_tier,
      supported_task_types: existing?.supported_task_types ?? input.supported_task_types,
      supported_image_sizes: input.supported_image_sizes,
      supported_input_types: input.supported_input_types,
      supported_output_types: input.supported_output_types,
      max_input_files: input.max_input_files,
      max_output_count: input.max_output_count,
      sort_order: input.sort_order,
      default_task_types: existing?.default_task_types ?? [],
      synced_at: now,
      created_at: existing?.created_at ?? now,
      updated_at: now
    });
    return Promise.resolve();
  }

  markMissingSourceModels(activeModelIds: string[]): Promise<void> {
    const activeIds = new Set(activeModelIds);

    for (const [id, record] of this.records) {
      if (!activeIds.has(id)) {
        this.records.set(id, { ...record, source_available: false });
      }
    }

    return Promise.resolve();
  }

  async update(input: UpdateImageModelConfigInput): Promise<ImageModelConfigRecord | undefined> {
    const existing = this.records.get(input.id);

    if (existing === undefined) {
      return undefined;
    }

    this.records.set(input.id, {
      ...existing,
      display_name: input.display_name ?? existing.display_name,
      description: input.description ?? existing.description,
      capability: input.capability ?? existing.capability,
      admin_enabled: input.admin_enabled ?? existing.admin_enabled,
      supported_task_types: input.supported_task_types ?? existing.supported_task_types,
      supported_image_sizes: input.supported_image_sizes ?? existing.supported_image_sizes,
      max_input_files: input.max_input_files ?? existing.max_input_files,
      max_output_count: input.max_output_count ?? existing.max_output_count,
      sort_order: input.sort_order ?? existing.sort_order
    });

    if (input.default_task_types !== undefined) {
      await this.replaceDefaultTaskTypes(input.id, input.default_task_types);
    }

    return this.findById(input.id);
  }

  replaceDefaultTaskTypes(modelId: string, taskTypes: string[]): Promise<void> {
    for (const [taskType, currentModelId] of this.defaults) {
      if (currentModelId === modelId) {
        this.defaults.delete(taskType);
      }
    }

    for (const taskType of taskTypes) {
      this.defaults.set(taskType, modelId);
    }

    return Promise.resolve();
  }

  private withDefaults(record: ImageModelConfigRecord): ImageModelConfigRecord {
    return {
      ...record,
      default_task_types: [...this.defaults.entries()]
        .filter(([, modelId]) => modelId === record.id)
        .map(([taskType]) => taskType)
    };
  }
}
