import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export type RiskControlDecision = "allow" | "block";

export interface CreateRiskControlEventInput {
  id: string;
  request_id?: string | null;
  owner_user_id: number;
  ip_address: string;
  task_type: string;
  gateway_model_code?: string | null;
  gateway_capability?: string | null;
  decision: RiskControlDecision;
  reason_code: string;
  reason_message: string;
  window_seconds?: number | null;
  limit_count?: number | null;
  observed_count?: number | null;
  metadata_json?: Record<string, unknown> | null;
}

export interface RiskControlEventsRepository {
  create(input: CreateRiskControlEventInput): Promise<void>;
  incrementWindowCounter(input: {
    subjectType: "user" | "ip";
    subjectKey: string;
    bucketStart: Date;
    windowSeconds: number;
  }): Promise<number>;
}

interface CounterRow extends RowDataPacket {
  request_count: number;
}

export class MySqlRiskControlEventsRepository implements RiskControlEventsRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateRiskControlEventInput): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO risk_control_events (
        id,
        request_id,
        owner_user_id,
        ip_address,
        task_type,
        gateway_model_code,
        gateway_capability,
        decision,
        reason_code,
        reason_message,
        window_seconds,
        limit_count,
        observed_count,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.request_id ?? null,
        input.owner_user_id,
        input.ip_address,
        input.task_type,
        input.gateway_model_code ?? null,
        input.gateway_capability ?? null,
        input.decision,
        input.reason_code,
        input.reason_message,
        input.window_seconds ?? null,
        input.limit_count ?? null,
        input.observed_count ?? null,
        input.metadata_json === undefined || input.metadata_json === null
          ? null
          : JSON.stringify(input.metadata_json)
      ]
    );
  }

  async incrementWindowCounter(input: {
    subjectType: "user" | "ip";
    subjectKey: string;
    bucketStart: Date;
    windowSeconds: number;
  }): Promise<number> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO risk_control_counters (
        subject_type,
        subject_key,
        bucket_start,
        window_seconds,
        request_count
      ) VALUES (?, ?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE
        request_count = request_count + 1,
        window_seconds = VALUES(window_seconds)`,
      [input.subjectType, input.subjectKey, input.bucketStart, input.windowSeconds]
    );
    const [rows] = await this.pool.execute<CounterRow[]>(
      `SELECT request_count
       FROM risk_control_counters
       WHERE subject_type = ?
        AND subject_key = ?
        AND bucket_start = ?
       LIMIT 1`,
      [input.subjectType, input.subjectKey, input.bucketStart]
    );

    return rows[0]?.request_count ?? 0;
  }
}
