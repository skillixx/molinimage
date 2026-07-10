-- P2-G05：作品历史管理字段与索引。
-- 软删除只隐藏作品历史，MinIO 对象由后续后台清理任务异步回收，避免误删仍被引用的文件。

ALTER TABLE image_tasks
  ADD COLUMN deleted_at DATETIME(3) NULL COMMENT '作品历史软删除时间；对象文件由后台清理任务异步处理',
  ADD KEY idx_image_tasks_owner_deleted_created (owner_user_id, deleted_at, created_at);

ALTER TABLE user_collections
  ADD UNIQUE KEY uk_user_collections_owner_task (owner_user_id, task_id);
