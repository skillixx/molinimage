import type { PricingRuleAuditLogger } from "../../modules/billing/pricing-rule-service.js";

export class ConsolePricingRuleAuditLogger implements PricingRuleAuditLogger {
  record(event: Parameters<PricingRuleAuditLogger["record"]>[0]): void {
    // 结构化日志交由部署平台持久化和检索；严禁加入 Authorization 或 INTERNAL_API_TOKEN。
    console.info(
      JSON.stringify({
        log_type: "security_audit",
        occurred_at: new Date().toISOString(),
        ...event
      })
    );
  }
}
