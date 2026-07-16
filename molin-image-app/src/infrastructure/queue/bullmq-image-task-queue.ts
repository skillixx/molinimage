import { createHash, randomUUID } from "node:crypto";

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
  id?: string;
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
  toKey?(type: string): string;
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

const failedJobFingerprintLimit = 1_000;

export interface FailedJobAuditSnapshot {
  count: number;
  fingerprint: string;
  overflow: boolean;
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

  async removeFailed(taskId: string): Promise<void> {
    if (taskId.trim().length === 0) {
      throw new ImageTaskQueueError();
    }

    try {
      if (this.connection !== undefined && this.queue.toKey !== undefined) {
        const result = await this.connection.eval(
          `if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then
             if redis.call('EXISTS', KEYS[2]) == 0 then return 2 end
             return 0
           end
           if redis.call('EXISTS', KEYS[2] .. ':lock') == 1 then return -1 end
           if redis.call('HEXISTS', KEYS[2], 'parentKey') == 1 then return -2 end
           redis.call('ZREM', KEYS[1], ARGV[1])
           redis.call('DEL', KEYS[2], KEYS[2] .. ':logs', KEYS[2] .. ':dependencies',
             KEYS[2] .. ':processed', KEYS[2] .. ':failed', KEYS[2] .. ':unsuccessful')
           return 1`,
          2,
          this.queue.toKey("failed"),
          this.queue.toKey(taskId),
          taskId
        );
        if (result === 1 || result === 2) {
          // 1 表示原子移除成功，2 表示重复请求时 Job 已不存在，两者都满足幂等语义。
          return;
        }
        throw new Error("仅允许原子移除无锁、无父任务且仍处于 failed 集合的 Job。");
      }

      if (this.queue.getJobState === undefined || this.queue.remove === undefined) {
        throw new Error("队列客户端不支持 failed Job 清理。");
      }

      const state = await this.queue.getJobState(taskId);
      if (state === "unknown") {
        // 管理端重复提交时，旧 Job 可能已由首次请求移除；该结果按幂等成功处理。
        return;
      }
      if (state !== "failed") {
        throw new Error("仅允许移除已完成业务审核的 failed Job。");
      }

      const removed = await this.queue.remove(taskId);
      if (removed !== 1 && (await this.queue.getJobState(taskId)) !== "unknown") {
        throw new Error("failed Job 未能安全移除。");
      }
    } catch (error: unknown) {
      throw new ImageTaskQueueError({ cause: error });
    }
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

  async getFailedJobAuditSnapshot(): Promise<FailedJobAuditSnapshot> {
    if (this.queue.getJobCounts === undefined || this.queue.getJobs === undefined) {
      throw new ImageTaskQueueError();
    }

    try {
      if (this.connection !== undefined && this.queue.toKey !== undefined) {
        // ZCARD 与 ZRANGE 必须在同一段 Lua 中执行，避免审核摘要遗漏并发新增或替换的 failed Job。
        const result = await this.connection.eval(
          `local count = redis.call('ZCARD', KEYS[1])
           local limit = tonumber(ARGV[1])
           if count > limit then
             return { tostring(count) }
           end
           local ids = redis.call('ZRANGE', KEYS[1], 0, -1)
           table.insert(ids, 1, tostring(count))
           return ids`,
          1,
          this.queue.toKey("failed"),
          failedJobFingerprintLimit
        );
        return createAtomicFailedJobAuditSnapshot(result);
      }

      const counts = await this.queue.getJobCounts("failed");
      const failedCount = counts.failed;
      if (failedCount > failedJobFingerprintLimit) {
        // 先查数量再决定是否加载 Job，超限时内部门禁直接阻断，避免读取大量完整 Job。
        return { count: failedCount, fingerprint: "overflow", overflow: true };
      }

      const failedJobs =
        failedCount === 0 ? [] : await this.queue.getJobs(["failed"], 0, failedCount - 1, true);
      const confirmedCount = (await this.queue.getJobCounts("failed")).failed;
      if (confirmedCount !== failedCount) {
        // 注入式测试客户端没有 Redis Lua 能力时采用二次计数，集合变化必须阻断而不能生成不完整摘要。
        return { count: confirmedCount, fingerprint: "overflow", overflow: true };
      }
      return {
        count: failedCount,
        fingerprint: createFailedJobFingerprint(failedJobs, failedCount),
        overflow: false
      };
    } catch (error: unknown) {
      throw new ImageTaskQueueError({ cause: error });
    }
  }
}

function createAtomicFailedJobAuditSnapshot(result: unknown): FailedJobAuditSnapshot {
  if (!Array.isArray(result) || result.length === 0) {
    throw new ImageTaskQueueError();
  }

  const values = result.map((value) =>
    Buffer.isBuffer(value) ? value.toString("utf8") : String(value)
  );
  const failedCount = Number(values[0]);
  if (!Number.isSafeInteger(failedCount) || failedCount < 0) {
    throw new ImageTaskQueueError();
  }

  if (failedCount > failedJobFingerprintLimit) {
    return { count: failedCount, fingerprint: "overflow", overflow: true };
  }

  const ids = values.slice(1);
  if (ids.length !== failedCount || ids.some((id) => id.length === 0)) {
    throw new ImageTaskQueueError();
  }

  return {
    count: failedCount,
    fingerprint: createFailedJobFingerprint(
      ids.map((id) => ({ id, timestamp: 0 })),
      failedCount
    ),
    overflow: false
  };
}

function createFailedJobFingerprint(jobs: BullMqJobSummary[], failedCount: number): string {
  if (failedCount === 0) {
    return "none";
  }

  const ids = jobs
    .map((job) => job.id)
    .filter((id): id is string => id !== undefined)
    .sort();
  if (ids.length !== failedCount) {
    throw new ImageTaskQueueError();
  }

  // 内部部署门禁只返回稳定摘要，运维可确认失败 Job 集合而无需传输任务 ID。
  return createHash("sha256").update(JSON.stringify(ids)).digest("hex");
}
