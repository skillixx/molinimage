import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { splitSqlStatements } from "../src/infrastructure/database/migration-runner.js";

const foundationMigrationPath = resolve("migrations", "001_create_image_foundation_tables.up.sql");
const requiredTables = [
  "image_tasks",
  "files",
  "billing_events",
  "ai_gateway_call_logs",
  "style_presets",
  "user_collections",
  "pricing_rules",
  "image_model_configs",
  "image_model_defaults",
  "billing_reconciliation_attempts",
  "risk_control_events",
  "risk_control_counters"
];
const requiredIndexes = [
  "uk_image_tasks_idempotency_key",
  "idx_image_tasks_owner_status_created",
  "idx_image_tasks_owner_deleted_created",
  "idx_image_tasks_task_type_created",
  "uk_billing_events_idempotency_key",
  "idx_billing_events_task_id",
  "idx_billing_events_owner_status_created",
  "uk_ai_gateway_call_logs_request_id",
  "idx_ai_gateway_call_logs_task_id",
  "idx_files_owner_created",
  "uk_user_collections_owner_task",
  "idx_user_collections_owner_created",
  "idx_pricing_rules_task_active",
  "idx_pricing_rules_capability_active",
  "uk_image_model_configs_source",
  "idx_image_model_configs_visible",
  "idx_image_model_defaults_model",
  "idx_style_presets_task_category_enabled_sort",
  "idx_billing_reconciliation_task_created",
  "idx_billing_reconciliation_result_created",
  "idx_risk_control_owner_created",
  "idx_risk_control_ip_created",
  "idx_risk_control_decision_created",
  "idx_risk_control_reason_created",
  "idx_risk_control_counters_updated"
];

void test("基础表 migration 包含 P1-G02 要求的表、引擎、字符集和关键索引", async () => {
  const sql = await readAllUpMigrations();

  for (const table of requiredTables) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "i"));
  }

  assert.equal((sql.match(/ENGINE=InnoDB/gi) ?? []).length, requiredTables.length);
  assert.equal((sql.match(/DEFAULT CHARSET=utf8mb4/gi) ?? []).length, requiredTables.length);

  for (const indexName of requiredIndexes) {
    assert.match(sql, new RegExp(indexName, "i"));
  }
});

void test("SQL 拆分器能按语句执行 migration 文件", async () => {
  const sql = await readFile(foundationMigrationPath, "utf8");
  const statements = splitSqlStatements(sql);

  // 每张基础表各一条 CREATE TABLE，保证迁移执行器不会依赖 multiStatements。
  assert.equal(statements.length, 6);
  assert.ok(statements.every((statement) => /CREATE TABLE IF NOT EXISTS/i.test(statement)));
});

void test("作品历史管理 migration 独立补齐软删除和收藏索引", async () => {
  const sql = await readFile(
    resolve("migrations", "002_add_history_management_fields.up.sql"),
    "utf8"
  );
  const statements = splitSqlStatements(sql);

  assert.equal(statements.length, 2);
  assert.match(sql, /ADD COLUMN deleted_at/i);
  assert.match(sql, /idx_image_tasks_owner_deleted_created/i);
  assert.match(sql, /uk_user_collections_owner_task/i);
});

void test("高清放大 migration 为任务增加倍率字段并支持回滚", async () => {
  const upSql = await readFile(resolve("migrations", "003_add_upscale_factor.up.sql"), "utf8");
  const downSql = await readFile(resolve("migrations", "003_add_upscale_factor.down.sql"), "utf8");

  assert.match(upSql, /ADD COLUMN upscale_factor TINYINT UNSIGNED NULL/i);
  assert.match(downSql, /DROP COLUMN upscale_factor/i);
});

