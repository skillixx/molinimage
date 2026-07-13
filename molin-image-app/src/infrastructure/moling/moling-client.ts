import type { AppConfig } from "../../config/app-config.js";
import type {
  EntitlementReleaseGateway,
  EntitlementReleaseInput,
  EntitlementReleaseResult,
  EntitlementReserveGateway,
  EntitlementReserveInput,
  EntitlementReserveResult,
  EntitlementBalanceGateway,
  EntitlementBalanceInput,
  EntitlementBalanceResult,
  EntitlementSettleGateway,
  EntitlementSettleInput,
  EntitlementSettleResult
} from "../../modules/billing/billing-service.js";
import { BillingServiceError } from "../../modules/billing/billing-service.js";

export interface MolingLaunchIdentity {
  user_id: number;
  app_id: number;
  product_id: number;
  entitlement_id?: number;
}

export interface LaunchTicketVerifier {
  verifyLaunchTicket(ticket: string): Promise<MolingLaunchIdentity>;
}

export class MolingTicketError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "MolingTicketError";
  }
}

export class MolingClient
  implements
    LaunchTicketVerifier,
    EntitlementReserveGateway,
    EntitlementReleaseGateway,
    EntitlementSettleGateway,
    EntitlementBalanceGateway
{
  constructor(private readonly config: Pick<AppConfig, "molingApiBaseUrl" | "internalApiToken">) {}

  async verifyLaunchTicket(ticket: string): Promise<MolingLaunchIdentity> {
    const response = await fetch(
      new URL("/api/internal/app-launch/verify", this.config.molingApiBaseUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-token": this.config.internalApiToken
        },
        // 只把一次性 ticket 发给墨灵内部接口，不写日志、不落库、不回传给前端。
        body: JSON.stringify({ launch_ticket: ticket })
      }
    );

    if (!response.ok) {
      throw new MolingTicketError(
        "LAUNCH_TICKET_INVALID",
        "票据无效、已过期或已被使用，请从墨灵平台重新进入应用。"
      );
    }

    const payload = await response.json();

    return parseLaunchIdentity(payload);
  }

  async reserve(input: EntitlementReserveInput): Promise<EntitlementReserveResult> {
    if (input.entitlementId === undefined) {
      throw new BillingServiceError(
        "BILLING_ENTITLEMENT_REQUIRED",
        "当前用户缺少可用权益额度。",
        402
      );
    }

    const response = await fetch(
      new URL("/api/internal/entitlement-reserve", this.config.molingApiBaseUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-token": this.config.internalApiToken
        },
        // 预占只传平台要求的最小字段，幂等键由应用稳定生成并落库，避免重试重复扣额度。
        body: JSON.stringify({
          user_id: input.userId,
          entitlement_id: input.entitlementId,
          amount: input.amount,
          idempotency_key: input.idempotencyKey
        })
      }
    );

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw mapReserveError(payload);
    }

    const source = unwrapDataObject(payload);

    return {
      reserveId: readOptionalStringOrNumberField(source, "hold_id", "holdId", "reserve_id"),
      entitlementId: input.entitlementId,
      balancePoints:
        readOptionalDecimalField(source, "balance_points", "balance", "remaining") ?? "0"
    };
  }

  async getBalance(input: EntitlementBalanceInput): Promise<EntitlementBalanceResult> {
    const url = new URL("/api/internal/entitlement-balance", this.config.molingApiBaseUrl);
    url.searchParams.set("entitlement_id", String(input.entitlementId));
    url.searchParams.set("user_id", String(input.userId));

    // 余额查询走墨灵内部接口，前端只拿本应用后端整理后的公开字段，不接触内部令牌。
    const response = await fetch(url, {
      headers: {
        "x-internal-token": this.config.internalApiToken
      }
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new BillingServiceError("BILLING_BALANCE_LOOKUP_FAILED", "墨灵积分余额查询失败。", 502);
    }

    let source: Record<string, unknown>;
    try {
      source = unwrapDataObject(payload);
    } catch {
      // 平台响应格式异常时对外仍归类为余额查询失败，避免把内部协议细节泄露给用户端。
      throw new BillingServiceError("BILLING_BALANCE_LOOKUP_FAILED", "墨灵积分余额查询失败。", 502);
    }

    return {
      entitlementId: input.entitlementId,
      balancePoints:
        readOptionalDecimalField(source, "remaining", "balance_points", "balance") ?? "0",
      usable: readOptionalUsableField(source)
    };
  }

  async release(input: EntitlementReleaseInput): Promise<EntitlementReleaseResult> {
    const response = await fetch(
      new URL("/api/internal/entitlement-release", this.config.molingApiBaseUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-token": this.config.internalApiToken
        },
        // 释放接口按墨灵文档只需要 hold_id；应用侧 release 事件负责幂等和审计。
        body: JSON.stringify({
          hold_id: coerceNumericHoldId(input.reserveId)
        })
      }
    );

    if (!response.ok) {
      throw new BillingServiceError("BILLING_RELEASE_FAILED", "墨灵积分释放失败。", 502);
    }

    const payload = await response.json().catch(() => ({}));
    const source = unwrapDataObject(payload);

    return {
      reserveId: readOptionalStringOrNumberField(source, "hold_id", "holdId") ?? input.reserveId
    };
  }

  async settle(input: EntitlementSettleInput): Promise<EntitlementSettleResult> {
    const response = await fetch(
      new URL("/api/internal/entitlement-settle", this.config.molingApiBaseUrl),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-token": this.config.internalApiToken
        },
        // 墨灵结算接口使用原 hold_id 和实际积分，任务侧稳定幂等键负责防止重复调用。
        body: JSON.stringify({
          hold_id: coerceNumericHoldId(input.reserveId),
          actual_amount: input.actualAmount,
          idempotency_key: input.idempotencyKey
        })
      }
    );

    if (!response.ok) {
      throw new BillingServiceError("BILLING_SETTLE_FAILED", "墨灵积分结算失败。", 502);
    }

    const payload = await response.json().catch(() => ({}));
    const source = unwrapDataObject(payload);

    return {
      reserveId: readOptionalStringOrNumberField(source, "hold_id", "holdId") ?? input.reserveId
    };
  }
}

