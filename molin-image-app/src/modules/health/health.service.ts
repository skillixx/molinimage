export interface HealthResponse {
  status: "ok";
  service: "molin-image-app";
}

export function createHealthResponse(): HealthResponse {
  // 健康检查先保持纯函数，方便测试和后续扩展数据库、队列、存储探活。
  return {
    status: "ok",
    service: "molin-image-app"
  };
}
