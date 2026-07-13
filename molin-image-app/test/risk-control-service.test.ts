import assert from "node:assert/strict";
import test from "node:test";

import type {
  CreateRiskControlEventInput,
  RiskControlEventsRepository
} from "../src/infrastructure/database/risk-control-events-repository.js";
import {
  RiskControlService,
  RiskControlServiceError
} from "../src/modules/risk-control/risk-control-service.js";

void test("用户级限流命中时拒绝任务并记录风控日志", async () => {
  const repository = new InMemoryRiskControlEventsRepository();
  const service = new RiskControlService(repository, {
    windowSeconds: 60,
    userLimit: 1,
    ipLimit: 0,
    disabledTaskTypes: [],
    disabledCapabilities: []
  });

  await service.assertAllowed({
    requestId: "request_001",
    ownerUserId: 479,
    ipAddress: "10.0.0.1",
    taskType: "text_to_image",
    gatewayModelCode: "image-gen-default",
    gatewayCapability: "image_generation"
  });

  await assert.rejects(
    () =>
      service.assertAllowed({
        requestId: "request_002",
        ownerUserId: 479,
        ipAddress: "10.0.0.2",
        taskType: "text_to_image",
        gatewayModelCode: "image-gen-default",
        gatewayCapability: "image_generation"
      }),
    (error: unknown) =>
      error instanceof RiskControlServiceError && error.code === "RISK_USER_RATE_LIMITED"
  );

  assert.equal(repository.events[0]?.decision, "allow");
  assert.equal(repository.events[1]?.decision, "block");
  assert.equal(repository.events[1]?.reason_code, "RISK_USER_RATE_LIMITED");
  assert.equal(repository.events[1]?.observed_count, 2);
});

void test("IP 级限流命中时拒绝任务并记录来源 IP", async () => {
  const repository = new InMemoryRiskControlEventsRepository();
  const service = new RiskControlService(repository, {
    windowSeconds: 60,
    userLimit: 0,
    ipLimit: 1,
    disabledTaskTypes: [],
    disabledCapabilities: []
  });

  await service.assertAllowed({
    ownerUserId: 479,
    ipAddress: "10.0.0.9",
    taskType: "text_to_image"
  });

  await assert.rejects(
    () =>
      service.assertAllowed({
        ownerUserId: 696,
        ipAddress: "10.0.0.9",
        taskType: "image_to_text"
      }),
    (error: unknown) =>
      error instanceof RiskControlServiceError && error.code === "RISK_IP_RATE_LIMITED"
  );

  assert.equal(repository.events[1]?.ip_address, "10.0.0.9");
  assert.equal(repository.events[1]?.reason_code, "RISK_IP_RATE_LIMITED");
  assert.equal(repository.events[1]?.observed_count, 2);
});

void test("并发用户级请求通过原子窗口计数只放行阈值内任务", async () => {
  const repository = new InMemoryRiskControlEventsRepository();
  const service = new RiskControlService(repository, {
    windowSeconds: 60,
    userLimit: 1,
    ipLimit: 0,
    disabledTaskTypes: [],
    disabledCapabilities: []
  });

  const results = await Promise.allSettled([
    service.assertAllowed({
      ownerUserId: 479,
      ipAddress: "10.0.0.1",
      taskType: "text_to_image"
    }),
    service.assertAllowed({
      ownerUserId: 479,
      ipAddress: "10.0.0.2",
      taskType: "text_to_image"
    })
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.deepEqual(repository.events.map((event) => event.decision).sort(), ["allow", "block"]);
});

void test("高风险任务类型或模型能力关闭时直接拦截", async () => {
  const repository = new InMemoryRiskControlEventsRepository();
  const service = new RiskControlService(repository, {
    windowSeconds: 60,
    userLimit: 20,
    ipLimit: 60,
    disabledTaskTypes: ["image_restore"],
    disabledCapabilities: ["upscale"]
  });

  await assert.rejects(
    () =>
      service.assertAllowed({
        ownerUserId: 479,
        ipAddress: "10.0.0.1",
        taskType: "image_restore",
        gatewayCapability: "image_restore"
      }),
    (error: unknown) =>
      error instanceof RiskControlServiceError && error.code === "RISK_TASK_TYPE_DISABLED"
  );

  await assert.rejects(
    () =>
      service.assertAllowed({
        ownerUserId: 479,
        ipAddress: "10.0.0.1",
        taskType: "upscale",
        gatewayCapability: "upscale"
      }),
    (error: unknown) =>
      error instanceof RiskControlServiceError && error.code === "RISK_CAPABILITY_DISABLED"
  );

  assert.deepEqual(
    repository.events.map((event) => event.reason_code),
    ["RISK_TASK_TYPE_DISABLED", "RISK_CAPABILITY_DISABLED"]
  );
});

class InMemoryRiskControlEventsRepository implements RiskControlEventsRepository {
  readonly events: CreateRiskControlEventInput[] = [];
  readonly counters = new Map<string, number>();

  create(input: CreateRiskControlEventInput): Promise<void> {
    this.events.push(input);

    return Promise.resolve();
  }

  incrementWindowCounter(input: {
    subjectType: "user" | "ip";
    subjectKey: string;
    bucketStart: Date;
    windowSeconds: number;
  }): Promise<number> {
    const key = `${input.subjectType}:${input.subjectKey}:${input.bucketStart.toISOString()}`;
    const nextCount = (this.counters.get(key) ?? 0) + 1;

    this.counters.set(key, nextCount);

    return Promise.resolve(nextCount);
  }
}
