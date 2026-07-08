import assert from "node:assert/strict";
import test from "node:test";

import { createHealthResponse } from "../src/modules/health/health.service.js";

void test("健康检查返回基础服务状态", () => {
  // 先验证最小业务模块可被测试框架加载，后续再扩展 API、任务和计费测试。
  assert.deepEqual(createHealthResponse(), {
    status: "ok",
    service: "molin-image-app"
  });
});
