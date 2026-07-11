import assert from "node:assert/strict";
import test from "node:test";

import type {
  BillingEventRecord,
  BillingEventsRepository,
  ClaimSettleBillingEventInput,
  CompleteSettleBillingEventInput,
  CreateReservedBillingEventInput
} from "../src/infrastructure/database/billing-events-repository.js";
import type { PricingRuleRecord } from "../src/infrastructure/database/pricing-rules-repository.js";
import {
  BillingService,
  BillingServiceError,
  MockEntitlementReserveGateway
} from "../src/modules/billing/billing-service.js";
import type {
  EntitlementSettleInput,
  EntitlementSettleResult
} from "../src/modules/billing/billing-service.js";

const rulesJson = JSON.stringify([
  {
    task_type: "text_to_image",
    usage_type: "image_text_to_image",
    unit: "credits",
    points_per_unit: "6",
    active: true
  },
  {
    task_type: "image_to_text",
    usage_type: "image_to_text",
    unit: "credits",
    points_per_unit: "1",
    active: true
  },
  {
    task_type: "upscale",
    usage_type: "image_upscale",
    unit: "credits",
    points_per_unit: "4",
    upscale_factor: 2,
    active: true
  },
  {
    task_type: "upscale",
    usage_type: "image_upscale",
    unit: "credits",
    points_per_unit: "8",
    upscale_factor: 4,
    active: true
  }
]);

void test("计费估算会按任务参数变化重新计算预计积分", async () => {
  const service = createBillingService("100");

  const oneImage = await service.estimate({
    ownerUserId: 479,
    taskType: "text_to_image",
    imageCount: 1
  });
  const threeImages = await service.estimate({
    ownerUserId: 479,
    taskType: "text_to_image",
    imageCount: 3
  });

  assert.equal(oneImage.estimated_points, "6");
  assert.equal(threeImages.estimated_points, "18");
  assert.equal(threeImages.enough_balance, true);
});

void test("高清放大 2x 和 4x 使用不同价格规则", async () => {
  const service = createBillingService("100");

  const twoTimes = await service.estimate({
    ownerUserId: 479,
    taskType: "upscale",
    imageCount: 1,
    upscaleFactor: 2
  });
  const fourTimes = await service.estimate({
    ownerUserId: 479,
    taskType: "upscale",
    imageCount: 1,
    upscaleFactor: 4
  });

  assert.equal(twoTimes.unit_points, "4");
  assert.equal(twoTimes.estimated_points, "4");
  assert.equal(fourTimes.unit_points, "8");
  assert.equal(fourTimes.estimated_points, "8");
});

void test("数据库具体价格规则按能力、质量和尺寸覆盖默认规则", async () => {
  const service = new BillingService(
    rulesJson,
    new InMemoryBillingEventsRepository(),
    new MockEntitlementReserveGateway("100"),
    createPricingRuleProvider([
      createPricingRule("price_default", { points_per_unit: "6" }),
      createPricingRule("price_hd", {
        gateway_capability: "image_generation",
        quality: "hd",
        image_size: "1024x1536",
        points_per_unit: "10"
      })
    ])
  );

  const specific = await service.estimate({
    ownerUserId: 479,
    taskType: "text_to_image",
    gatewayCapability: "image_generation",
    quality: "hd",
    imageSize: "1024x1536"
  });
  const fallback = await service.estimate({
    ownerUserId: 479,
    taskType: "text_to_image",
    gatewayCapability: "image_generation",
    quality: "standard",
    imageSize: "1024x1024"
  });

  assert.equal(specific.unit_points, "10");
  assert.equal(specific.rule_id, "price_hd");
  assert.equal(specific.rule_source, "database");
  assert.equal(fallback.unit_points, "6");
  assert.equal(fallback.rule_id, "price_default");
});

void test("禁用具体规则后回退默认规则，无启用默认规则时禁止估算", async () => {
  const repository = new InMemoryBillingEventsRepository();
  const service = new BillingService(
    rulesJson,
    repository,
    new MockEntitlementReserveGateway("100"),
    createPricingRuleProvider([
      createPricingRule("price_default", { points_per_unit: "6" }),
      createPricingRule("price_hd", {
        quality: "hd",
        points_per_unit: "10",
        active: false
      })
    ])
  );

  assert.equal(
    (await service.estimate({ ownerUserId: 479, taskType: "text_to_image", quality: "hd" }))
      .unit_points,
    "6"
  );

  const disabledService = new BillingService(
    rulesJson,
    repository,
    new MockEntitlementReserveGateway("100"),
    createPricingRuleProvider([
      createPricingRule("price_default", { points_per_unit: "6", active: false })
    ])
  );
  await assert.rejects(
    () => disabledService.estimate({ ownerUserId: 479, taskType: "text_to_image" }),
    (error: unknown) =>
      error instanceof BillingServiceError && error.code === "BILLING_RULE_NOT_FOUND"
  );
});

