import { Worker } from "bullmq";
import { Redis } from "ioredis";

import {
  IMAGE_TASK_JOB_NAME,
  type ImageTaskJobData
} from "../../src/infrastructure/queue/image-task-queue.js";

const queueName = process.env.G09_QUEUE_NAME;
const redisUrl = process.env.G09_REDIS_URL;

if (queueName === undefined || redisUrl === undefined) {
  process.exit(2);
}

const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const worker = new Worker<ImageTaskJobData, void, typeof IMAGE_TASK_JOB_NAME>(
  queueName,
  async (job) => {
    // 子进程只领取最小队列载荷，模拟在业务处理前突然崩溃的 Worker 实例。
    process.send?.({ type: "active", task_id: job.data.task_id });
    await new Promise<void>(() => undefined);
  },
  {
    connection,
    concurrency: 1,
    lockDuration: 1_000,
    stalledInterval: 250
  }
);

worker.on("error", () => {
  // 故障夹具不输出 Redis 连接详情，父测试只通过 IPC 接收稳定状态。
});

process.on("SIGTERM", () => {
  process.exit(0);
});
