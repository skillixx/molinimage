import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export interface BillingEventRecord {
  id: string;
  owner_user_id: number;
  task_id: string;
  event_type: string;
  amount_points: string;
  status: string;
  idempotency_key: string;
  moling_reserve_id: string | null;
  moling_entitlement_id: number | null;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface BillingEventWithTaskRecord extends BillingEventRecord {
  task_type: string | null;
  task_status: string | null;
  task_error_code: string | null;
  task_created_at: string | null;
}

export interface BillingEventSummaryRecord {
  reserved_points: string;
  settled_points: string;
  released_points: string;
  pending_points: string;
  record_count: number;
}

export interface CreateReservedBillingEventInput {
  id: string;
  owner_user_id: number;
  task_id: string;
  amount_points: string;
  idempotency_key: string;
  moling_reserve_id: string | null;
  moling_entitlement_id: number | null;
}

export interface CreateReleaseBillingEventInput {
  id: string;
  owner_user_id: number;
  task_id: string;
  amount_points: string;
  status: "released" | "release_pending";
  idempotency_key: string;
  moling_reserve_id: string | null;
  moling_entitlement_id: number | null;
  error_code: string | null;
  error_message: string | null;
}

export interface ClaimReleaseBillingEventInput {
  idempotencyKey: string;
}

export interface CompleteReleaseBillingEventInput {
  eventId: string;
  expectedRetryCount: number;
  status: "released" | "release_pending";
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ClaimSettleBillingEventInput {
  id: string;
  owner_user_id: number;
  task_id: string;
  amount_points: string;
  idempotency_key: string;
  moling_reserve_id: string | null;
  moling_entitlement_id: number | null;
  retry_pending: boolean;
}

export interface CompleteSettleBillingEventInput {
  eventId: string;
  expectedRetryCount: number;
  status: "settled" | "settle_pending";
  errorCode: string | null;
  errorMessage: string | null;
}

export interface BillingEventsRepository {
  createReserved(input: CreateReservedBillingEventInput): Promise<BillingEventRecord>;
  claimSettle(
    input: ClaimSettleBillingEventInput
  ): Promise<{ event: BillingEventRecord; claimed: boolean }>;
  completeSettle(input: CompleteSettleBillingEventInput): Promise<BillingEventRecord>;
  createRelease(input: CreateReleaseBillingEventInput): Promise<BillingEventRecord>;
  claimRelease(
    input: ClaimReleaseBillingEventInput
  ): Promise<{ event: BillingEventRecord; claimed: boolean }>;
  completeRelease(input: CompleteReleaseBillingEventInput): Promise<BillingEventRecord>;
  findById(eventId: string): Promise<BillingEventRecord | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<BillingEventRecord | undefined>;
  findByOwner(input: {
    ownerUserId: number;
    page: number;
    pageSize: number;
  }): Promise<{ items: BillingEventWithTaskRecord[]; total: number }>;
  summarizeByOwner(ownerUserId: number): Promise<BillingEventSummaryRecord>;
}

interface BillingEventRow extends RowDataPacket, BillingEventRecord {}
interface BillingEventWithTaskRow extends RowDataPacket, BillingEventWithTaskRecord {}
interface BillingEventSummaryRow extends RowDataPacket, BillingEventSummaryRecord {}

export class MySqlBillingEventsRepository implements BillingEventsRepository {
  constructor(private readonly pool: Pool) {}

  async createReserved(input: CreateReservedBillingEventInput): Promise<BillingEventRecord> {
    try {
      await this.pool.execute<ResultSetHeader>(
        `INSERT INTO billing_events (
          id,
          owner_user_id,
          task_id,
          event_type,
          amount_points,
          status,
          idempotency_key,
          moling_reserve_id,
          moling_entitlement_id
        ) VALUES (?, ?, ?, 'reserve', ?, 'reserved', ?, ?, ?)`,
        [
          input.id,
          input.owner_user_id,
          input.task_id,
          input.amount_points,
          input.idempotency_key,
          input.moling_reserve_id,
          input.moling_entitlement_id
        ]
      );
    } catch (error: unknown) {
      const existingEvent = await this.findByIdempotencyKey(input.idempotency_key);

      if (existingEvent !== undefined) {
        // 幂等键冲突时返回原计费事件，保证接口重试不会重复写入预占流水。
        return existingEvent;
      }

      throw error;
    }

    const createdEvent = await this.findByIdempotencyKey(input.idempotency_key);

    if (createdEvent === undefined) {
      throw new Error("计费事件写入后回读失败");
    }

    return createdEvent;
  }

  async createRelease(input: CreateReleaseBillingEventInput): Promise<BillingEventRecord> {
    try {
      await this.pool.execute<ResultSetHeader>(
        `INSERT INTO billing_events (
          id,
          owner_user_id,
          task_id,
          event_type,
          amount_points,
          status,
          idempotency_key,
          moling_reserve_id,
          moling_entitlement_id,
          error_code,
          error_message
        ) VALUES (?, ?, ?, 'release', ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.owner_user_id,
          input.task_id,
          input.amount_points,
          input.status,
          input.idempotency_key,
          input.moling_reserve_id,
          input.moling_entitlement_id,
          input.error_code,
          input.error_message
        ]
      );
    } catch (error: unknown) {
      const existingEvent = await this.findByIdempotencyKey(input.idempotency_key);

      if (existingEvent !== undefined) {
        // release 事件以任务级幂等键去重，避免失败回调、重试或 worker 重放重复释放同一 hold。
        return existingEvent;
      }

      throw error;
    }

    const createdEvent = await this.findByIdempotencyKey(input.idempotency_key);

    if (createdEvent === undefined) {
      throw new Error("释放计费事件写入后回读失败");
    }

    return createdEvent;
  }

  async claimRelease(
    input: ClaimReleaseBillingEventInput
  ): Promise<{ event: BillingEventRecord; claimed: boolean }> {
    const existingEvent = await this.findByIdempotencyKey(input.idempotencyKey);

    if (existingEvent?.event_type !== "release") {
      return {
        event:
          existingEvent ??
          ({
            id: "",
            owner_user_id: 0,
            task_id: "",
            event_type: "release",
            amount_points: "0",
            status: "missing",
            idempotency_key: input.idempotencyKey,
            moling_reserve_id: null,
            moling_entitlement_id: null,
            error_code: "BILLING_RELEASE_EVENT_NOT_FOUND",
            error_message: "释放事件不存在。",
            retry_count: 0,
            created_at: "",
            updated_at: ""
          } satisfies BillingEventRecord),
        claimed: false
      };
    }

    if (existingEvent.status === "released") {
      return { event: existingEvent, claimed: false };
    }

    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE billing_events
       SET status = 'releasing', retry_count = retry_count + 1, error_code = NULL, error_message = NULL
       WHERE id = ?
        AND (
          status = 'release_pending'
          OR (status = 'releasing' AND updated_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE))
        )`,
      [existingEvent.id]
    );
    const claimedEvent = await this.findById(existingEvent.id);

    if (claimedEvent === undefined) {
      throw new Error("释放事件重试抢占后回读失败。");
    }

    // release 重试也用 CAS 抢占，避免多个管理员或定时任务同时归还同一个 hold。
    return { event: claimedEvent, claimed: result.affectedRows === 1 };
  }

  async completeRelease(input: CompleteReleaseBillingEventInput): Promise<BillingEventRecord> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE billing_events
       SET status = ?, error_code = ?, error_message = ?
       WHERE id = ? AND status = 'releasing' AND retry_count = ?`,
      [input.status, input.errorCode, input.errorMessage, input.eventId, input.expectedRetryCount]
    );
    const completedEvent = await this.findById(input.eventId);

    if (completedEvent === undefined) {
      throw new Error("释放事件完成后回读失败。");
    }

    return completedEvent;
  }

  async claimSettle(
    input: ClaimSettleBillingEventInput
  ): Promise<{ event: BillingEventRecord; claimed: boolean }> {
    try {
      await this.pool.execute<ResultSetHeader>(
        `INSERT INTO billing_events (
          id,
          owner_user_id,
          task_id,
          event_type,
          amount_points,
          status,
          idempotency_key,
          moling_reserve_id,
          moling_entitlement_id,
          error_code,
          error_message
        ) VALUES (?, ?, ?, 'settle', ?, 'settling', ?, ?, ?, NULL, NULL)`,
        [
          input.id,
          input.owner_user_id,
          input.task_id,
          input.amount_points,
          input.idempotency_key,
          input.moling_reserve_id,
          input.moling_entitlement_id
        ]
      );
    } catch (error: unknown) {
      const existingEvent = await this.findByIdempotencyKey(input.idempotency_key);

      if (existingEvent !== undefined) {
        if (
          input.retry_pending &&
          (existingEvent.status === "settle_pending" || existingEvent.status === "settling")
        ) {
          const [retryResult] = await this.pool.execute<ResultSetHeader>(
            `UPDATE billing_events
             SET status = 'settling', retry_count = retry_count + 1, error_code = NULL, error_message = NULL
             WHERE id = ?
               AND (
                 status = 'settle_pending'
                 OR (status = 'settling' AND updated_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE))
               )`,
            [existingEvent.id]
          );

          const claimedEvent = await this.findById(existingEvent.id);

          if (claimedEvent === undefined) {
            throw new Error("结算事件重试抢占后回读失败", { cause: error });
          }

          // CAS 只允许一个对账 worker 接管 pending 或租约过期的 settling，避免进程退出后永久卡住。
          return { event: claimedEvent, claimed: retryResult.affectedRows === 1 };
        }

        return { event: existingEvent, claimed: false };
      }

      throw error;
    }

    const createdEvent = await this.findByIdempotencyKey(input.idempotency_key);

    if (createdEvent === undefined) {
      throw new Error("结算计费事件写入后回读失败");
    }

    return { event: createdEvent, claimed: true };
  }

  async completeSettle(input: CompleteSettleBillingEventInput): Promise<BillingEventRecord> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE billing_events
       SET status = ?, error_code = ?, error_message = ?
       WHERE id = ? AND status = 'settling' AND retry_count = ?`,
      [input.status, input.errorCode, input.errorMessage, input.eventId, input.expectedRetryCount]
    );
    const completedEvent = await this.findById(input.eventId);

    if (completedEvent === undefined) {
      throw new Error("结算事件完成后回读失败");
    }

    return completedEvent;
  }

  async findById(eventId: string): Promise<BillingEventRecord | undefined> {
    const [rows] = await this.pool.execute<BillingEventRow[]>(
      `${billingEventSelectSql}
       WHERE id = ?
       LIMIT 1`,
      [eventId]
    );

    return rows[0];
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<BillingEventRecord | undefined> {
    const [rows] = await this.pool.execute<BillingEventRow[]>(
      `${billingEventSelectSql}
       WHERE idempotency_key = ?
       LIMIT 1`,
      [idempotencyKey]
    );

    return rows[0];
  }

  async findByOwner(input: {
    ownerUserId: number;
    page: number;
    pageSize: number;
  }): Promise<{ items: BillingEventWithTaskRecord[]; total: number }> {
    const offset = (input.page - 1) * input.pageSize;
    const limitSql = formatSqlLimit(input.pageSize);
    const offsetSql = formatSqlLimit(offset);
    const [countRows] = await this.pool.execute<(RowDataPacket & { total: number })[]>(
      `SELECT COUNT(*) AS total
       FROM billing_events
       WHERE owner_user_id = ?`,
      [input.ownerUserId]
    );
    const [rows] = await this.pool.execute<BillingEventWithTaskRow[]>(
      `SELECT
        billing_events.id,
        billing_events.owner_user_id,
        billing_events.task_id,
        billing_events.event_type,
        CAST(billing_events.amount_points AS CHAR) AS amount_points,
        billing_events.status,
        billing_events.idempotency_key,
        billing_events.moling_reserve_id,
        billing_events.moling_entitlement_id,
        billing_events.error_code,
        billing_events.error_message,
        billing_events.retry_count,
        DATE_FORMAT(billing_events.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
        DATE_FORMAT(billing_events.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at,
        image_tasks.task_type,
        image_tasks.status AS task_status,
        image_tasks.error_code AS task_error_code,
        DATE_FORMAT(image_tasks.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS task_created_at
       FROM billing_events
       LEFT JOIN image_tasks
        ON image_tasks.id = billing_events.task_id
       AND image_tasks.owner_user_id = billing_events.owner_user_id
       WHERE billing_events.owner_user_id = ?
       ORDER BY billing_events.created_at DESC, billing_events.id DESC
       LIMIT ${limitSql} OFFSET ${offsetSql}`,
      [input.ownerUserId]
    );

    return {
      items: rows,
      total: countRows[0]?.total ?? 0
    };
  }

  async summarizeByOwner(ownerUserId: number): Promise<BillingEventSummaryRecord> {
    const [rows] = await this.pool.execute<BillingEventSummaryRow[]>(
      `SELECT
        CAST(COALESCE(SUM(CASE WHEN event_type = 'reserve' THEN amount_points ELSE 0 END), 0) AS CHAR) AS reserved_points,
        CAST(COALESCE(SUM(CASE WHEN event_type = 'settle' AND status = 'settled' THEN amount_points ELSE 0 END), 0) AS CHAR) AS settled_points,
        CAST(COALESCE(SUM(CASE WHEN event_type = 'release' AND status = 'released' THEN amount_points ELSE 0 END), 0) AS CHAR) AS released_points,
        CAST(COALESCE(SUM(CASE WHEN status IN ('settle_pending', 'release_pending', 'settling', 'releasing') THEN amount_points ELSE 0 END), 0) AS CHAR) AS pending_points,
        COUNT(*) AS record_count
       FROM billing_events
       WHERE owner_user_id = ?`,
      [ownerUserId]
    );

    return (
      rows[0] ?? {
        reserved_points: "0",
        settled_points: "0",
        released_points: "0",
        pending_points: "0",
        record_count: 0
      }
    );
  }
}

function formatSqlLimit(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("分页参数必须是非负安全整数。");
  }

  // MySQL 某些版本对 prepared statement 的 LIMIT/OFFSET 参数兼容性不好；这里仅内联已校验数字。
  return String(value);
}

const billingEventSelectSql = `SELECT
  id,
  owner_user_id,
  task_id,
  event_type,
  CAST(amount_points AS CHAR) AS amount_points,
  status,
  idempotency_key,
  moling_reserve_id,
  moling_entitlement_id,
  error_code,
  error_message,
  retry_count,
  DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
  DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at
 FROM billing_events`;
