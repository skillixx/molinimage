-- 补齐图片生成和图片编辑模型的尺寸能力，确保工作台中的尺寸选项都可以被当前通用模型选择。
-- 这里不修改图生文、提示词优化和审核模型，因为这些能力不依赖图片输出尺寸。
UPDATE image_model_configs
SET
  supported_image_sizes = JSON_ARRAY(
    '512x512',
    '640x640',
    '768x768',
    '896x896',
    '1024x1024',
    '512x768',
    '640x960',
    '768x1024',
    '896x1152',
    '960x1280',
    '720x1280',
    '1024x1536',
    '640x360',
    '768x512',
    '896x512',
    '960x640',
    '1024x768',
    '1280x720',
    '1280x960',
    '1536x1024'
  ),
  updated_at = CURRENT_TIMESTAMP(3)
WHERE capability IN ('image_generation', 'image_edit');