void test("估价后规则变化会在预占前拒绝，不产生计费事件", async () => {
  const repository = new InMemoryBillingEventsRepository();
  let currentRules = [createPricingRule("price_default", { points_per_unit: "6" })];
  const service = new BillingService(
    rulesJson,
    repository,
    new MockEntitlementReserveGateway("100"),
    { listAll: () => Promise.resolve(currentRules) }
  );
  const estimate = await service.estimate({ ownerUserId: 479, taskType: "text_to_image" });

  currentRules = [createPricingRule("price_default", { points_per_unit: "8" })];
  await assert.rejects(
    () =>
      service.reserve({
        ownerUserId: 479,
        taskId: "task_price_changed",
        taskType: "text_to_image",
        idempotencyKey: "task_price_changed:reserve",
        expectedRuleId: estimate.rule_id,
        expectedPoints: estimate.estimated_points
      }),
    (error: unknown) =>
      error instanceof BillingServiceError && error.code === "BILLING_PRICE_CHANGED"
  );
  assert.equal(repository.events.length, 0);
});

void test("多个计费服务实例通过共享规则源立即读取最新价格", async () => {
  let currentRules = [createPricingRule("price_default", { points_per_unit: "6" })];
  const provider = { listAll: () => Promise.resolve(currentRules) };
  const first = new BillingService(
    rulesJson,
    new InMemoryBillingEventsRepository(),
    new MockEntitlementReserveGateway("100"),
    provider
  );
  const second = new BillingService(
    rulesJson,
    new InMemoryBillingEventsRepository(),
    new MockEntitlementReserveGateway("100"),
    provider
  );

  assert.equal(
    (await first.estimate({ ownerUserId: 479, taskType: "text_to_image" })).unit_points,
    "6"
  );
  currentRules = [createPricingRule("price_default", { points_per_unit: "9" })];
  assert.equal(
    (await second.estimate({ ownerUserId: 479, taskType: "text_to_image" })).unit_points,
    "9"
  );
  assert.equal(
    (await first.estimate({ ownerUserId: 479, taskType: "text_to_image" })).unit_points,
    "9"
  );
});

void test("预占计费事件具备稳定幂等键并落库", async () => {
  const repository = new InMemoryBillingEventsRepository();
  const service = new BillingService(
    rulesJson,
    repository,
    new MockEntitlementReserveGateway("100")
  );

  const reserved = await service.reserve({
    ownerUserId: 479,
    taskId: "task_billing_001",
    taskType: "text_to_image",
    imageCount: 2,
    entitlementId: 62,
    idempotencyKey: "task_billing_001:text_to_image:reserve"
  });

  assert.equal(reserved.estimate.estimated_points, "12");
  assert.equal(reserved.billing_event.amount_points, "12");
  assert.equal(reserved.billing_event.status, "reserved");
  assert.equal(reserved.billing_event.idempotency_key, "task_billing_001:text_to_image:reserve");
  assert.equal(repository.events[0]?.idempotency_key, "task_billing_001:text_to_image:reserve");
});

void test("失败释放会归还预占积分，并用 release 幂等键防重复释放", async () => {
  const repository = new InMemoryBillingEventsRepository();
  const gateway = new MockEntitlementReserveGateway("100");
  const service = new BillingService(
    '[{"task_type":"text_to_image","usage_type":"image_text_to_image","unit":"credits","points_per_unit":"6","active":true}]',
    repository,
    gateway
  );
  const reserved = await service.reserve({
    ownerUserId: 479,
    taskId: "task_billing_release_001",
    taskType: "text_to_image",
    imageCount: 1,
    entitlementId: 62,
    idempotencyKey: "task_billing_release_001:text_to_image:reserve"
  });
  const released = await service.release({
    ownerUserId: 479,
    taskId: "task_billing_release_001",
    reserveBillingEventId: reserved.billing_event.id,
    idempotencyKey: "task_billing_release_001:text_to_image:release",
    reasonCode: "AI_GATEWAY_FAILED",
    reasonMessage: "AI 网关调用失败。"
  });
  const releasedAgain = await service.release({
    ownerUserId: 479,
    taskId: "task_billing_release_001",
    reserveBillingEventId: reserved.billing_event.id,
    idempotencyKey: "task_billing_release_001:text_to_image:release",
    reasonCode: "AI_GATEWAY_FAILED",
    reasonMessage: "AI 网关调用失败。"
  });

  assert.equal(reserved.estimate.balance_points, "94");
  assert.equal(released.released, true);
  assert.equal(released.billing_event.status, "released");
  assert.equal(releasedAgain.billing_event.id, released.billing_event.id);
  assert.equal(gateway.getBalancePoints(), "100");
  assert.equal(repository.events.filter((event) => event.event_type === "release").length, 1);
});

