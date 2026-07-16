import { randomUUID } from "node:crypto";

import type {
  ClaimImageTaskExecutionInput,
  ImageTaskExecutionClaim,
  ImageTaskRecord
} from "../infrastructure/database/image-tasks-repository.js";
import type { ImageTaskJobData } from "../infrastructure/queue/image-task-queue.js";
import type { ImageTaskWorkerExecutionContext } from "./image-generation-worker-service.js";
import {
  ImageTaskProcessingError,
  toImageTaskProcessingError
} from "./image-task-processing-error.js";

export interface ImageTaskExecutionRepository {
  claimExecution(input: ClaimImageTaskExecutionInput): Promise<ImageTaskExecutionClaim | undefined>;
  renewExecution(input: ClaimImageTaskExecutionInput): Promise<boolean>;
  releaseExecution(input: { taskId: string; lockToken: string }): Promise<boolean>;
  isExecutionActive(input: { taskId: string; lockToken: string }): Promise<boolean>;
}

export interface ImageTaskJobProcessorOptions {
  jobTimeoutMs: number;
  lockDurationMs?: number;
  heartbeatIntervalMs?: number;
}

export interface ClaimedImageTaskProcessor {
  processTask(taskId: string, context: ImageTaskWorkerExecutionContext): Promise<unknown>;
}

export interface ImageTaskJobAttemptContext {
  attemptNumber: number;
  maxAttempts: number;
  requestId?: string;
  jobId?: string;
}

export interface ImageTaskExecutionMetrics {
  request_id: string;
  task_id: string;
  job_id: string;
  outcome: "processed" | "skipped" | "retrying" | "failed";
  attempt_number: number;
  queue_wait_ms: number;
  execution_ms: number;
  end_to_end_ms: number;
}

export interface ImageTaskExecutionMetricsLogger {
  record(metrics: ImageTaskExecutionMetrics): void;
}

export interface ImageTaskFinalFailureHandler {
  finalizeFailure(input: {
    task: ImageTaskRecord;
    workerLockToken: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<void>;
}

export type ImageTaskJobProcessOutcome = "processed" | "skipped";

export class ImageTaskJobTimeoutError extends Error {
  constructor() {
    super("图片任务执行超时，等待队列重试。");
    this.name = "ImageTaskJobTimeoutError";
  }
}

export class ImageTaskExecutionLeaseLostError extends Error {
  constructor() {
    super("图片任务执行租约已失效，等待队列重新分配。");
    this.name = "ImageTaskExecutionLeaseLostError";
  }
}

export class ImageTaskJobFinalFailureError extends Error {
  constructor(
    public readonly code: string,
    public readonly discardRemainingAttempts: boolean
  ) {
    super("图片任务已达到最终失败状态。");
    this.name = "ImageTaskJobFinalFailureError";
  }
}

export class ImageTaskJobProcessor {
  private readonly lockDurationMs: number;
  private readonly heartbeatIntervalMs: number;

  constructor(
    private readonly repository: ImageTaskExecutionRepository,
    private readonly workerService: ClaimedImageTaskProcessor,
    private readonly options: ImageTaskJobProcessorOptions,
    private readonly finalFailureHandler?: ImageTaskFinalFailureHandler,
    private readonly metricsLogger?: ImageTaskExecutionMetricsLogger
  ) {
    this.lockDurationMs = options.lockDurationMs ?? Math.max(options.jobTimeoutMs * 2, 30_000);
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ??
      Math.max(1000, Math.min(10_000, Math.floor(this.lockDurationMs / 3)));
  }

  async process(
    jobData: ImageTaskJobData,
    attemptContext: ImageTaskJobAttemptContext = { attemptNumber: 1, maxAttempts: 3 }
  ): Promise<ImageTaskJobProcessOutcome> {
    const taskId = normalizeTaskId(jobData.task_id);
    const executionStartedAt = Date.now();
    const requestId = attemptContext.requestId ?? `worker_${randomUUID().replaceAll("-", "")}`;
    const jobId = attemptContext.jobId ?? taskId;
    const lockToken = randomUUID().replaceAll("-", "");
    const claim = await this.repository.claimExecution({
      taskId,
      lockToken,
      lockDurationMs: this.lockDurationMs
    });

    if (claim === undefined) {
      // 终态任务或仍被其他 Worker 持有的任务视为幂等跳过，不再次调用模型或修改计费。
      this.recordMetrics({
        requestId,
        taskId,
        jobId,
        attemptNumber: attemptContext.attemptNumber,
        executionStartedAt,
        taskCreatedAt: executionStartedAt,
        outcome: "skipped"
      });
      return "skipped";
    }

    const abortController = new AbortController();
    let rejectInterruption: ((reason: Error) => void) | undefined;
    const interruption = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject;
    });
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing || abortController.signal.aborted) {
        return;
      }

