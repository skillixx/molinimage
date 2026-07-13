export const supportedImageTaskTypes = [
  "text_to_image",
  "image_to_text",
  "image_to_image",
  "image_restore",
  "upscale"
] as const;

export const stylePresetTaskTypes = ["text_to_image", "image_to_image", "image_restore"] as const;

export const supportedImageRestoreTypes = [
  "old_photo",
  "denoise",
  "deblur",
  "color_enhance"
] as const;

const supportedImageTaskTypeSet = new Set<string>(supportedImageTaskTypes);
const stylePresetTaskTypeSet = new Set<string>(stylePresetTaskTypes);
const supportedImageRestoreTypeSet = new Set<string>(supportedImageRestoreTypes);

export function isSupportedImageTaskType(taskType: string): boolean {
  // 所有可创建任务类型统一从这里判断，避免新增模式时散落修改多个 Set。
  return supportedImageTaskTypeSet.has(taskType);
}

export function supportsStylePreset(taskType: string): boolean {
  // 只有需要提示词模板的任务才允许绑定 style_preset_id，图生文和放大暂不走模板。
  return stylePresetTaskTypeSet.has(taskType);
}

export function isSupportedImageRestoreType(restoreType: string): boolean {
  // 图片修复的内置类型保留兜底校验；后续可迁移为数据库模板配置。
  return supportedImageRestoreTypeSet.has(restoreType);
}