void test("再次编辑 migration 为任务增加来源关系并建立查询索引", async () => {
  const upSql = await readFile(resolve("migrations", "004_add_source_task_id.up.sql"), "utf8");
  const downSql = await readFile(resolve("migrations", "004_add_source_task_id.down.sql"), "utf8");

  assert.match(upSql, /ADD COLUMN source_task_id VARCHAR\(64\) NULL/i);
  assert.match(upSql, /idx_image_tasks_source_task_id/i);
  assert.match(downSql, /DROP INDEX idx_image_tasks_source_task_id/i);
  assert.match(downSql, /DROP COLUMN source_task_id/i);
});

void test("任务权益 migration 支持幂等请求核对首次计费权益", async () => {
  const upSql = await readFile(resolve("migrations", "005_add_task_entitlement_id.up.sql"), "utf8");
  const downSql = await readFile(
    resolve("migrations", "005_add_task_entitlement_id.down.sql"),
    "utf8"
  );

  assert.match(upSql, /ADD COLUMN entitlement_id BIGINT UNSIGNED NULL/i);
  assert.match(downSql, /DROP COLUMN entitlement_id/i);
});

void test("历史任务权益 migration 从预占计费事件回填权益 ID", async () => {
  const sql = await readFile(
    resolve("migrations", "006_backfill_task_entitlement_id.up.sql"),
    "utf8"
  );

  assert.match(sql, /JOIN billing_events AS billing_event/i);
  assert.match(sql, /billing_event\.id = image_task\.billing_event_id/i);
  assert.match(sql, /SET image_task\.entitlement_id = billing_event\.moling_entitlement_id/i);
  assert.match(sql, /billing_event\.event_type = 'reserve'/i);
});

void test("价格规则 migration 覆盖任务、模型能力、质量、尺寸和启用状态", async () => {
  const upSql = await readFile(resolve("migrations", "007_create_pricing_rules.up.sql"), "utf8");
  const downSql = await readFile(
    resolve("migrations", "007_create_pricing_rules.down.sql"),
    "utf8"
  );

  for (const field of [
    "task_type",
    "gateway_model_code",
    "gateway_capability",
    "quality",
    "image_size",
    "points_per_unit",
    "active"
  ]) {
    assert.match(upSql, new RegExp(field, "i"));
  }

  assert.match(downSql, /DROP TABLE IF EXISTS pricing_rules/i);
});

void test("价格规则维度 migration 禁止重复匹配规则", async () => {
  const upSql = await readFile(
    resolve("migrations", "008_add_pricing_rule_dimension_key.up.sql"),
    "utf8"
  );
  const downSql = await readFile(
    resolve("migrations", "008_add_pricing_rule_dimension_key.down.sql"),
    "utf8"
  );

  assert.match(upSql, /GENERATED ALWAYS AS/i);
  assert.match(upSql, /uk_pricing_rules_task_dimensions/i);
  assert.match(downSql, /DROP INDEX uk_pricing_rules_task_dimensions/i);
});

void test("模型管理 migration 支持同步、开关和默认模型配置", async () => {
  const upSql = await readFile(
    resolve("migrations", "009_create_image_model_configs.up.sql"),
    "utf8"
  );
  const downSql = await readFile(
    resolve("migrations", "009_create_image_model_configs.down.sql"),
    "utf8"
  );

  assert.match(upSql, /CREATE TABLE IF NOT EXISTS image_model_configs/i);
  assert.match(upSql, /admin_enabled/i);
  assert.match(upSql, /supported_task_types JSON/i);
  assert.match(upSql, /CREATE TABLE IF NOT EXISTS image_model_defaults/i);
  assert.match(upSql, /PRIMARY KEY \(task_type\)/i);
  assert.match(downSql, /DROP TABLE IF EXISTS image_model_defaults/i);
  assert.match(downSql, /DROP TABLE IF EXISTS image_model_configs/i);
});

