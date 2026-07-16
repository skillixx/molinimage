import { createHash, randomBytes } from "node:crypto";

import type { AppConfig } from "../../config/app-config.js";
import { createRedisKey } from "../../infrastructure/redis/redis-key.js";
import {
  SessionStoreError,
  type ApplicationSession,
  type CreatedSession,
  type SessionIdentity,
  type SessionStore
} from "./session-store.js";

export interface RedisSessionClient {
  set(key: string, value: string, expirationMode: "EX", ttlSeconds: number): Promise<"OK">;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

export interface RedisSessionLogger {
  warn(message: string): void;
}

type RedisSessionConfig = Pick<AppConfig, "redisKeyPrefix">;

export class RedisSessionStore implements SessionStore {
  constructor(
    private readonly client: RedisSessionClient,
    private readonly config: RedisSessionConfig,
    private readonly logger: RedisSessionLogger = console
  ) {}

  async createSession(identity: SessionIdentity, ttlSeconds: number): Promise<CreatedSession> {
    const now = new Date();
    const token = randomBytes(32).toString("base64url");
    const session: ApplicationSession = {
      ...identity,
      session_id: randomBytes(16).toString("hex"),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString()
    };

    try {
      // Redis Key 只使用 Token 摘要，Redis 管理界面和日志中都不会出现可直接登录的原始凭证。
      await this.client.set(
        createRedisSessionKey(this.config.redisKeyPrefix, token),
        JSON.stringify(session),
        "EX",
        ttlSeconds
      );
    } catch (error: unknown) {
      throw new SessionStoreError({ cause: error });
    }

    return { token, session };
  }

  async getSession(token: string | undefined): Promise<ApplicationSession | undefined> {
    if (token === undefined || token.length === 0) {
      return undefined;
    }

    const key = createRedisSessionKey(this.config.redisKeyPrefix, token);
    let payload: string | null;

    try {
      payload = await this.client.get(key);
    } catch (error: unknown) {
      // Redis 故障必须显式失败，禁止回退到进程内会话造成多实例身份不一致。
      throw new SessionStoreError({ cause: error });
    }

    if (payload === null) {
      return undefined;
    }

    const session = parseApplicationSession(payload);

    if (session === undefined) {
      this.logger.warn("Redis Session 数据格式无效，已按未登录处理");
      await this.deleteInvalidSession(key);
      return undefined;
    }

    if (Date.parse(session.expires_at) <= Date.now()) {
      // TTL 是主清理机制，本地时间校验用于阻止时钟边界上的过期会话被继续使用。
      await this.deleteInvalidSession(key);
      return undefined;
    }

    return session;
  }

  async deleteSession(token: string | undefined): Promise<void> {
    if (token === undefined || token.length === 0) {
      return;
    }

    try {
      await this.client.del(createRedisSessionKey(this.config.redisKeyPrefix, token));
    } catch (error: unknown) {
      throw new SessionStoreError({ cause: error });
    }
  }

  private async deleteInvalidSession(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch {
      // 损坏或过期数据已经拒绝授权；清理失败只记脱敏告警，不能把该数据重新视为有效会话。
      this.logger.warn("无效 Redis Session 清理失败，将等待 TTL 自动回收");
    }
  }
}

export function createRedisSessionKey(prefix: string, token: string): string {
  const tokenDigest = createHash("sha256").update(token).digest("hex");
  return createRedisKey(prefix, "session", tokenDigest);
}

function parseApplicationSession(payload: string): ApplicationSession | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }

  const entitlementId = parsed.entitlement_id;

  if (
    !isNonEmptyString(parsed.session_id) ||
    !isPositiveInteger(parsed.user_id) ||
    !isPositiveInteger(parsed.app_id) ||
    !isPositiveInteger(parsed.product_id) ||
    (entitlementId !== undefined && !isPositiveInteger(entitlementId)) ||
    !isIsoDateString(parsed.created_at) ||
    !isIsoDateString(parsed.expires_at)
  ) {
    return undefined;
  }

  return {
    session_id: parsed.session_id,
    user_id: parsed.user_id,
    app_id: parsed.app_id,
    product_id: parsed.product_id,
    ...(entitlementId === undefined ? {} : { entitlement_id: entitlementId }),
    created_at: parsed.created_at,
    expires_at: parsed.expires_at
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}
