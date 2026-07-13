import type {
  BillingEventsRepository,
  BillingEventSummaryRecord,
  BillingEventWithTaskRecord
} from "../../infrastructure/database/billing-events-repository.js";

export interface BillingRecordListResult {
  items: PublicBillingRecord[];
  page: number;
  page_size: number;
  total: number;
  summary: PublicBillingRecordSummary;
}

export interface PublicBillingRecordSummary {
  reserved_points: string;
  settled_points: string;
  released_points: string;
  pending_points: string;
  net_spent_points: string;
  record_count: number;
}

export interface PublicBillingRecord {
  id: string;
  task_id: string;
  task_type: string | null;
  task_status: string | null;
  event_type: string;
  event_type_label: string;
  amount_points: string;
  display_amount_points: string;
  status: string;
  status_label: string;
  billing_stage:
    "reserved" | "settled" | "released" | "pending" | "processing" | "failed" | "unknown";
  task_detail_url: string;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export class BillingRecordService {
  constructor(
    private readonly repository: Pick<BillingEventsRepository, "findByOwner" | "summarizeByOwner">
  ) {}

  async listUserRecords(input: {
    ownerUserId: number;
    page?: number;
    pageSize?: number;
  }): Promise<BillingRecordListResult> {
    // 消耗记录只能按当前登录用户 owner_user_id 查询，调用方不能传入任意用户条件绕过隔离。
    const page = normalizePositiveInteger(input.page ?? 1, "page");
    const pageSize = normalizePageSize(input.pageSize ?? 20);
    const [records, summary] = await Promise.all([
      this.repository.findByOwner({
        ownerUserId: input.ownerUserId,
        page,
        pageSize
      }),
      this.repository.summarizeByOwner(input.ownerUserId)
    ]);

    return {
      items: records.items.map(toPublicBillingRecord),
      page,
      page_size: pageSize,
      total: records.total,
      summary: toPublicSummary(summary)
    };
  }
}

function toPublicBillingRecord(record: BillingEventWithTaskRecord): PublicBillingRecord {
  // 用户侧只暴露可展示的状态、金额方向和任务跳转地址；内部计费错误详情由对账后台处理。
  return {
    id: record.id,
    task_id: record.task_id,
    task_type: record.task_type,
    task_status: record.task_status,
    event_type: record.event_type,
    event_type_label: formatEventType(record.event_type),
    amount_points: record.amount_points,
    display_amount_points: formatDisplayAmount(record),
    status: record.status,
    status_label: formatBillingStatus(record.status),
    billing_stage: resolveBillingStage(record.status),
    task_detail_url: `/?task_id=${encodeURIComponent(record.task_id)}`,
    error_code: normalizePublicErrorCode(record),
    error_message: formatPublicErrorMessage(record),
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function toPublicSummary(summary: BillingEventSummaryRecord): PublicBillingRecordSummary {
  // 汇总值保持 decimal 字符串传递，前端只负责展示，不参与资金口径计算。
  return {
    reserved_points: summary.reserved_points,
    settled_points: summary.settled_points,
    released_points: summary.released_points,
    pending_points: summary.pending_points,
    net_spent_points: subtractDecimal(summary.settled_points, summary.released_points),
    record_count: summary.record_count
  };
}

function formatDisplayAmount(record: BillingEventWithTaskRecord): string {
  // release 表示归还积分，用户侧展示为正向变动；预占和结算展示为消耗方向。
  if (record.event_type === "release") {
    return `+${record.amount_points}`;
  }

  return `-${record.amount_points}`;
}

function formatEventType(eventType: string): string {
  const labels: Record<string, string> = {
    reserve: "预占",
    settle: "结算",
    release: "释放"
  };

  return labels[eventType] ?? eventType;
}

function formatBillingStatus(status: string): string {
  // 后端统一输出中文状态，前端避免重复维护计费状态语义。
  const labels: Record<string, string> = {
    reserved: "已预占",
    settling: "结算中",
    settled: "已结算",
    settle_pending: "待对账",
    releasing: "释放中",
    released: "已释放",
    release_pending: "待对账"
  };

  return labels[status] ?? status;
}

function resolveBillingStage(
  status: string
): "reserved" | "settled" | "released" | "pending" | "processing" | "failed" | "unknown" {
  // billing_stage 是前端样式分组，不替代真实 status；真实状态仍保留给排查和自动化测试。
  if (status === "reserved") {
    return "reserved";
  }

  if (status === "settled") {
    return "settled";
  }

  if (status === "released") {
    return "released";
  }

  if (status === "settle_pending" || status === "release_pending") {
    return "pending";
  }

  if (status === "settling" || status === "releasing") {
    return "processing";
  }

  return status === "missing" ? "failed" : "unknown";
}

function normalizePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new BillingRecordServiceError(
      "REQUEST_FIELD_INVALID",
      `字段 ${fieldName} 必须是正整数。`,
      400
    );
  }

  return value;
}

function normalizePageSize(value: number): number {
  const pageSize = normalizePositiveInteger(value, "page_size");

  if (pageSize > 100) {
    // 用户消耗记录分页设置上限，避免单次查询拖慢账单页或放大数据库压力。
    throw new BillingRecordServiceError("REQUEST_FIELD_INVALID", "page_size 不能超过 100。", 400);
  }

  return pageSize;
}

function normalizePublicErrorCode(record: BillingEventWithTaskRecord): string | null {
  if (record.error_code === null) {
    return null;
  }

  // 用户端不透出墨灵或内部 provider 的原始错误码，避免把平台协议细节暴露到浏览器。
  return resolveBillingStage(record.status) === "pending"
    ? "BILLING_RECONCILIATION_REQUIRED"
    : "BILLING_EVENT_ERROR";
}

function formatPublicErrorMessage(record: BillingEventWithTaskRecord): string | null {
  if (record.error_message === null) {
    return null;
  }

  // 原始 error_message 可能包含内部接口返回或运维线索，用户侧仅提示可理解的处理状态。
  if (resolveBillingStage(record.status) === "pending") {
    return "计费处理需要对账，请稍后刷新或联系管理员。";
  }

  return "计费状态异常，请稍后重试或联系管理员。";
}

export class BillingRecordServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "BillingRecordServiceError";
  }
}

function subtractDecimal(left: string, right: string): string {
  return fromScaledInteger(toScaledInteger(left) - toScaledInteger(right));
}

function toScaledInteger(value: string): bigint {
  const normalized = normalizeDecimal(value);
  const [integerPart, decimalPart = ""] = normalized.split(".");
  const paddedDecimal = decimalPart.padEnd(6, "0").slice(0, 6);

  // 积分按 decimal 字符串计算，不通过 Number 做加减，避免额度展示出现精度偏差。
  return BigInt(integerPart) * 1_000_000n + BigInt(paddedDecimal);
}

function fromScaledInteger(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absoluteValue = value < 0n ? -value : value;
  const integerPart = absoluteValue / 1_000_000n;
  const decimalPart = (absoluteValue % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");

  return decimalPart.length === 0
    ? `${sign}${integerPart.toString()}`
    : `${sign}${integerPart.toString()}.${decimalPart}`;
}

function normalizeDecimal(value: string): string {
  const normalized = value.trim();

  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) {
    return "0";
  }

  return normalized;
}
