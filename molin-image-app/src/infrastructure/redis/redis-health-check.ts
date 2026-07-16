export interface RedisHealthConnection {
  client: {
    ping(): Promise<string>;
  };
}

export interface RedisHealthResult {
  status: "ok";
  latency_ms: number;
}

export class RedisHealthCheckError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RedisHealthCheckError";
  }
}

export async function checkRedisHealth(
  connection: RedisHealthConnection
): Promise<RedisHealthResult> {
  const startedAt = performance.now();

  try {
    const response = await connection.client.ping();

    if (response !== "PONG") {
      throw new Error("Redis PING 响应异常");
    }
  } catch (error: unknown) {
    // 对外只返回稳定中文错误，原始驱动错误保留为 cause，不能进入 HTTP 响应或普通运行日志。
    throw new RedisHealthCheckError("Redis 健康检查失败，请检查服务连接", { cause: error });
  }

  return {
    status: "ok",
    latency_ms: Math.max(0, Math.round(performance.now() - startedAt))
  };
}
