import { randomUUID } from "node:crypto";

import type {
  ClaimStuckTaskFinalizationInput,
  ImageTaskExecutionClaim,
  ImageTaskRecord
} from "../infrastructure/database/image-tasks-repository.js";
import type { ImageTaskService } from "../modules/image-tasks/image-task-service.js";

export interface ImageTaskRecoveryScannerRepository {
  findRecoverableStuckTasks(input: {
    staleAfterMs: number;
    limit: number;
  }): Promise<ImageTaskRecord[]>;
  recoverStuckExecution(input: { taskId: string; staleAfterMs: number }): Promise<boolean>;
  claimStuckTaskFinalization(
    input: ClaimStuckTaskFinalizationInput
  ): Promise<ImageTaskExecutionClaim | undefined>;
}

export interface ImageTaskRecoveryQueue {
  requeue(taskId: string): Promise<void>;
}

export interface ImageTaskRecoveryScannerOptions {
  scanIntervalMs: number;
  staleAfterMs: number;
  batchSize: number;
  maxAttempts: number;
  finalizationLockDurationMs?: number;
}

export interface ImageTaskRecoveryScanResult {
  scanned: number;
  requeued: number;
  finalized: number;
  skipped: number;
}

export interface ImageTaskRecoveryScannerLogger {
  error(message: string): void;
}

export class ImageTaskRecoveryScanner {
  private timer: NodeJS.Timeout | undefined;
  private currentScan: Promise<ImageTaskRecoveryScanResult> | undefined;

  constructor(
    private readonly repository: ImageTaskRecoveryScannerRepository,
    private readonly queue: ImageTaskRecoveryQueue,
    private readonly imageTaskService: Pick<ImageTaskService, "finalizeClaimedFailure">,
    private readonly options: ImageTaskRecoveryScannerOptions,
    private readonly logger: ImageTaskRecoveryScannerLogger = console
  ) {}

  start(): void {
    if (this.timer !== undefined) {
      return;
    }

    void this.runExclusive();
    this.timer = setInterval(() => void this.runExclusive(), this.options.scanIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    await this.currentScan;
  }

  async scanOnce(): Promise<ImageTaskRecoveryScanResult> {
    const tasks = await this.repository.findRecoverableStuckTasks({
      staleAfterMs: this.options.staleAfterMs,
      limit: this.options.batchSize
    });
    const result: ImageTaskRecoveryScanResult = {
      scanned: tasks.length,
      requeued: 0,
      finalized: 0,
      skipped: 0
    };

    for (const task of tasks) {
      if ((task.worker_attempt_count ?? 0) >= this.options.maxAttempts) {
        const finalized = await this.claimAndFinalizeExhaustedTask(task);
        result[finalized ? "finalized" : "skipped"] += 1;
        continue;
      }

      const recovered = await this.repository.recoverStuckExecution({
        taskId: task.id,
        staleAfterMs: this.options.staleAfterMs
      });

      if (!recovered) {
        // 另一个 Worker 或扫描器已推进状态时按幂等跳过，不能重复改写任务。
        result.skipped += 1;
        continue;
      }

      await this.queue.requeue(task.id);
      result.requeued += 1;
    }

    return result;
  }

  private runExclusive(): Promise<ImageTaskRecoveryScanResult> {
    this.currentScan ??= this.scanOnce()
      .catch(() => {
        // 扫描故障不退出 Worker，但必须输出脱敏告警，下一轮定时器会继续尝试恢复。
        this.logger.error("图片任务恢复扫描失败，将在下一轮自动重试。");
        return { scanned: 0, requeued: 0, finalized: 0, skipped: 0 };
      })
      .finally(() => {
        this.currentScan = undefined;
      });

    return this.currentScan;
  }

  private async claimAndFinalizeExhaustedTask(task: ImageTaskRecord): Promise<boolean> {
    const lockToken = `recovery_${randomUUID().replaceAll("-", "")}`;
    const lockDurationMs =
      this.options.finalizationLockDurationMs ?? Math.max(this.options.scanIntervalMs * 2, 30_000);
    const claim = await this.repository.claimStuckTaskFinalization({
      taskId: task.id,
      lockToken,
      lockDurationMs,
      staleAfterMs: this.options.staleAfterMs,
      maxAttempts: this.options.maxAttempts
    });

    if (claim === undefined) {
      return false;
    }

    try {
      // 业务服务会先原子落最终失败，再释放积分，外部调用期间不存在可被 Worker 接管的执行态。
      await this.imageTaskService.finalizeClaimedFailure({
        ownerUserId: claim.task.owner_user_id,
        taskId: claim.task.id,
        errorCode: "IMAGE_TASK_RETRY_EXHAUSTED",
        errorMessage: "图片任务多次执行失败，系统已停止自动重试并释放预占积分。",
        workerLockToken: claim.lock_token
      });
      return true;
    } catch {
      // 状态已被并发推进时不覆盖新结果；仍处于异常状态的任务会在下一轮继续扫描。
      return false;
    }
  }
}
