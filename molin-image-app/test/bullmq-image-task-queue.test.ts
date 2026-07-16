import assert from "node:assert/strict";
import test from "node:test";
import type { JobType } from "bullmq";
import type { Redis } from "ioredis";

import {
  BullMqImageTaskQueue,
  type BullMqQueueClient,
  type BullMqWriteProbeClient
} from "../src/infrastructure/queue/bullmq-image-task-queue.js";
import {
  IMAGE_TASK_JOB_NAME,
  ImageTaskQueueError,
  type ImageTaskJobData
} from "../src/infrastructure/queue/image-task-queue.js";

void test("BullMQ 图片任务使用固定名称、task_id JobId 和最小载荷", async () => {
  const client = new RecordingBullMqQueueClient();
  const queue = new BullMqImageTaskQueue("molinimage-image-tasks", undefined, 3, client);

  await queue.enqueue("task_queue_001");

  assert.equal(client.jobs.length, 1);
  assert.equal(client.jobs[0]?.name, IMAGE_TASK_JOB_NAME);
  assert.deepEqual(client.jobs[0]?.data, { task_id: "task_queue_001" });
  assert.deepEqual(Object.keys(client.jobs[0]?.data ?? {}), ["task_id"]);
  assert.equal(client.jobs[0]?.options.jobId, "task_queue_001");
  assert.equal(client.jobs[0]?.options.attempts, 3);
  assert.deepEqual(client.jobs[0]?.options.backoff, {
    type: "exponential",
    delay: 1000,
    jitter: 0.25
  });
  assert.equal(client.jobs[0]?.options.removeOnComplete, false);
  assert.equal(client.jobs[0]?.options.removeOnFail, false);
});

void test("BullMQ 底层错误统一映射且不暴露连接信息", async () => {
  const client = new RecordingBullMqQueueClient();
  client.addError = new Error("sensitive redis connection detail");
  const queue = new BullMqImageTaskQueue("molinimage-image-tasks", undefined, 3, client);

  await assert.rejects(
    queue.enqueue("task_queue_002"),
    (error: unknown) => error instanceof ImageTaskQueueError && !error.message.includes("sensitive")
  );
});

void test("恢复投递会替换同 task_id 的历史失败 Job", async () => {
  const client = new RecordingBullMqQueueClient();
  client.jobState = "failed";
  const queue = new BullMqImageTaskQueue("molinimage-image-tasks", undefined, 3, client);

  await queue.requeue("task_queue_recovery");

  assert.deepEqual(client.removedJobIds, ["task_queue_recovery"]);
  assert.equal(client.jobs.length, 1);
  assert.equal(client.jobs[0]?.options.jobId, "task_queue_recovery");
});

void test("管理端审核后只移除对应 failed Job 且重复调用幂等", async () => {
  const client = new RecordingBullMqQueueClient();
  client.jobState = "failed";
  const queue = new BullMqImageTaskQueue("molinimage-image-tasks", undefined, 3, client);

  await queue.removeFailed("task_reviewed_failed");
  await queue.removeFailed("task_reviewed_failed");

  assert.deepEqual(client.removedJobIds, ["task_reviewed_failed"]);
});

void test("管理端不能移除非 failed 状态 Job", async () => {
  const client = new RecordingBullMqQueueClient();
  client.jobState = "waiting";
  const queue = new BullMqImageTaskQueue("molinimage-image-tasks", undefined, 3, client);

  await assert.rejects(() => queue.removeFailed("task_waiting"), ImageTaskQueueError);
  assert.deepEqual(client.removedJobIds, []);
});

void test("真实 Redis 路径原子校验并移除单个 failed Job", async () => {
  const client = new RecordingBullMqQueueClient();
  client.toKey = (type) => `bull:molinimage-image-tasks:${type}`;
  const evalCalls: unknown[][] = [];
  const connection = {
    eval: (...args: unknown[]) => {
      evalCalls.push(args);
      return Promise.resolve(1);
    }
  } as unknown as Redis;
  const queue = new BullMqImageTaskQueue("molinimage-image-tasks", connection, 3, client);

  await queue.removeFailed("task_atomic_failed");

  assert.equal(evalCalls.length, 1);
  assert.equal(evalCalls[0]?.[2], "bull:molinimage-image-tasks:failed");
  assert.equal(evalCalls[0]?.[3], "bull:molinimage-image-tasks:task_atomic_failed");
  assert.deepEqual(client.removedJobIds, []);
});

void test("队列监控读取等待、处理中、延迟、失败和最老等待时间", async () => {
  const client = new RecordingBullMqQueueClient();
  client.jobCounts = { wait: 2, active: 1, delayed: 3, failed: 4 };
  client.waitingJobs = [{ timestamp: Date.now() - 5_000 }];
  client.failedJobs = ["task-a", "task-b", "task-c", "task-d"].map((id) => ({
    id,
    timestamp: Date.now() - 10_000
  }));
  const queue = new BullMqImageTaskQueue("molinimage-image-tasks", undefined, 3, client);

  const snapshot = await queue.getMonitoringSnapshot();

  assert.equal(snapshot.waiting, 2);
  assert.equal(snapshot.active, 1);
  assert.equal(snapshot.delayed, 3);
  assert.equal(snapshot.failed, 4);
  assert.equal(snapshot.oldest_wait_ms >= 4_000, true);

  const auditSnapshot = await queue.getFailedJobAuditSnapshot();
  assert.equal(auditSnapshot.fingerprint.length, 64);
  client.failedJobs[0] = { id: "task-replaced", timestamp: Date.now() - 10_000 };
  const changedSnapshot = await queue.getFailedJobAuditSnapshot();
  assert.notEqual(changedSnapshot.fingerprint, auditSnapshot.fingerprint);
});

