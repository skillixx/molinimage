import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import type { ImageTaskStatus } from "./image-tasks-repository.js";

export interface BillingReconciliationTaskRecord {
  id: string;
  owner_user_id: number;
  task_type: string;
  status: ImageTaskStatus;
  cost_points: string | null;
  billing_event_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  latest_billing_event_id: string | null;
  latest_billing_event_type: string | null;
  latest_billing_event_status: string | null;
  latest_billing_event_error_code: string | null;
  latest_billing_event_error_message: string | null;
  latest_reconciliation_result: string | null;
  latest_reconciliation_error_code: string | null;
  latest_reconciliation_error_message: string | null;
  latest_reconciliation_created_at: string | null;
}

export interface BillingReconciliationAttemptInput {
  id: string;
  task_id: string;
  owner_user_id: number;
  actor_user_id: number;
  action: "retry_settle" | "retry_release";
  before_task_status: string;
  after_task_status: string;
  before_error_code: string | null;
  after_error_code: string | null;
  billing_event_id: string | null;
  billing_event_status: string | null;
  result: "succeeded" | "pending" | "failed";
  error_code: string | null;
  error_message: string | null;
  request_id: string;
}

export interface UpdateBillingReconciliationAttemptInput {
  attemptId: string;
  after_task_status: string;
  after_error_code: string | null;
  billing_event_id: string | null;
  billing_event_status: string | null;
  result: "succeeded" | "pending" | "failed";
  error_code: string | null;
  error_message: string | null;
}

export interface BillingReconciliationAttemptRecord extends BillingReconciliationAttemptInput {
  created_at: string;
}

export interface BillingReconciliationRepository {
  listPending(input: {
    page: number;
    pageSize: number;
  }): Promise<{ items: BillingReconciliationTaskRecord[]; total: number }>;
  createAttempt(
    input: BillingReconciliationAttemptInput
  ): Promise<BillingReconciliationAttemptRecord>;
  updateAttemptResult(
    input: UpdateBillingReconciliationAttemptInput
  ): Promise<BillingReconciliationAttemptRecord>;
  markReleaseReconciled(input: {
    taskId: string;
    ownerUserId: number;
    errorCode: string;
    errorMessage: string;
  }): Promise<void>;
  listAttempts(taskId: string): Promise<BillingReconciliationAttemptRecord[]>;
}

interface BillingReconciliationTaskRow extends RowDataPacket, BillingReconciliationTaskRecord {}

interface BillingReconciliationAttemptRow
  extends RowDataPacket, BillingReconciliationAttemptRecord {}

export class MySqlBillingReconciliationRepository implements BillingReconciliationRepository {
  constructor(private readonly pool: Pool) {}

  async listPending(input: {
    page: number;
    pageSize: number;
  }): Promise<{ items: BillingReconciliationTaskRecord[]; total: number }> {
    const offset = (input.page - 1) * input.pageSize;
    const limitSql = formatSqlLimit(input.pageSize);
    const offsetSql = formatSqlLimit(offset);
    const [countRows] = await this.pool.execute<(RowDataPacket & { total: number })[]>(
      `SELECT COUNT(*) AS total
       FROM image_tasks
       WHERE status = 'billing_pending'
        OR (status = 'failed' AND error_code = 'BILLING_RELEASE_PENDING')`
    );
    const [rows] = await this.pool.execute<BillingReconciliationTaskRow[]>(
      `${pendingTaskSelectSql}
       WHERE image_tasks.status = 'billing_pending'
        OR (image_tasks.status = 'failed' AND image_tasks.error_code = 'BILLING_RELEASE_PENDING')
       ORDER BY image_tasks.updated_at ASC
       LIMIT ${limitSql} OFFSET ${offsetSql}`
    );

    return {
      items: rows,
      total: countRows[0]?.total ?? 0
    };
  }

