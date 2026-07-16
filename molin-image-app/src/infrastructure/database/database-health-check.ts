import type { Pool } from "mysql2/promise";

import type { HealthDependencyProbe } from "../../modules/health/health.service.js";

export class MySqlHealthProbe implements HealthDependencyProbe {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async check(): Promise<void> {
    // SELECT 1 不读取业务数据，只验证连接池能获得连接并执行最小查询。
    await this.pool.query("SELECT 1");
  }
}
