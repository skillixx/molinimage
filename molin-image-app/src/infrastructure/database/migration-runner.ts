import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import mysql, { type Connection } from "mysql2/promise";

export type MigrationDirection = "up" | "down";

export interface MigrationFile {
  version: string;
  name: string;
  upPath: string;
  downPath: string;
}

export interface MigrationRunResult {
  direction: MigrationDirection;
  appliedVersions: string[];
}

export async function runMigrations(options: {
  databaseUrl: string;
  migrationsDir: string;
  direction: MigrationDirection;
}): Promise<MigrationRunResult> {
  const connection = await mysql.createConnection(options.databaseUrl);

  try {
    await ensureMigrationTable(connection);
    const migrations = await discoverMigrations(options.migrationsDir);

    if (options.direction === "up") {
      return await runUpMigrations(connection, migrations);
    }

    return await runDownMigration(connection, migrations);
  } finally {
    await connection.end();
  }
}

async function ensureMigrationTable(connection: Connection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='应用数据库迁移记录'
  `);
}

async function discoverMigrations(migrationsDir: string): Promise<MigrationFile[]> {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(migrationsDir);
  const upFiles = files
    .filter((file) => file.endsWith(".up.sql"))
    .sort((left, right) => left.localeCompare(right));

  return upFiles.map((upFile) => {
    const version = upFile.split("_", 1)[0] ?? "";
    const downFile = upFile.replace(".up.sql", ".down.sql");

    if (version.length === 0 || !files.includes(downFile)) {
      // 每个 up migration 必须有对应 down 文件，确保上线前就具备可回滚路径。
      throw new Error(`迁移文件缺少版本号或回滚文件：${upFile}`);
    }

    return {
      version,
      name: basename(upFile, ".up.sql"),
      upPath: join(migrationsDir, upFile),
      downPath: join(migrationsDir, downFile)
    };
  });
}

async function runUpMigrations(
  connection: Connection,
  migrations: MigrationFile[]
): Promise<MigrationRunResult> {
  const appliedVersions = await readAppliedVersions(connection);
  const executedVersions: string[] = [];

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    await connection.beginTransaction();

    try {
      await executeSqlFile(connection, migration.upPath);
      await connection.execute("INSERT INTO schema_migrations (version, name) VALUES (?, ?)", [
        migration.version,
        migration.name
      ]);
      await connection.commit();
      executedVersions.push(migration.version);
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }

  return {
    direction: "up",
    appliedVersions: executedVersions
  };
}

async function runDownMigration(
  connection: Connection,
  migrations: MigrationFile[]
): Promise<MigrationRunResult> {
  const appliedVersions = await readAppliedVersions(connection);
  const migration = migrations
    .filter((candidate) => appliedVersions.has(candidate.version))
    .sort((left, right) => right.version.localeCompare(left.version))
    .at(0);

  if (migration === undefined) {
    return {
      direction: "down",
      appliedVersions: []
    };
  }

  await connection.beginTransaction();

  try {
    await executeSqlFile(connection, migration.downPath);
    await connection.execute("DELETE FROM schema_migrations WHERE version = ?", [
      migration.version
    ]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }

  return {
    direction: "down",
    appliedVersions: [migration.version]
  };
}

async function readAppliedVersions(connection: Connection): Promise<Set<string>> {
  const [rows] = await connection.query("SELECT version FROM schema_migrations");
  const versions = new Set<string>();

  for (const row of rows as { version: string }[]) {
    versions.add(row.version);
  }

  return versions;
}

async function executeSqlFile(connection: Connection, filePath: string): Promise<void> {
  const sql = await readFile(filePath, "utf8");
  const statements = splitSqlStatements(sql);

  for (const statement of statements) {
    // mysql2 默认不启用 multiStatements，这里逐条执行，避免 SQL 文件中混入额外语句造成安全风险。
    await connection.query(statement);
  }
}

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | undefined;
  let lineComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index] ?? "";
    const nextChar = sql[index + 1] ?? "";

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
      }

      current += char;
      continue;
    }

    if (quote === undefined && char === "-" && nextChar === "-") {
      lineComment = true;
      current += char;
      continue;
    }

    if (quote === undefined && (char === "'" || char === '"' || char === "`")) {
      quote = char;
      current += char;
      continue;
    }

    if (quote !== undefined && char === quote) {
      quote = undefined;
      current += char;
      continue;
    }

    if (quote === undefined && char === ";") {
      const statement = current.trim();

      if (statement.length > 0) {
        statements.push(statement);
      }

      current = "";
      continue;
    }

    current += char;
  }

  const tailStatement = current.trim();

  if (tailStatement.length > 0) {
    statements.push(tailStatement);
  }

  return statements;
}
