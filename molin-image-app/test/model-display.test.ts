import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

interface DisplayModel {
  gateway_model_code: string;
  display_name: string;
  capability: string;
}

interface ModelDisplayModule {
  resolveModelCapabilityLabel(capability: string): string;
  resolveModelDisplayName(
    models: DisplayModel[],
    modelCode: string | null,
    capability: string | null,
    taskType: string
  ): string;
}

const modelDisplay = (await import(
  pathToFileURL(resolve("public", "assets", "model-display.js")).href
)) as ModelDisplayModule;

void test("模型能力 code 全部转换为中文展示名称", () => {
  assert.equal(modelDisplay.resolveModelCapabilityLabel("image_generation"), "图片生成");
  assert.equal(modelDisplay.resolveModelCapabilityLabel("image_edit"), "图片编辑");
  assert.equal(modelDisplay.resolveModelCapabilityLabel("image_restore"), "图片修复");
  assert.equal(modelDisplay.resolveModelCapabilityLabel("vision_text"), "图片理解");
  assert.equal(modelDisplay.resolveModelCapabilityLabel("prompt_optimize"), "提示词优化");
  assert.equal(modelDisplay.resolveModelCapabilityLabel("moderation"), "内容审核");
  assert.equal(modelDisplay.resolveModelCapabilityLabel("upscale"), "高清放大");
  assert.equal(modelDisplay.resolveModelCapabilityLabel("future_capability"), "其他能力");
});

void test("旧任务缺少能力标签时按任务类型解析正确中文模型名", () => {
  const models: DisplayModel[] = [
    {
      gateway_model_code: "same-provider-model",
      display_name: "通用图片生成",
      capability: "image_generation"
    },
    {
      gateway_model_code: "same-provider-model",
      display_name: "通用图生图",
      capability: "image_edit"
    },
    {
      gateway_model_code: "same-provider-model",
      display_name: "通用图片理解",
      capability: "vision_text"
    }
  ];

  assert.equal(
    modelDisplay.resolveModelDisplayName(models, "same-provider-model", null, "text_to_image"),
    "通用图片生成"
  );
  assert.equal(
    modelDisplay.resolveModelDisplayName(models, "same-provider-model", null, "image_to_image"),
    "通用图生图"
  );
  assert.equal(
    modelDisplay.resolveModelDisplayName(models, "same-provider-model", null, "image_to_text"),
    "通用图片理解"
  );
});

void test("模型不可用时使用中文兜底且不暴露技术 code", () => {
  assert.equal(
    modelDisplay.resolveModelDisplayName([], "provider/removed-model", null, "text_to_image"),
    "其他模型（已下架或不可用）"
  );
  assert.equal(modelDisplay.resolveModelDisplayName([], null, null, "text_to_image"), "未记录");
});
