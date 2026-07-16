import { Redis, type RedisOptions } from "ioredis";

import type { AppConfig } from "../../config/app-config.js";

export type RedisConnectionPurpose = "api" | "worker" | "session" | "queue";

export interface RedisConnectionLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ManagedRedisConnection {
  readonly client: Redis;
  readonly endpoint: string;
  connect(): Promise<void>;
  close(): Promise<void>;
}

type RedisConnectionConfig = Pick<
  AppConfig,
  "redisUrl" | "redisConnectTimeoutMs" | "redisCommandTimeoutMs" | "redisMaxRetriesPerRequest"
>;

export class RedisConnectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RedisConnectionError";
  }
}

export function createRedisConnection(
  config: RedisConnectionConfig,
  purpose: RedisConnectionPurpose,
  logger: RedisConnectionLogger = console
): ManagedRedisConnection {
  return createManagedConnection(config, purpose, logger, {
    maxRetriesPerRequest: config.redisMaxRetriesPerRequest
  });
}

export function createBullMqRedisConnection(
  config: RedisConnectionConfig,
  purpose: Extract<RedisConnectionPurpose, "worker" | "queue">,
  logger: RedisConnectionLogger = console
): ManagedRedisConnection {
  // BullMQ 的阻塞读取必须禁用单请求重试上限，否则长时间等待任务会被 ioredis 主动中断。
  return createManagedConnection(config, purpose, logger, {
    maxRetriesPerRequest: null
  });
}

function createManagedConnection(
  config: RedisConnectionConfig,
  purpose: RedisConnectionPurpose,
  logger: RedisConnectionLogger,
  overrides: Pick<RedisOptions, "maxRetriesPerRequest">
): ManagedRedisConnection {
  const endpoint = describeRedisEndpoint(config.redisUrl);
  const client = new Redis(config.redisUrl, {
    lazyConnect: true,
    enableReadyCheck: true,
    connectTimeout: config.redisConnectTimeoutMs,
    commandTimeout: config.redisCommandTimeoutMs,
    keepAlive: 10_000,
    ...overrides,
    retryStrategy: (attempt: number) => Math.min(250 * 2 ** Math.min(attempt - 1, 5), 5_000)
  });
  let closePromise: Promise<void> | undefined;

  // 事件日志只包含用途和脱敏端点，不拼接原始错误，防止连接串或密码被第三方错误对象带入日志。
  client.on("connect", () => {
    logger.info(`Redis ${purpose} 正在连接 ${endpoint}`);
  });
  client.on("ready", () => {
    logger.info(`Redis ${purpose} 连接就绪 ${endpoint}`);
  });
  client.on("reconnecting", (delay: number) => {
    logger.warn(`Redis ${purpose} 将在 ${String(delay)}ms 后重连 ${endpoint}`);
  });
  client.on("error", () => {
    logger.error(`Redis ${purpose} 连接异常 ${endpoint}`);
  });
  client.on("close", () => {
    logger.warn(`Redis ${purpose} 连接已断开 ${endpoint}`);
  });
  client.on("end", () => {
    logger.info(`Redis ${purpose} 连接已关闭 ${endpoint}`);
  });

  return {
    client,
    endpoint,
    async connect(): Promise<void> {
      if (client.status === "ready") {
        return;
      }

      try {
        await client.connect();
      } catch (error: unknown) {
        client.disconnect(false);
        throw new RedisConnectionError(`Redis 连接失败，请检查服务状态（${endpoint}）`, {
          cause: error
        });
      }
    },
    async close(): Promise<void> {
      closePromise ??= closeRedisClient(client, purpose, endpoint, logger);
      await closePromise;
    }
  };
}

async function closeRedisClient(
  client: Redis,
  purpose: RedisConnectionPurpose,
  endpoint: string,
  logger: RedisConnectionLogger
): Promise<void> {
  if (client.status === "end") {
    return;
  }

  if (client.status === "wait") {
    client.disconnect(false);
    logger.info(`Redis ${purpose} 连接已关闭 ${endpoint}`);
    return;
  }

  try {
    await client.quit();
  } catch {
    // 服务端已断开时 quit 可能失败，此时强制释放本地 socket，保证进程可以按时退出。
    client.disconnect(false);
  }
}

export function describeRedisEndpoint(redisUrl: string): string {
  let url: URL;

  try {
    url = new URL(redisUrl);
  } catch (error: unknown) {
    throw new RedisConnectionError("REDIS_URL 格式无效", { cause: error });
  }

  if ((url.protocol !== "redis:" && url.protocol !== "rediss:") || url.hostname.length === 0) {
    throw new RedisConnectionError("REDIS_URL 必须使用 redis:// 或 rediss:// 协议");
  }

  const port = url.port.length > 0 ? url.port : url.protocol === "rediss:" ? "6380" : "6379";
  const database = url.pathname.replace(/^\//, "") || "0";

  return `${url.protocol}//${maskRedisHost(url.hostname)}:${port}/${database}`;
}

function maskRedisHost(hostname: string): string {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    const parts = hostname.split(".");
    return `${parts[0] ?? "*"}.*.*.${parts[3] ?? "*"}`;
  }

  if (hostname.length <= 2) {
    return "**";
  }

  return `${hostname.charAt(0)}***${hostname.charAt(hostname.length - 1)}`;
}
