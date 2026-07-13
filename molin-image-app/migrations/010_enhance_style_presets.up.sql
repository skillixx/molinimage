ALTER TABLE style_presets
  ADD COLUMN category VARCHAR(64) NOT NULL DEFAULT 'general' COMMENT '模板分类，例如 portrait、product、restore',
  ADD COLUMN preview_image_url VARCHAR(512) NULL COMMENT '模板预览图 URL，优先用于前端展示',
  DROP KEY idx_style_presets_task_enabled_sort,
  ADD KEY idx_style_presets_task_category_enabled_sort (task_type, category, enabled, sort_order);

INSERT INTO style_presets (
  id, name, category, task_type, prompt_template, preview_image_url, enabled, sort_order
) VALUES
  ('tti_product_poster', '商品海报', 'product', 'text_to_image', '以商业摄影和高级电商海报风格呈现，主体清晰，光线精致，背景干净，适合商品展示。', 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=640&q=80', 1, 10),
  ('tti_portrait_editorial', '人物大片', 'portrait', 'text_to_image', '以时尚杂志封面质感呈现，人物神态自然，布光有层次，画面具有高级摄影感。', 'https://images.unsplash.com/photo-1496747611176-843222e1e57c?auto=format&fit=crop&w=640&q=80', 1, 20),
  ('tti_illustration_flat', '扁平插画', 'illustration', 'text_to_image', '使用现代扁平插画风格，色彩明快，构图简洁，适合社媒封面和产品说明图。', 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=640&q=80', 1, 30),
  ('keep_subject', '保持主体', 'edit', 'image_to_image', '请基于参考图生成新图，尽量保持主体身份、构图重点和核心视觉特征。', 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=640&q=80', 1, 10),
  ('change_background', '换背景', 'edit', 'image_to_image', '请基于参考图生成新图，保持主体不变，重点替换或重绘背景环境。', 'https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=640&q=80', 1, 20),
  ('change_style', '换风格', 'edit', 'image_to_image', '请基于参考图生成新图，保持主体和构图关系，重点转换整体艺术风格。', 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=640&q=80', 1, 30),
  ('variation', '生成变体', 'edit', 'image_to_image', '请基于参考图生成同主题变体，保留画面语义并提供新的细节变化。', 'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?auto=format&fit=crop&w=640&q=80', 1, 40),
  ('old_photo', '老照片修复', 'restore', 'image_restore', '请修复老照片中的划痕、折痕、褪色、污渍和局部缺损，并自然恢复细节。', 'https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=640&q=80', 1, 10),
  ('denoise', '去噪增强', 'restore', 'image_restore', '请进行去噪增强，减少颗粒、压缩噪点和色块，同时保留边缘与细节。', 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=640&q=80', 1, 20),
  ('deblur', '模糊变清晰', 'restore', 'image_restore', '请将模糊图片变清晰，改善主体边缘和局部细节，避免过度锐化与伪影。', 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=640&q=80', 1, 30),
  ('color_enhance', '色彩增强', 'restore', 'image_restore', '请增强图片色彩，校正白平衡、饱和度和对比度，保持自然真实。', 'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?auto=format&fit=crop&w=640&q=80', 1, 40)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  category = VALUES(category),
  prompt_template = VALUES(prompt_template),
  preview_image_url = VALUES(preview_image_url),
  sort_order = VALUES(sort_order);
