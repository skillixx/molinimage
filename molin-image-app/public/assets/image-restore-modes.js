export const imageRestoreCategoryOptions = [
  { value: "all", label: "全部" },
  { value: "quality", label: "画质修复" },
  { value: "color", label: "色彩与老照片" },
  { value: "portrait", label: "人像" },
  { value: "local", label: "局部处理" }
];

const commonParameters = [
  {
    key: "restore_strength",
    label: "修复强度",
    type: "segmented",
    options: [
      { value: "light", label: "轻微" },
      { value: "standard", label: "标准" },
      { value: "strong", label: "强力" }
    ],
    helper: "强度越高，模型对噪点、模糊和缺损的处理越明显"
  },
  {
    key: "detail_preservation",
    label: "细节保留",
    type: "segmented",
    options: [
      { value: "low", label: "低" },
      { value: "medium", label: "中" },
      { value: "high", label: "高" }
    ],
    helper: "高细节保留更适合人物、文字和具有年代感的照片"
  },
  {
    key: "preserve_composition",
    label: "保持原始构图",
    type: "toggle",
    helper: "开启后会限制模型改变主体位置和画面结构"
  }
];

export const imageRestoreModes = [
  {
    mode_code: "smart_restore",
    display_name: "智能修复",
    description: "自动分析模糊、噪点、色彩和局部缺损，推荐平衡参数。",
    category: ["all", "quality"],
    preview: "smart",
    scene_tags: ["自动分析", "综合修复", "推荐"],
    backend_preset_id: "restore_detail_enhance",
    requires_annotation: false,
    parameter_schema: [
      ...commonParameters,
      { key: "denoise_level", label: "去噪程度", type: "range", min: 0, max: 100, step: 5, unit: "%" },
      { key: "clarity_level", label: "清晰度", type: "range", min: 0, max: 100, step: 5, unit: "%" },
      { key: "restore_color", label: "色彩恢复", type: "toggle" }
    ],
    defaults: {
      restore_strength: "standard",
      detail_preservation: "high",
      preserve_composition: true,
      denoise_level: 45,
      clarity_level: 55,
      restore_color: true
    }
  },
  {
    mode_code: "denoise",
    display_name: "去噪增强",
    description: "减少颗粒、压缩噪点和色块，同时保护主体边缘。",
    category: ["all", "quality"],
    preview: "denoise",
    scene_tags: ["颗粒", "压缩痕迹", "边缘保护"],
    backend_preset_id: "denoise",
    requires_annotation: false,
    parameter_schema: [
      ...commonParameters,
      { key: "denoise_level", label: "去噪程度", type: "range", min: 10, max: 100, step: 5, unit: "%" }
    ],
    defaults: {
      restore_strength: "standard",
      detail_preservation: "high",
      preserve_composition: true,
      denoise_level: 60
    }
  },
  {
    mode_code: "clarity",
    display_name: "清晰度增强",
    description: "改善失焦和运动模糊，恢复边缘与局部纹理。",
    category: ["all", "quality"],
    preview: "clarity",
    scene_tags: ["去模糊", "锐度", "纹理"],
    backend_preset_id: "deblur",
    requires_annotation: false,
    parameter_schema: [
      ...commonParameters,
      { key: "clarity_level", label: "清晰度", type: "range", min: 10, max: 100, step: 5, unit: "%" }
    ],
    defaults: {
      restore_strength: "standard",
      detail_preservation: "high",
      preserve_composition: true,
      clarity_level: 65
    }
  },
  {
    mode_code: "old_photo",
    display_name: "老照片修复",
    description: "处理划痕、折痕、褪色和污渍，保留年代质感。",
    category: ["all", "color"],
    preview: "old-photo",
    scene_tags: ["划痕", "褪色", "缺损"],
    backend_preset_id: "old_photo",
    requires_annotation: false,
    parameter_schema: [
      ...commonParameters,
      { key: "scratch_repair", label: "划痕修复", type: "range", min: 10, max: 100, step: 5, unit: "%" },
      { key: "restore_color", label: "恢复自然色彩", type: "toggle" }
    ],
    defaults: {
      restore_strength: "standard",
      detail_preservation: "high",
      preserve_composition: true,
      scratch_repair: 70,
      restore_color: false
    }
  },
  {
    mode_code: "color_repair",
    display_name: "色彩修复",
    description: "校正白平衡、偏色、对比度和饱和度，恢复自然色彩。",
    category: ["all", "color"],
    preview: "color",
    scene_tags: ["白平衡", "偏色", "对比度"],
    backend_preset_id: "restore_color_repair",
    requires_annotation: false,
    parameter_schema: [
      ...commonParameters,
      { key: "color_strength", label: "色彩恢复", type: "range", min: 10, max: 100, step: 5, unit: "%" }
    ],
    defaults: {
      restore_strength: "standard",
      detail_preservation: "high",
      preserve_composition: true,
      color_strength: 60
    }
  },
  {
    mode_code: "portrait_restore",
    display_name: "人像修复",
    description: "增强面部与发丝细节，保护身份特征和真实皮肤纹理。",
    category: ["all", "portrait"],
    preview: "portrait",
    scene_tags: ["面部保护", "身份保持", "自然肤质"],
    backend_preset_id: "restore_portrait_enhance",
    requires_annotation: false,
    parameter_schema: [
      ...commonParameters,
      { key: "face_protection", label: "面部保护", type: "toggle" },
      { key: "face_detail", label: "面部细节", type: "range", min: 10, max: 80, step: 5, unit: "%" }
    ],
    defaults: {
      restore_strength: "light",
      detail_preservation: "high",
      preserve_composition: true,
      face_protection: true,
      face_detail: 45
    }
  },
  {
    mode_code: "local_repair",
    display_name: "局部修复",
    description: "在画布上标记破损或需要增强的区域，仅处理标注位置。",
    category: ["all", "local"],
    preview: "local",
    scene_tags: ["画布标注", "区域修复", "精准"],
    backend_preset_id: "restore_detail_enhance",
    requires_annotation: true,
    parameter_schema: [
      ...commonParameters,
      { key: "edge_blend", label: "边缘融合", type: "range", min: 0, max: 100, step: 5, unit: "%" }
    ],
    defaults: {
      restore_strength: "standard",
      detail_preservation: "high",
      preserve_composition: true,
      edge_blend: 55
    }
  },
  {
    mode_code: "remove_object",
    display_name: "去除元素",
    description: "标记需要移除的物体或文字，并根据周围内容自然补全。",
    category: ["all", "local"],
    preview: "remove",
    scene_tags: ["移除物体", "去文字", "背景补全"],
    backend_preset_id: "restore_detail_enhance",
    requires_annotation: true,
    parameter_schema: [
      ...commonParameters,
      { key: "fill_consistency", label: "背景一致性", type: "range", min: 20, max: 100, step: 5, unit: "%" }
    ],
    defaults: {
      restore_strength: "strong",
      detail_preservation: "high",
      preserve_composition: true,
      fill_consistency: 80
    }
  }
];

