-- 回滚 P2-G05 作品历史管理字段与索引。

ALTER TABLE user_collections
  DROP KEY uk_user_collections_owner_task;

ALTER TABLE image_tasks
  DROP KEY idx_image_tasks_owner_deleted_created,
  DROP COLUMN deleted_at;