      renewing = true;
      void this.repository
        .renewExecution({ taskId, lockToken, lockDurationMs: this.lockDurationMs })
        .then((renewed) => {
          if (!renewed && !abortController.signal.aborted) {
            const error = new ImageTaskExecutionLeaseLostError();
            abortController.abort(error);
            rejectInterruption?.(error);
          }
        })
        .catch(() => {
          if (!abortController.signal.aborted) {
            const error = new ImageTaskExecutionLeaseLostError();
            abortController.abort(error);
            rejectInterruption?.(error);
          }
        })
        .finally(() => {
          renewing = false;
        });
    }, this.heartbeatIntervalMs);
    const timeout = setTimeout(() => {
      const error = new ImageTaskJobTimeoutError();
      abortController.abort(error);
      rejectInterruption?.(error);
    }, this.options.jobTimeoutMs);
    const executionContext: ImageTaskWorkerExecutionContext = {
      workerLockToken: lockToken,
      signal: abortController.signal,
      assertActive: async () => {
        if (abortController.signal.aborted) {
          throwAbortReason(abortController.signal);
        }

        const active = await this.repository.isExecutionActive({ taskId, lockToken });

        if (!active) {
          throw new ImageTaskExecutionLeaseLostError();
        }
      }
    };
    const processing = this.workerService.processTask(taskId, executionContext);

    try {
      await Promise.race([processing, interruption]);
      this.recordMetrics({
        requestId,
        taskId,
        jobId,
        attemptNumber: attemptContext.attemptNumber,
        executionStartedAt,
        taskCreatedAt: parseTaskTimestamp(claim.task.created_at, executionStartedAt),
        workerStartedAt: parseTaskTimestamp(claim.task.worker_started_at, executionStartedAt),
        outcome: "processed"
      });
      return "processed";
    } catch (error: unknown) {
      if (!abortController.signal.aborted) {
        abortController.abort(error);
      }

      const processingError = resolveProcessingError(error);
      const finalAttempt = attemptContext.attemptNumber >= attemptContext.maxAttempts;
      const shouldFinalize = !processingError.retryable || finalAttempt;

      if (shouldFinalize && this.finalFailureHandler !== undefined) {
        // 只有不可重试或次数耗尽时才进入业务终态；该路径会由 ImageTaskService 幂等释放预占积分。
        try {
          await this.finalFailureHandler.finalizeFailure({
            task: claim.task,
            workerLockToken: lockToken,
            errorCode: processingError.code,
            errorMessage: processingError.message
          });
        } finally {
          this.recordMetrics({
            requestId,
            taskId,
            jobId,
            attemptNumber: attemptContext.attemptNumber,
            executionStartedAt,
            taskCreatedAt: parseTaskTimestamp(claim.task.created_at, executionStartedAt),
            workerStartedAt: parseTaskTimestamp(claim.task.worker_started_at, executionStartedAt),
            outcome: "failed"
          });
        }
        void processing.catch(() => undefined);
        throw new ImageTaskJobFinalFailureError(processingError.code, !processingError.retryable);
      }

      // 中间失败只归还数据库租约，绝不能提前把任务标记失败或释放积分。
      await this.repository.releaseExecution({ taskId, lockToken }).catch(() => false);
      this.recordMetrics({
        requestId,
        taskId,
        jobId,
        attemptNumber: attemptContext.attemptNumber,
        executionStartedAt,
        taskCreatedAt: parseTaskTimestamp(claim.task.created_at, executionStartedAt),
        workerStartedAt: parseTaskTimestamp(claim.task.worker_started_at, executionStartedAt),
        outcome: "retrying"
      });
      void processing.catch(() => undefined);
      throw toPublicProcessingError(error);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
    }
  }

  private recordMetrics(input: {
    requestId: string;
    taskId: string;
    jobId: string;
    attemptNumber: number;
    executionStartedAt: number;
    taskCreatedAt: number;
    workerStartedAt?: number;
    outcome: ImageTaskExecutionMetrics["outcome"];
  }): void {
    const completedAt = Date.now();

    try {
      this.metricsLogger?.record({
        request_id: input.requestId,
        task_id: input.taskId,
        job_id: input.jobId,
        outcome: input.outcome,
        attempt_number: input.attemptNumber,
        queue_wait_ms: Math.max(
          0,
          (input.workerStartedAt ?? input.executionStartedAt) - input.taskCreatedAt
        ),
        execution_ms: Math.max(0, completedAt - input.executionStartedAt),
        end_to_end_ms: Math.max(0, completedAt - input.taskCreatedAt)
      });
    } catch {
      // 可观测性是旁路能力，日志后端异常不能触发任务重试、状态回滚或重复计费。
    }
  }
}

function resolveProcessingError(error: unknown): ImageTaskProcessingError {
  if (error instanceof ImageTaskJobTimeoutError) {
    return new ImageTaskProcessingError({
      code: "IMAGE_TASK_TIMEOUT",
      message: "图片任务执行超时，请等待系统自动重试。",
      retryable: true,
      cause: error
    });
  }

  if (error instanceof ImageTaskExecutionLeaseLostError) {
    return new ImageTaskProcessingError({
      code: "IMAGE_TASK_WORKER_LEASE_LOST",
      message: "图片任务执行权已转移，请等待系统自动重试。",
      retryable: true,
      cause: error
    });
  }

  return toImageTaskProcessingError(error, {
    code: "IMAGE_TASK_WORKER_FAILED",
    message: "图片任务执行异常，请等待系统自动重试。",
    retryable: true
  });
}

function normalizeTaskId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 64) {
    throw new Error("图片任务队列消息缺少合法 task_id。");
  }

  return value.trim();
}

function throwAbortReason(signal: AbortSignal): never {
  const reason = signal.reason as unknown;
  throw reason instanceof Error ? reason : new Error("图片任务执行已中止。");
}

function toPublicProcessingError(error: unknown): Error {
  if (
    error instanceof ImageTaskJobTimeoutError ||
    error instanceof ImageTaskExecutionLeaseLostError
  ) {
    return error;
  }

  if (error instanceof ImageTaskProcessingError) {
    return new Error(error.message);
  }

  // BullMQ 失败原因只保留稳定中文信息，不能把 Provider、Redis 或数据库原始异常写进队列。
  return new Error("图片任务执行异常，等待队列重试。");
}

function parseTaskTimestamp(value: string | null | undefined, fallback: number): number {
  if (value === null || value === undefined) {
    return fallback;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : fallback;
}
