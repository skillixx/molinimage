import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export type ImageTaskStatus =
  | "pending"
  | "billing_reserved"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "billing_pending"
  | "cancelled";

export interface ImageTaskRecord {
  id: string;
  source_task_id: string | null;
  source_file_id: string | null;
  owner_user_id: number;
  entitlement_id: number | null;
  task_type: string;
  status: ImageTaskStatus;
  prompt: string | null;
  negative_prompt: string | null;
  style_preset_id: string | null;
  input_file_ids: string[];
  output_file_ids: string[];
  text_result: string | null;
  gateway_model_code: string | null;
  gateway_capability: string | null;
  gateway_request_id: string | null;
  quality: string | null;
  image_size: string | null;
  image_count: number;
  upscale_factor: number | null;
  cost_points: string | null;
  billing_event_id: string | null;
  idempotency_key: string;
  error_code: string | null;
  error_message: string | null;
  is_favorited: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateImageTaskRecordInput {
  id: string;
  source_task_id?: string | null;
  source_file_id?: string | null;
  owner_user_id: number;
  entitlement_id?: number | null;
  task_type: string;
  status: ImageTaskStatus;
  prompt: string | null;
  negative_prompt: string | null;
  style_preset_id: string | null;
  input_file_ids: string[];
  gateway_model_code: string | null;
  gateway_capability: string | null;
  quality: string | null;
  image_size: string | null;
  image_count: number;
  upscale_factor?: number | null;
  cost_points: string | null;
  billing_event_id: string | null;
  idempotency_key: string;
}

export interface TransitionImageTaskInput {
  taskId: string;
  ownerUserId: number;
  fromStatus: ImageTaskStatus;
  toStatus: ImageTaskStatus;
  outputFileIds?: string[];
  textResult?: string | null;
  gatewayRequestId?: string | null;
  billingEventId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  workerLockToken?: string;
}

export interface ClaimImageTaskExecutionInput {
  taskId: string;
  lockToken: string;
  lockDurationMs: number;
}

export interface ImageTaskExecutionClaim {
  task: ImageTaskRecord;
  lock_token: string;
}

export interface RecordImageTaskOutputInput {
  taskId: string;
  ownerUserId: number;
  fileId: string;
  gatewayRequestId: string;
  workerLockToken?: string;
}

export interface ImageTasksRepository {
  create(input: CreateImageTaskRecordInput): Promise<ImageTaskRecord>;
  findById(taskId: string): Promise<ImageTaskRecord | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<ImageTaskRecord | undefined>;
  findHistoryByOwner(input: {
    ownerUserId: number;
    taskType?: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: ImageTaskRecord[]; total: number }>;
  markFavorite(input: {
    ownerUserId: number;
    taskId: string;
    collectionId: string;
  }): Promise<ImageTaskRecord | undefined>;
  softDeleteHistoryItem(input: {
    ownerUserId: number;
    taskId: string;
  }): Promise<ImageTaskRecord | undefined>;
  updateStatus(input: TransitionImageTaskInput): Promise<ImageTaskRecord | undefined>;
  claimExecution?(
    input: ClaimImageTaskExecutionInput
  ): Promise<ImageTaskExecutionClaim | undefined>;
  renewExecution?(input: ClaimImageTaskExecutionInput): Promise<boolean>;
  releaseExecution?(input: { taskId: string; lockToken: string }): Promise<boolean>;
  isExecutionActive?(input: { taskId: string; lockToken: string }): Promise<boolean>;
  recordOutputFile?(input: RecordImageTaskOutputInput): Promise<ImageTaskRecord | undefined>;
}

interface ImageTaskRow extends RowDataPacket {
  id: string;
  source_task_id: string | null;
  source_file_id: string | null;
  owner_user_id: number;
  entitlement_id: number | null;
  task_type: string;
  status: ImageTaskStatus;
  prompt: string | null;
  negative_prompt: string | null;
  style_preset_id: string | null;
  input_file_ids: string | string[] | null;
  output_file_ids: string | string[] | null;
  text_result: string | null;
  gateway_model_code: string | null;
  gateway_capability: string | null;
  gateway_request_id: string | null;
  quality: string | null;
  image_size: string | null;
  image_count: number;
  upscale_factor: number | null;
  cost_points: string | null;
  billing_event_id: string | null;
  idempotency_key: string;
  error_code: string | null;
  error_message: string | null;
  is_favorited: number | boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export class MySqlImageTasksRepository implements ImageTasksRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateImageTaskRecordInput): Promise<ImageTaskRecord> {
    try {
      await insertImageTaskRecord(this.pool, input);
    } catch (error: unknown) {
      const existingTask = await this.findByIdempotencyKey(input.idempotency_key);

      if (existingTask !== undefined) {
        // 任务创建幂等键重复时返回已有任务，避免接口或重试按钮连点重复预占积分。
        return existingTask;
      }

      throw error;
    }

    const createdTask = await this.findById(input.id);

    if (createdTask === undefined) {
      // 插入后回读数据库真实记录，避免接口返回和数据库默认值出现偏差。
      throw new Error("图片任务写入后回读失败");
    }

    return createdTask;
  }

