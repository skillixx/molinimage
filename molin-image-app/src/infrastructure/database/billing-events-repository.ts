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

export interface BillingEventsRepository {
  createReserved(input: CreateReservedBillingEventInput): Promise<BillingEventRecord>;
  createRelease(input: CreateReleaseBillingEventInput): Promise<BillingEventRecord>;
  findById(eventId: string): Promise<BillingEventRecord | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<BillingEventRecord | undefined>;
}

interface BillingEventRow extends RowDataPacket, BillingEventRecord {}

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
