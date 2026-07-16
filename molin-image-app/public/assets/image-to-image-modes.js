export const imageEditCategoryOptions = [
  { value: "common", label: "常用" },
  { value: "local", label: "局部编辑" },
  { value: "style", label: "风格转换" },
  { value: "scene", label: "场景重构" },
  { value: "commerce", label: "商品设计" }
];

export const imageEditModes = [
  {
    mode_code: "keep_subject",
    display_name: "保持主体",
    description: "保留人物或商品主体，仅调整周围画面。",
    category: ["common", "scene"],
    preview: "subject",
    scene_tags: ["人物", "商品", "换环境"],
    prompt_placeholder: "例如：保持人物姿态和服装，将环境改为清晨的海边咖啡馆",
    supported_capabilities: ["image_edit"],
    parameter_schema: [
      {
        key: "subject_strength",
        label: "主体保留强度",
        type: "range",
        min: 30,
        max: 100,
        step: 5,
        unit: "%",
        helper: "数值越高，主体轮廓与身份特征越稳定"
      }
    ],
    defaults: { subject_strength: 80 }
  },
  {
    mode_code: "change_background",
    display_name: "更换背景",
    description: "替换环境，并让光线、景深与主体自然融合。",
    category: ["common", "scene", "commerce"],
    preview: "background",
    scene_tags: ["换景", "融合", "宣传图"],
    prompt_placeholder: "例如：背景替换为现代美术馆，保留人物，匹配柔和顶光与浅景深",
    supported_capabilities: ["image_edit"],
    parameter_schema: [
      {
        key: "background_description",
        label: "背景描述",
        type: "textarea",
        placeholder: "描述新的地点、时间、光线和氛围",
        helper: "背景描述会与主提示词一起提交"
      },
      {
        key: "subject_blend",
        label: "主体融合强度",
        type: "range",
        min: 20,
        max: 100,
        step: 5,
        unit: "%",
        helper: "控制新背景光影对主体的影响程度"
      }
    ],
    defaults: { background_description: "", subject_blend: 70 }
  },
  {
    mode_code: "change_style",
    display_name: "风格转换",
    description: "保留构图，将画面转换为指定视觉风格。",
    category: ["common", "style"],
    preview: "style",
    scene_tags: ["插画", "摄影", "艺术化"],
    prompt_placeholder: "例如：保持原构图，转换为细腻水彩插画，减少硬边和高饱和色",
    supported_capabilities: ["image_edit"],
    parameter_schema: [
      {
        key: "style_family",
        label: "目标风格",
        type: "segmented",
        options: [
          { value: "cinematic", label: "电影感" },
          { value: "watercolor", label: "水彩" },
          { value: "anime", label: "动漫" },
          { value: "minimal", label: "极简" }
        ]
      },
      {
        key: "style_strength",
        label: "风格强度",
        type: "range",
        min: 20,
        max: 100,
        step: 5,
        unit: "%",
        helper: "数值越高，原图质感变化越明显"
      }
    ],
    defaults: { style_family: "cinematic", style_strength: 65 }
  },
  {
    mode_code: "variation",
    display_name: "生成变体",
    description: "围绕原图构图探索不同细节和视觉方案。",
    category: ["common", "style"],
    preview: "variation",
    scene_tags: ["灵感", "多方案", "构图"],
    prompt_placeholder: "例如：保持整体主题，探索更具张力的构图和暖色光线",
    supported_capabilities: ["image_edit"],
    parameter_schema: [
      {
        key: "variation_strength",
        label: "变化强度",
        type: "range",
        min: 10,
        max: 100,
        step: 5,
        unit: "%",
        helper: "低强度保留更多原图，高强度允许重新构图"
      }
    ],
    defaults: { variation_strength: 55 }
  },
  {
    mode_code: "inpaint",
    display_name: "局部重绘",
    description: "通过画布标注需要替换、擦除或补充的区域。",
    category: ["common", "local"],
    preview: "inpaint",
    scene_tags: ["标注", "替换", "去除"],
    prompt_placeholder: "例如：移除标注区域的路人，并根据周围路面自然补全",
    supported_capabilities: ["image_edit"],
    parameter_schema: [
      {
        key: "mask_feather",
        label: "边缘融合",
        type: "range",
        min: 0,
        max: 100,
        step: 5,
        unit: "%",
        helper: "提高数值可让重绘区域边缘更柔和"
      }
    ],
    defaults: { mask_feather: 45 }
  },
  {
    mode_code: "outpaint",
    display_name: "扩图",
    description: "向指定方向扩展画面，并补全合理的新内容。",
    category: ["common", "local", "scene"],
    preview: "outpaint",
    scene_tags: ["扩展画布", "横竖转换", "补全"],
    prompt_placeholder: "例如：向左右扩展城市街景，延续建筑透视、路面和傍晚灯光",
    supported_capabilities: ["image_edit"],
    parameter_schema: [
      {
        key: "expand_direction",
        label: "扩展方向",
        type: "segmented",
        options: [
          { value: "all", label: "四周" },
          { value: "horizontal", label: "左右" },
          { value: "vertical", label: "上下" },
          { value: "right", label: "向右" }
        ]
      },
      {
        key: "expand_ratio",
        label: "扩展比例",
        type: "range",
        min: 10,
        max: 80,
        step: 10,
        unit: "%",
        helper: "表示相对原画面的扩展幅度"
      }
    ],
    defaults: { expand_direction: "all", expand_ratio: 30 }
  },
  {
    mode_code: "product_scene",
    display_name: "商品换景",
    description: "保留商品外观，生成适合电商投放的场景图。",
    category: ["common", "scene", "commerce"],
    preview: "product",
    scene_tags: ["电商", "主图", "营销"],
    prompt_placeholder: "例如：保持商品包装与文字，放置在明亮厨房台面，生成自然接触阴影",
    supported_capabilities: ["image_edit"],
    parameter_schema: [
      {
        key: "product_scene",
        label: "场景模板",
        type: "segmented",
        options: [
          { value: "studio", label: "影棚" },
          { value: "home", label: "家居" },
          { value: "outdoor", label: "户外" },
          { value: "festival", label: "节日" }
        ]
      },
      {
        key: "lighting_match",
        label: "光影匹配",
        type: "range",
        min: 20,
        max: 100,
        step: 5,
        unit: "%",
        helper: "控制接触阴影、反光和环境光融合"
      }
    ],
    defaults: { product_scene: "studio", lighting_match: 80 }
  },
  {
    mode_code: "portrait_retouch",
    display_name: "人像美化",
    description: "优化肤色、光线和细节，同时保持人物身份。",
    category: ["common", "local"],
    preview: "portrait",
    scene_tags: ["人像", "肤色", "光线"],
    prompt_placeholder: "例如：保持人物身份和五官，改善肤色与面部光线，保留真实皮肤质感",
    supported_capabilities: ["image_edit"],
    parameter_schema: [
      {
        key: "retouch_strength",
        label: "美化强度",
        type: "range",
        min: 10,
        max: 80,
        step: 5,
        unit: "%",
        helper: "建议保持在 60% 以下以保留自然质感"
      }
    ],
    defaults: { retouch_strength: 40 }
  }
];

export function getImageEditMode(modeCode) {
  return imageEditModes.find((mode) => mode.mode_code === modeCode) ?? imageEditModes[0];
}

export function createImageEditParameterValues() {
  return Object.fromEntries(imageEditModes.map((mode) => [mode.mode_code, { ...mode.defaults }]));
}

export function composeImageEditPrompt(mode, prompt, values) {
  const parameterText = mode.parameter_schema
    .map((parameter) => {
      const value = values[parameter.key];

      if (value === undefined || value === null || String(value).trim().length === 0) {
        return null;
      }

      const optionLabel = parameter.options?.find((option) => option.value === value)?.label;
      return `${parameter.label}：${optionLabel ?? String(value)}${parameter.unit ?? ""}`;
    })
    .filter(Boolean)
    .join("；");

  // 高级参数暂通过结构化提示词传给现有图生图网关，保持公开 API 与历史任务兼容。
  return [`编辑模式：${mode.display_name}`, prompt.trim(), parameterText]
    .filter((part) => part.length > 0)
    .join("。")
    .replace(/。{2,}/gu, "。");
}
