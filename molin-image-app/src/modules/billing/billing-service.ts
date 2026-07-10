import { randomUUID } from "node:crypto";

import type {
  BillingEventRecord,
  BillingEventsRepository
} from "../../infrastructure/database/billing-events-repository.js";

export interface BillingRule {
  task_type: string;
  usage_type: string;
  unit: string;
  points_per_unit: string;
  active: boolean;
}

export interface EstimateBillingRequest {
  ownerUserId: number;
  taskType: string;
  imageCount?: number;
  quality?: string;
  imageSize?: string;
}

export interface BillingEstimateResult {
  task_type: string;
  usage_type: string;
  unit: string;
  unit_points: string;
  quantity: number;
  estimated_points: string;
  balance_points: string;
  enough_balance: boolean;
  rule_source: "env";
}

export interface ReserveBillingRequest extends EstimateBillingRequest {
  taskId: string;
  entitlementId?: number;
  idempotencyKey: string;
}

export interface ReserveBillingResult {
  estimate: BillingEstimateResult;
  billing_event: PublicBillingEvent;
}

export interface ReleaseBillingRequest {
  ownerUserId: number;
  taskId: string;
  reserveBillingEventId: string;
  idempotencyKey: string;
  reasonCode: string;
  reasonMessage: string;
}

export interface ReleaseBillingResult {
  billing_event: PublicBillingEvent;
  released: boolean;
}

export interface PublicBillingEvent {
  id: string;
  owner_user_id: number;
  task_id: string;
  event_type: string;
  amount_points: string;
  status: string;
  idempotency_key: string;
  moling_reserve_id: string | null;
  moling_entitlement_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface EntitlementReserveGateway {
  reserve(input: EntitlementReserveInput): Promise<EntitlementReserveResult>;
}

export interface EntitlementReleaseGateway {
  release(input: EntitlementReleaseInput): Promise<EntitlementReleaseResult>;
}

export interface EntitlementReserveInput {
  userId: number;
  entitlementId?: number;
  amount: string;
  idempotencyKey: string;
}

export interface EntitlementReserveResult {
  reserveId: string | null;
  entitlementId: number | null;
  balancePoints: string;
}

export interface EntitlementReleaseInput {
  reserveId: string;
}

export interface EntitlementReleaseResult {
  reserveId: string | null;
}

export class BillingServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "BillingServiceError";
  }
}

export class BillingService {
  private readonly rules: BillingRule[];

  constructor(
    rulesJson: string,
    private readonly repository: BillingEventsRepository,
    private readonly gateway: EntitlementReserveGateway & EntitlementReleaseGateway
  ) {
    this.rules = parseBillingRules(rulesJson);
  }

  estimate(request: EstimateBillingRequest): BillingEstimateResult {
    const rule = this.findActiveRule(request.taskType);
    const quantity = normalizeQuantity(request.imageCount);
    const estimatedPoints = multiplyDecimal(rule.points_per_unit, quantity);
    const balancePoints =
      this.gateway instanceof MockEntitlementReserveGateway
        ? this.gateway.getBalancePoints()
        : estimatedPoints;

    void request.ownerUserId;
    void request.quality;
    void request.imageSize;

    return {
      task_type: rule.task_type,
      usage_type: rule.usage_type,
      unit: rule.unit,
      unit_points: rule.points_per_unit,
      quantity,
      estimated_points: estimatedPoints,
      balance_points: balancePoints,
      enough_balance: compareDecimal(balancePoints, estimatedPoints) >= 0,
      rule_source: "env"
    };
  }

  async reserve(request: ReserveBillingRequest): Promise<ReserveBillingResult> {
    const estimate = this.estimate(request);

    if (!estimate.enough_balance) {
      // 余额不足必须在任务入队和 AI 调用前拦截，避免用户无额度时产生上游成本。
      throw new BillingServiceError("BILLING_BALANCE_INSUFFICIENT", "积分余额不足。", 402);
    }

    const reserveResult = await this.reserveWithPublicError({
      userId: request.ownerUserId,
      entitlementId: request.entitlementId,
      amount: estimate.estimated_points,
      idempotencyKey: request.idempotencyKey
    });
    const event = await this.repository.createReserved({
      id: `billing_${randomUUID().replaceAll("-", "")}`,
      owner_user_id: request.ownerUserId,
      task_id: request.taskId,
      amount_points: estimate.estimated_points,
      idempotency_key: request.idempotencyKey,
      moling_reserve_id: reserveResult.reserveId,
      moling_entitlement_id: reserveResult.entitlementId
    });

    return {
      estimate: {
        ...estimate,
        balance_points: reserveResult.balancePoints,
        enough_balance: compareDecimal(reserveResult.balancePoints, estimate.estimated_points) >= 0
      },
      billing_event: toPublicBillingEvent(event)
    };
  }

