import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface ApplicationSession {
  session_id: string;
  user_id: number;
  app_id: number;
  product_id: number;
  entitlement_id?: number;
  created_at: string;
  expires_at: string;
}

export interface CreatedSession {
  token: string;
  session: ApplicationSession;
}

export class InMemorySessionStore {
  private readonly sessions = new Map<string, ApplicationSession>();

  createSession(
    identity: Omit<ApplicationSession, "session_id" | "created_at" | "expires_at">,
    ttlSeconds: number
  ): CreatedSession {
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

    return { token, session };
  }

  getSession(token: string | undefined): ApplicationSession | undefined {
    if (token === undefined || token.length === 0) {
      return undefined;
    }

    const session = this.sessions.get(token);

    if (session === undefined) {
      return undefined;
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      // 读取时顺手清理过期 session，避免无效凭证长期留在进程内存。
      this.sessions.delete(token);
      return undefined;
    }

    return session;
  }

  deleteSession(token: string | undefined): void {
    if (token !== undefined) {
      this.sessions.delete(token);
    }
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
