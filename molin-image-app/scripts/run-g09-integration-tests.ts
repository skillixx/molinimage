import { spawnSync } from "node:child_process";

const integrationTests = [
  "dist/test/redis-session-store.integration.test.js",
  "dist/test/runtime-process.integration.test.js",
  "dist/test/image-task-queue.integration.test.js",
  "dist/test/image-task-worker.integration.test.js",
  "dist/test/image-task-commercialization.integration.test.js",
  "dist/test/health.integration.test.js"
];

const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", ...integrationTests],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      RUN_REDIS_INTEGRATION_TESTS: "true",
      RUN_QUEUE_INTEGRATION_TESTS: "true"
    }
  }
);

if (result.error !== undefined) {
  // 不拼接子进程原始错误，避免测试环境路径或端点进入 CI 日志。
  console.error("G09 真实集成测试进程启动失败。");
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