  async findById(taskId: string): Promise<ImageTaskRecord | undefined> {
    const [rows] = await this.pool.execute<ImageTaskRow[]>(
      `${imageTaskSelectSql}
       WHERE id = ?
       LIMIT 1`,
      [taskId]
    );

    if (rows.length === 0) {
      return undefined;
    }

    return toImageTaskRecord(rows[0]);
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<ImageTaskRecord | undefined> {
    const [rows] = await this.pool.execute<ImageTaskRow[]>(
      `${imageTaskSelectSql}
       WHERE idempotency_key = ?
       LIMIT 1`,
      [idempotencyKey]
    );

    if (rows.length === 0) {
      return undefined;
    }

    return toImageTaskRecord(rows[0]);
  }

  async findHistoryByOwner(input: {
    ownerUserId: number;
    taskType?: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: ImageTaskRecord[]; total: number }> {
    const offset = (input.page - 1) * input.pageSize;
    const limitSql = formatSqlLimit(input.pageSize);
    const offsetSql = formatSqlLimit(offset);
    const taskTypeWhere = input.taskType === undefined ? "" : "AND task_type = ?";
    const queryParams =
      input.taskType === undefined ? [input.ownerUserId] : [input.ownerUserId, input.taskType];
    const [countRows] = await this.pool.execute<(RowDataPacket & { total: number })[]>(
      `SELECT COUNT(*) AS total
       FROM image_tasks
       WHERE owner_user_id = ?
        AND status = 'succeeded'
        AND deleted_at IS NULL
        ${taskTypeWhere}`,
      queryParams
    );
    const [rows] = await this.pool.execute<ImageTaskRow[]>(
      `SELECT
        id,
        source_task_id,
        source_file_id,
        owner_user_id,
        entitlement_id,
        task_type,
        status,
        prompt,
        negative_prompt,
        style_preset_id,
        input_file_ids,
        output_file_ids,
        text_result,
        gateway_model_code,
        gateway_capability,
        gateway_request_id,
        quality,
        image_size,
        image_count,
        upscale_factor,
        CAST(cost_points AS CHAR) AS cost_points,
        billing_event_id,
        idempotency_key,
        error_code,
        error_message,
        EXISTS (
          SELECT 1
          FROM user_collections
          WHERE user_collections.owner_user_id = image_tasks.owner_user_id
            AND user_collections.task_id = image_tasks.id
          LIMIT 1
        ) AS is_favorited,
        DATE_FORMAT(deleted_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS deleted_at,
        DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
        DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at
       FROM image_tasks
       WHERE owner_user_id = ?
        AND status = 'succeeded'
       AND deleted_at IS NULL
        ${taskTypeWhere}
       ORDER BY is_favorited DESC, created_at DESC
       LIMIT ${limitSql} OFFSET ${offsetSql}`,
      queryParams
    );

    return {
      items: rows.map((row) => toImageTaskRecord(row)),
      total: countRows[0]?.total ?? 0
    };
  }

  async markFavorite(input: {
    ownerUserId: number;
    taskId: string;
    collectionId: string;
  }): Promise<ImageTaskRecord | undefined> {
    const task = await this.findById(input.taskId);

    if (
      task?.owner_user_id !== input.ownerUserId ||
      task.status !== "succeeded" ||
      task.deleted_at !== null
    ) {
      return undefined;
    }

    // 收藏使用独立表保持作品和精选关系解耦；重复点击通过唯一索引幂等吸收。
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO user_collections (id, owner_user_id, task_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE task_id = VALUES(task_id)`,
      [input.collectionId, input.ownerUserId, input.taskId]
    );

    return this.findById(input.taskId);
  }

  async softDeleteHistoryItem(input: {
    ownerUserId: number;
    taskId: string;
  }): Promise<ImageTaskRecord | undefined> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE image_tasks
       SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP(3))
       WHERE id = ?
        AND owner_user_id = ?
        AND status = 'succeeded'
        AND deleted_at IS NULL`,
      [input.taskId, input.ownerUserId]
    );

    if (result.affectedRows === 0) {
      return undefined;
    }

    // 删除收藏关系，避免软删除作品继续出现在精选查询里。
    await this.pool.execute<ResultSetHeader>(
      `DELETE FROM user_collections
       WHERE owner_user_id = ?
        AND task_id = ?`,
      [input.ownerUserId, input.taskId]
    );

    return this.findById(input.taskId);
  }

  async updateStatus(input: TransitionImageTaskInput): Promise<ImageTaskRecord | undefined> {
    const workerFenceSql = input.workerLockToken === undefined ? "" : "AND worker_lock_token = ?";
    const clearWorkerLeaseSql =
      input.workerLockToken === undefined
        ? ""
        : ", worker_lock_token = NULL, worker_lock_expires_at = NULL";
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE image_tasks
       SET
        status = ?,
        output_file_ids = COALESCE(?, output_file_ids),
        text_result = COALESCE(?, text_result),
        gateway_request_id = COALESCE(?, gateway_request_id),
        billing_event_id = COALESCE(?, billing_event_id),
        error_code = ?,
        error_message = ?
        ${clearWorkerLeaseSql}
       WHERE id = ?
        AND owner_user_id = ?
        AND status = ?
        ${workerFenceSql}`,
      [
        input.toStatus,
        input.outputFileIds === undefined ? null : JSON.stringify(input.outputFileIds),
        input.textResult ?? null,
        input.gatewayRequestId ?? null,
        input.billingEventId ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.taskId,
        input.ownerUserId,
        input.fromStatus,
        ...(input.workerLockToken === undefined ? [] : [input.workerLockToken])
      ]
    );

    if (result.affectedRows === 0) {
      // affectedRows 为 0 表示任务不存在、归属错误或状态已被并发流程推进。
      return undefined;
    }

    return this.findById(input.taskId);
  }

  async claimExecution(
    input: ClaimImageTaskExecutionInput
  ): Promise<ImageTaskExecutionClaim | undefined> {
    const lockDurationMicroseconds = toDurationMicroseconds(
      input.lockDurationMs,
      "Worker 租约时长"
    );
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE image_tasks
       SET status = 'running',
           worker_lock_token = ?,
           worker_lock_expires_at = TIMESTAMPADD(MICROSECOND, ?, CURRENT_TIMESTAMP(3)),
           worker_started_at = COALESCE(worker_started_at, CURRENT_TIMESTAMP(3)),
           worker_attempt_count = worker_attempt_count + 1
       WHERE id = ?
         AND deleted_at IS NULL
         AND (
           status IN ('billing_reserved', 'queued')
           OR (
             status = 'running'
             AND (worker_lock_expires_at IS NULL OR worker_lock_expires_at <= CURRENT_TIMESTAMP(3))
           )
         )`,
      [input.lockToken, lockDurationMicroseconds, input.taskId]
    );

    if (result.affectedRows !== 1) {
      // 终态任务、有效租约或不存在的任务都不再执行，重复 Job 在这里被幂等吸收。
      return undefined;
    }

    const task = await this.findById(input.taskId);

    if (task === undefined) {
      throw new Error("Worker 抢占图片任务后回读失败");
    }

    return { task, lock_token: input.lockToken };
  }

  async renewExecution(input: ClaimImageTaskExecutionInput): Promise<boolean> {
    const lockDurationMicroseconds = toDurationMicroseconds(
      input.lockDurationMs,
      "Worker 租约时长"
    );
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE image_tasks
       SET worker_lock_expires_at = TIMESTAMPADD(MICROSECOND, ?, CURRENT_TIMESTAMP(3))
       WHERE id = ?
         AND status = 'running'
         AND worker_lock_token = ?
         AND worker_lock_expires_at > CURRENT_TIMESTAMP(3)`,
      [lockDurationMicroseconds, input.taskId, input.lockToken]
    );

    return result.affectedRows === 1;
  }

  async releaseExecution(input: { taskId: string; lockToken: string }): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE image_tasks
       SET status = 'queued',
           worker_lock_token = NULL,
           worker_lock_expires_at = NULL
       WHERE id = ?
         AND status = 'running'
         AND worker_lock_token = ?`,
      [input.taskId, input.lockToken]
    );

    return result.affectedRows === 1;
  }

