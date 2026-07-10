import type {
  ImageTaskAuditEvent,
  ImageTaskAuditLogger
} from "../../modules/image-tasks/image-task-service.js";

export class ConsoleImageTaskAuditLogger implements ImageTaskAuditLogger {
  record(event: ImageTaskAuditEvent): void {
    // 审计日志只记录业务标识和拒绝原因，不写 token、图片内容或用户隐私字段。
    console.warn(
      JSON.stringify({
        level: "warn",
        category: "security_audit",
        occurred_at: new Date().toISOString(),
        ...event
      })
    );
  }
}
