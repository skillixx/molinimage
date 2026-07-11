import assert from "node:assert/strict";
import test from "node:test";

import type {
  PricingRuleRecord,
  PricingRulesRepository,
  SavePricingRuleInput
} from "../src/infrastructure/database/pricing-rules-repository.js";
import { PricingRuleRepositoryConflictError } from "../src/infrastructure/database/pricing-rules-repository.js";
import {
  PricingRuleService,
  PricingRuleServiceError
} from "../src/modules/billing/pricing-rule-service.js";

void test("价格规则管理支持创建、禁用并记录审计", async () => {
  const repository = new InMemoryPricingRulesRepository();
  const auditEvents: {
    event_type: string;
    actor_user_id: number | null;
    current_rule: { active: boolean };
    previous_rule: { points_per_unit: string; active: boolean } | null;
  }[] = [];
  const service = new PricingRuleService(repository, {
    record(event) {
      auditEvents.push(event);
    }
  });
  const created = await service.createRule(
    {
      taskType: "text_to_image",
      gatewayCapability: "image_generation",
      quality: "hd",
      imageSize: "1024x1536",
      usageType: "image_text_to_image",
      pointsPerUnit: "10.500000",
      active: true
    },
    { actorUserId: 696, source: "admin_session", requestId: "request_create" }
  );
  const disabled = await service.updateRule(
    created.rule.id,
    { active: false },
    { actorUserId: 696, source: "admin_session", requestId: "request_update" }
  );

  assert.equal(created.rule.points_per_unit, "10.5");
  assert.equal(created.rule.gateway_capability, "image_generation");
  assert.equal(disabled.rule.active, false);
  assert.deepEqual(
    auditEvents.map((event) => event.event_type),
    ["pricing_rule_created", "pricing_rule_updated"]
  );
  assert.equal(auditEvents[1]?.actor_user_id, 696);
  assert.equal(auditEvents[1]?.previous_rule?.points_per_unit, "10.5");
  assert.equal(auditEvents[1]?.previous_rule?.active, true);
  assert.equal(auditEvents[1]?.current_rule.active, false);
});

void test("数据库重复价格维度映射为公开冲突错误", async () => {
  const repository = new InMemoryPricingRulesRepository();
  repository.rejectNextCreateAsConflict = true;
  const service = new PricingRuleService(repository);

  await assert.rejects(
    () =>
      service.createRule({
        taskType: "text_to_image",
        usageType: "image_text_to_image",
        pointsPerUnit: "6"
      }),
    (error: unknown) =>
      error instanceof PricingRuleServiceError &&
      error.code === "PRICING_RULE_CONFLICT" &&
      error.statusCode === 409
  );
});

class InMemoryPricingRulesRepository implements PricingRulesRepository {
  private readonly rules = new Map<string, PricingRuleRecord>();
  rejectNextCreateAsConflict = false;

  listAll(): Promise<PricingRuleRecord[]> {
    return Promise.resolve([...this.rules.values()]);
  }

  findById(ruleId: string): Promise<PricingRuleRecord | undefined> {
    return Promise.resolve(this.rules.get(ruleId));
  }

  create(input: SavePricingRuleInput): Promise<PricingRuleRecord> {
    if (this.rejectNextCreateAsConflict) {
      this.rejectNextCreateAsConflict = false;
      return Promise.reject(new PricingRuleRepositoryConflictError());
    }

    const rule = toRecord(input);
    this.rules.set(rule.id, rule);
    return Promise.resolve(rule);
  }

  update(input: SavePricingRuleInput): Promise<PricingRuleRecord | undefined> {
    if (!this.rules.has(input.id)) {
      return Promise.resolve(undefined);
    }

    const rule = toRecord(input);
    this.rules.set(rule.id, rule);
    return Promise.resolve(rule);
  }
}

function toRecord(input: SavePricingRuleInput): PricingRuleRecord {
  return {
    ...input,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z"
  };
}
