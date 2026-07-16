import { createConnection, type Pool, type RowDataPacket } from "mysql2/promise";

import type { AppConfig } from "../../src/config/app-config.js";

const supportedTemporaryTables = new Set(["image_tasks", "image_task_outbox"]);
type SqlValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | null
  | Buffer
  | Uint8Array
  | SqlValue[]
  | { [key: string]: SqlValue };

export async function createIsolatedIntegrationPool(
  config: Pick<AppConfig, "databaseUrl">,
  tables: string[]
): Promise<Pool> {
  const connection = await createConnection(config.databaseUrl);
  const [databaseRows] = await connection.query<(RowDataPacket & { database_name: string })[]>(
    "SELECT DATABASE() AS database_name"
  );

  if (databaseRows.length === 0 || !/^[A-Za-z0-9_]+$/u.test(databaseRows[0].database_name)) {
    await connection.end();
    throw new Error("集成测试无法识别当前 MySQL 数据库。");
  }
  const databaseName = databaseRows[0].database_name;

  for (const table of tables) {
    if (!supportedTemporaryTables.has(table)) {
      await connection.end();
      throw new Error("集成测试请求了不允许的临时表。");
    }

    const temporaryName = `__g09_${table}`;
    // MySQL 不允许同名 CREATE ... LIKE；先复制到临时别名，再重命名以遮蔽同名业务表。
    await connection.query(
      `CREATE TEMPORARY TABLE \`${temporaryName}\` LIKE \`${databaseName}\`.\`${table}\``
    );
    await connection.query(`ALTER TABLE \`${temporaryName}\` RENAME TO \`${table}\``);
  }

  let closed = false;
  const execute = async (sql: string, values?: SqlValue) => await connection.execute(sql, values);
  const transactionConnection = {
    beginTransaction: async () => {
      await connection.beginTransaction();
    },
    execute,
    commit: async () => {
      await connection.commit();
    },
    rollback: async () => {
      await connection.rollback();
    },
    // 仓储释放的是逻辑连接；临时表必须保留到整个测试结束后再统一关闭。
    release: () => undefined
  };
  const pool = {
    execute,
    query: async (sql: string, values?: SqlValue) => await connection.query(sql, values),
    getConnection: () => Promise.resolve(transactionConnection),
    end: async () => {
      if (!closed) {
        closed = true;
        await connection.end();
      }
    }
  };

  return pool as unknown as Pool;
}