  async isExecutionActive(input: { taskId: string; lockToken: string }): Promise<boolean> {
    const [rows] = await this.pool.execute<(RowDataPacket & { active: number })[]>(
      `SELECT EXISTS(
         SELECT 1
         FROM image_tasks
         WHERE id = ?
           AND status = 'running'
           AND worker_lock_token = ?
           AND worker_lock_expires_at > CURRENT_TIMESTAMP(3)
       ) AS active`,
      [input.taskId, input.lockToken]
    );

    return rows[0]?.active === 1;
  }

  async recordOutputFile(input: RecordImageTaskOutputInput): Promise<ImageTaskRecord | undefined> {
    const workerFenceSql = input.workerLockToken === undefined ? "" : "AND worker_lock_token = ?";
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE image_tasks
       SET output_file_ids = CASE
             WHEN JSON_CONTAINS(output_file_ids, JSON_QUOTE(?), '$') THEN output_file_ids
             ELSE JSON_ARRAY_APPEND(output_file_ids, '$', ?)
           END,
           gateway_request_id = COALESCE(gateway_request_id, ?)
       WHERE id = ?
         AND owner_user_id = ?
         AND status = 'running'
         ${workerFenceSql}`,
      [
        input.fileId,
        input.fileId,
        input.gatewayRequestId,
        input.taskId,
        input.ownerUserId,
        ...(input.workerLockToken === undefined ? [] : [input.workerLockToken])
      ]
    );

    if (result.affectedRows !== 1) {
      // 只有持有当前执行租约的 Worker 才能登记结果，过期 Worker 不能覆盖新执行者状态。
      return undefined;
    }

    return await this.findById(input.taskId);
  }
}

export async function insertImageTaskRecord(
  executor: Pool | PoolConnection,
  input: CreateImageTaskRecordInput
): Promise<void> {
  // 该底层 INSERT 可复用于普通创建和 Outbox 事务，但不负责提交事务或吞掉唯一键冲突。
  await executor.execute<ResultSetHeader>(
    `INSERT INTO image_tasks (
      id,
      source_task_id,
      source_file_id,
      owner_user_id,
      entitlement_id,
      task_type,
      status,
      prompt,
      negative_prompt,
      style_preset_id,
      input_file_ids,
      output_file_ids,
      gateway_model_code,
      gateway_capability,
      quality,
      image_size,
      image_count,
      upscale_factor,
      cost_points,
      billing_event_id,
      idempotency_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.source_task_id ?? null,
      input.source_file_id ?? null,
      input.owner_user_id,
      input.entitlement_id ?? null,
      input.task_type,
      input.status,
      input.prompt,
      input.negative_prompt,
      input.style_preset_id,
      JSON.stringify(input.input_file_ids),
      JSON.stringify([]),
      input.gateway_model_code,
      input.gateway_capability,
      input.quality,
      input.image_size,
      input.image_count,
      input.upscale_factor ?? null,
      input.cost_points,
      input.billing_event_id,
      input.idempotency_key
    ]
  );
}

function toImageTaskRecord(row: ImageTaskRow): ImageTaskRecord {
  return {
    ...row,
    input_file_ids: parseJsonArray(row.input_file_ids),
    output_file_ids: parseJsonArray(row.output_file_ids),
    is_favorited: row.is_favorited === true || row.is_favorited === 1
  };
}

function parseJsonArray(value: string | string[] | null): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  if (typeof value !== "string" || value.length === 0) {
    return [];
  }

