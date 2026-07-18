import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

interface TaskResult {
  task: { status: string };
}

interface PollerOptions {
  loadTask: (taskId: string) => Promise<TaskResult>;
  onTask: (result: TaskResult) => Promise<void> | void;
  onTransientError?: (error: unknown) => Promise<void> | void;
  onTerminalError?: (error: unknown) => Promise<void> | void;
  isTransientError?: (error: unknown) => boolean;
  initialDelayMs?: number;
  maxDelayMs?: number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}

interface Poller {
  start(taskId: string): void;
  stop(): void;
  getActiveTaskId(): string | null;
}

const pollerModulePath = pathToFileURL(resolve("public/assets/image-task-poller.js")).href;
const {
  createImageTaskPoller,
  isActiveImageTaskStatus,
  isTerminalImageTaskStatus,
  resolveImageTaskProgressStage
} = (await import(pollerModulePath)) as {
  createImageTaskPoller: (options: PollerOptions) => Poller;
  isActiveImageTaskStatus: (status: string) => boolean;
  isTerminalImageTaskStatus: (status: string) => boolean;
  resolveImageTaskProgressStage: (status: string) => string;
};

void test("图片任务状态会映射到真实的前端进度阶段", () => {
  assert.equal(resolveImageTaskProgressStage("billing_reserved"), "reserving");
  assert.equal(resolveImageTaskProgressStage("queued"), "generating");
  assert.equal(resolveImageTaskProgressStage("running"), "generating");
  assert.equal(resolveImageTaskProgressStage("billing_pending"), "saving");
  assert.equal(resolveImageTaskProgressStage("succeeded"), "completed");
  assert.equal(resolveImageTaskProgressStage("failed"), "failed");
  assert.equal(isTerminalImageTaskStatus("billing_pending"), false);
  assert.equal(isTerminalImageTaskStatus("cancelled"), true);
  for (const status of ["pending", "billing_reserved", "queued", "running", "billing_pending"]) {
    assert.equal(isActiveImageTaskStatus(status), true, `${status} 应保持工作台任务活动状态`);
  }
  for (const status of ["succeeded", "failed", "cancelled"]) {
    assert.equal(isActiveImageTaskStatus(status), false, `${status} 应解除工作台任务锁定`);
  }
});

void test("轮询器按退避间隔查询并在任务成功后停止", async () => {
  const delays: number[] = [];
  const statuses = ["queued", "running", "succeeded"];
  const updates: string[] = [];
  const scheduled: (() => void)[] = [];
  const poller = createImageTaskPoller({
    loadTask: () => Promise.resolve({ task: { status: statuses.shift() ?? "succeeded" } }),
    onTask: (result) => {
      updates.push(result.task.status);
    },
    initialDelayMs: 10,
    maxDelayMs: 40,
    schedule(callback, delay) {
      delays.push(delay);
      scheduled.push(callback);
      return scheduled.length;
    },
    cancel(timer) {
      void timer;
    }
  });

  poller.start("task_async_001");
  await flushPromises();
  scheduled.shift()?.();
  await flushPromises();
  scheduled.shift()?.();
  await flushPromises();

  assert.deepEqual(updates, ["queued", "running", "succeeded"]);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(poller.getActiveTaskId(), null);
});

void test("轮询器遇到短暂网络错误后继续查询", async () => {
  let attempts = 0;
  let transientErrors = 0;
  const scheduled: (() => void)[] = [];
  const poller = createImageTaskPoller({
    loadTask: () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("network unavailable"))
        : Promise.resolve({ task: { status: "succeeded" } });
    },
    onTask: () => undefined,
    onTransientError: () => {
      transientErrors += 1;
    },
    schedule(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancel(timer) {
      void timer;
    }
  });

  poller.start("task_async_002");
  await flushPromises();
  scheduled.shift()?.();
  await flushPromises();

  assert.equal(attempts, 2);
  assert.equal(transientErrors, 1);
  assert.equal(poller.getActiveTaskId(), null);
});

void test("轮询器遇到永久 HTTP 错误后停止并通知工作台", async () => {
  let transientErrors = 0;
  let terminalErrors = 0;
  const scheduled: (() => void)[] = [];
  const notFoundError = Object.assign(new Error("任务不存在"), { status: 404 });
  const poller = createImageTaskPoller({
    loadTask: () => Promise.reject(notFoundError),
    onTask: () => undefined,
    onTransientError: () => {
      transientErrors += 1;
    },
    onTerminalError: () => {
      terminalErrors += 1;
    },
    schedule(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancel(timer) {
      void timer;
    }
  });

  poller.start("task_missing_001");
  await flushPromises();

  assert.equal(transientErrors, 0);
  assert.equal(terminalErrors, 1);
  assert.equal(scheduled.length, 0);
  assert.equal(poller.getActiveTaskId(), null);
});

void test("切换到新任务后忽略旧任务的延迟响应", async () => {
  let resolveOldTask!: (result: TaskResult) => void;
  let resolveNewTask!: (result: TaskResult) => void;
  const updates: string[] = [];
  const poller = createImageTaskPoller({
    loadTask: (taskId) =>
      new Promise<TaskResult>((resolveTask) => {
        if (taskId === "task_old_001") {
          resolveOldTask = resolveTask;
          return;
        }
        resolveNewTask = resolveTask;
      }),
    onTask: (result) => {
      updates.push(result.task.status);
    }
  });

  poller.start("task_old_001");
  poller.start("task_new_001");

  // 新草稿启动后，即使旧请求更晚返回，也不能再覆盖当前任务的界面状态。
  resolveOldTask({ task: { status: "failed" } });
  await flushPromises();
  assert.deepEqual(updates, []);
  assert.equal(poller.getActiveTaskId(), "task_new_001");

  resolveNewTask({ task: { status: "succeeded" } });
  await flushPromises();
  assert.deepEqual(updates, ["succeeded"]);
  assert.equal(poller.getActiveTaskId(), null);
});

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}
