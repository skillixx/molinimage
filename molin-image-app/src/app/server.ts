import "dotenv/config";

import { createServer } from "node:http";

import { ConfigError, loadAppConfig } from "../config/app-config.js";
import { createHealthResponse } from "../modules/health/health.service.js";

const config = loadConfigOrExit();

const server = createServer((request, response) => {
  // API 服务只负责 HTTP 入口和请求分发，具体业务逻辑放到 modules 内，避免入口文件变成大杂烩。
  if (request.method === "GET" && request.url === "/health") {
    const body = JSON.stringify(createHealthResponse());

    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body)
    });
    response.end(body);
    return;
  }

  // 当前阶段只提供健康检查，后续 Goal 再逐步接入鉴权、任务和计费 API。
  response.writeHead(404, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify({ error: "NOT_FOUND" }));
});

server.listen(config.port, () => {
  // 启动日志不输出任何敏感配置，后续接入墨灵 ticket 和 AI 网关时也保持同样约束。
  console.log(`molin-image-app api listening on http://localhost:${String(config.port)}`);
});

function loadConfigOrExit() {
  try {
    return loadAppConfig();
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      // 配置错误只输出缺失键名，不输出任何环境变量值，避免密钥或连接串泄漏到日志。
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  }
}
