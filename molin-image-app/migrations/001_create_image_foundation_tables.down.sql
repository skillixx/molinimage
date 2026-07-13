-- P1-G02 回滚：按依赖使用方向反向删除基础表。
-- 当前基础表不声明外键，回滚仍按业务依赖顺序执行，便于后续增加外键时保持习惯。

DROP TABLE IF EXISTS user_collections;
DROP TABLE IF EXISTS style_presets;
DROP TABLE IF EXISTS ai_gateway_call_logs;
DROP TABLE IF EXISTS billing_events;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS image_tasks;
