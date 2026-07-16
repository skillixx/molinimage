import { randomUUID } from "node:crypto";

import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import {
  insertImageTaskRecord,
  type CreateImageTaskRecordInput,
  type ImageTaskRecord,
  type MySqlImageTasksRepository
} from "./image-tasks-repository.js";

export type ImageTaskOutboxStatus =
  "pending" | "dispatching" | "dispatched" | "failed" | "cancelled";

export interface ImageTaskOutboxRecord {
  id: string;
  task_id: string;
  status: ImageTaskOutboxStatus;
  attempt_count: number;
  next_attempt_at: string;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
}

export interface ImageTaskCreationRepository {
  create(input: CreateImageTaskRecordInput): Promise<ImageTaskRecord>;
}

export interface ImageTaskOutboxRepository {
  claimReady(limit: number, now: Date): Promise<ImageTaskOutboxRecord[]>;
  markDispatched(outboxId: string, dispatchedAt: Date): Promise<boolean>;
  markRetry(input: {
    outboxId: string;
    nextAttemptAt: Date;
    errorCode: string;
    errorMessage: string;
  }): Promise<boolean>;
  markCancellationRetry(input: { outboxId: string; nextAttemptAt: Date }): Promise<boolean>;
  claimTimedOut(limit: number, maxWaitMs: number): Promise<ImageTaskOutboxRecord[]>;
}

interface ImageTaskOutboxRow extends RowDataPacket {
  id: string;
  task_id: string;
  status: ImageTaskOutboxStatus;
  attempt_count: number;
  next_attempt_at: string;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
}

