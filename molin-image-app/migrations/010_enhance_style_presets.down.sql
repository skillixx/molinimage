DELETE FROM style_presets
WHERE id IN (
  'tti_product_poster',
  'tti_portrait_editorial',
  'tti_illustration_flat',
  'keep_subject',
  'change_background',
  'change_style',
  'variation',
  'old_photo',
  'denoise',
  'deblur',
  'color_enhance'
);

ALTER TABLE style_presets
  DROP KEY idx_style_presets_task_category_enabled_sort,
  ADD KEY idx_style_presets_task_enabled_sort (task_type, enabled, sort_order),
  DROP COLUMN preview_image_url,
  DROP COLUMN category;
