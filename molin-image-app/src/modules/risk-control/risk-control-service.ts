import { randomUUID } from "node:crypto";

import type { RiskControlEventsRepository } from "../../infrastructure/database/risk-control-events-repository.js";

export interface RiskControlPolicy {
  windowSeconds: number;
  userLimit: number;
  ipLimit: number;
  disabledTaskTypes: string[];
  disabledCapabilities: string[];
}

export interface RiskControlCheckInput {
  requestId?: string;
  ownerUserId: number;
  ipAddress?: string;
  taskType: string;
  gatewayModelCode?: string | null;
  gatewayCapability?: string | null;
}

export class RiskControlServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "RiskControlServiceError";
  }
}

export class RiskControlService {
  private readonly disabledTaskTypes: ReadonlySet<string>;
  private readonly disabledCapabilities: ReadonlySet<string>;

  constructor(
    private readonly repository: RiskControlEventsRepository,
    private readonly policy: RiskControlPolicy
  ) {
    this.disabledTaskTypes = new Set(
      policy.disabledTaskTypes.map((item) => item.trim()).filter(Boolean)
    );
    this.disabledCapabilities = new Set(
      policy.disabledCapabilities.map((item) => item.trim()).filter(Boolean)
    );
  }

  async assertAllowed(input: RiskControlCheckInput): Promise<void> {
    const ipAddress = normalizeIpAddress(input.ipAddress);

    if (this.disabledTaskTypes.has(input.taskType)) {
      await this.recordDecision(input, {
        ipAddress,
        decision: "block",
        reasonCode: "RISK_TASK_TYPE_DISABLED",
        reasonMessage: "当前图片能力已被风控关闭，请稍后再试。"
      });
      throw new RiskControlServiceError(
        "RISK_TASK_TYPE_DISABLED",
        "当前图片能力已被风控关闭，请稍后再试。",
        403
      );
    }

    const gatewayCapability = input.gatewayCapability?.trim() ?? "";

    if (gatewayCapability.length > 0 && this.disabledCapabilities.has(gatewayCapability)) {
      await this.recordDecision(input, {
        ipAddress,
        decision: "block",
        reasonCode: "RISK_CAPABILITY_DISABLED",
        reasonMessage: "当前模型能力已被风控关闭，请稍后再试。"
      });
      throw new RiskControlServiceError(
        "RISK_CAPABILITY_DISABLED",
        "当前模型能力已被风控关闭，请稍后再试。",
        403
      );
    }

    const bucketStart = getWindowBucketStart(this.policy.windowSeconds);
    const userCount =
      this.policy.userLimit <= 0
        ? 0
        : await this.repository.incrementWindowCounter({
            subjectType: "user",
            subjectKey: String(input.ownerUserId),
            bucketStart,
            windowSeconds: this.policy.windowSeconds
          });

    if (this.policy.userLimit > 0 && userCount > this.policy.userLimit) {
      await this.recordDecision(input, {
        ipAddress,
        decision: "block",
        reasonCode: "RISK_USER_RATE_LIMITED",
        reasonMessage: "请求过于频繁，请稍后再试。",
        observedCount: userCount,
        limitCount: this.policy.userLimit
      });
      throw new RiskControlServiceError(
        "RISK_USER_RATE_LIMITED",
        "请求过于频繁，请稍后再试。",
        429
      );
    }

    const ipCount =
      this.policy.ipLimit <= 0
        ? 0
        : await this.repository.incrementWindowCounter({
            subjectType: "ip",
            subjectKey: ipAddress,
            bucketStart,
            windowSeconds: this.policy.windowSeconds
          });

    if (this.policy.ipLimit > 0 && ipCount > this.policy.ipLimit) {
      await this.recordDecision(input, {
        ipAddress,
        decision: "block",
        reasonCode: "RISK_IP_RATE_LIMITED",
        reasonMessage: "当前网络请求过于频繁，请稍后再试。",
        observedCount: ipCount,
        limitCount: this.policy.ipLimit
      });
      throw new RiskControlServiceError(
        "RISK_IP_RATE_LIMITED",
        "当前网络请求过于频繁，请稍后再试。",
        429
      );
    }

    await this.recordDecision(input, {
      ipAddress,
      decision: "allow",
      reasonCode: "RISK_ALLOWED",
      reasonMessage: "风控校验通过。",
      observedCount: Math.max(userCount, ipCount),
      limitCount: smallestPositiveLimit(this.policy.userLimit, this.policy.ipLimit)
    });
  }

  private async recordDecision(
    input: RiskControlCheckInput,
    decision: {
      ipAddress: string;
      decision: "allow" | "block";
      reasonCode: string;
      reasonMessage: string;
      observedCount?: number;
      limitCount?: number;
    }
  ): Promise<void> {
    // 风控日志必须先于错误返回或任务创建落库，方便运营追踪“为什么没有调用 AI 网关”。
    await this.repository.create({
      id: `risk_${randomUUID().replaceAll("-", "")}`,
      request_id: input.requestId ?? null,
      owner_user_id: input.ownerUserId,
      ip_address: decision.ipAddress,
      task_type: input.taskType,
      gateway_model_code: input.gatewayModelCode ?? null,
      gateway_capability: input.gatewayCapability ?? null,
      decision: decision.decision,
      reason_code: decision.reasonCode,
      reason_message: decision.reasonMessage,
      window_seconds: this.policy.windowSeconds,
      limit_count: decision.limitCount ?? null,
      observed_count: decision.observedCount ?? null,
      metadata_json: {
        source: "image_task_create"
      }
    });
  }
}

function smallestPositiveLimit(...limits: number[]): number | undefined {
  const positiveLimits = limits.filter((item) => item > 0);

  return positiveLimits.length === 0 ? undefined : Math.min(...positiveLimits);
}

function normalizeIpAddress(value: string | undefined): string {
  const normalized = value?.trim();

  return normalized === undefined || normalized.length === 0 ? "unknown" : normalized.slice(0, 64);
}

function getWindowBucketStart(windowSeconds: number): Date {
  const windowMilliseconds = windowSeconds * 1000;
  const bucketStartMs = Math.floor(Date.now() / windowMilliseconds) * windowMilliseconds;

  return new Date(bucketStartMs);
}
