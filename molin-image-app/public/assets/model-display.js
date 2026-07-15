const capabilityLabels = Object.freeze({
  image_generation: "图片生成",
  image_edit: "图片编辑",
  image_restore: "图片修复",
  vision_text: "图片理解",
  prompt_optimize: "提示词优化",
  moderation: "内容审核",
  upscale: "高清放大"
});

const taskTypeCapabilities = Object.freeze({
  text_to_image: "image_generation",
  image_to_text: "vision_text",
  image_to_image: "image_edit",
  image_restore: "image_edit",
  upscale: "image_edit"
});

export function resolveModelCapabilityLabel(capability) {
  return capabilityLabels[capability] ?? "其他能力";
}

export function resolveModelDisplayName(models, modelCode, capability, taskType) {
  if (modelCode === null || modelCode === undefined) {
    return "未记录";
  }

  const candidates = models.filter((model) => model.gateway_model_code === modelCode);
  // 旧任务可能没有保存能力标签，此时按任务类型推导，避免同一真实模型的多个用途互相错配。
  const expectedCapability = capability ?? taskTypeCapabilities[taskType];
  const matched = candidates.find((model) => model.capability === expectedCapability);

  if (matched !== undefined) {
    return matched.display_name;
  }

  if (candidates.length === 1) {
    return candidates[0].display_name;
  }

  // 历史模型已下架或目录无法唯一匹配时，不向用户暴露供应商技术 code。
  return "其他模型（已下架或不可用）";
}