export function getImageRestoreMode(modeCode) {
  return imageRestoreModes.find((mode) => mode.mode_code === modeCode) ?? imageRestoreModes[0];
}

export function createImageRestoreParameterValues() {
  return Object.fromEntries(
    imageRestoreModes.map((mode) => [mode.mode_code, { ...mode.defaults }])
  );
}

export function validateImageRestoreMode(mode, hasAnnotations) {
  if (mode.requires_annotation && !hasAnnotations) {
    return { valid: false, message: `${mode.display_name}需要先在画布中标注处理区域` };
  }

  return { valid: true, message: `${mode.display_name}参数已就绪` };
}

export function composeImageRestorePrompt(mode, prompt, values) {
  const parameterText = mode.parameter_schema
    .map((parameter) => {
      const value = values[parameter.key];

      if (value === undefined || value === null || String(value).trim().length === 0) {
        return null;
      }

      const optionLabel = parameter.options?.find((option) => option.value === value)?.label;
      const displayValue =
        parameter.type === "toggle" ? (value ? "开启" : "关闭") : (optionLabel ?? String(value));
      return `${parameter.label}：${displayValue}${parameter.unit ?? ""}`;
    })
    .filter(Boolean)
    .join("；");

  // 修复高级参数进入结构化提示词，公开任务字段和既有 worker 契约保持不变。
  return [
    `修复方式：${mode.display_name}`,
    parameterText,
    prompt.trim().length > 0 ? `用户补充说明：${prompt.trim()}` : ""
  ]
    .filter((part) => part.length > 0)
    .join("。")
    .replace(/。{2,}/gu, "。");
}
