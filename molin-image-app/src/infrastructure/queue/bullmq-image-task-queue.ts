import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";

import {
  IMAGE_TASK_JOB_NAME,
  ImageTaskQueueError,
  type ImageTaskJobData,
  type ImageTaskQueue
} from "./image-task-queue.js";

export interface BullMqQueueClient {
  add(
    name: typeof IMAGE_TASK_JOB_NAME,
    data: ImageTaskJobData,
    options: JobsOptions
  ): Promise<unknown>;
  getJobState?(jobId: string): Promise<string>;
  remove?(jobId: string): Promise<number>;
  close(): Promise<void>;
}

export class BullMqImageTaskQueue implements ImageTaskQueue {
  private readonly queue: BullMqQueueClient;

  constructor(
    queueName: string,
    connection: Redis | undefined,
    private readonly attempts: number,
    queue?: BullMqQueueClient
  ) {
    if (queue !== undefined) {
      this.queue = queue;
      return;
    }

    if (connection === undefined) {
      throw new ImageTaskQueueError();
    }

    this.queue = new Queue<ImageTaskJobData, void, typeof IMAGE_TASK_JOB_NAME>(queueName, {
      connection
    });
  }

  async enqueue(taskId: string): Promise<void> {
    if (taskId.trim().length === 0) {
      throw new ImageTaskQueueError();
    }

    try {
      await this.queue.add(
        IMAGE_TASK_JOB_NAME,
        // 队列载荷只能包含 task_id；Worker 必须回 MySQL 读取完整任务和用户归属。
        { task_id: taskId },
        {
          jobId: taskId,
          attempts: this.attempts,
          // 指数退避叠加 25% 抖动，避免网关恢复瞬间所有失败任务同时重放。
          backoff: { type: "exponential", delay: 1000, jitter: 0.25 },
          // 保留终态 Job 才能让同一 task_id 的迟到重复投递继续被 BullMQ 吸收。
          removeOnComplete: false,
          removeOnFail: false
        }
      );
    } catch (error: unknown) {
      throw new ImageTaskQueueError({ cause: error });
    }
  }

  async requeue(taskId: string): Promise<void> {
    if (taskId.trim().length === 0) {
      throw new ImageTaskQueueError();
    }

    try {
      const state = await this.queue.getJobState?.(taskId);

      if (state === "failed" || state === "completed") {
        // 恢复投递需要替换历史终态 Job；普通 enqueue 仍保留终态 Job 作为去重和排障依据。
        const removed = await this.queue.remove?.(taskId);

        if (removed !== 1) {
          throw new Error("终态图片任务 Job 未能安全移除。");
        }
      }
    } catch (error: unknown) {
      throw new ImageTaskQueueError({ cause: error });
    }

    await this.enqueue(taskId);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
