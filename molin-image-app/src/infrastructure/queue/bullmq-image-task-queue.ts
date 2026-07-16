import { randomUUID } from "node:crypto";

import { Queue, type JobsOptions, type JobType } from "bullmq";
import type { Redis } from "ioredis";

import {
  IMAGE_TASK_JOB_NAME,
  ImageTaskQueueError,
  type ImageTaskJobData,
  type ImageTaskQueue
} from "./image-task-queue.js";
import type {
  QueueHealthMonitor,
  QueueMonitoringSnapshot
} from "../../modules/health/health.service.js";

export interface BullMqJobSummary {
  timestamp: number;
}

export interface BullMqQueueClient {
  add(
    name: typeof IMAGE_TASK_JOB_NAME,
    data: ImageTaskJobData,
    options: JobsOptions
  ): Promise<unknown>;
  getJobState?(jobId: string): Promise<string>;
  remove?(jobId: string): Promise<number>;
  getJobCounts?(...types: JobType[]): Promise<Record<string, number>>;
  getJobs?(
    types?: JobType[] | JobType,
    start?: number,
    end?: number,
    asc?: boolean
  ): Promise<BullMqJobSummary[]>;
  close(): Promise<void>;
}

export interface BullMqWriteProbeJob {
  remove(): Promise<void>;
}

export interface BullMqWriteProbeClient {
  add(
    name: typeof IMAGE_TASK_JOB_NAME,
    data: ImageTaskJobData,
    options: JobsOptions
  ): Promise<BullMqWriteProbeJob>;
  close(): Promise<void>;
}

export class BullMqImageTaskQueue implements ImageTaskQueue, QueueHealthMonitor {
  private readonly queue: BullMqQueueClient;
  private readonly writeProbeQueue: BullMqWriteProbeClient | undefined;

  constructor(
    queueName: string,
    connection: Redis | undefined,
    private readonly attempts: number,
    queue?: BullMqQueueClient,
    writeProbeQueue?: BullMqWriteProbeClient
  ) {
    this.connection = connection;
    this.writeProbeQueue = writeProbeQueue;

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
    this.writeProbeQueue = new Queue<ImageTaskJobData, void, typeof IMAGE_TASK_JOB_NAME>(
      `${queueName}-health-probe`,
      { connection }
    );
  }

  private readonly connection: Redis | undefined;

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
    await Promise.all([this.queue.close(), this.writeProbeQueue?.close()]);
  }

  async checkWrite(): Promise<void> {
    if (this.connection === undefined || this.writeProbeQueue === undefined) {
      throw new ImageTaskQueueError();
    }

    try {
      const probeId = `health_probe_${randomUUID().replaceAll("-", "")}`;
      // 探针使用独立 BullMQ 队列执行真实 add 命令，业务 Worker 不监听该队列，因此不会消费虚假任务。
      const probeJob = await this.writeProbeQueue.add(
        IMAGE_TASK_JOB_NAME,
        { task_id: probeId },
        { jobId: probeId, removeOnComplete: true, removeOnFail: true }
      );
      await probeJob.remove();
    } catch (error: unknown) {
      throw new ImageTaskQueueError({ cause: error });
    }
  }

  async getMonitoringSnapshot(): Promise<QueueMonitoringSnapshot> {
    if (this.queue.getJobCounts === undefined || this.queue.getJobs === undefined) {
      throw new ImageTaskQueueError();
    }

    try {
      const [counts, oldestWaitingJobs] = await Promise.all([
        this.queue.getJobCounts("wait", "active", "delayed", "failed"),
        this.queue.getJobs(["wait"], 0, 0, true)
      ]);
      const oldestTimestamp =
        oldestWaitingJobs.length === 0 ? undefined : oldestWaitingJobs[0].timestamp;

      return {
        waiting: counts.wait,
        active: counts.active,
        delayed: counts.delayed,
        failed: counts.failed,
        oldest_wait_ms:
          oldestTimestamp === undefined ? 0 : Math.max(0, Date.now() - oldestTimestamp)
      };
    } catch (error: unknown) {
      throw new ImageTaskQueueError({ cause: error });
    }
  }

  async getSnapshot(): Promise<QueueMonitoringSnapshot> {
    return await this.getMonitoringSnapshot();
  }
}
