import "dotenv/config";

import { ConfigError, loadAppConfig } from "../config/app-config.js";

function main(): void {
  const config = loadConfigOrExit();

  // Worker 入口只负责启动异步任务消费循环，后续 Goal 再接入 Redis 队列和图片任务状态机。
  console.log(`molin-image-app image task worker started for ${config.storageProvider}`);
}

try {
  main();
} catch (error: unknown) {
  // Worker 启动失败必须显式退出，避免部署系统误判为正常运行。
  console.error("image task worker failed to start", error);
  process.exitCode = 1;
}

function loadConfigOrExit() {
  try {
    return loadAppConfig();
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      // Worker 和 API 使用同一套启动校验，保证异步任务不会在缺少队列、存储或网关配置时继续运行。
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  }
}
