ALTER TABLE image_tasks
  DROP INDEX idx_image_tasks_source_file_id,
  DROP COLUMN source_file_id;
