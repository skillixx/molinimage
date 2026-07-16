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
          backoff: { type: "exponential", delay: 1000 },
          // 保留终态 Job 才能让同一 task_id 的迟到重复投递继续被 BullMQ 吸收。
          removeOnComplete: false,
          removeOnFail: false
        }
      );
    } catch (error: unknown) {
      throw new ImageTaskQueueError({ cause: error });
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
