ALTER TABLE image_tasks
  ADD COLUMN entitlement_id BIGINT UNSIGNED NULL COMMENT '任务首次计费使用的墨灵权益 ID' AFTER owner_user_id;
