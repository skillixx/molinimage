import { randomUUID } from "node:crypto";

import type {
  PricingRuleRecord,
  PricingRulesRepository,
  SavePricingRuleInput
} from "../../infrastructure/database/pricing-rules-repository.js";
import { PricingRuleRepositoryConflictError } from "../../infrastructure/database/pricing-rules-repository.js";

export interface SavePricingRuleRequest {
  taskType: string;
  gatewayModelCode?: string | null;
  gatewayCapability?: string | null;
  quality?: string | null;
  imageSize?: string | null;
  upscaleFactor?: number | null;
  usageType: string;
  unit?: string;
  pointsPerUnit: string;
  active?: boolean;
}

export interface PricingRuleAuditLogger {
  record(event: {
    event_type: "pricing_rule_created" | "pricing_rule_updated";
    rule_id: string;
    task_type: string;
    points_per_unit: string;
    active: boolean;
    actor_user_id: number | null;
    source: "admin_session" | "internal_api";
    request_id: string;
    current_rule: PricingRuleAuditSnapshot;
    previous_rule: PricingRuleAuditSnapshot | null;
  }): void | Promise<void>;
}

export type PricingRuleAuditSnapshot = Pick<
  PricingRuleRecord,
  | "task_type"
  | "gateway_model_code"
  | "gateway_capability"
  | "quality"
  | "image_size"
  | "upscale_factor"
  | "usage_type"
  | "unit"
  | "points_per_unit"
  | "active"
>;

export interface PricingRuleAuditContext {
  actorUserId: number | null;
  source: "admin_session" | "internal_api";
  requestId: string;
}

export class PricingRuleServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "PricingRuleServiceError";
  }
}

const supportedTaskTypes = new Set([
  "text_to_image",
  "image_to_text",
  "image_to_image",
  "image_restore",
  "upscale"
]);

export class PricingRuleService {
  constructor(
    private readonly repository: PricingRulesRepository,
    private readonly auditLogger?: PricingRuleAuditLogger
  ) {}

  async listRules(): Promise<{
    items: PricingRuleRecord[];
    page: 1;
    page_size: number;
    total: number;
  }> {
    const items = await this.repository.listAll();

    return { items, page: 1, page_size: items.length, total: items.length };
  }

  async createRule(
    request: SavePricingRuleRequest,
    auditContext: PricingRuleAuditContext = defaultAuditContext
  ): Promise<{ rule: PricingRuleRecord }> {
    const input = normalizeRuleInput(`price_${randomUUID().replaceAll("-", "")}`, request);
    const rule = await this.persistRule(() => this.repository.create(input));

    await this.recordAudit("pricing_rule_created", rule, null, auditContext);
    return { rule };
  }

  async updateRule(
    ruleId: string,
    request: Partial<SavePricingRuleRequest>,
    auditContext: PricingRuleAuditContext = defaultAuditContext
  ): Promise<{ rule: PricingRuleRecord }> {
    const existing = await this.repository.findById(normalizeRequiredString(ruleId, "rule_id"));

    if (existing === undefined) {
      throw new PricingRuleServiceError("PRICING_RULE_NOT_FOUND", "价格规则不存在。", 404);
    }

    const merged: SavePricingRuleRequest = {
      taskType: request.taskType ?? existing.task_type,
      gatewayModelCode: hasOwn(request, "gatewayModelCode")
        ? (request.gatewayModelCode ?? null)
        : existing.gateway_model_code,
      gatewayCapability: hasOwn(request, "gatewayCapability")
        ? (request.gatewayCapability ?? null)
        : existing.gateway_capability,
      quality: hasOwn(request, "quality") ? (request.quality ?? null) : existing.quality,
      imageSize: hasOwn(request, "imageSize") ? (request.imageSize ?? null) : existing.image_size,
      upscaleFactor: hasOwn(request, "upscaleFactor")
        ? (request.upscaleFactor ?? null)
        : existing.upscale_factor,
      usageType: request.usageType ?? existing.usage_type,
      unit: request.unit ?? existing.unit,
      pointsPerUnit: request.pointsPerUnit ?? existing.points_per_unit,
      active: request.active ?? existing.active
    };
    const updated = await this.persistRule(() =>
      this.repository.update(normalizeRuleInput(existing.id, merged))
    );

    if (updated === undefined) {
      throw new PricingRuleServiceError("PRICING_RULE_NOT_FOUND", "价格规则不存在。", 404);
    }

    await this.recordAudit("pricing_rule_updated", updated, existing, auditContext);
    return { rule: updated };
  }