  async release(request: ReleaseBillingRequest): Promise<ReleaseBillingResult> {
    const existingRelease = await this.repository.findByIdempotencyKey(request.idempotencyKey);

    if (existingRelease !== undefined) {
      // 已经释放过的失败任务直接返回原事件，确保 worker 重放或接口重试不会重复归还额度。
      return {
        billing_event: toPublicBillingEvent(existingRelease),
        released: existingRelease.status === "released"
      };
    }

    const reserveEvent = await this.repository.findById(request.reserveBillingEventId);

    if (reserveEvent?.event_type !== "reserve") {
      throw new BillingServiceError(
        "BILLING_RESERVE_EVENT_NOT_FOUND",
        "未找到可释放的预占记录。",
        409
      );
    }

    if (
      reserveEvent.owner_user_id !== request.ownerUserId ||
      reserveEvent.task_id !== request.taskId
    ) {
      throw new BillingServiceError(
        "BILLING_RESERVE_EVENT_FORBIDDEN",
        "预占记录与当前任务不匹配。",
        403
      );
    }

    if (reserveEvent.moling_reserve_id === null) {
      throw new BillingServiceError(
        "BILLING_RESERVE_HOLD_MISSING",
        "预占记录缺少 hold_id，无法释放。",
        409
      );
    }

    try {
      await this.gateway.release({
        reserveId: reserveEvent.moling_reserve_id
      });

      const event = await this.repository.createRelease({
        id: `billing_${randomUUID().replaceAll("-", "")}`,
        owner_user_id: request.ownerUserId,
        task_id: request.taskId,
        amount_points: reserveEvent.amount_points,
        status: "released",
        idempotency_key: request.idempotencyKey,
        moling_reserve_id: reserveEvent.moling_reserve_id,
        moling_entitlement_id: reserveEvent.moling_entitlement_id,
        error_code: null,
        error_message: null
      });

      return {
        billing_event: toPublicBillingEvent(event),
        released: true
      };
    } catch (error: unknown) {
      const event = await this.repository.createRelease({
        id: `billing_${randomUUID().replaceAll("-", "")}`,
        owner_user_id: request.ownerUserId,
        task_id: request.taskId,
        amount_points: reserveEvent.amount_points,
        status: "release_pending",
        idempotency_key: request.idempotencyKey,
        moling_reserve_id: reserveEvent.moling_reserve_id,
        moling_entitlement_id: reserveEvent.moling_entitlement_id,
        error_code: "BILLING_RELEASE_FAILED",
        error_message: error instanceof Error ? error.message : "积分释放失败，等待对账。"
      });

      return {
        billing_event: toPublicBillingEvent(event),
        released: false
      };
    }
  }

  private findActiveRule(taskType: string): BillingRule {
    const normalizedTaskType = taskType.trim();
    const rule = this.rules.find((item) => item.task_type === normalizedTaskType && item.active);

    if (rule === undefined) {
      throw new BillingServiceError("BILLING_RULE_NOT_FOUND", "当前任务类型未配置计费规则。", 400);
    }

    return rule;
  }

  private async reserveWithPublicError(
    input: EntitlementReserveInput
  ): Promise<EntitlementReserveResult> {
    try {
      return await this.gateway.reserve(input);
    } catch (error: unknown) {
      if (error instanceof BillingServiceError) {
        throw error;
      }

      // 外部平台错误统一转成公开错误，避免把内部接口响应或堆栈透给前端。
      throw new BillingServiceError("BILLING_RESERVE_FAILED", "积分预占失败，请稍后重试。", 502);
    }
  }
}

export class MockEntitlementReserveGateway
  implements EntitlementReserveGateway, EntitlementReleaseGateway
{
  private readonly releasedReserveIds = new Set<string>();

  constructor(private balancePoints: string) {}

  getBalancePoints(): string {
    return this.balancePoints;
  }

  reserve(input: EntitlementReserveInput): Promise<EntitlementReserveResult> {
    if (compareDecimal(this.balancePoints, input.amount) < 0) {
      throw new BillingServiceError("BILLING_BALANCE_INSUFFICIENT", "积分余额不足。", 402);
    }

    this.balancePoints = subtractDecimal(this.balancePoints, input.amount);
    const reserveId = `mock_hold_${input.idempotencyKey}:amount=${input.amount}`;

    return Promise.resolve({
      reserveId,
      entitlementId: input.entitlementId ?? null,
      balancePoints: this.balancePoints
    });
  }

  release(input: EntitlementReleaseInput): Promise<EntitlementReleaseResult> {
    if (!this.releasedReserveIds.has(input.reserveId)) {
      const amount = extractReservedAmountFromMockHold(input.reserveId);

      this.balancePoints = addDecimal(this.balancePoints, amount);
      this.releasedReserveIds.add(input.reserveId);
    }

    return Promise.resolve({
      reserveId: input.reserveId
    });
  }
}

