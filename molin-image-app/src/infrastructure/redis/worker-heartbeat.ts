export interface WorkerHeartbeatRedisClient {
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  srem(key: string, ...members: string[]): Promise<unknown>;
  eval(script: string, keyCount: number, key: string, expectedValue: string): Promise<unknown>;
}

export interface RedisWorkerHeartbeatOptions {
  workerId: string;
  ttlSeconds: number;
  intervalMs: number;
}

export interface WorkerHeartbeatLogger {
  error(message: string): void;
}

export class RedisWorkerHeartbeat {
  private timer: NodeJS.Timeout | undefined;
  private readonly workerKey: string;
  private readonly registryKey: string;

  constructor(
    private readonly redis: WorkerHeartbeatRedisClient,
    private readonly baseKey: string,
    private readonly options: RedisWorkerHeartbeatOptions,
    private readonly logger: WorkerHeartbeatLogger = console
  ) {
    if (options.intervalMs >= options.ttlSeconds * 1000) {
      throw new Error("Worker 心跳间隔必须小于 TTL");
    }

    this.workerKey = `${baseKey}:${options.workerId}`;
    this.registryKey = `${baseKey}:registry`;
  }

  async start(): Promise<void> {
    if (this.timer !== undefined) {
      return;
    }

    // 启动时先写一次，首次写入失败必须阻止 Worker 宣称已经就绪。
    await this.publish();
    this.timer = setInterval(() => {
      void this.publish().catch(() => {
        // 心跳失败只输出固定文本；实例 Key 会自然过期，使 API 能发现 Worker 离线。
        this.logger.error("图片任务 Worker 心跳写入失败");
      });
    }, this.options.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    // 每个实例使用独立 TTL Key，退出时只删除自身记录，不会误删其他在线 Worker。
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      this.workerKey,
      this.options.workerId
    );
    await this.redis.srem(this.registryKey, this.options.workerId);
  }

  private async publish(): Promise<void> {
    await this.redis.set(this.workerKey, this.options.workerId, "EX", this.options.ttlSeconds);
    await this.redis.sadd(this.registryKey, this.options.workerId);
  }
}

export class RedisWorkerHeartbeatReader {
  private readonly registryKey: string;

  constructor(
    private readonly redis: Pick<WorkerHeartbeatRedisClient, "smembers" | "mget" | "srem">,
    private readonly baseKey: string
  ) {
    this.registryKey = `${baseKey}:registry`;
  }

  async isAlive(): Promise<boolean> {
    const workerIds = await this.redis.smembers(this.registryKey);

    if (workerIds.length === 0) {
      return false;
    }

    const values = await this.redis.mget(
      ...workerIds.map((workerId) => `${this.baseKey}:${workerId}`)
    );
    const staleWorkerIds = workerIds.filter((_workerId, index) => values[index] === null);

    if (staleWorkerIds.length > 0) {
      // 读取时顺便清理 TTL 已过期的注册项，避免离线实例长期堆积。
      await this.redis.srem(this.registryKey, ...staleWorkerIds).catch(() => {
        // 清理属于旁路维护；已有在线实例时，清理失败不能把 readiness 误判为 Worker 离线。
      });
    }

    return values.some((value) => value !== null);
  }
}
