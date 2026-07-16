import type {
  ImageTaskOutboxRecord,
  ImageTaskOutboxRepository
} from "../database/image-task-outbox-repository.js";
import type { ImageTaskQueue } from "./image-task-queue.js";

export interface ImageTaskDispatchLifecycle {
  markTaskQueued(taskId: string): Promise<void>;
  cancelTaskForDispatchTimeout(taskId: string): Promise<void>;
}

export interface ImageTaskOutboxDispatcherLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ImageTaskOutboxDispatcherConfig {
  batchSize: number;
  pollIntervalMs: number;
  maxWaitMs: number;
  maxBackoffMs: number;
}

export class ImageTaskOutboxDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private runningDispatch: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly repository: ImageTaskOutboxRepository,
    private readonly queue: ImageTaskQueue,
    private readonly lifecycle: ImageTaskDispatchLifecycle,
    private readonly config: ImageTaskOutboxDispatcherConfig,
    private readonly logger: ImageTaskOutboxDispatcherLogger = console
  ) {}

  start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    await this.runningDispatch;
  }

  async dispatchOnce(now = new Date()): Promise<void> {
    await this.cancelTimedOutRecords(now);
    const records = await this.repository.claimReady(this.config.batchSize, now);

    for (const record of records) {
      await this.dispatchRecord(record, now);
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      this.runningDispatch = this.dispatchOnce()
        .catch(() => {
          // 调度循环只输出稳定告警，不拼接数据库或 Redis 原始错误，避免连接信息泄漏。
          this.logger.error("图片任务 Outbox 调度失败，将在下一轮重试");
        })
        .finally(() => {
          this.runningDispatch = undefined;
          this.schedule(this.config.pollIntervalMs);
        });
    }, delayMs);
  }

  private async dispatchRecord(record: ImageTaskOutboxRecord, now: Date): Promise<void> {
    try {
      await this.queue.enqueue(record.task_id);
      // Job 已存在也视为成功；随后幂等推进任务状态，修复提交后崩溃留下的半完成投递。
      await this.lifecycle.markTaskQueued(record.task_id);
      const marked = await this.repository.markDispatched(record.id, now);

      if (!marked) {
        this.logger.warn(`Outbox 状态已被并发修改，任务 ${record.task_id} 将由后续扫描核对`);
      }
    } catch {
      const nextAttemptAt = new Date(now.getTime() + this.calculateBackoff(record.attempt_count));
      await this.repository.markRetry({
        outboxId: record.id,
        nextAttemptAt,
        errorCode: "IMAGE_TASK_QUEUE_UNAVAILABLE",
        errorMessage: "图片任务队列暂不可用，等待重试。"
      });
      this.logger.warn(`图片任务 ${record.task_id} 入队失败，Outbox 已保留等待重试`);
    }
  }

  private async cancelTimedOutRecords(now: Date): Promise<void> {
    const records = await this.repository.claimTimedOut(
      this.config.batchSize,
      this.config.maxWaitMs
    );

    for (const record of records) {
      try {
        // 超时取消沿用任务服务的 release 幂等键，重复扫描不会重复归还预占积分。
        await this.lifecycle.cancelTaskForDispatchTimeout(record.task_id);
        this.logger.warn(`图片任务 ${record.task_id} 长时间未入队，已取消并释放预占积分`);
      } catch {
        await this.repository.markCancellationRetry({
          outboxId: record.id,
          nextAttemptAt: new Date(now.getTime() + this.calculateBackoff(record.attempt_count + 1))
        });
        this.logger.error(`图片任务 ${record.task_id} 超时取消失败，将继续重试`);
      }
    }
  }

  private calculateBackoff(attemptCount: number): number {
    const exponent = Math.max(0, Math.min(attemptCount - 1, 16));
    return Math.min(1000 * 2 ** exponent, this.config.maxBackoffMs);
  }
}
