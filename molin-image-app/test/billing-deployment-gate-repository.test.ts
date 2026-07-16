import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "mysql2/promise";

import { MySqlBillingEventsRepository } from "../src/infrastructure/database/billing-events-repository.js";

void test("计费部署门禁统计待对账和孤立预占并归一化数字", async () => {
  const pool = {
    execute: () => Promise.resolve([[{ pending_count: "2", orphan_reserve_count: "3" }], undefined])
  } as unknown as Pool;
  const repository = new MySqlBillingEventsRepository(pool);

  const snapshot = await repository.getDeploymentGateSnapshot();

  assert.deepEqual(snapshot, { pending_count: 2, orphan_reserve_count: 3 });
});