  private async recordAudit(
    eventType: "pricing_rule_created" | "pricing_rule_updated",
    rule: PricingRuleRecord,
    previousRule: PricingRuleRecord | null,
    context: PricingRuleAuditContext
  ): Promise<void> {
    // 价格变更属于高风险操作，完整保留公开规则维度的前后快照，不记录内部令牌。
    await this.auditLogger?.record({
      event_type: eventType,
      rule_id: rule.id,
      task_type: rule.task_type,
      points_per_unit: rule.points_per_unit,
      active: rule.active,
      actor_user_id: context.actorUserId,
      source: context.source,
      request_id: context.requestId,
      current_rule: toAuditSnapshot(rule),
      previous_rule: previousRule === null ? null : toAuditSnapshot(previousRule)
    });
  }

  private async persistRule<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof PricingRuleRepositoryConflictError) {
        throw new PricingRuleServiceError(
          "PRICING_RULE_CONFLICT",
          "相同任务和价格维度的规则已存在。",
          409
        );
      }

      throw error;
    }
  }
}

function toAuditSnapshot(rule: PricingRuleRecord): PricingRuleAuditSnapshot {
  return {
    task_type: rule.task_type,
    gateway_model_code: rule.gateway_model_code,
    gateway_capability: rule.gateway_capability,
    quality: rule.quality,
    image_size: rule.image_size,
    upscale_factor: rule.upscale_factor,
    usage_type: rule.usage_type,
    unit: rule.unit,
    points_per_unit: rule.points_per_unit,
    active: rule.active
  };
}

const defaultAuditContext: PricingRuleAuditContext = {
  actorUserId: null,
  source: "internal_api",
  requestId: "unknown"
};

function hasOwn(source: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function normalizeRuleInput(id: string, request: SavePricingRuleRequest): SavePricingRuleInput {
  const taskType = normalizeRequiredString(request.taskType, "task_type");

  if (!supportedTaskTypes.has(taskType)) {
    throw new PricingRuleServiceError("TASK_TYPE_UNSUPPORTED", "当前不支持该任务类型。", 400);
  }

  const upscaleFactor = request.upscaleFactor ?? null;

  if (upscaleFactor !== null && upscaleFactor !== 2 && upscaleFactor !== 4) {
    throw new PricingRuleServiceError("UPSCALE_FACTOR_INVALID", "高清倍率只支持 2x 或 4x。", 400);
  }

  return {
    id,
    task_type: taskType,
    gateway_model_code: normalizeOptionalDimension(request.gatewayModelCode, "gateway_model_code"),
    gateway_capability: normalizeOptionalDimension(request.gatewayCapability, "gateway_capability"),
    quality: normalizeOptionalDimension(request.quality, "quality"),
    image_size: normalizeOptionalDimension(request.imageSize, "image_size"),
    upscale_factor: upscaleFactor,
    usage_type: normalizeRequiredString(request.usageType, "usage_type"),
    unit: normalizeRequiredString(request.unit ?? "credits", "unit"),
    points_per_unit: normalizePoints(request.pointsPerUnit),
    active: request.active !== false
  };
}

function normalizePoints(value: string): string {
  const normalized = normalizeRequiredString(value, "points_per_unit");

  if (!/^\d+(\.\d{1,6})?$/u.test(normalized)) {
    throw new PricingRuleServiceError(
      "PRICING_POINTS_INVALID",
      "积分必须是最多六位小数的非负数。",
      400
    );
  }

  const [integerPart, decimalPart = ""] = normalized.split(".");
  const integer = integerPart.replace(/^0+(?=\d)/u, "");
  const decimal = decimalPart.replace(/0+$/u, "");

  return decimal.length === 0 ? integer : `${integer}.${decimal}`;
}

function normalizeRequiredString(value: string, field: string): string {
  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new PricingRuleServiceError("PRICING_RULE_FIELD_REQUIRED", `${field} 不能为空。`, 400);
  }

  return normalized;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function normalizeOptionalDimension(
  value: string | null | undefined,
  field: string
): string | null {
  const normalized = normalizeOptionalString(value);

  if (normalized?.includes("|") === true) {
    throw new PricingRuleServiceError(
      "PRICING_RULE_DIMENSION_INVALID",
      `${field} 不能包含字符 |。`,
      400
    );
  }

  return normalized;
}
