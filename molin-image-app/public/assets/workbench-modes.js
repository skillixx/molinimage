export const modeConfig = {
  text_to_image: {
    title: "文生图",
    eyebrow: "TEXT TO IMAGE",
    capability: "image_generation",
    placeholder: "输入画面主题、风格、主体、背景和细节",
    requiresUpload: false,
    supportsPromptInput: true,
    supportsStylePreset: true
  },
  image_to_text: {
    title: "图生文",
    eyebrow: "IMAGE TO TEXT",
    capability: "vision_text",
    placeholder: "可选：说明希望生成描述、标题、标签、商品文案或社媒文案",
    requiresUpload: true,
    supportsPromptInput: false,
    supportsStylePreset: false
  },
  image_to_image: {
    title: "图生图",
    eyebrow: "IMAGE TO IMAGE",
    capability: "image_edit",
    placeholder: "描述需要保持、替换或增强的画面部分",
    requiresUpload: true,
    supportsPromptInput: true,
    supportsStylePreset: true
  },
  image_restore: {
    title: "图片修复",
    eyebrow: "IMAGE RESTORE",
    capability: "image_edit",
    placeholder: "描述修复目标，例如去噪、增强清晰度、色彩修复",
    requiresUpload: true,
    supportsPromptInput: true,
    supportsStylePreset: true
  },
  upscale: {
    title: "高清放大",
    eyebrow: "IMAGE UPSCALE",
    capability: "image_edit",
    placeholder: "高清放大将保持原图内容并增强细节",
    requiresUpload: true,
    supportsPromptInput: false,
    supportsStylePreset: false
  }
};

export const imageSizeOptions = [
  { value: "512x512", label: "512 x 512 · 头像/图标", ratio: "1:1", usage: "头像、图标、小封面" },
  { value: "640x640", label: "640 x 640 · 轻量方图", ratio: "1:1", usage: "快速草图、聊天配图" },
  { value: "768x768", label: "768 x 768 · 社媒方图", ratio: "1:1", usage: "社媒配图、商品主图" },
  { value: "896x896", label: "896 x 896 · 精细方图", ratio: "1:1", usage: "作品预览、商品展示" },
  {
    value: "1024x1024",
    label: "1024 x 1024 · 标准方图",
    ratio: "1:1",
    usage: "通用出图、作品封面"
  },
  { value: "512x768", label: "512 x 768 · 小竖图", ratio: "2:3", usage: "手机预览、竖版草图" },
  { value: "640x960", label: "640 x 960 · 轻量海报", ratio: "2:3", usage: "海报草图、人物构图" },
  { value: "768x1024", label: "768 x 1024 · 竖版内容", ratio: "3:4", usage: "小红书、竖版配图" },
  { value: "896x1152", label: "896 x 1152 · 竖版详情", ratio: "7:9", usage: "商品详情、内容封面" },
  { value: "960x1280", label: "960 x 1280 · 高清竖图", ratio: "3:4", usage: "竖版海报、内容长图" },
  { value: "720x1280", label: "720 x 1280 · 手机竖屏", ratio: "9:16", usage: "短视频封面、手机壁纸" },
  {
    value: "1024x1536",
    label: "1024 x 1536 · 海报竖图",
    ratio: "2:3",
    usage: "海报、人物写真、竖版广告"
  },
  { value: "640x360", label: "640 x 360 · 轻量宽屏", ratio: "16:9", usage: "视频草图、横版预览" },
  { value: "768x512", label: "768 x 512 · 小横图", ratio: "3:2", usage: "文章插图、横版草图" },
  { value: "896x512", label: "896 x 512 · 宽屏配图", ratio: "7:4", usage: "横版运营图、内容配图" },
  { value: "960x640", label: "960 x 640 · 横版摄影", ratio: "3:2", usage: "场景图、产品横图" },
  {
    value: "1024x768",
    label: "1024 x 768 · 横版内容",
    ratio: "4:3",
    usage: "PPT 配图、详情页插图"
  },
  { value: "1280x720", label: "1280 x 720 · 视频封面", ratio: "16:9", usage: "视频封面、横幅预览" },
  { value: "1280x960", label: "1280 x 960 · 高清横图", ratio: "4:3", usage: "PPT 封面、详情页大图" },
  {
    value: "1536x1024",
    label: "1536 x 1024 · 封面横图",
    ratio: "3:2",
    usage: "横版封面、Banner、场景图"
  }
];

export function hasStylePresetSupport(taskType) {
  // 前端模式是否展示模板卡片统一由模式配置决定，新增模式时只需要补 modeConfig。
  return modeConfig[taskType]?.supportsStylePreset === true;
}
