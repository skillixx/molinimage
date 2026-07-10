import assert from "node:assert/strict";
import test from "node:test";

import { EnvAiGatewayModelCatalogClient } from "../src/infrastructure/ai/ai-gateway-client.js";
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

function createModel(
  gatewayModelCode: string,
  capability: string,
  status: "active" | "inactive",
  sortOrder: number
) {
  return {
    gateway_model_code: gatewayModelCode,
    display_name: gatewayModelCode,
    description: "测试模型",
    capability,
    status,
    quality_tier: "standard",
    supported_task_types: ["text_to_image"],
    supported_image_sizes: ["1024x1024"],
    supported_input_types: ["text"],
    supported_output_types: ["image"],
    max_input_files: 0,
    max_output_count: 1,
    sort_order: sortOrder
  };
}
