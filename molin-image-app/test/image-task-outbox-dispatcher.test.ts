import assert from "node:assert/strict";
import test from "node:test";

import type {
  ImageTaskOutboxRecord,
  ImageTaskOutboxRepository
} from "../src/infrastructure/database/image-task-outbox-repository.js";
import {
  ImageTaskOutboxDispatcher,
  type ImageTaskDispatchLifecycle,
  type ImageTaskOutboxDispatcherLogger
} from "../src/infrastructure/queue/image-task-outbox-dispatcher.js";
import type { ImageTaskQueue } from "../src/infrastructure/queue/image-task-queue.js";

const now = new Date("2026-07-16T08:00:00.000Z");

void test("Dispatcher 成功投递后推进 queued 并标记 Outbox", async () => {
  const repository = new InMemoryOutboxRepository([createOutboxRecord()]);
  const queue = new FakeImageTaskQueue();
  const lifecycle = new FakeDispatchLifecycle();
  const dispatcher = createDispatcher(repository, queue, lifecycle);

  await dispatcher.dispatchOnce(now);

  assert.deepEqual(queue.taskIds, ["task_outbox_001"]);
  assert.deepEqual(lifecycle.queuedTaskIds, ["task_outbox_001"]);
  assert.equal(repository.records[0]?.status, "dispatched");
});

void test("Redis 断开时 Outbox 保持失败状态，恢复后可重新入队", async () => {
  const repository = new InMemoryOutboxRepository([createOutboxRecord()]);
  const queue = new FakeImageTaskQueue();
  const lifecycle = new FakeDispatchLifecycle();
  const dispatcher = createDispatcher(repository, queue, lifecycle);
  queue.fail = true;

  await dispatcher.dispatchOnce(now);

  assert.equal(repository.records[0]?.status, "failed");
  assert.equal(repository.records[0]?.last_error_code, "IMAGE_TASK_QUEUE_UNAVAILABLE");
  assert.equal(lifecycle.queuedTaskIds.length, 0);

  queue.fail = false;
  await dispatcher.dispatchOnce(new Date(now.getTime() + 1_000));

  assert.equal(repository.records[0]?.status, "dispatched");
  assert.deepEqual(queue.taskIds, ["task_outbox_001"]);
});

void test("超过最大等待时间会取消任务并触发积分释放生命周期", async () => {
  const repository = new InMemoryOutboxRepository([
    createOutboxRecord({ created_at: "2026-07-16T07:50:00.000Z" })
  ]);
  const queue = new FakeImageTaskQueue();
  const lifecycle = new FakeDispatchLifecycle();
  const logger = new RecordingDispatcherLogger();
  const dispatcher = createDispatcher(repository, queue, lifecycle, logger);

  await dispatcher.dispatchOnce(now);

  assert.deepEqual(lifecycle.cancelledTaskIds, ["task_outbox_001"]);
  assert.equal(repository.records[0]?.status, "cancelled");
  assert.equal(queue.taskIds.length, 0);
  assert.match(logger.messages.join(" "), /长时间未入队/);
});

void test("超时取消失败会进入独立重试，不会误投正常队列", async () => {
  const repository = new InMemoryOutboxRepository([
    createOutboxRecord({ created_at: "2026-07-16T07:50:00.000Z" })
  ]);
  const queue = new FakeImageTaskQueue();
  const lifecycle = new FakeDispatchLifecycle();
  lifecycle.cancelError = new Error("billing unavailable");
  const dispatcher = createDispatcher(repository, queue, lifecycle);

  await dispatcher.dispatchOnce(now);

  assert.equal(repository.records[0]?.status, "failed");
  assert.equal(repository.records[0]?.last_error_code, "OUTBOX_CANCELLATION_RETRY");
  assert.equal(queue.taskIds.length, 0);
});

function createDispatcher(
  repository: InMemoryOutboxRepository,
  queue: FakeImageTaskQueue,
  lifecycle: FakeDispatchLifecycle,
  logger: ImageTaskOutboxDispatcherLogger = new RecordingDispatcherLogger()
): ImageTaskOutboxDispatcher {
  return new ImageTaskOutboxDispatcher(
    repository,
    queue,
    lifecycle,
    { batchSize: 20, pollIntervalMs: 1000, maxWaitMs: 300_000, maxBackoffMs: 60_000 },
    logger
  );
}

class InMemoryOutboxRepository implements ImageTaskOutboxRepository {
  constructor(readonly records: ImageTaskOutboxRecord[]) {}