void test("成功结算使用稳定幂等键且不会重复写入 settle 事件", async () => {
  const repository = new InMemoryBillingEventsRepository();
  const gateway = new MockEntitlementReserveGateway("100");
  const service = new BillingService(rulesJson, repository, gateway);
  const reserved = await service.reserve({
    ownerUserId: 479,
    taskId: "task_billing_settle_001",
    taskType: "upscale",
    imageCount: 1,
    upscaleFactor: 4,
    entitlementId: 62,
    idempotencyKey: "task_billing_settle_001:upscale:reserve"
  });
  const request = {
    ownerUserId: 479,
    taskId: "task_billing_settle_001",
    reserveBillingEventId: reserved.billing_event.id,
    idempotencyKey: "task_billing_settle_001:upscale:settle"
  };

  const [settled, settledAgain] = await Promise.all([
    service.settle(request),
    service.settle(request)
  ]);

  assert.equal(settled.settled, true);
  assert.equal(settled.billing_event.amount_points, "8");
  assert.equal(settledAgain.billing_event.id, settled.billing_event.id);
  assert.equal(gateway.getSettleCallCount(), 1);
  assert.equal(repository.events.filter((event) => event.event_type === "settle").length, 1);
});

void test("待对账结算只能由一个重试者重新抢占并完成", async () => {
  const repository = new InMemoryBillingEventsRepository();
  const gateway = new FlakySettleGateway("100");
  const service = new BillingService(rulesJson, repository, gateway);
  const reserved = await service.reserve({
    ownerUserId: 479,
    taskId: "task_billing_reconcile_001",
    taskType: "upscale",
    imageCount: 1,
    upscaleFactor: 2,
    entitlementId: 62,
    idempotencyKey: "task_billing_reconcile_001:upscale:reserve"
  });
  const request = {
    ownerUserId: 479,
    taskId: "task_billing_reconcile_001",
    reserveBillingEventId: reserved.billing_event.id,
    idempotencyKey: "task_billing_reconcile_001:upscale:settle"
  };

  const pending = await service.settle(request);
  gateway.allowSettle();
  const [reconciled, duplicate] = await Promise.all([
    service.settle({ ...request, retryPending: true }),
    service.settle({ ...request, retryPending: true })
  ]);

  assert.equal(pending.settled, false);
  assert.equal(reconciled.settled, true);
  assert.equal(duplicate.billing_event.id, reconciled.billing_event.id);
  assert.equal(repository.events.at(-1)?.status, "settled");
  assert.equal(repository.events.at(-1)?.retry_count, 1);
});

void test("结算版本栅栏拒绝旧 worker 在租约接管后迟到写回", async () => {
  const repository = new InMemoryBillingEventsRepository();
  const claimInput: ClaimSettleBillingEventInput = {
    id: "billing_settle_fence_001",
    owner_user_id: 479,
    task_id: "task_fence_001",
    amount_points: "8",
    idempotency_key: "task_fence_001:upscale:settle",
    moling_reserve_id: "hold_fence_001",
    moling_entitlement_id: 62,
    retry_pending: false
  };
  const firstClaim = await repository.claimSettle(claimInput);
  firstClaim.event.status = "settle_pending";
  const retryClaim = await repository.claimSettle({ ...claimInput, retry_pending: true });

  const staleCompletion = await repository.completeSettle({
    eventId: firstClaim.event.id,
    expectedRetryCount: 0,
    status: "settled",
    errorCode: null,
    errorMessage: null
  });

  assert.equal(staleCompletion.status, "settling");
  assert.equal(staleCompletion.retry_count, 1);

  const currentCompletion = await repository.completeSettle({
    eventId: retryClaim.event.id,
    expectedRetryCount: 1,
    status: "settled",
    errorCode: null,
    errorMessage: null
  });

  assert.equal(currentCompletion.status, "settled");
});

void test("余额不足时预占失败，不能继续创建任务", async () => {
  const service = createBillingService("5");

  await assert.rejects(
    () =>
      service.reserve({
        ownerUserId: 479,
        taskId: "task_billing_002",
        taskType: "text_to_image",
        imageCount: 1,
        entitlementId: 62,
        idempotencyKey: "task_billing_002:text_to_image:reserve"
      }),
    (error: unknown) =>
      error instanceof BillingServiceError && error.code === "BILLING_BALANCE_INSUFFICIENT"
  );
});

function createBillingService(balancePoints: string): BillingService {
  return new BillingService(
    rulesJson,
    new InMemoryBillingEventsRepository(),
    new MockEntitlementReserveGateway(balancePoints)
  );
}

