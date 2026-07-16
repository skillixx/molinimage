import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface SessionIdentity {
  user_id: number;
  app_id: number;
  product_id: number;
  entitlement_id?: number;
}

export interface ApplicationSession extends SessionIdentity {
  session_id: string;
  created_at: string;
  expires_at: string;
}

export interface CreatedSession {
  token: string;
  session: ApplicationSession;
}

export interface SessionStore {
  createSession(identity: SessionIdentity, ttlSeconds: number): Promise<CreatedSession>;
  getSession(token: string | undefined): Promise<ApplicationSession | undefined>;
  deleteSession(token: string | undefined): Promise<void>;
}

export class SessionStoreError extends Error {
  readonly code = "SESSION_STORE_UNAVAILABLE";

  constructor(options?: ErrorOptions) {
    super("会话服务暂不可用，请稍后重试。", options);
    this.name = "SessionStoreError";
  }
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, ApplicationSession>();

  createSession(identity: SessionIdentity, ttlSeconds: number): Promise<CreatedSession> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    const token = randomBytes(32).toString("base64url");
    const session: ApplicationSession = {
      ...identity,
      session_id: randomBytes(16).toString("hex"),
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString()
    };

    // 内存存储只保存应用自有 session token，不保存墨灵一次性 ticket，避免 ticket 被二次使用或泄漏。
    this.sessions.set(token, session);

    return Promise.resolve({ token, session });
  }

  getSession(token: string | undefined): Promise<ApplicationSession | undefined> {
    if (token === undefined || token.length === 0) {
      return Promise.resolve(undefined);
    }

    const session = this.sessions.get(token);

    if (session === undefined) {
      return Promise.resolve(undefined);
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      // 读取时顺手清理过期 session，避免无效凭证长期留在进程内存。
      this.sessions.delete(token);
      return Promise.resolve(undefined);
    }

    return Promise.resolve(session);
  }

  deleteSession(token: string | undefined): Promise<void> {
    if (token !== undefined) {
      this.sessions.delete(token);
    }

    return Promise.resolve();
  }
}

export function readCookie(request: IncomingMessage, cookieName: string): string | undefined {
  const cookieHeader = request.headers.cookie;

  if (cookieHeader === undefined) {
    return undefined;
  }

  for (const cookiePair of cookieHeader.split(";")) {
    const [name, ...rawValueParts] = cookiePair.trim().split("=");

    if (name === cookieName) {
      return decodeURIComponent(rawValueParts.join("="));
    }
  }

  return undefined;
}

export function serializeSessionCookie(options: {
  cookieName: string;
  token: string;
  ttlSeconds: number;
  secure: boolean;
}): string {
  const attributes = [
    `${options.cookieName}=${encodeURIComponent(options.token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${String(options.ttlSeconds)}`
  ];

  if (options.secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

export function serializeExpiredSessionCookie(cookieName: string, secure: boolean): string {
  const attributes = [`${cookieName}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}
