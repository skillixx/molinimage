import assert from "node:assert/strict";
import test from "node:test";

import { DeploymentGateService } from "../src/modules/health/deployment-gate.service.js";

void test("部署门禁在远端实例内聚合 failed Job 与计费状态", async () => {
  const service = new DeploymentGateService(
    {
      getFailedJobAuditSnapshot: () =>
        Promise.resolve({ count: 2, fingerprint: "reviewed-fingerprint", overflow: false })
    },
    {
      getDeploymentGateSnapshot: () =>
        Promise.resolve({ pending_count: 0, orphan_reserve_count: 0 })
    }
  );

  assert.deepEqual(await service.getSnapshot(), {
    failed_jobs: { count: 2, fingerprint: "reviewed-fingerprint", overflow: false },
    billing: { pending_count: 0, orphan_reserve_count: 0 }
  });
});

void test("未启用 BullMQ 时内部部署门禁明确失败", async () => {
  const service = new DeploymentGateService(undefined, {
    getDeploymentGateSnapshot: () => Promise.resolve({ pending_count: 0, orphan_reserve_count: 0 })
  });

  await assert.rejects(service.getSnapshot(), /要求启用 BullMQ/u);
});