function parseBillingRules(rulesJson: string): BillingRule[] {
  const parsed = JSON.parse(rulesJson) as unknown;

  if (!Array.isArray(parsed)) {
    throw new BillingServiceError("BILLING_RULES_INVALID", "计费规则配置格式不正确。", 500);
  }

  return parsed.map((item) => {
    if (!isRecord(item)) {
      throw new BillingServiceError("BILLING_RULES_INVALID", "计费规则配置格式不正确。", 500);
    }

    return {
      task_type: readRuleString(item, "task_type"),
      usage_type: readRuleString(item, "usage_type"),
      unit: readRuleString(item, "unit"),
      points_per_unit: normalizeDecimal(readRuleString(item, "points_per_unit")),
      active: item.active !== false
    };
  });
}

function readRuleString(source: Record<string, unknown>, key: string): string {
  const value = source[key];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BillingServiceError("BILLING_RULES_INVALID", `计费规则缺少 ${key}。`, 500);
  }

  return value.trim();
}

function normalizeQuantity(value: number | undefined): number {
  const quantity = value ?? 1;

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 8) {
    throw new BillingServiceError("BILLING_QUANTITY_INVALID", "计费数量必须在 1 到 8 之间。", 400);
  }

  return quantity;
}

function normalizeDecimal(value: string): string {
  if (!/^\d+(\.\d+)?$/u.test(value)) {
    throw new BillingServiceError("BILLING_AMOUNT_INVALID", "计费金额配置不正确。", 500);
  }

  const [integerPart, decimalPart = ""] = value.split(".");
  const normalizedInteger = integerPart.replace(/^0+(?=\d)/u, "");
  const normalizedDecimal = decimalPart.replace(/0+$/u, "");

  return normalizedDecimal.length === 0
    ? normalizedInteger
    : `${normalizedInteger}.${normalizedDecimal}`;
}

function multiplyDecimal(value: string, quantity: number): string {
  const scaled = toScaledInteger(value) * BigInt(quantity);

  return fromScaledInteger(scaled);
}

function subtractDecimal(left: string, right: string): string {
  return fromScaledInteger(toScaledInteger(left) - toScaledInteger(right));
}

function addDecimal(left: string, right: string): string {
  return fromScaledInteger(toScaledInteger(left) + toScaledInteger(right));
}

function compareDecimal(left: string, right: string): number {
  const leftValue = toScaledInteger(left);
  const rightValue = toScaledInteger(right);

  if (leftValue === rightValue) {
    return 0;
  }

  return leftValue > rightValue ? 1 : -1;
}

function toScaledInteger(value: string): bigint {
  const normalized = normalizeDecimal(value);
  const [integerPart, decimalPart = ""] = normalized.split(".");
  const paddedDecimal = decimalPart.padEnd(6, "0").slice(0, 6);

  // 积分按 decimal 字符串计算，不使用 Number 做加减，避免资金/额度精度问题。
  return BigInt(integerPart) * 1_000_000n + BigInt(paddedDecimal);
}

function fromScaledInteger(value: bigint): string {
  const integerPart = value / 1_000_000n;
  const decimalPart = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");

  return decimalPart.length === 0
    ? integerPart.toString()
    : `${integerPart.toString()}.${decimalPart}`;
}

function extractReservedAmountFromMockHold(reserveId: string): string {
  const match = /:amount=([0-9.]+)$/u.exec(reserveId);

  return match?.[1] ?? "0";
}

function toPublicBillingEvent(event: BillingEventRecord): PublicBillingEvent {
  return {
    id: event.id,
    owner_user_id: event.owner_user_id,
    task_id: event.task_id,
    event_type: event.event_type,
    amount_points: event.amount_points,
    status: event.status,
    idempotency_key: event.idempotency_key,
    moling_reserve_id: event.moling_reserve_id,
    moling_entitlement_id: event.moling_entitlement_id,
    created_at: event.created_at,
    updated_at: event.updated_at
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