  async createAttempt(
    input: BillingReconciliationAttemptInput
  ): Promise<BillingReconciliationAttemptRecord> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO billing_reconciliation_attempts (
        id, task_id, owner_user_id, actor_user_id, action,
        before_task_status, after_task_status, before_error_code, after_error_code,
        billing_event_id, billing_event_status, result, error_code, error_message, request_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.task_id,
        input.owner_user_id,
        input.actor_user_id,
        input.action,
        input.before_task_status,
        input.after_task_status,
        input.before_error_code,
        input.after_error_code,
        input.billing_event_id,
        input.billing_event_status,
        input.result,
        input.error_code,
        input.error_message,
        input.request_id
      ]
    );
    const [rows] = await this.pool.execute<BillingReconciliationAttemptRow[]>(
      `${attemptSelectSql} WHERE id = ? LIMIT 1`,
      [input.id]
    );
    return rows[0];
  }

  async updateAttemptResult(
    input: UpdateBillingReconciliationAttemptInput
  ): Promise<BillingReconciliationAttemptRecord> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE billing_reconciliation_attempts
       SET after_task_status = ?,
        after_error_code = ?,
        billing_event_id = ?,
        billing_event_status = ?,
        result = ?,
        error_code = ?,
        error_message = ?
       WHERE id = ?`,
      [
        input.after_task_status,
        input.after_error_code,
        input.billing_event_id,
        input.billing_event_status,
        input.result,
        input.error_code,
        input.error_message,
        input.attemptId
      ]
    );
    const [rows] = await this.pool.execute<BillingReconciliationAttemptRow[]>(
      `${attemptSelectSql} WHERE id = ? LIMIT 1`,
      [input.attemptId]
    );

    return rows[0];
  }

  async markReleaseReconciled(input: {
    taskId: string;
    ownerUserId: number;
    errorCode: string;
    errorMessage: string;
  }): Promise<void> {
    // 释放对账成功后任务仍是失败态，但错误原因改为“已释放”，避免继续出现在待对账列表。
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE image_tasks
       SET error_code = ?, error_message = ?
       WHERE id = ?
        AND owner_user_id = ?
        AND status = 'failed'
        AND error_code = 'BILLING_RELEASE_PENDING'`,
      [input.errorCode, input.errorMessage, input.taskId, input.ownerUserId]
    );

    if (result.affectedRows === 0) {
      throw new Error("释放对账标记失败，任务状态已变化或不再待释放对账。");
    }
  }

  async listAttempts(taskId: string): Promise<BillingReconciliationAttemptRecord[]> {
    const [rows] = await this.pool.execute<BillingReconciliationAttemptRow[]>(
      `${attemptSelectSql}
       WHERE task_id = ?
       ORDER BY created_at DESC`,
      [taskId]
    );

    return rows;
  }
}

function formatSqlLimit(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("分页参数必须是非负安全整数。");
  }

  // MySQL 某些版本对 prepared statement 的 LIMIT/OFFSET 参数兼容性不好；这里仅内联已校验数字。
  return String(value);
}

const pendingTaskSelectSql = `SELECT
  image_tasks.id,
  image_tasks.owner_user_id,
  image_tasks.task_type,
  image_tasks.status,
  CAST(image_tasks.cost_points AS CHAR) AS cost_points,
  image_tasks.billing_event_id,
  image_tasks.error_code,
  image_tasks.error_message,
  DATE_FORMAT(image_tasks.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
  DATE_FORMAT(image_tasks.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at,
  latest_event.id AS latest_billing_event_id,
  latest_event.event_type AS latest_billing_event_type,
  latest_event.status AS latest_billing_event_status,
  latest_event.error_code AS latest_billing_event_error_code,
  latest_event.error_message AS latest_billing_event_error_message,
  latest_attempt.result AS latest_reconciliation_result,
  latest_attempt.error_code AS latest_reconciliation_error_code,
  latest_attempt.error_message AS latest_reconciliation_error_message,
  DATE_FORMAT(latest_attempt.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS latest_reconciliation_created_at
 FROM image_tasks
 LEFT JOIN billing_events AS latest_event
  ON latest_event.id = (
    SELECT billing_events.id
    FROM billing_events
    WHERE billing_events.task_id = image_tasks.id
    ORDER BY billing_events.created_at DESC
    LIMIT 1
  )
 LEFT JOIN billing_reconciliation_attempts AS latest_attempt
  ON latest_attempt.id = (
    SELECT billing_reconciliation_attempts.id
    FROM billing_reconciliation_attempts
    WHERE billing_reconciliation_attempts.task_id = image_tasks.id
    ORDER BY billing_reconciliation_attempts.created_at DESC
    LIMIT 1
  )`;

const attemptSelectSql = `SELECT
  id,
  task_id,
  owner_user_id,
  actor_user_id,
  action,
  before_task_status,
  after_task_status,
  before_error_code,
  after_error_code,
  billing_event_id,
  billing_event_status,
  result,
  error_code,
  error_message,
  request_id,
  DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at
 FROM billing_reconciliation_attempts`;
