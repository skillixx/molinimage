import type {
  ImageTaskRecoveryAuditEvent,
  ImageTaskRecoveryAuditLogger
} from "../../modules/image-tasks/image-task-recovery-service.js";

export class ConsoleImageTaskRecoveryAuditLogger implements ImageTaskRecoveryAuditLogger {
  record(event: ImageTaskRecoveryAuditEvent): void {
    // 仅记录任务标识和用户数字 ID，不写入提示词、Token、文件内容或第三方响应。
    console.info(JSON.stringify({ scope: "image_task_recovery", ...event }));
  }
}
