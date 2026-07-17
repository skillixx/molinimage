const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);

export function isTerminalImageTaskStatus(status) {
  return terminalStatuses.has(status);
}

export function isActiveImageTaskStatus(status) {
  // 只对白名单终态解除锁定；后端未来新增中间态时继续轮询，避免提前创建任务和重复计费。
  return !isTerminalImageTaskStatus(status);
}

export function resolveImageTaskProgressStage(status) {
  if (status === "pending" || status === "billing_reserved") return "reserving";
  if (status === "queued" || status === "running") return "generating";
  if (status === "billing_pending") return "saving";
  if (status === "succeeded") return "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  return "idle";
}

export function createImageTaskPoller({
  loadTask,
  onTask,
  onTransientError = () => {},
  onTerminalError = () => {},
  isTransientError = defaultIsTransientPollingError,
  initialDelayMs = 800,
  maxDelayMs = 8000,
  schedule = globalThis.setTimeout,
  cancel = globalThis.clearTimeout
}) {
  let activeTaskId = null;
  let timer = null;
  let stopped = true;
  let nextDelayMs = initialDelayMs;

  const stop = () => {
    stopped = true;
    activeTaskId = null;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  };

  const scheduleNext = () => {
    if (stopped || activeTaskId === null) return;
    timer = schedule(() => {
      timer = null;
      void poll();
    }, nextDelayMs);
    nextDelayMs = Math.min(maxDelayMs, Math.max(initialDelayMs, nextDelayMs * 2));
  };

  const poll = async () => {
    const taskId = activeTaskId;
    if (stopped || taskId === null) return;

    try {
      const result = await loadTask(taskId);
      // 切换轮询任务后丢弃旧请求结果，避免旧任务覆盖当前结果区。
      if (stopped || activeTaskId !== taskId) return;
      await onTask(result);
      if (!isActiveImageTaskStatus(result.task.status)) {
        stop();
        return;
      }
    } catch (error) {
      if (!isTransientError(error)) {
        await onTerminalError(error);
        stop();
        return;
      }

      // 查询失败通常是短暂网络波动；保留任务 ID 并按退避间隔继续恢复。
      if (!stopped && activeTaskId === taskId) await onTransientError(error);
    }

    scheduleNext();
  };

  return {
    start(taskId) {
      stop();
      activeTaskId = taskId;
      stopped = false;
      nextDelayMs = initialDelayMs;
      void poll();
    },
    stop,
    getActiveTaskId() {
      return activeTaskId;
    }
  };
}

function defaultIsTransientPollingError(error) {
  const status = Number(error?.status);
  return !Number.isFinite(status) || status === 408 || status === 429 || status >= 500;
}
