export interface HealthResponse {
  status: "ok";
  service: "molin-image-app";
}

export type HealthDependencyStatus = "ok" | "error" | "disabled";

export interface HealthDependencyProbe {
  check(): Promise<void>;
}

export interface QueueMonitoringSnapshot {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  oldest_wait_ms: number;
}

export interface OutboxMonitoringSnapshot {
  backlog: number;
  dead_letter: number;
  oldest_wait_ms: number;
}

export interface QueueHealthMonitor {
  checkWrite(): Promise<void>;
  getSnapshot(): Promise<QueueMonitoringSnapshot>;
}

export interface WorkerHealthMonitor {
  isAlive(): Promise<boolean>;
}

export interface OutboxHealthMonitor {
  getSnapshot(): Promise<OutboxMonitoringSnapshot>;
}

export interface HealthAlert {
  code:
    | "IMAGE_WORKER_OFFLINE"
    | "IMAGE_QUEUE_BACKLOG"
    | "IMAGE_OUTBOX_BACKLOG"
    | "IMAGE_OUTBOX_DEAD_LETTER";
  severity: "warning" | "critical";
  message: string;
}

export interface ReadinessResponse {
  status: "ok" | "degraded" | "error";
  service: "molin-image-app";
  runtime: {
    session_store: "redis" | "memory";
    image_task_execution_mode: "queue" | "inline";
  };
  dependencies: {
    mysql: HealthDependencyStatus;
    redis: HealthDependencyStatus;
    minio: HealthDependencyStatus;
    queue: HealthDependencyStatus;
  };
  worker: { status: "ok" | "offline" | "disabled" };
  queue: QueueMonitoringSnapshot;
  outbox: OutboxMonitoringSnapshot;
  alerts: HealthAlert[];
}

export interface HealthServiceDependencies {
  mysql: HealthDependencyProbe;
  redis: HealthDependencyProbe;
  minio: HealthDependencyProbe;
  queue?: QueueHealthMonitor;
  worker?: WorkerHealthMonitor;
  outbox?: OutboxHealthMonitor;
}

export interface HealthServiceOptions {
  sessionStore: "redis" | "memory";
  queueEnabled: boolean;
  queueBacklogAlertThreshold: number;
  queueOldestWaitAlertMs: number;
  outboxBacklogAlertThreshold: number;
  probeTimeoutMs?: number;
  readinessCacheTtlMs?: number;
}

const emptyQueueSnapshot: QueueMonitoringSnapshot = {
  waiting: 0,
  active: 0,
  delayed: 0,
  failed: 0,
  oldest_wait_ms: 0
};

const emptyOutboxSnapshot: OutboxMonitoringSnapshot = {
  backlog: 0,
  dead_letter: 0,
  oldest_wait_ms: 0
};

