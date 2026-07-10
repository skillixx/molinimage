import assert from "node:assert/strict";
import test from "node:test";

import type {
  BillingEventRecord,
  BillingEventsRepository,
  CreateReservedBillingEventInput
} from "../src/infrastructure/database/billing-events-repository.js";
import {
  BillingService,
  BillingServiceError,
  MockEntitlementReserveGateway
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
  }
]);

void test("计费估算会按任务参数变化重新计算预计积分", () => {
  const service = createBillingService("100");

  const oneImage = service.estimate({
    ownerUserId: 479,
    taskType: "text_to_image",
    imageCount: 1
  });
  const threeImages = service.estimate({
    ownerUserId: 479,
    taskType: "text_to_image",
    imageCount: 3
  });

  assert.equal(oneImage.estimated_points, "6");
  assert.equal(threeImages.estimated_points, "18");
  assert.equal(threeImages.enough_balance, true);
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

  findById(eventId: string): Promise<BillingEventRecord | undefined> {
    return Promise.resolve(this.events.find((event) => event.id === eventId));
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<BillingEventRecord | undefined> {
    return Promise.resolve(this.events.find((event) => event.idempotency_key === idempotencyKey));
  }
}
