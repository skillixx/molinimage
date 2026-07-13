import assert from "node:assert/strict";
import test from "node:test";

import type {
  BillingEventSummaryRecord,
  BillingEventWithTaskRecord,
  BillingEventsRepository
} from "../src/infrastructure/database/billing-events-repository.js";
import { BillingRecordService } from "../src/modules/billing/billing-record-service.js";

void test("消耗记录只按当前用户查询并展示任务关联与计费状态", async () => {
  const repository = new InMemoryBillingRecordRepository();
  const service = new BillingRecordService(repository);
  const result = await service.listUserRecords({ ownerUserId: 479, page: 1, pageSize: 20 });

  assert.equal(repository.findRequests[0]?.ownerUserId, 479);
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0]?.event_type_label, "预占");
  assert.equal(result.items[0]?.status_label, "已预占");
  assert.equal(result.items[0]?.task_detail_url, "/?task_id=task_record_001");
  assert.equal(result.items[1]?.billing_stage, "pending");
  assert.equal(result.items[2]?.display_amount_points, "+6");
  assert.deepEqual(result.summary, {
    reserved_points: "12",
    settled_points: "6",
    released_points: "6",
    pending_points: "6",
    net_spent_points: "0",
    record_count: 3
  });
});

class InMemoryBillingRecordRepository implements Pick<
  BillingEventsRepository,
  "findByOwner" | "summarizeByOwner"
> {
  readonly findRequests: { ownerUserId: number; page: number; pageSize: number }[] = [];

  findByOwner(input: {
    ownerUserId: number;
    page: number;
    pageSize: number;
  }): Promise<{ items: BillingEventWithTaskRecord[]; total: number }> {
    this.findRequests.push(input);
    const items = records.filter((record) => record.owner_user_id === input.ownerUserId);

    return Promise.resolve({ items, total: items.length });
  }

  summarizeByOwner(ownerUserId: number): Promise<BillingEventSummaryRecord> {
    assert.equal(ownerUserId, 479);

    return Promise.resolve({
      reserved_points: "12",
      settled_points: "6",
      released_points: "6",
      pending_points: "6",
      record_count: 3
    });
  }
}

const records: BillingEventWithTaskRecord[] = [
  createRecord({
    id: "billing_record_001",
    ownerUserId: 479,
    taskId: "task_record_001",
    eventType: "reserve",
    status: "reserved",
    amountPoints: "6"
  }),
  createRecord({
    id: "billing_record_002",
    ownerUserId: 479,
    taskId: "task_record_002",
    eventType: "settle",
    status: "settle_pending",
    amountPoints: "6"
  }),
  createRecord({
    id: "billing_record_003",
    ownerUserId: 479,
    taskId: "task_record_003",
    eventType: "release",
    status: "released",
    amountPoints: "6"
  }),
  createRecord({
    id: "billing_record_other",
    ownerUserId: 696,
    taskId: "task_record_other",
    eventType: "reserve",
    status: "reserved",
    amountPoints: "6"
  })
];

function createRecord(input: {
  id: string;
  ownerUserId: number;
  taskId: string;
  eventType: string;
  status: string;
  amountPoints: string;
}): BillingEventWithTaskRecord {
  return {
    id: input.id,
    owner_user_id: input.ownerUserId,
    task_id: input.taskId,
    event_type: input.eventType,
    amount_points: input.amountPoints,
    status: input.status,
    idempotency_key: `${input.id}:idem`,
    moling_reserve_id: "hold_001",
    moling_entitlement_id: 62,
    error_code: input.status.endsWith("_pending") ? "BILLING_SETTLE_PENDING" : null,
    error_message: input.status.endsWith("_pending") ? "等待对账。" : null,
    retry_count: 0,
    task_type: "text_to_image",
    task_status: input.status === "settle_pending" ? "billing_pending" : "succeeded",
    task_error_code: input.status.endsWith("_pending") ? "BILLING_SETTLE_PENDING" : null,
    task_created_at: "2026-07-13T00:00:00.000Z",
    created_at: "2026-07-13T00:00:00.000Z",
    updated_at: "2026-07-13T00:00:00.000Z"
  };
}