void test("队列就绪检查使用独立 Redis 写探针且不创建虚假 Job", async () => {
  const client = new RecordingBullMqQueueClient();
  const probe = new RecordingWriteProbeQueue();
  const queue = new BullMqImageTaskQueue("molinimage-image-tasks", {} as Redis, 3, client, probe);

  await queue.checkWrite();

  assert.equal(probe.jobs.length, 1);
  assert.deepEqual(Object.keys(probe.jobs[0]?.data ?? {}), ["task_id"]);
  assert.equal(probe.jobs[0]?.removed, true);
  assert.equal(client.jobs.length, 0);
});

void test("失败 Job 超过摘要上限时返回 overflow 而不读取无限历史", async () => {
  const client = new RecordingBullMqQueueClient();
  client.jobCounts = { wait: 0, active: 0, delayed: 0, failed: 1_001 };
  const queue = new BullMqImageTaskQueue("molinimage-image-tasks", undefined, 3, client);

  const snapshot = await queue.getFailedJobAuditSnapshot();

  assert.equal(snapshot.fingerprint, "overflow");
  assert.equal(snapshot.overflow, true);
  assert.equal(client.failedJobsReadCount, 0);
});

void test("失败 Job 在兼容读取期间变化时阻断摘要生成", async () => {
  const client = new RecordingBullMqQueueClient();
  client.jobCounts = { wait: 0, active: 0, delayed: 0, failed: 1 };
  client.failedJobs = [{ id: "task-a", timestamp: Date.now() }];
  client.failedCountSequence = [1, 2];
  const queue = new BullMqImageTaskQueue("molinimage-image-tasks", undefined, 3, client);

  const snapshot = await queue.getFailedJobAuditSnapshot();

  assert.equal(snapshot.count, 2);
  assert.equal(snapshot.fingerprint, "overflow");
  assert.equal(snapshot.overflow, true);
});

void test("真实 Redis 路径通过 Lua 原子读取 failed Job ID 集合", async () => {
  const client = new RecordingBullMqQueueClient();
  client.toKey = () => "bull:molinimage-image-tasks:failed";
  const evalCalls: unknown[][] = [];
  const connection = {
    eval: (...args: unknown[]) => {
      evalCalls.push(args);
      return Promise.resolve(["2", "task-b", "task-a"]);
    }
  } as unknown as Redis;
  const queue = new BullMqImageTaskQueue("molinimage-image-tasks", connection, 3, client);

  const snapshot = await queue.getFailedJobAuditSnapshot();

  assert.equal(snapshot.count, 2);
  assert.equal(snapshot.fingerprint.length, 64);
  assert.equal(snapshot.overflow, false);
  assert.equal(evalCalls[0]?.[2], "bull:molinimage-image-tasks:failed");
  assert.equal(client.failedJobsReadCount, 0);
});

class RecordingBullMqQueueClient implements BullMqQueueClient {
  readonly jobs: {
    name: typeof IMAGE_TASK_JOB_NAME;
    data: ImageTaskJobData;
    options: Parameters<BullMqQueueClient["add"]>[2];
  }[] = [];
  addError: Error | undefined;
  jobState = "unknown";
  readonly removedJobIds: string[] = [];
  jobCounts = { wait: 0, active: 0, delayed: 0, failed: 0 };
  waitingJobs: { timestamp: number }[] = [];
  failedJobs: { id: string; timestamp: number }[] = [];
  failedJobsReadCount = 0;
  failedCountSequence: number[] = [];
  toKey: ((type: string) => string) | undefined;

  add(
    name: typeof IMAGE_TASK_JOB_NAME,
    data: ImageTaskJobData,
    options: Parameters<BullMqQueueClient["add"]>[2]
  ): Promise<unknown> {
    if (this.addError !== undefined) {
      return Promise.reject(this.addError);
    }

    this.jobs.push({ name, data, options });
    return Promise.resolve({ id: options.jobId });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  getJobState(): Promise<string> {
    return Promise.resolve(this.jobState);
  }

  remove(jobId: string): Promise<number> {
    this.removedJobIds.push(jobId);
    this.jobState = "unknown";
    return Promise.resolve(1);
  }

  getJobCounts(): Promise<Record<string, number>> {
    const failed = this.failedCountSequence.shift();
    if (failed !== undefined) {
      return Promise.resolve({ ...this.jobCounts, failed });
    }
    return Promise.resolve(this.jobCounts);
  }

  getJobs(types?: JobType[] | JobType): Promise<{ id?: string; timestamp: number }[]> {
    const normalizedTypes = Array.isArray(types) ? types : [types];
    if (normalizedTypes.includes("failed")) {
      this.failedJobsReadCount += 1;
      return Promise.resolve(this.failedJobs);
    }

    return Promise.resolve(this.waitingJobs);
  }
}

class RecordingWriteProbeQueue implements BullMqWriteProbeClient {
  readonly jobs: { data: ImageTaskJobData; removed: boolean }[] = [];

  add(
    _name: typeof IMAGE_TASK_JOB_NAME,
    data: ImageTaskJobData
  ): Promise<{ remove: () => Promise<void> }> {
    const record = { data, removed: false };
    this.jobs.push(record);
    return Promise.resolve({
      remove: () => {
        record.removed = true;
        return Promise.resolve();
      }
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
