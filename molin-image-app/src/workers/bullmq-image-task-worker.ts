import { UnrecoverableError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";

import {
  IMAGE_TASK_JOB_NAME,
  type ImageTaskJobData
} from "../infrastructure/queue/image-task-queue.js";
import {
  ImageTaskJobFinalFailureError,
  type ImageTaskJobProcessor
} from "./image-task-job-processor.js";

export interface BullMqImageTaskWorkerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export class BullMqImageTaskWorker {
  private readonly worker: Worker<ImageTaskJobData, void, typeof IMAGE_TASK_JOB_NAME>;

  constructor(
    queueName: string,
    connection: Redis,
    concurrency: number,
    lockDurationMs: number,
    processor: Pick<ImageTaskJobProcessor, "process">,
    private readonly logger: BullMqImageTaskWorkerLogger = console
  ) {
    this.worker = new Worker<ImageTaskJobData, void, typeof IMAGE_TASK_JOB_NAME>(
      queueName,
      async (job) => {
        await this.processJob(job, processor);
      },
      {
        connection,
        concurrency,
        lockDuration: lockDurationMs
      }
    );

    this.worker.on("completed", (job) => {
      this.logger.info(`图片任务 ${job.data.task_id} 消费完成`);
    });
    this.worker.on("failed", (job) => {
      this.logger.warn(`图片任务 ${job?.data.task_id ?? "unknown"} 消费失败，等待队列策略处理`);
    });
    this.worker.on("error", () => {
      // BullMQ 原始异常可能携带连接信息，运行日志只输出固定文本。
      this.logger.error("图片任务 Worker 队列连接异常");
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.worker.waitUntilReady();
  }

  async close(): Promise<void> {
    // close(false) 会停止领取新 Job，并等待当前并发任务安全结束后关闭连接。
    await this.worker.close(false);
  }

  private async processJob(
    job: Job<ImageTaskJobData, void, typeof IMAGE_TASK_JOB_NAME>,
    processor: Pick<ImageTaskJobProcessor, "process">
  ): Promise<void> {
    if (Object.keys(job.data).some((key) => key !== "task_id")) {
      throw new Error("图片任务队列消息契约不合法。");
    }

    try {
      await processor.process(
        { task_id: job.data.task_id },
        {
          attemptNumber: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts ?? 1
        }
      );
    } catch (error: unknown) {
      if (error instanceof ImageTaskJobFinalFailureError && error.discardRemainingAttempts) {
        // 稳定业务错误不再消耗后续队列尝试，但 Job 仍保留在 failed 集合供管理端排查。
        throw new UnrecoverableError(error.message);
      }

      throw error;
    }
  }
}