  const parsed = JSON.parse(value) as unknown;

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((item): item is string => typeof item === "string");
}

function formatSqlLimit(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("分页参数必须是非负安全整数。");
  }

  // MySQL 某些版本对 prepared statement 的 LIMIT/OFFSET 参数兼容性不好；这里仅内联已校验数字。
  return String(value);
}

function toDurationMicroseconds(value: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
  ) {
    throw new Error(`${label}必须是可转换为微秒的正整数。`);
  }

  return value * 1000;
}

const imageTaskSelectSql = `SELECT
  id,
  source_task_id,
  source_file_id,
  owner_user_id,
  entitlement_id,
  task_type,
  status,
  prompt,
  negative_prompt,
  style_preset_id,
  input_file_ids,
  output_file_ids,
  text_result,
  gateway_model_code,
  gateway_capability,
  gateway_request_id,
  quality,
  image_size,
  image_count,
  upscale_factor,
  CAST(cost_points AS CHAR) AS cost_points,
  billing_event_id,
  idempotency_key,
  error_code,
  error_message,
  EXISTS (
    SELECT 1
    FROM user_collections
    WHERE user_collections.owner_user_id = image_tasks.owner_user_id
      AND user_collections.task_id = image_tasks.id
    LIMIT 1
  ) AS is_favorited,
  DATE_FORMAT(deleted_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS deleted_at,
  DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
  DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at
 FROM image_tasks`;
