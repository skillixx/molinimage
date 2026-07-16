import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

interface WorkbenchModel {
  gateway_model_code: string;
  capability: string;
  supported_task_types: string[];
  supported_input_types?: string[];
  max_input_files?: number;
  supported_image_sizes?: string[];
}

interface WorkbenchModesModule {
  findTaskModel(
    models: WorkbenchModel[],
    modelCode: string,
    taskType: string
  ): WorkbenchModel | undefined;
  isReferenceImageTaskModelCompatible(
    model: WorkbenchModel | undefined,
    taskType: string,
    imageSize?: string | null
  ): boolean;
}

const workbenchModes = (await import(
  pathToFileURL(resolve("public", "assets", "workbench-modes.js")).href
)) as WorkbenchModesModule;

void test("同一模型代码配置多种能力时按当前任务找到图生图记录", () => {
  const models: WorkbenchModel[] = [
    {
      gateway_model_code: "provider/shared-image-model",
      capability: "image_generation",
      supported_task_types: ["text_to_image"],
      supported_input_types: ["text"],
      max_input_files: 0
    },
    {
      gateway_model_code: "provider/shared-image-model",
      capability: "image_edit",
      supported_task_types: ["image_to_image"],
      supported_input_types: ["image", "text"],
      max_input_files: 1
    }
  ];

  const selected = workbenchModes.findTaskModel(
    models,
    "provider/shared-image-model",
    "image_to_image"
  );

  assert.ok(selected);
  assert.equal(selected.capability, "image_edit");
  assert.deepEqual(selected.supported_input_types, ["image", "text"]);
});

void test("模型代码相同但任务能力不匹配时不返回其他能力记录", () => {
  const models: WorkbenchModel[] = [
    {
      gateway_model_code: "provider/shared-image-model",
      capability: "image_generation",
      supported_task_types: ["text_to_image"]
    }
  ];

  assert.equal(
    workbenchModes.findTaskModel(models, "provider/shared-image-model", "image_to_image"),
    undefined
  );
});

void test("图片修复从同代码多能力记录中选择 image_restore 能力", () => {
  const models: WorkbenchModel[] = [
    {
      gateway_model_code: "provider/shared-image-model",
      capability: "image_generation",
      supported_task_types: ["text_to_image"],
      supported_input_types: ["text"],
      max_input_files: 0
    },
    {
      gateway_model_code: "provider/shared-image-model",
      capability: "image_edit",
      supported_task_types: ["image_restore"],
      supported_input_types: ["image", "text"],
      supported_image_sizes: ["1024x1024"],
      max_input_files: 1
    }
  ];

  const selected = workbenchModes.findTaskModel(
    models,
    "provider/shared-image-model",
    "image_restore"
  );
  assert.ok(selected);
  assert.equal(
    workbenchModes.isReferenceImageTaskModelCompatible(
      selected,
      "image_restore",
      "1024x1024"
    ),
    true
  );
});

void test("明确不支持参考图或输出尺寸的修复模型被拒绝", () => {
  const textOnly: WorkbenchModel = {
    gateway_model_code: "provider/text-only",
    capability: "image_edit",
    supported_task_types: ["image_restore"],
    supported_input_types: ["text"],
    supported_image_sizes: ["1024x1024"],
    max_input_files: 0
  };
  const wrongSize: WorkbenchModel = {
    ...textOnly,
    gateway_model_code: "provider/image-model",
    supported_input_types: ["image", "text"],
    max_input_files: 1
  };

  assert.equal(
    workbenchModes.isReferenceImageTaskModelCompatible(textOnly, "image_restore"),
    false
  );
  assert.equal(
    workbenchModes.isReferenceImageTaskModelCompatible(
      wrongSize,
      "image_restore",
      "768x1024"
    ),
    false
  );
});