function mapReserveError(payload: unknown): BillingServiceError {
  const source = isRecord(payload) ? (isRecord(payload.error) ? payload.error : payload) : {};
  const code = readErrorCode(source);

  if (code === "60001" || code.includes("INSUFFICIENT") || code.includes("BALANCE")) {
    return new BillingServiceError("BILLING_BALANCE_INSUFFICIENT", "积分余额不足。", 402);
  }

  return new BillingServiceError("BILLING_RESERVE_FAILED", "墨灵积分预占失败。", 502);
}

function readErrorCode(source: Record<string, unknown>): string {
  const value = source.code ?? source.error_code;

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return "";
}

export function parseLaunchIdentity(payload: unknown): MolingLaunchIdentity {
  const source = unwrapDataObject(payload);
  const userId = readPositiveIntegerField(source, "user_id", "userId");
  const appId = readPositiveIntegerField(source, "app_id", "appId");
  const productId = readPositiveIntegerField(source, "product_id", "productId");
  const entitlementId = readOptionalPositiveIntegerField(source, "entitlement_id", "entitlementId");

  return {
    user_id: userId,
    app_id: appId,
    product_id: productId,
    ...(entitlementId === undefined ? {} : { entitlement_id: entitlementId })
  };
}

function unwrapDataObject(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new MolingTicketError("MOLING_RESPONSE_INVALID", "墨灵票据校验响应格式异常。");
  }

  const data = payload.data;

  if (isRecord(data)) {
    return data;
  }

  return payload;
}

function readPositiveIntegerField(
  source: Record<string, unknown>,
  snakeKey: string,
  camelKey: string
): number {
  const value = source[snakeKey] ?? source[camelKey];

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new MolingTicketError("MOLING_RESPONSE_INVALID", `墨灵票据校验响应缺少 ${snakeKey}。`);
  }

  return value;
}

function readOptionalPositiveIntegerField(
  source: Record<string, unknown>,
  snakeKey: string,
  camelKey: string
): number | undefined {
  const value = source[snakeKey] ?? source[camelKey];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    // entitlement_id 是后续计费兜底信息，不是建立登录 session 的硬前提；平台返回空值、0 或异常值时先忽略。
    return undefined;
  }

  return value;
}

function readOptionalStringOrNumberField(
  source: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = source[key];

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

function readOptionalDecimalField(
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key];

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return undefined;
}

function readOptionalUsableField(source: Record<string, unknown>): boolean {
  const usable = source.usable;
  const status = source.status;

  if (typeof usable === "boolean") {
    return usable;
  }

  if (typeof usable === "number") {
    return usable !== 0;
  }

  if (typeof usable === "string") {
    return usable !== "0" && usable.toLowerCase() !== "false";
  }

  return typeof status === "string" ? status.toLowerCase() === "active" : true;
}

function coerceNumericHoldId(value: string): number | string {
  const normalized = value.trim();
  const numericValue = Number(normalized);

  return Number.isInteger(numericValue) && numericValue > 0 ? numericValue : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
