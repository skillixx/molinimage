import "dotenv/config";

import { resolve } from "node:path";

import { ConfigError, loadAppConfig } from "../src/config/app-config.js";
import {
  runMigrations,
  type MigrationDirection
} from "../src/infrastructure/database/migration-runner.js";

async function main(): Promise<void> {
  const direction = readDirection(process.argv[2]);
  const config = loadAppConfig();
  const migrationsDir = resolve(process.cwd(), "migrations");
  const result = await runMigrations({
    databaseUrl: config.databaseUrl,
    migrationsDir,
    direction
  });

  // 迁移日志只输出方向和版本号，不输出 DATABASE_URL，避免数据库账号密码进入控制台日志。
  console.log(
    JSON.stringify({
      direction: result.direction,
      applied_versions: result.appliedVersions
    })
  );
}

function readDirection(value: string | undefined): MigrationDirection {
  if (value === "up" || value === undefined) {
    return "up";
  }

  if (value === "down") {
    return "down";
  }

  throw new Error("迁移方向只支持 up 或 down");
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }

  const message = error instanceof Error ? error.message : "数据库迁移失败";
  console.error(message);
  process.exit(1);
});
