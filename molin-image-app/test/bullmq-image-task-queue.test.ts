import assert from "node:assert/strict";
import test from "node:test";
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

void test("队列监控读取等待、处理中、延迟、失败和最老等待时间", async () => {
  const client = new RecordingBullMqQueueClient();
  client.jobCounts = { wait: 2, active: 1, delayed: 3, failed: 4 };
  client.waitingJobs = [{ timestamp: Date.now() - 5_000 }];
  const queue = new BullMqImageTaskQueue("molinimage-image-tasks", undefined, 3, client);

  const snapshot = await queue.getMonitoringSnapshot();

  assert.equal(snapshot.waiting, 2);
  assert.equal(snapshot.active, 1);
  assert.equal(snapshot.delayed, 3);
  assert.equal(snapshot.failed, 4);
  assert.equal(snapshot.oldest_wait_ms >= 4_000, true);
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
    return Promise.resolve(this.jobCounts);
  }

  getJobs(): Promise<{ timestamp: number }[]> {
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
