import { randomUUID } from "node:crypto";

import type {
  ClaimImageTaskExecutionInput,
  ImageTaskExecutionClaim
} from "../infrastructure/database/image-tasks-repository.js";
import type { ImageTaskJobData } from "../infrastructure/queue/image-task-queue.js";
import type { ImageTaskWorkerExecutionContext } from "./image-generation-worker-service.js";

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

export class ImageTaskJobProcessor {
  private readonly lockDurationMs: number;
  private readonly heartbeatIntervalMs: number;

  constructor(
    private readonly repository: ImageTaskExecutionRepository,
    private readonly workerService: ClaimedImageTaskProcessor,
    private readonly options: ImageTaskJobProcessorOptions
  ) {
    this.lockDurationMs = options.lockDurationMs ?? Math.max(options.jobTimeoutMs * 2, 30_000);
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ??
      Math.max(1000, Math.min(10_000, Math.floor(this.lockDurationMs / 3)));
  }

  async process(jobData: ImageTaskJobData): Promise<ImageTaskJobProcessOutcome> {
    const taskId = normalizeTaskId(jobData.task_id);
    const lockToken = randomUUID().replaceAll("-", "");
    const claim = await this.repository.claimExecution({
      taskId,
      lockToken,
      lockDurationMs: this.lockDurationMs
    });

    if (claim === undefined) {
      // 终态任务或仍被其他 Worker 持有的任务视为幂等跳过，不再次调用模型或修改计费。
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
      return "processed";
    } catch (error: unknown) {
      if (!abortController.signal.aborted) {
        abortController.abort(error);
      }

      // 非业务终态异常交回 queued，由 BullMQ 的 attempts/backoff 决定下一次消费。
      await this.repository.releaseExecution({ taskId, lockToken }).catch(() => false);
      void processing.catch(() => undefined);
      throw toPublicProcessingError(error);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
    }
  }
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

  // BullMQ 失败原因只保留稳定中文信息，不能把 Provider、Redis 或数据库原始异常写进队列。
  return new Error("图片任务执行异常，等待队列重试。");
}