void test("风格模板 migration 支持分类、预览图、排序启停和默认模板", async () => {
  const upSql = await readFile(resolve("migrations", "010_enhance_style_presets.up.sql"), "utf8");
  const downSql = await readFile(
    resolve("migrations", "010_enhance_style_presets.down.sql"),
    "utf8"
  );

  assert.match(upSql, /ADD COLUMN category VARCHAR\(64\)/i);
  assert.match(upSql, /ADD COLUMN preview_image_url VARCHAR\(512\)/i);
  assert.match(upSql, /idx_style_presets_task_category_enabled_sort/i);
  assert.match(upSql, /tti_product_poster/i);
  assert.match(upSql, /change_background/i);
  assert.match(upSql, /old_photo/i);
  assert.match(downSql, /DROP COLUMN preview_image_url/i);
  assert.match(downSql, /DROP COLUMN category/i);
});

void test("标注再次编辑 migration 记录原始来源文件并支持回滚", async () => {
  const upSql = await readFile(resolve("migrations", "016_add_source_file_id.up.sql"), "utf8");
  const downSql = await readFile(resolve("migrations", "016_add_source_file_id.down.sql"), "utf8");

  assert.match(upSql, /ADD COLUMN source_file_id VARCHAR\(64\) NULL/i);
  assert.match(upSql, /idx_image_tasks_source_file_id/i);
  assert.match(downSql, /DROP INDEX idx_image_tasks_source_file_id/i);
  assert.match(downSql, /DROP COLUMN source_file_id/i);
});

void test("风格模板扩充 migration 覆盖三类任务并只回滚新增模板", async () => {
  const upSql = await readFile(resolve("migrations", "014_seed_more_style_presets.up.sql"), "utf8");
  const downSql = await readFile(
    resolve("migrations", "014_seed_more_style_presets.down.sql"),
    "utf8"
  );
  const newTemplateIds = [
    "tti_commercial_photo",
    "tti_ecommerce_main_image",
    "tti_xiaohongshu_cover",
    "tti_douyin_cover",
    "tti_realistic_photo",
    "tti_chinese_style",
    "tti_anime_style",
    "tti_children_book",
    "tti_watercolor",
    "tti_oil_painting",
    "tti_cyberpunk",
    "tti_minimal_premium",
    "tti_3d_render",
    "tti_logo_icon",
    "tti_movie_poster",
    "edit_scene_replace",
    "edit_outfit_change",
    "edit_hair_style",
    "edit_season_change",
    "edit_lighting",
    "edit_to_chinese_style",
    "edit_to_anime",
    "edit_product_refine",
    "restore_portrait_enhance",
    "restore_low_light",
    "restore_low_resolution",
    "restore_background_extend",
    "restore_color_repair",
    "restore_detail_enhance"
  ];

  assert.match(upSql, /ON DUPLICATE KEY UPDATE/i);
  assert.match(upSql, /text_to_image/i);
  assert.match(upSql, /image_to_image/i);
  assert.match(upSql, /image_restore/i);
  assert.match(upSql, /tti_xiaohongshu_cover/i);
  assert.match(upSql, /tti_anime_style/i);
  assert.match(upSql, /edit_outfit_change/i);
  assert.match(upSql, /edit_product_refine/i);
  assert.match(upSql, /restore_portrait_enhance/i);
  assert.match(upSql, /restore_low_light/i);
  assert.match(
    upSql,
    /UPDATE style_presets SET category = 'portrait', sort_order = 60 WHERE id = 'tti_portrait_editorial'/i
  );

  for (const templateId of newTemplateIds) {
    assert.match(upSql, new RegExp(templateId, "i"));
    assert.match(downSql, new RegExp(templateId, "i"));
  }

  assert.doesNotMatch(downSql, /tti_product_poster/i);
  assert.doesNotMatch(downSql, /keep_subject/i);
  assert.doesNotMatch(downSql, /old_photo/i);
});

