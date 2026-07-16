import { FileServiceError } from "../modules/files/file-service.js";

export function buildTextToImagePromptWithTemplate(
  prompt: string | null,
  template: string | null
): string {
  const userPrompt = prompt?.trim() ?? "";

  if (template === null) {
    return userPrompt;
  }

  return `${template}\n\n用户创作要求：${userPrompt}`;
}

export function buildImageEditPromptWithTemplate(
  prompt: string | null,
  editMode: string | null,
  template: string | null
): string {
  const userPrompt = prompt?.trim();
  const modeInstruction = template ?? resolveImageEditModeInstruction(editMode);

  if (userPrompt !== undefined && userPrompt.length > 0) {
    return `${modeInstruction}\n\n用户编辑要求：${userPrompt}`;
  }

  return modeInstruction;
}

export function buildImageRestorePromptWithTemplate(
  prompt: string | null,
  restoreType: string | null,
  template: string | null
): string {
  const userPrompt = prompt?.trim();
  const typeInstruction = template ?? resolveImageRestoreTypeInstruction(restoreType);
  const qualityInstruction =
    "请只修复图片质量问题，保留原始主体身份、构图、时代特征和真实纹理，避免改变人物五官或添加无关内容。";

  if (userPrompt !== undefined && userPrompt.length > 0) {
    return `${typeInstruction}\n${qualityInstruction}\n\n用户补充要求：${userPrompt}`;
  }

  return `${typeInstruction}\n${qualityInstruction}`;
}

export function buildUpscalePrompt(
  factor: 2 | 4,
  targetWidth: number,
  targetHeight: number
): string {
  return [
    `请将输入图片高清放大 ${String(factor)} 倍，输出尺寸必须为 ${String(targetWidth)}x${String(targetHeight)} 像素。`,
    "保持原始主体、构图、色彩和画面内容不变，增强真实细节，减少锯齿、噪点和压缩伪影。",
    "不要添加新主体、文字、水印或改变人物身份。"
  ].join("\n");
}

export function buildVisionTextPrompt(prompt: string | null): string {
  const userPrompt = prompt?.trim();

  if (userPrompt !== undefined && userPrompt.length > 0) {
    return userPrompt;
  }

  return [
    "请分析这张图片，输出适合用户直接复制使用的中文内容。",
    "请包含：1. 标题；2. 画面描述；3. 关键词标签；4. 可用于社交媒体或商品场景的短文案。"
  ].join("\n");
}

export function resolveUpscaleTargetDimension(source: number, factor: 2 | 4): number {
  const target = source * factor;

  if (!Number.isSafeInteger(target) || target > 32_768) {
    throw new FileServiceError(
      "UPSCALE_TARGET_TOO_LARGE",
      "放大后的目标尺寸超过 32768 像素限制。",
      400
    );
  }

  return target;
}

function resolveImageEditModeInstruction(editMode: string | null): string {
  const instructions: Record<string, string> = {
    keep_subject: "请基于参考图生成新图，尽量保持主体身份、构图重点和核心视觉特征。",
    change_background: "请基于参考图生成新图，保持主体不变，重点替换或重绘背景环境。",
    change_style: "请基于参考图生成新图，保持主体和构图关系，重点转换整体艺术风格。",
    variation: "请基于参考图生成同主题变体，保留画面语义并提供新的细节变化。"
  };

  // 未知编辑模式走通用图生图提示词，避免历史任务因为旧 mode code 失败。
  return instructions[editMode ?? ""] ?? "请基于参考图生成新图，并遵循用户补充的编辑要求。";
}

function resolveImageRestoreTypeInstruction(restoreType: string | null): string {
  const instructions: Record<string, string> = {
    old_photo: "请修复老照片中的划痕、折痕、褪色、污渍和局部缺损，并自然恢复细节。",
    denoise: "请进行去噪增强，减少颗粒、压缩噪点和色块，同时保留边缘与细节。",
    deblur: "请将模糊图片变清晰，改善主体边缘和局部细节，避免过度锐化与伪影。",
    color_enhance: "请增强图片色彩，校正白平衡、饱和度和对比度，保持自然真实。"
  };

  // 修复类型可由模板覆盖；没有模板时使用内置兜底，保证旧任务仍可执行。
  return instructions[restoreType ?? ""] ?? "请修复图片质量问题并自然增强画面细节。";
}
