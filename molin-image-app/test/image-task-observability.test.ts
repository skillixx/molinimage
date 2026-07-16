import assert from "node:assert/strict";
import test from "node:test";

import { ConsoleImageTaskExecutionMetricsLogger } from "../src/workers/image-task-observability.js";

void test("结构化任务日志包含关联 ID 和耗时但不包含敏感内容", () => {
  const messages: string[] = [];
  const logger = new ConsoleImageTaskExecutionMetricsLogger({
    info: (message) => messages.push(message)
  });

  logger.record({
    request_id: "request_001",
    task_id: "task_001",
    job_id: "job_001",
    outcome: "processed",
    attempt_number: 1,
    queue_wait_ms: 10,
    execution_ms: 20,
    end_to_end_ms: 30
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? "", /request_001/);
  assert.match(messages[0] ?? "", /task_001/);
  assert.match(messages[0] ?? "", /job_001/);
  assert.doesNotMatch(messages[0] ?? "", /prompt|token|image_content/iu);
});