void test("图片模型尺寸扩充 migration 让生成和编辑模型支持工作台完整尺寸", async () => {
  const upSql = await readFile(
    resolve("migrations", "015_expand_image_model_sizes.up.sql"),
    "utf8"
  );
  const downSql = await readFile(
    resolve("migrations", "015_expand_image_model_sizes.down.sql"),
    "utf8"
  );
  const expandedSizes = [
    "512x512",
    "640x640",
    "768x768",
    "896x896",
    "1024x1024",
    "512x768",
    "640x960",
    "768x1024",
    "896x1152",
    "960x1280",
    "720x1280",
    "1024x1536",
    "640x360",
    "768x512",
    "896x512",
    "960x640",
    "1024x768",
    "1280x720",
    "1280x960",
    "1536x1024"
  ];

  assert.match(upSql, /UPDATE image_model_configs/i);
  assert.match(upSql, /capability IN \('image_generation', 'image_edit'\)/i);
  assert.match(upSql, /JSON_ARRAY/i);

  for (const size of expandedSizes) {
    assert.match(upSql, new RegExp(size, "i"));
  }

  assert.match(downSql, /1024x1024/i);
  assert.match(downSql, /1024x1536/i);
  assert.match(downSql, /1536x1024/i);
  assert.doesNotMatch(downSql, /512x512/i);
  assert.doesNotMatch(downSql, /1280x720/i);
});

void test("对账管理 migration 支持重试结算、重试释放和结果记录", async () => {
  const upSql = await readFile(
    resolve("migrations", "011_create_billing_reconciliation_attempts.up.sql"),
    "utf8"
  );
  const downSql = await readFile(
    resolve("migrations", "011_create_billing_reconciliation_attempts.down.sql"),
    "utf8"
  );

  assert.match(upSql, /CREATE TABLE IF NOT EXISTS billing_reconciliation_attempts/i);
  assert.match(upSql, /retry_settle/i);
  assert.match(upSql, /retry_release/i);
  assert.match(upSql, /before_error_code/i);
  assert.match(upSql, /after_error_code/i);
  assert.match(upSql, /idx_billing_reconciliation_task_created/i);
  assert.match(downSql, /DROP TABLE IF EXISTS billing_reconciliation_attempts/i);
});

void test("风控 migration 支持用户限流、IP 限流、高风险开关和审计查询", async () => {
  const upSql = await readFile(
    resolve("migrations", "012_create_risk_control_events.up.sql"),
    "utf8"
  );
  const downSql = await readFile(
    resolve("migrations", "012_create_risk_control_events.down.sql"),
    "utf8"
  );

  assert.match(upSql, /CREATE TABLE IF NOT EXISTS risk_control_events/i);
  assert.match(upSql, /owner_user_id/i);
  assert.match(upSql, /ip_address/i);
  assert.match(upSql, /gateway_capability/i);
  assert.match(upSql, /decision ENUM\('allow', 'block'\)/i);
  assert.match(upSql, /idx_risk_control_owner_created/i);
  assert.match(upSql, /idx_risk_control_ip_created/i);
  assert.match(downSql, /DROP TABLE IF EXISTS risk_control_events/i);
});

void test("风控计数器 migration 支持窗口内原子限流", async () => {
  const upSql = await readFile(
    resolve("migrations", "013_create_risk_control_counters.up.sql"),
    "utf8"
  );
  const downSql = await readFile(
    resolve("migrations", "013_create_risk_control_counters.down.sql"),
    "utf8"
  );

  assert.match(upSql, /CREATE TABLE IF NOT EXISTS risk_control_counters/i);
  assert.match(upSql, /subject_type ENUM\('user', 'ip'\)/i);
  assert.match(upSql, /PRIMARY KEY \(subject_type, subject_key, bucket_start\)/i);
  assert.match(upSql, /request_count INT UNSIGNED/i);
  assert.match(downSql, /DROP TABLE IF EXISTS risk_control_counters/i);
});

async function readAllUpMigrations(): Promise<string> {
  const migrationsDir = resolve("migrations");
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".up.sql")).sort();
  const contents = await Promise.all(
    files.map(async (file) => await readFile(resolve(migrationsDir, file), "utf8"))
  );

  return contents.join("\n");
}
