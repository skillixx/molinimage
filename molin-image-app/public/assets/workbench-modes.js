export const modeConfig = {
  text_to_image: {
    title: "文生图",
    eyebrow: "TEXT TO IMAGE",
    capability: "image_generation",
    placeholder: "输入画面主题、风格、主体、背景和细节",
    requiresUpload: false,
    supportsStylePreset: true
  },
  image_to_text: {
    title: "图生文",
    eyebrow: "IMAGE TO TEXT",
    capability: "vision_text",
    placeholder: "可选：说明希望生成描述、标题、标签、商品文案或社媒文案",
    requiresUpload: true,
    supportsStylePreset: false
  },
  image_to_image: {
    title: "图生图",
    eyebrow: "IMAGE TO IMAGE",
    capability: "image_edit",
    placeholder: "描述需要保持、替换或增强的画面部分",
    requiresUpload: true,
    supportsStylePreset: true
  },
  image_restore: {
    title: "图片修复",
    eyebrow: "IMAGE RESTORE",
    capability: "image_edit",
    placeholder: "描述修复目标，例如去噪、增强清晰度、色彩修复",
    requiresUpload: true,
    supportsStylePreset: true
  },
  upscale: {
    title: "高清放大",
    eyebrow: "IMAGE UPSCALE",
    capability: "image_edit",
    placeholder: "高清放大将保持原图内容并增强细节",
    requiresUpload: true,
    supportsStylePreset: false
  }
};

export const imageSizeOptions = [
  { value: "512x512", label: "512 x 512 · 小方图" },
  { value: "768x768", label: "768 x 768 · 方图" },
  { value: "1024x1024", label: "1024 x 1024 · 标准方图" },
  { value: "512x768", label: "512 x 768 · 小竖图" },
  { value: "768x1024", label: "768 x 1024 · 竖图" },
  { value: "1024x1536", label: "1024 x 1536 · 海报竖图" },
  { value: "768x512", label: "768 x 512 · 小横图" },
  { value: "1024x768", label: "1024 x 768 · 横图" },
  { value: "1536x1024", label: "1536 x 1024 · 封面横图" }
];

export function hasStylePresetSupport(taskType) {
  // 前端模式是否展示模板卡片统一由模式配置决定，新增模式时只需要补 modeConfig。
  return modeConfig[taskType]?.supportsStylePreset === true;
}
