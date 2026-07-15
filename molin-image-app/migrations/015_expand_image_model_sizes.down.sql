-- 回滚时仅恢复图片生成和图片编辑模型的旧核心尺寸，不影响其他模型能力配置。
UPDATE image_model_configs
SET
  supported_image_sizes = JSON_ARRAY(
    '1024x1024',
    '1024x1536',
    '1536x1024'
  ),
  updated_at = CURRENT_TIMESTAMP(3)
WHERE capability IN ('image_generation', 'image_edit');
