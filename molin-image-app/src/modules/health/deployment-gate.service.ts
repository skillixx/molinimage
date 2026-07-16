import type {
  BillingDeploymentGateSnapshot,
  MySqlBillingEventsRepository
} from "../../infrastructure/database/billing-events-repository.js";
import type {
  BullMqImageTaskQueue,
  FailedJobAuditSnapshot
} from "../../infrastructure/queue/bullmq-image-task-queue.js";

export interface DeploymentGateSnapshot {
  failed_jobs: FailedJobAuditSnapshot;
  billing: BillingDeploymentGateSnapshot;
}

export class DeploymentGateService {
  constructor(
    private readonly queue: Pick<BullMqImageTaskQueue, "getFailedJobAuditSnapshot"> | undefined,
    private readonly billingRepository: Pick<
      MySqlBillingEventsRepository,
      "getDeploymentGateSnapshot"
    >
  ) {}

  async getSnapshot(): Promise<DeploymentGateSnapshot> {
    if (this.queue === undefined) {
      throw new Error("部署门禁要求启用 BullMQ 队列。");
    }

    // 两项检查都在远端 API 进程内执行，天然绑定该实例实际使用的 Redis 与 MySQL。
    const [failedJobs, billing] = await Promise.all([
      this.queue.getFailedJobAuditSnapshot(),
      this.billingRepository.getDeploymentGateSnapshot()
    ]);
    return { failed_jobs: failedJobs, billing };
  }
}