export class MySqlImageTaskOutboxRepository
  implements ImageTaskCreationRepository, ImageTaskOutboxRepository
{
  constructor(
    private readonly pool: Pool,
    private readonly imageTasksRepository: Pick<
      MySqlImageTasksRepository,
      "findById" | "findByIdempotencyKey"
    >
  ) {}

  async create(input: CreateImageTaskRecordInput): Promise<ImageTaskRecord> {
    const connection = await this.pool.getConnection();

    try {
      await connection.beginTransaction();
      await insertImageTaskRecord(connection, input);
      await connection.execute<ResultSetHeader>(
        `INSERT INTO image_task_outbox (
          id,
          task_id,
          status,
          attempt_count,
          next_attempt_at
        ) VALUES (?, ?, 'pending', 0, CURRENT_TIMESTAMP(3))`,
        [`outbox_${randomUUID().replaceAll("-", "")}`, input.id]
      );
      // 任务和 Outbox 必须共用一次提交；API 在 commit 后崩溃也能由 Dispatcher 扫描恢复。
      await connection.commit();
    } catch (error: unknown) {
      await rollbackQuietly(connection);
      const existingTask = await this.imageTasksRepository.findByIdempotencyKey(
        input.idempotency_key
      );

      if (existingTask !== undefined) {
        // 并发幂等请求由 image_tasks 唯一键吸收，复用首次事务已经创建的 Outbox。
        return existingTask;
      }

      throw error;
    } finally {
      connection.release();
    }

    const createdTask = await this.imageTasksRepository.findById(input.id);

    if (createdTask === undefined) {
      throw new Error("图片任务与 Outbox 提交后回读失败");
    }

    return createdTask;
  }

  async claimReady(limit: number, now: Date): Promise<ImageTaskOutboxRecord[]> {
    void now;
    return await this.claimRows(
      `status IN ('pending', 'failed')
       AND next_attempt_at <= CURRENT_TIMESTAMP(3)
       AND COALESCE(last_error_code, '') <> 'OUTBOX_CANCELLATION_RETRY'`,
      [],
      limit,
      "dispatching",
      true
    );
  }

  async markDispatched(outboxId: string, dispatchedAt: Date): Promise<boolean> {
    void dispatchedAt;
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE image_task_outbox
       SET status = 'dispatched',
           dispatched_at = CURRENT_TIMESTAMP(3),
           last_error_code = NULL,
           last_error_message = NULL
       WHERE id = ?
         AND status = 'dispatching'`,
      [outboxId]
    );

    return result.affectedRows === 1;
  }

  async markRetry(input: {
    outboxId: string;
    nextAttemptAt: Date;
    errorCode: string;
    errorMessage: string;
  }): Promise<boolean> {
    const delayMicroseconds = toDelayMicroseconds(input.nextAttemptAt);
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE image_task_outbox
       SET status = 'failed',
           next_attempt_at = TIMESTAMPADD(MICROSECOND, ?, CURRENT_TIMESTAMP(3)),
           last_error_code = ?,
           last_error_message = ?
       WHERE id = ?
         AND status = 'dispatching'`,
      [delayMicroseconds, input.errorCode, input.errorMessage, input.outboxId]
    );

    return result.affectedRows === 1;
  }

  async markCancellationRetry(input: { outboxId: string; nextAttemptAt: Date }): Promise<boolean> {
    const delayMicroseconds = toDelayMicroseconds(input.nextAttemptAt);
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE image_task_outbox
       SET status = 'failed',
           next_attempt_at = TIMESTAMPADD(MICROSECOND, ?, CURRENT_TIMESTAMP(3)),
           last_error_code = 'OUTBOX_CANCELLATION_RETRY',
           last_error_message = '超时任务取消失败，等待重试。'
       WHERE id = ?
         AND status = 'cancelled'`,
      [delayMicroseconds, input.outboxId]
    );

    return result.affectedRows === 1;
  }

  async claimTimedOut(limit: number, maxWaitMs: number): Promise<ImageTaskOutboxRecord[]> {
    const maxWaitMicroseconds = toDurationMicroseconds(maxWaitMs, "Outbox 最大等待时间");
    return await this.claimRows(
      `status IN ('pending', 'failed')
       AND created_at <= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? MICROSECOND)
       AND (status = 'pending' OR last_error_code = 'OUTBOX_CANCELLATION_RETRY')`,
      [maxWaitMicroseconds],
      limit,
      "cancelled",
      false
    );
  }

  private async claimRows(
    whereSql: string,
    parameters: (Date | string | number | null)[],
    limit: number,
    nextStatus: Extract<ImageTaskOutboxStatus, "dispatching" | "cancelled">,
    incrementAttempt: boolean
  ): Promise<ImageTaskOutboxRecord[]> {
    const safeLimit = formatSqlLimit(limit);
    const connection = await this.pool.getConnection();

    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<ImageTaskOutboxRow[]>(
        `${imageTaskOutboxSelectSql}
         WHERE ${whereSql}
         ORDER BY created_at ASC
         LIMIT ${safeLimit}
         FOR UPDATE SKIP LOCKED`,
        parameters
      );

      if (rows.length === 0) {
        await connection.commit();
        return [];
      }

      const placeholders = rows.map(() => "?").join(", ");
      const timeoutErrorSql =
        nextStatus === "cancelled"
          ? ", last_error_code = 'OUTBOX_DISPATCH_TIMEOUT', last_error_message = '任务等待入队超时，已取消。'"
          : "";
      await connection.execute<ResultSetHeader>(
        `UPDATE image_task_outbox
         SET status = ?,
             attempt_count = attempt_count + ?
             ${timeoutErrorSql}
         WHERE id IN (${placeholders})`,
        [nextStatus, incrementAttempt ? 1 : 0, ...rows.map((row) => row.id)]
      );
      await connection.commit();

      return rows.map((row) => ({
        ...toOutboxRecord(row),
        status: nextStatus,
        attempt_count: row.attempt_count + (incrementAttempt ? 1 : 0),
        ...(nextStatus === "cancelled"
          ? {
              last_error_code: "OUTBOX_DISPATCH_TIMEOUT",
              last_error_message: "任务等待入队超时，已取消。"
            }
          : {})
      }));
    } catch (error: unknown) {
      await rollbackQuietly(connection);
      throw error;
    } finally {
      connection.release();
    }
  }
}

async function rollbackQuietly(connection: PoolConnection): Promise<void> {
  try {
    await connection.rollback();
  } catch {
    // 原事务错误优先上抛，回滚连接故障不能覆盖最初失败原因。
  }
}

function toOutboxRecord(row: ImageTaskOutboxRow): ImageTaskOutboxRecord {
  return { ...row };
}

function formatSqlLimit(limit: number): string {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("Outbox 批量大小必须是 1 到 1000 之间的整数");
  }

  return String(limit);
}

function toDelayMicroseconds(nextAttemptAt: Date): number {
  // MySQL DATETIME 没有时区信息，使用数据库当前时间加时长，避免应用与数据库时区不同导致误调度。
  return Math.max(0, nextAttemptAt.getTime() - Date.now()) * 1000;
}

function toDurationMicroseconds(milliseconds: number, label: string): number {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1) {
    throw new Error(`${label}必须是正整数毫秒`);
  }

  return milliseconds * 1000;
}

const imageTaskOutboxSelectSql = `SELECT
  id,
  task_id,
  status,
  attempt_count,
  DATE_FORMAT(next_attempt_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS next_attempt_at,
  last_error_code,
  last_error_message,
  DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
  DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at,
  DATE_FORMAT(dispatched_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS dispatched_at
 FROM image_task_outbox`;
