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
  "user_collections"
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
  "idx_user_collections_owner_created"
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
  assert.equal(statements.length, requiredTables.length);
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

async function readAllUpMigrations(): Promise<string> {
  const migrationsDir = resolve("migrations");
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".up.sql")).sort();
  const contents = await Promise.all(
    files.map(async (file) => await readFile(resolve(migrationsDir, file), "utf8"))
  );

  return contents.join("\n");
}