  claimReady(limit: number, claimTime: Date): Promise<ImageTaskOutboxRecord[]> {
    const ready = this.records
      .filter(
        (record) =>
          (record.status === "pending" || record.status === "failed") &&
          record.last_error_code !== "OUTBOX_CANCELLATION_RETRY" &&
          Date.parse(record.next_attempt_at) <= claimTime.getTime()
      )
      .slice(0, limit);

    for (const record of ready) {
      record.status = "dispatching";
      record.attempt_count += 1;
    }

    return Promise.resolve(ready.map((record) => ({ ...record })));
  }

  markDispatched(outboxId: string, dispatchedAt: Date): Promise<boolean> {
    const record = this.records.find((item) => item.id === outboxId);

    if (record?.status !== "dispatching") {
      return Promise.resolve(false);
    }

    record.status = "dispatched";
    record.dispatched_at = dispatchedAt.toISOString();
    return Promise.resolve(true);
  }

  markRetry(input: {
    outboxId: string;
    nextAttemptAt: Date;
    errorCode: string;
    errorMessage: string;
  }): Promise<boolean> {
    const record = this.records.find((item) => item.id === input.outboxId);

    if (record?.status !== "dispatching") {
      return Promise.resolve(false);
    }

    record.status = "failed";
    record.next_attempt_at = input.nextAttemptAt.toISOString();
    record.last_error_code = input.errorCode;
    record.last_error_message = input.errorMessage;
    return Promise.resolve(true);
  }

  markCancellationRetry(input: { outboxId: string; nextAttemptAt: Date }): Promise<boolean> {
    const record = this.records.find((item) => item.id === input.outboxId);

    if (record?.status !== "cancelled") {
      return Promise.resolve(false);
    }

    record.status = "failed";
    record.next_attempt_at = input.nextAttemptAt.toISOString();
    record.last_error_code = "OUTBOX_CANCELLATION_RETRY";
    record.last_error_message = "超时任务取消失败，等待重试。";
    return Promise.resolve(true);
  }

  claimTimedOut(limit: number, maxWaitMs: number): Promise<ImageTaskOutboxRecord[]> {
    const cutoff = new Date(now.getTime() - maxWaitMs);
    const timedOut = this.records
      .filter(
        (record) =>
          (record.status === "pending" ||
            (record.status === "failed" &&
              record.last_error_code === "OUTBOX_CANCELLATION_RETRY")) &&
          Date.parse(record.created_at) <= cutoff.getTime()
      )
      .slice(0, limit);

    for (const record of timedOut) {
      record.status = "cancelled";
      record.last_error_code = "OUTBOX_DISPATCH_TIMEOUT";
      record.last_error_message = "任务等待入队超时，已取消。";
    }

    return Promise.resolve(timedOut.map((record) => ({ ...record })));
  }
}

class FakeImageTaskQueue implements ImageTaskQueue {
  readonly taskIds: string[] = [];
  fail = false;

  enqueue(taskId: string): Promise<void> {
    if (this.fail) {
      return Promise.reject(new Error("queue unavailable"));
    }

    this.taskIds.push(taskId);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeDispatchLifecycle implements ImageTaskDispatchLifecycle {
  readonly queuedTaskIds: string[] = [];
  readonly cancelledTaskIds: string[] = [];
  cancelError: Error | undefined;

  markTaskQueued(taskId: string): Promise<void> {
    this.queuedTaskIds.push(taskId);
    return Promise.resolve();
  }

  cancelTaskForDispatchTimeout(taskId: string): Promise<void> {
    this.cancelledTaskIds.push(taskId);

    if (this.cancelError !== undefined) {
      return Promise.reject(this.cancelError);
    }

    return Promise.resolve();
  }
}

class RecordingDispatcherLogger implements ImageTaskOutboxDispatcherLogger {
  readonly messages: string[] = [];

  info(message: string): void {
    this.messages.push(message);
  }

  warn(message: string): void {
    this.messages.push(message);
  }

  error(message: string): void {
    this.messages.push(message);
  }
}

function createOutboxRecord(overrides: Partial<ImageTaskOutboxRecord> = {}): ImageTaskOutboxRecord {
  return {
    id: "outbox_001",
    task_id: "task_outbox_001",
    status: "pending",
    attempt_count: 0,
    next_attempt_at: "2026-07-16T08:00:00.000Z",
    last_error_code: null,
    last_error_message: null,
    created_at: "2026-07-16T08:00:00.000Z",
    updated_at: "2026-07-16T08:00:00.000Z",
    dispatched_at: null,
    ...overrides
  };
}
