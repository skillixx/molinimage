import assert from "node:assert/strict";
import test from "node:test";

import {
  BullMqImageTaskQueue,
  type BullMqQueueClient
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

class RecordingBullMqQueueClient implements BullMqQueueClient {
  readonly jobs: {
    name: typeof IMAGE_TASK_JOB_NAME;
    data: ImageTaskJobData;
    options: Parameters<BullMqQueueClient["add"]>[2];
  }[] = [];
  addError: Error | undefined;
  jobState = "unknown";
  readonly removedJobIds: string[] = [];

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
}