export class HealthService {
  private cachedReadiness: { value: ReadinessResponse; expiresAt: number } | undefined;
  private readinessInFlight: Promise<ReadinessResponse> | undefined;
  private readonly dependencyProbesInFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dependencies: HealthServiceDependencies,
    private readonly options: HealthServiceOptions
  ) {}

  getLiveness(): HealthResponse {
    // 存活检查只证明 Node.js 事件循环仍能响应，不能访问 Redis、MySQL 或对象存储。
    return createHealthResponse();
  }

  async getReadiness(): Promise<ReadinessResponse> {
    const now = Date.now();

    if (this.cachedReadiness !== undefined && this.cachedReadiness.expiresAt > now) {
      return this.cachedReadiness.value;
    }

    if (this.readinessInFlight !== undefined) {
      return await this.readinessInFlight;
    }

    const request = this.getFreshReadiness();
    this.readinessInFlight = request;

    try {
      const value = await request;
      this.cachedReadiness = {
        value,
        expiresAt: Date.now() + (this.options.readinessCacheTtlMs ?? 1_000)
      };
      return value;
    } finally {
      if (this.readinessInFlight === request) {
        this.readinessInFlight = undefined;
      }
    }
  }

  private async getFreshReadiness(): Promise<ReadinessResponse> {
    const timeoutMs = this.options.probeTimeoutMs ?? 5_000;
    const [mysql, redis, minio, queueResult, workerResult, outboxResult] = await Promise.allSettled(
      [
        this.runProbe("mysql", () => this.dependencies.mysql.check(), timeoutMs),
        this.runProbe("redis", () => this.dependencies.redis.check(), timeoutMs),
        this.runProbe("minio", () => this.dependencies.minio.check(), timeoutMs),
        this.runProbe("queue", () => this.checkQueue(), timeoutMs),
        this.runProbe("worker", () => this.checkWorker(), timeoutMs),
        this.runProbe("outbox", () => this.readOutbox(), timeoutMs)
      ]
    );
    const dependencies = {
      mysql: toDependencyStatus(mysql),
      redis: toDependencyStatus(redis),
      minio: toDependencyStatus(minio),
      queue: this.options.queueEnabled ? toDependencyStatus(queueResult) : "disabled"
    } satisfies ReadinessResponse["dependencies"];
    const queue = readSettledValue(queueResult, emptyQueueSnapshot);
    const outbox = readSettledValue(outboxResult, emptyOutboxSnapshot);
    const workerAlive = readSettledValue(workerResult, false);
    const worker = {
      status: this.options.queueEnabled ? (workerAlive ? "ok" : "offline") : "disabled"
    } satisfies ReadinessResponse["worker"];
    const alerts = this.createAlerts(queue, outbox, worker.status);
    const dependencyFailed =
      Object.values(dependencies).includes("error") || outboxResult.status === "rejected";
    const criticalAlert = alerts.some((alert) => alert.severity === "critical");

    // 响应只保留稳定状态和计数；第三方错误、连接串与堆栈均停留在探针内部。
    return {
      status: dependencyFailed || criticalAlert ? "error" : alerts.length > 0 ? "degraded" : "ok",
      service: "molin-image-app",
      // 部署探针只暴露非敏感运行模式，用于确认远端实例没有误用本地降级配置。
      runtime: {
        session_store: this.options.sessionStore,
        image_task_execution_mode: this.options.queueEnabled ? "queue" : "inline"
      },
      dependencies,
      worker,
      queue,
      outbox,
      alerts
    };
  }

  private async runProbe<T>(
    name: string,
    operation: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    const existing = this.dependencyProbesInFlight.get(name) as Promise<T> | undefined;
    if (existing !== undefined) {
      // 底层调用超时后可能仍未结束；后续检查复用同一调用，防止持续占用连接池。
      return await withTimeout(existing, timeoutMs);
    }

    const probe = Promise.resolve().then(operation);
    this.dependencyProbesInFlight.set(name, probe);
    const clearProbe = (): void => {
      if (this.dependencyProbesInFlight.get(name) === probe) {
        this.dependencyProbesInFlight.delete(name);
      }
    };
    // 成功和失败都清理栅栏，同时消费失败分支，避免产生未处理的拒绝 Promise。
    void probe.then(clearProbe, clearProbe);

    return await withTimeout(probe, timeoutMs);
  }

  private async checkQueue(): Promise<QueueMonitoringSnapshot> {
    if (!this.options.queueEnabled || this.dependencies.queue === undefined) {
      return emptyQueueSnapshot;
    }

    // 写探针和指标读取都成功才认为 BullMQ 就绪，避免只 PING Redis 的假健康。
    await this.dependencies.queue.checkWrite();
    return await this.dependencies.queue.getSnapshot();
  }

  private async checkWorker(): Promise<boolean> {
    if (!this.options.queueEnabled) {
      return true;
    }

    return (await this.dependencies.worker?.isAlive()) ?? false;
  }

  private async readOutbox(): Promise<OutboxMonitoringSnapshot> {
    if (!this.options.queueEnabled) {
      return emptyOutboxSnapshot;
    }

    if (this.dependencies.outbox === undefined) {
      throw new Error("Outbox 监控未配置");
    }

    return await this.dependencies.outbox.getSnapshot();
  }

  private createAlerts(
    queue: QueueMonitoringSnapshot,
    outbox: OutboxMonitoringSnapshot,
    workerStatus: ReadinessResponse["worker"]["status"]
  ): HealthAlert[] {
    const alerts: HealthAlert[] = [];

    if (workerStatus === "offline") {
      alerts.push({
        code: "IMAGE_WORKER_OFFLINE",
        severity: "critical",
        message: "图片任务 Worker 全部离线。"
      });
    }

    if (
      queue.waiting >= this.options.queueBacklogAlertThreshold &&
      queue.oldest_wait_ms >= this.options.queueOldestWaitAlertMs
    ) {
      // 数量和等待时长同时越线才告警，避免瞬时批量任务触发无意义噪声。
      alerts.push({
        code: "IMAGE_QUEUE_BACKLOG",
        severity: "warning",
        message: "图片任务队列持续积压。"
      });
    }

    if (outbox.backlog >= this.options.outboxBacklogAlertThreshold) {
      alerts.push({
        code: "IMAGE_OUTBOX_BACKLOG",
        severity: "warning",
        message: "图片任务 Outbox 持续积压。"
      });
    }

    if (outbox.dead_letter > 0) {
      alerts.push({
        code: "IMAGE_OUTBOX_DEAD_LETTER",
        severity: "warning",
        message: "图片任务 Outbox 存在死信。"
      });
    }

    return alerts;
  }
}

export function createHealthResponse(): HealthResponse {
  return {
    status: "ok",
    service: "molin-image-app"
  };
}

function toDependencyStatus(
  result: PromiseSettledResult<unknown>
): Exclude<HealthDependencyStatus, "disabled"> {
  return result.status === "fulfilled" ? "ok" : "error";
}

function readSettledValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === "fulfilled" ? result.value : fallback;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("健康探针执行超时"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