class InMemoryBillingEventsRepository implements BillingEventsRepository {
  readonly events: BillingEventRecord[] = [];

  createReserved(input: CreateReservedBillingEventInput): Promise<BillingEventRecord> {
    const existingEvent = this.events.find(
      (event) => event.idempotency_key === input.idempotency_key
    );

    if (existingEvent !== undefined) {
      return Promise.resolve(existingEvent);
    }

    const now = new Date("2026-07-09T00:00:00.000Z").toISOString();
    const event: BillingEventRecord = {
      ...input,
      event_type: "reserve",
      status: "reserved",
      error_code: null,
      error_message: null,
      retry_count: 0,
      created_at: now,
      updated_at: now
    };

    this.events.push(event);

    return Promise.resolve(event);
  }

  createRelease(input: {
    id: string;
    owner_user_id: number;
    task_id: string;
    amount_points: string;
    status: "released" | "release_pending";
    idempotency_key: string;
    moling_reserve_id: string | null;
    moling_entitlement_id: number | null;
    error_code: string | null;
    error_message: string | null;
  }): Promise<BillingEventRecord> {
    const existing = this.events.find((event) => event.idempotency_key === input.idempotency_key);

    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    const event: BillingEventRecord = {
      ...input,
      event_type: "release",
      retry_count: 0,
      created_at: new Date("2026-07-09T00:01:00.000Z").toISOString(),
      updated_at: new Date("2026-07-09T00:01:00.000Z").toISOString()
    };

    this.events.push(event);

    return Promise.resolve(event);
  }

  claimSettle(
    input: ClaimSettleBillingEventInput
  ): Promise<{ event: BillingEventRecord; claimed: boolean }> {
    const existing = this.events.find((event) => event.idempotency_key === input.idempotency_key);

    if (existing !== undefined) {
      if (input.retry_pending && existing.status === "settle_pending") {
        existing.status = "settling";
        existing.retry_count += 1;

        return Promise.resolve({ event: existing, claimed: true });
      }

      return Promise.resolve({ event: existing, claimed: false });
    }

    const event: BillingEventRecord = {
      id: input.id,
      owner_user_id: input.owner_user_id,
      task_id: input.task_id,
      event_type: "settle",
      amount_points: input.amount_points,
      status: "settling",
      idempotency_key: input.idempotency_key,
      moling_reserve_id: input.moling_reserve_id,
      moling_entitlement_id: input.moling_entitlement_id,
      error_code: null,
      error_message: null,
      retry_count: 0,
      created_at: new Date("2026-07-09T00:01:00.000Z").toISOString(),
      updated_at: new Date("2026-07-09T00:01:00.000Z").toISOString()
    };

    this.events.push(event);

    return Promise.resolve({ event, claimed: true });
  }

  completeSettle(input: CompleteSettleBillingEventInput): Promise<BillingEventRecord> {
    const event = this.events.find((item) => item.id === input.eventId);

    if (event === undefined) {
      return Promise.reject(new Error("结算事件不存在"));
    }

    if (event.status !== "settling" || event.retry_count !== input.expectedRetryCount) {
      // 迟到 worker 持有旧版本时只读取当前事件，不能覆盖新 worker 的结算结果。
      return Promise.resolve(event);
    }

    event.status = input.status;
    event.error_code = input.errorCode;
    event.error_message = input.errorMessage;

    return Promise.resolve(event);
  }

  findById(eventId: string): Promise<BillingEventRecord | undefined> {
    return Promise.resolve(this.events.find((event) => event.id === eventId));
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<BillingEventRecord | undefined> {
    return Promise.resolve(this.events.find((event) => event.idempotency_key === idempotencyKey));
  }
}

class FlakySettleGateway extends MockEntitlementReserveGateway {
  private shouldFail = true;

  allowSettle(): void {
    this.shouldFail = false;
  }

  override settle(input: EntitlementSettleInput): Promise<EntitlementSettleResult> {
    if (this.shouldFail) {
      return Promise.reject(new Error("模拟结算失败"));
    }

    return super.settle(input);
  }
}

function createPricingRule(
  id: string,
  overrides: Partial<PricingRuleRecord> = {}
): PricingRuleRecord {
  return {
    id,
    task_type: "text_to_image",
    gateway_model_code: null,
    gateway_capability: null,
    quality: null,
    image_size: null,
    upscale_factor: null,
    usage_type: "image_text_to_image",
    unit: "credits",
    points_per_unit: "6",
    active: true,
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
    ...overrides
  };
}

function createPricingRuleProvider(rules: PricingRuleRecord[]) {
  return {
    listAll: () => Promise.resolve(rules)
  };
}
