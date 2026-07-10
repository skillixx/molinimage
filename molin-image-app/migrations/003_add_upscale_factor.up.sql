ALTER TABLE image_tasks
  ADD COLUMN upscale_factor TINYINT UNSIGNED NULL COMMENT '高清放大倍率，仅允许 2 或 4' AFTER image_count;
