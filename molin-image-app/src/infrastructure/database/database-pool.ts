import mysql, { type Pool } from "mysql2/promise";

import type { AppConfig } from "../../config/app-config.js";

export function createDatabasePool(config: Pick<AppConfig, "databaseUrl">): Pool {
  // 数据库连接只使用 DATABASE_URL，日志和错误响应中禁止输出连接串，避免账号密码泄漏。
  return mysql.createPool({
    uri: config.databaseUrl,
    waitForConnections: true,
    connectionLimit: 10,
    namedPlaceholders: true
  });
}
