import assert from "node:assert/strict";
import test from "node:test";

import type {
  ReleaseBillingRequest,
  ReleaseBillingResult,
  ReserveBillingRequest,
  ReserveBillingResult,
  SettleBillingRequest,
  SettleBillingResult
} from "../src/modules/billing/billing-service.js";
import { BillingServiceError } from "../src/modules/billing/billing-service.js";
import type {
  CreateImageTaskRecordInput,
  ImageTaskRecord,
  ImageTasksRepository,
  TransitionImageTaskInput
} from "../src/infrastructure/database/image-tasks-repository.js";
import {
  type ImageTaskAuditEvent,
  type ImageTaskModelResolver,
  ImageTaskService,
  ImageTaskServiceError
} from "../src/modules/image-tasks/image-task-service.js";

void test("创建图片任务时必须绑定 owner_user_id，并从 pending 开始", async () => {
  const repository = new InMemoryImageTasksRepository();
  const service = new ImageTaskService(repository);

  const result = await service.createTask({
    ownerUserId: 479,
    taskType: "text_to_image",
    prompt: "一张产品海报",
    gatewayModelCode: "image-gen-default",
    gatewayCapability: "image_generation",
    imageSize: "1024x1024",
    imageCount: 2
  });

  assert.equal(result.task.owner_user_id, 479);
  assert.equal(result.task.status, "pending");
  assert.equal(repository.records.get(result.task.id)?.owner_user_id, 479);
});

void test("创建任务会使用后台默认模型，并在模型不可用时阻止计费", async () => {
  const repository = new InMemoryImageTasksRepository();
  const billingService = new FakeBillingService();
  const modelResolver = new FakeImageTaskModelResolver({
    gatewayModelCode: "image-gen-default",
    gatewayCapability: "image_generation"
  });
  const service = new ImageTaskService(repository, billingService, undefined, modelResolver);

  const result = await service.createTask({
    ownerUserId: 479,
    taskType: "text_to_image",
    prompt: "一张产品海报",
    imageCount: 1,
    entitlementId: 62
  });

  assert.equal(result.task.gateway_model_code, "image-gen-default");
  assert.equal(result.task.gateway_capability, "image_generation");
  assert.equal(billingService.reserveRequests[0]?.gatewayModelCode, "image-gen-default");

  modelResolver.result = null;
  await assert.rejects(
    () =>
      service.createTask({
        ownerUserId: 479,
        taskType: "text_to_image",
        prompt: "一张产品海报",
        gatewayModelCode: "closed-model",
        gatewayCapability: "image_generation",
        entitlementId: 62
      }),
    (error: unknown) =>
      error instanceof ImageTaskServiceError && error.code === "IMAGE_MODEL_UNAVAILABLE"
  );

  // 模型关闭或能力不匹配时必须在计费前失败，避免错误请求占用额度。
  assert.equal(billingService.reserveRequests.length, 1);
});

void test("图片修复只接受四种修复类型且必须关联一张原图", async () => {
  const repository = new InMemoryImageTasksRepository();
  const billingService = new FakeBillingService();
  const service = new ImageTaskService(repository, billingService);

  await assert.rejects(
    () =>
      service.createTask({
        ownerUserId: 479,
        taskType: "image_restore",
        stylePresetId: "unknown_restore_type",
        inputFileIds: ["file_input_001"],
        entitlementId: 62
      }),
    (error: unknown) =>
      error instanceof ImageTaskServiceError && error.code === "IMAGE_RESTORE_TYPE_INVALID"
  );
  await assert.rejects(
    () =>
      service.createTask({
        ownerUserId: 479,
        taskType: "image_restore",
        stylePresetId: "denoise",
        inputFileIds: [],
        entitlementId: 62
      }),
    (error: unknown) =>
      error instanceof ImageTaskServiceError && error.code === "INPUT_IMAGE_REQUIRED"
  );

  // 参数校验必须发生在计费预占之前，无效修复任务不能占用用户额度。
  assert.equal(billingService.reserveRequests.length, 0);
  assert.equal(repository.records.size, 0);
});

void test("高清放大只接受 2x 或 4x 且在预占前校验原图", async () => {
  const repository = new InMemoryImageTasksRepository();
  const billingService = new FakeBillingService();
  const service = new ImageTaskService(repository, billingService);

  await assert.rejects(
    () =>
      service.createTask({
        ownerUserId: 479,
        taskType: "upscale",
        upscaleFactor: 3,
        inputFileIds: ["file_input_001"],
        entitlementId: 62
      }),
    (error: unknown) =>
      error instanceof ImageTaskServiceError && error.code === "UPSCALE_FACTOR_INVALID"
  );
  await assert.rejects(
    () =>
      service.createTask({
        ownerUserId: 479,
        taskType: "upscale",
        upscaleFactor: 2,
        inputFileIds: [],
        entitlementId: 62
      }),
    (error: unknown) =>
      error instanceof ImageTaskServiceError && error.code === "INPUT_IMAGE_REQUIRED"
  );

  assert.equal(billingService.reserveRequests.length, 0);
});

void test("再次编辑任务必须引用本人成功任务的结果文件并记录来源", async () => {
  const repository = new InMemoryImageTasksRepository();
  const service = new ImageTaskService(repository);
  const source = await service.createTask({
    ownerUserId: 479,
    taskType: "text_to_image",
    prompt: "清晨咖啡产品图",
    gatewayModelCode: "image-gen-default",
    gatewayCapability: "image_generation",
    imageSize: "1024x1024",
    imageCount: 1
  });
  await service.transitionTask({ ownerUserId: 479, taskId: source.task.id, toStatus: "queued" });
  await service.transitionTask({ ownerUserId: 479, taskId: source.task.id, toStatus: "running" });
  await service.transitionTask({
    ownerUserId: 479,
    taskId: source.task.id,
    toStatus: "succeeded",
    outputFileIds: ["file_source_result_001"]
  });

  const reedit = await service.createTask({
    ownerUserId: 479,
    taskType: "image_to_image",
    prompt: "改成黄昏背景",
    stylePresetId: "change_background",
    inputFileIds: ["file_source_result_001"],
    sourceTaskId: source.task.id,
    entitlementId: 62,
    idempotencyKey: "reedit:source:001"
  });

  assert.equal(reedit.task.source_task_id, source.task.id);
  assert.deepEqual(reedit.task.input_file_ids, ["file_source_result_001"]);
  await assert.rejects(
    () =>
      service.createTask({
        ownerUserId: 479,
        taskType: "image_to_image",
        inputFileIds: ["file_not_from_source"],
        sourceTaskId: source.task.id
      }),
    (error: unknown) =>
      error instanceof ImageTaskServiceError && error.code === "SOURCE_TASK_FILE_MISMATCH"
  );

  const sourceRecord = repository.records.get(source.task.id);

  assert.ok(sourceRecord);
  const billingService = new FakeBillingService();
  const auditLogger = new FakeImageTaskAuditLogger();
  const billedService = new ImageTaskService(repository, billingService, auditLogger);
  sourceRecord.owner_user_id = 480;
  await assert.rejects(
    () =>
      billedService.createTask({
        ownerUserId: 479,
        taskType: "image_to_image",
        inputFileIds: ["file_source_result_001"],
        sourceTaskId: source.task.id
      }),
    (error: unknown) =>
      error instanceof ImageTaskServiceError && error.code === "SOURCE_TASK_FORBIDDEN"
  );
  assert.deepEqual(auditLogger.events[0], {
    event_type: "source_task_access_denied",
    actor_user_id: 479,
    source_task_id: source.task.id,
    reason: "owner_mismatch"
  });

  sourceRecord.owner_user_id = 479;
  sourceRecord.status = "running";
  await assert.rejects(
    () =>
      billedService.createTask({
        ownerUserId: 479,
        taskType: "image_to_image",
        inputFileIds: ["file_source_result_001"],
        sourceTaskId: source.task.id,
        entitlementId: 62
      }),
    (error: unknown) =>
      error instanceof ImageTaskServiceError && error.code === "SOURCE_TASK_NOT_AVAILABLE"
  );

  sourceRecord.status = "succeeded";
  sourceRecord.deleted_at = "2026-07-10T00:00:00.000Z";
  await assert.rejects(
    () =>
      billedService.createTask({
        ownerUserId: 479,
        taskType: "image_to_image",
        inputFileIds: ["file_source_result_001"],
        sourceTaskId: source.task.id,
        entitlementId: 62
      }),
    (error: unknown) =>
      error instanceof ImageTaskServiceError && error.code === "SOURCE_TASK_NOT_AVAILABLE"
  );

  // 无效来源必须在计费预占前被拒绝，不能占用用户积分。
  assert.equal(billingService.reserveRequests.length, 0);

  const idempotentReplay = await billedService.createTask({
    ownerUserId: 479,
    taskType: "image_to_image",
    prompt: "改成黄昏背景",
    stylePresetId: "change_background",
    inputFileIds: ["file_source_result_001"],
    sourceTaskId: source.task.id,
    entitlementId: 62,
    idempotencyKey: "reedit:source:001"
  });

  assert.equal(idempotentReplay.task.id, reedit.task.id);
  assert.equal(billingService.reserveRequests.length, 0);
  await assert.rejects(
    () =>
      billedService.createTask({
        ownerUserId: 479,
        taskType: "image_to_image",
        prompt: "使用冲突参数",
        stylePresetId: "change_background",
        inputFileIds: ["file_source_result_001"],
        sourceTaskId: source.task.id,
        idempotencyKey: "reedit:source:001"
      }),
    (error: unknown) =>
      error instanceof ImageTaskServiceError && error.code === "IMAGE_TASK_IDEMPOTENCY_CONFLICT"
  );
  await assert.rejects(
    () =>
      billedService.createTask({
        ownerUserId: 479,
        taskType: "image_to_image",
        prompt: "改成黄昏背景",
        stylePresetId: "change_background",
        inputFileIds: ["file_source_result_001"],
        sourceTaskId: source.task.id,
        entitlementId: 63,
        idempotencyKey: "reedit:source:001"
      }),
    (error: unknown) =>
      error instanceof ImageTaskServiceError && error.code === "IMAGE_TASK_IDEMPOTENCY_CONFLICT"
  );
});

void test("接入计费服务后，创建图片任务会先预占积分并进入 billing_reserved", async () => {
  const repository = new InMemoryImageTasksRepository();
  const billingService = new FakeBillingService();
  const service = new ImageTaskService(repository, billingService);

  const result = await service.createTask({
    ownerUserId: 479,
    taskType: "text_to_image",
    prompt: "一张产品海报",
    imageCount: 2,
    gatewayModelCode: "image-gen-hd",
    gatewayCapability: "image_generation",
    quality: "hd",
    imageSize: "1024x1536",
    expectedPricingRuleId: "price_hd",
    expectedPoints: "12",
    entitlementId: 62
  });

  assert.equal(result.task.status, "billing_reserved");
  assert.equal(result.task.cost_points, "12");
  assert.equal(result.task.billing_event_id, "billing_event_001");
  assert.equal(billingService.reserveRequests[0]?.taskId, result.task.id);
  assert.equal(billingService.reserveRequests[0]?.gatewayModelCode, "image-gen-hd");
  assert.equal(billingService.reserveRequests[0]?.gatewayCapability, "image_generation");
  assert.equal(billingService.reserveRequests[0]?.quality, "hd");
  assert.equal(billingService.reserveRequests[0]?.imageSize, "1024x1536");
  assert.equal(billingService.reserveRequests[0]?.expectedRuleId, "price_hd");
  assert.equal(billingService.reserveRequests[0]?.expectedPoints, "12");
  assert.equal(
    billingService.reserveRequests[0]?.idempotencyKey,
    `${result.task.id}:text_to_image:reserve`
  );
});

void test("余额不足时图片任务不会写入数据库", async () => {
  const repository = new InMemoryImageTasksRepository();
  const service = new ImageTaskService(repository, new InsufficientBillingService());

  await assert.rejects(
    () =>
      service.createTask({
        ownerUserId: 479,
        taskType: "text_to_image",
        imageCount: 1,
        entitlementId: 62
      }),
    (error: unknown) =>
      error instanceof BillingServiceError && error.code === "BILLING_BALANCE_INSUFFICIENT"
  );
  assert.equal(repository.records.size, 0);
});

void test("价格规则全部禁用时任务不会写库也不会发起计费预占", async () => {
  const repository = new InMemoryImageTasksRepository();
  const billingService = new DisabledPricingBillingService();
  const service = new ImageTaskService(repository, billingService);

  await assert.rejects(
    () =>
      service.createTask({
        ownerUserId: 479,
        taskType: "text_to_image",
        imageCount: 1,
        entitlementId: 62
      }),
    (error: unknown) =>
      error instanceof BillingServiceError && error.code === "BILLING_RULE_NOT_FOUND"
  );
  assert.equal(repository.records.size, 0);
  assert.equal(billingService.reserveAttempts, 1);
  assert.equal(billingService.gatewayReserveAttempts, 0);
});

void test("图片任务状态机允许完整成功链路，并记录结果", async () => {
  const repository = new InMemoryImageTasksRepository();
  const service = new ImageTaskService(repository);
  const created = await service.createTask({
    ownerUserId: 479,
    taskType: "text_to_image",
    prompt: "生成一张封面图"
  });

  await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "billing_reserved",
    billingEventId: "billing_001"
  });
  await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "queued"
  });
  await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "running",
    gatewayRequestId: "gateway_req_001"
  });
  const succeeded = await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "succeeded",
    outputFileIds: ["file_output_001"]
  });

  assert.equal(succeeded.task.status, "succeeded");
  assert.deepEqual(succeeded.task.output_file_ids, ["file_output_001"]);
  assert.equal(succeeded.task.gateway_request_id, "gateway_req_001");
});

void test("图片任务状态机覆盖 P2-G01 要求的全部状态", async () => {
  const repository = new InMemoryImageTasksRepository();
  const service = new ImageTaskService(repository);
  const observedStatuses = new Set<string>();

  const successTask = await service.createTask({
    ownerUserId: 479,
    taskType: "text_to_image"
  });
  observedStatuses.add(successTask.task.status);
  observedStatuses.add(
    (
      await service.transitionTask({
        ownerUserId: 479,
        taskId: successTask.task.id,
        toStatus: "billing_reserved"
      })
    ).task.status
  );
  observedStatuses.add(
    (
      await service.transitionTask({
        ownerUserId: 479,
        taskId: successTask.task.id,
        toStatus: "queued"
      })
    ).task.status
  );
  observedStatuses.add(
    (
      await service.transitionTask({
        ownerUserId: 479,
        taskId: successTask.task.id,
        toStatus: "running"
      })
    ).task.status
  );
  observedStatuses.add(
    (
      await service.transitionTask({
        ownerUserId: 479,
        taskId: successTask.task.id,
        toStatus: "succeeded"
      })
    ).task.status
  );

  const failedTask = await service.createTask({
    ownerUserId: 479,
    taskType: "text_to_image"
  });
  observedStatuses.add(
    (
      await service.transitionTask({
        ownerUserId: 479,
        taskId: failedTask.task.id,
        toStatus: "failed",
        errorCode: "AI_GATEWAY_FAILED",
        errorMessage: "AI 网关调用失败。"
      })
    ).task.status
  );

  const billingPendingTask = await service.createTask({
    ownerUserId: 479,
    taskType: "text_to_image"
  });
  await service.transitionTask({
    ownerUserId: 479,
    taskId: billingPendingTask.task.id,
    toStatus: "queued"
  });
  await service.transitionTask({
    ownerUserId: 479,
    taskId: billingPendingTask.task.id,
    toStatus: "running"
  });
  observedStatuses.add(
    (
      await service.transitionTask({
        ownerUserId: 479,
        taskId: billingPendingTask.task.id,
        toStatus: "billing_pending",
        errorCode: "BILLING_SETTLE_FAILED",
        errorMessage: "计费结算待对账。"
      })
    ).task.status
  );

  const cancelledTask = await service.createTask({
    ownerUserId: 479,
    taskType: "text_to_image"
  });
  observedStatuses.add(
    (
      await service.transitionTask({
        ownerUserId: 479,
        taskId: cancelledTask.task.id,
        toStatus: "cancelled"
      })
    ).task.status
  );

  assert.deepEqual([...observedStatuses].sort(), [
    "billing_pending",
    "billing_reserved",
    "cancelled",
    "failed",
    "pending",
    "queued",
    "running",
    "succeeded"
  ]);
});

void test("非法状态流转会被状态机拦截", async () => {
  const repository = new InMemoryImageTasksRepository();
  const service = new ImageTaskService(repository);
  const created = await service.createTask({
    ownerUserId: 479,
    taskType: "image_to_text"
  });

  await assert.rejects(
    () =>
      service.transitionTask({
        ownerUserId: 479,
        taskId: created.task.id,
        toStatus: "succeeded"
      }),
    (error: unknown) =>
      error instanceof ImageTaskServiceError &&
      error.code === "IMAGE_TASK_STATUS_TRANSITION_INVALID"
  );
});

void test("失败和待对账状态必须记录失败原因", async () => {
  const repository = new InMemoryImageTasksRepository();
  const service = new ImageTaskService(repository);
  const created = await service.createTask({
    ownerUserId: 479,
    taskType: "text_to_image"
  });

  await assert.rejects(
    () =>
      service.transitionTask({
        ownerUserId: 479,
        taskId: created.task.id,
        toStatus: "failed"
      }),
    (error: unknown) =>
      error instanceof ImageTaskServiceError && error.code === "IMAGE_TASK_FAILURE_REASON_REQUIRED"
  );

  const failed = await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "failed",
    errorCode: "AI_GATEWAY_FAILED",
    errorMessage: "AI 网关调用失败。"
  });

  assert.equal(failed.task.status, "failed");
  assert.equal(failed.task.error_code, "AI_GATEWAY_FAILED");
  assert.equal(failed.task.error_message, "AI 网关调用失败。");
});

void test("预占后的任务失败会释放积分，AI 网关失败不扣费", async () => {
  const repository = new InMemoryImageTasksRepository();
  const billingService = new FakeBillingService();
  const service = new ImageTaskService(repository, billingService);
  const created = await service.createTask({
    ownerUserId: 479,
    taskType: "text_to_image",
    imageCount: 1,
    entitlementId: 62
  });
  await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "queued"
  });
  await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "running"
  });
  const failed = await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "failed",
    errorCode: "AI_GATEWAY_FAILED",
    errorMessage: "AI 网关调用失败。"
  });

  assert.equal(failed.task.status, "failed");
  assert.equal(billingService.releaseRequests.length, 1);
  assert.equal(billingService.releaseRequests[0]?.reserveBillingEventId, "billing_event_001");
  assert.equal(
    billingService.releaseRequests[0]?.idempotencyKey,
    `${created.task.id}:text_to_image:release`
  );
});

void test("成功任务结算失败时保留结果并进入 billing_pending", async () => {
  const repository = new InMemoryImageTasksRepository();
  const billingService = new FakeBillingService(false);
  const service = new ImageTaskService(repository, billingService);
  const created = await service.createTask({
    ownerUserId: 479,
    taskType: "upscale",
    inputFileIds: ["file_input_001"],
    upscaleFactor: 4,
    imageCount: 1,
    entitlementId: 62
  });
  await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "queued"
  });
  await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "running"
  });

  const completed = await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "succeeded",
    outputFileIds: ["file_output_001"]
  });

  assert.equal(completed.task.status, "billing_pending");
  assert.deepEqual(completed.task.output_file_ids, ["file_output_001"]);
  assert.equal(completed.task.error_code, "BILLING_SETTLE_PENDING");
  assert.equal(completed.task.billing_event_id, "billing_event_001");
  assert.equal(billingService.settleRequests[0]?.actualAmount, "8");

  billingService.setSettleShouldSucceed(true);
  const reconciled = await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "succeeded",
    outputFileIds: ["file_output_001"]
  });

  assert.equal(reconciled.task.status, "succeeded");
  assert.equal(billingService.settleRequests[1]?.retryPending, true);
});

void test("用户不能查询或流转他人的图片任务", async () => {
  const repository = new InMemoryImageTasksRepository();
  const service = new ImageTaskService(repository);
  const created = await service.createTask({
    ownerUserId: 479,
    taskType: "text_to_image"
  });

  await assert.rejects(
    () => service.getTask(480, created.task.id),
    (error: unknown) =>
      error instanceof ImageTaskServiceError && error.code === "IMAGE_TASK_FORBIDDEN"
  );
  await assert.rejects(
    () =>
      service.transitionTask({
        ownerUserId: 480,
        taskId: created.task.id,
        toStatus: "queued"
      }),
    (error: unknown) =>
      error instanceof ImageTaskServiceError && error.code === "IMAGE_TASK_FORBIDDEN"
  );
});

void test("失败任务重试会复制参数创建新任务，并用稳定幂等键避免重复扣费", async () => {
  const repository = new InMemoryImageTasksRepository();
  const billingService = new FakeBillingService();
  const service = new ImageTaskService(repository, billingService);
  const created = await service.createTask({
    ownerUserId: 479,
    taskType: "text_to_image",
    prompt: "一张 AI 海报",
    gatewayModelCode: "image-gen-default",
    gatewayCapability: "image_generation",
    imageSize: "1024x1024",
    imageCount: 1,
    entitlementId: 62
  });

  await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "failed",
    errorCode: "AI_GATEWAY_FAILED",
    errorMessage: "AI 网关调用失败。"
  });
  const retried = await service.retryTask(479, created.task.id, 62);
  const retriedAgain = await service.retryTask(479, created.task.id, 62);

  assert.equal(retried.retried_from_task_id, created.task.id);
  assert.equal(retried.task.prompt, "一张 AI 海报");
  assert.equal(retried.task.status, "billing_reserved");
  assert.equal(retriedAgain.task.id, retried.task.id);
  assert.equal(billingService.reserveRequests.length, 2);
});

void test("作品历史支持收藏并只允许成功作品进入收藏", async () => {
  const repository = new InMemoryImageTasksRepository();
  const service = new ImageTaskService(repository);
  const created = await service.createTask({
    ownerUserId: 479,
    taskType: "image_to_text"
  });

  await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "queued"
  });
  await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "running"
  });
  await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "succeeded",
    textResult: "标题：清晨咖啡"
  });
  const favorited = await service.favoriteHistoryItem(479, created.task.id);

  assert.equal(favorited.task.is_favorited, true);
  assert.equal(repository.favoriteRequests[0]?.ownerUserId, 479);
});

void test("作品历史删除使用软删除并从列表隐藏", async () => {
  const repository = new InMemoryImageTasksRepository();
  const service = new ImageTaskService(repository);
  const created = await service.createTask({
    ownerUserId: 479,
    taskType: "text_to_image"
  });

  await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "queued"
  });
  await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "running"
  });
  await service.transitionTask({
    ownerUserId: 479,
    taskId: created.task.id,
    toStatus: "succeeded",
    outputFileIds: ["file_output_001"]
  });
  const deleted = await service.deleteHistoryItem(479, created.task.id);
  const history = await service.listHistory({ ownerUserId: 479 });

  assert.equal(deleted.deleted, true);
  assert.equal(deleted.task_id, created.task.id);
  assert.equal(history.total, 0);
  await assert.rejects(
    () => service.getTask(479, created.task.id),
    (error: unknown) =>
      error instanceof ImageTaskServiceError && error.code === "IMAGE_TASK_NOT_FOUND"
  );
});

class InMemoryImageTasksRepository implements ImageTasksRepository {
  readonly records = new Map<string, ImageTaskRecord>();
  readonly favoriteRequests: { ownerUserId: number; taskId: string; collectionId: string }[] = [];

  create(input: CreateImageTaskRecordInput): Promise<ImageTaskRecord> {
    const now = new Date("2026-07-09T00:00:00.000Z").toISOString();
    const record: ImageTaskRecord = {
      ...input,
      source_task_id: input.source_task_id ?? null,
      entitlement_id: input.entitlement_id ?? null,
      upscale_factor: input.upscale_factor ?? null,
      output_file_ids: [],
      text_result: null,
      gateway_request_id: null,
      error_code: null,
      error_message: null,
      is_favorited: false,
      deleted_at: null,
      created_at: now,
      updated_at: now
    };

    this.records.set(record.id, record);

    return Promise.resolve(record);
  }

  findById(taskId: string): Promise<ImageTaskRecord | undefined> {
    return Promise.resolve(this.records.get(taskId));
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<ImageTaskRecord | undefined> {
    return Promise.resolve(
      Array.from(this.records.values()).find((record) => record.idempotency_key === idempotencyKey)
    );
  }

  updateStatus(input: TransitionImageTaskInput): Promise<ImageTaskRecord | undefined> {
    const record = this.records.get(input.taskId);

    if (record?.owner_user_id !== input.ownerUserId || record.status !== input.fromStatus) {
      return Promise.resolve(undefined);
    }

    const updated: ImageTaskRecord = {
      ...record,
      status: input.toStatus,
      output_file_ids: input.outputFileIds ?? record.output_file_ids,
      text_result: input.textResult ?? record.text_result,
      gateway_request_id: input.gatewayRequestId ?? record.gateway_request_id,
      billing_event_id: input.billingEventId ?? record.billing_event_id,
      error_code: input.errorCode ?? null,
      error_message: input.errorMessage ?? null,
      updated_at: new Date("2026-07-09T00:01:00.000Z").toISOString()
    };

    this.records.set(updated.id, updated);

    return Promise.resolve(updated);
  }

  findHistoryByOwner(input: {
    ownerUserId: number;
    taskType?: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: ImageTaskRecord[]; total: number }> {
    const items = Array.from(this.records.values())
      .filter(
        (record) =>
          record.owner_user_id === input.ownerUserId &&
          record.status === "succeeded" &&
          record.deleted_at === null &&
          (input.taskType === undefined || record.task_type === input.taskType)
      )
      .sort((left, right) => Number(right.is_favorited) - Number(left.is_favorited));

    return Promise.resolve({
      items: items.slice((input.page - 1) * input.pageSize, input.page * input.pageSize),
      total: items.length
    });
  }

  markFavorite(input: {
    ownerUserId: number;
    taskId: string;
    collectionId: string;
  }): Promise<ImageTaskRecord | undefined> {
    this.favoriteRequests.push(input);
    const record = this.records.get(input.taskId);

    if (
      record?.owner_user_id !== input.ownerUserId ||
      record.status !== "succeeded" ||
      record.deleted_at !== null
    ) {
      return Promise.resolve(undefined);
    }

    const updated: ImageTaskRecord = {
      ...record,
      is_favorited: true,
      updated_at: new Date("2026-07-09T00:02:00.000Z").toISOString()
    };

    this.records.set(updated.id, updated);

    return Promise.resolve(updated);
  }

  softDeleteHistoryItem(input: {
    ownerUserId: number;
    taskId: string;
  }): Promise<ImageTaskRecord | undefined> {
    const record = this.records.get(input.taskId);

    if (
      record?.owner_user_id !== input.ownerUserId ||
      record.status !== "succeeded" ||
      record.deleted_at !== null
    ) {
      return Promise.resolve(undefined);
    }

    const updated: ImageTaskRecord = {
      ...record,
      is_favorited: false,
      deleted_at: new Date("2026-07-09T00:03:00.000Z").toISOString(),
      updated_at: new Date("2026-07-09T00:03:00.000Z").toISOString()
    };

    this.records.set(updated.id, updated);

    return Promise.resolve(updated);
  }
}

class FakeBillingService {
  readonly reserveRequests: ReserveBillingRequest[] = [];
  readonly releaseRequests: ReleaseBillingRequest[] = [];
  readonly settleRequests: SettleBillingRequest[] = [];

  constructor(private settleShouldSucceed = true) {}

  setSettleShouldSucceed(value: boolean): void {
    this.settleShouldSucceed = value;
  }

  reserve(request: ReserveBillingRequest): Promise<ReserveBillingResult> {
    this.reserveRequests.push(request);
    const unitPoints = request.taskType === "upscale" && request.upscaleFactor === 4 ? 8 : 6;
    const estimatedPoints = String((request.imageCount ?? 1) * unitPoints);

    return Promise.resolve({
      estimate: {
        task_type: request.taskType,
        usage_type: "image_text_to_image",
        unit: "credits",
        unit_points: String(unitPoints),
        quantity: request.imageCount ?? 1,
        estimated_points: estimatedPoints,
        upscale_factor: request.upscaleFactor ?? null,
        balance_points: "100",
        enough_balance: true,
        rule_id: null,
        rule_source: "env"
      },
      billing_event: {
        id: "billing_event_001",
        owner_user_id: request.ownerUserId,
        task_id: request.taskId,
        event_type: "reserve",
        amount_points: estimatedPoints,
        status: "reserved",
        idempotency_key: request.idempotencyKey,
        moling_reserve_id: "hold_001",
        moling_entitlement_id: request.entitlementId ?? null,
        created_at: "2026-07-09T00:00:00.000Z",
        updated_at: "2026-07-09T00:00:00.000Z"
      }
    });
  }

  release(request: ReleaseBillingRequest): Promise<ReleaseBillingResult> {
    this.releaseRequests.push(request);

    return Promise.resolve({
      released: true,
      billing_event: {
        id: "billing_release_event_001",
        owner_user_id: request.ownerUserId,
        task_id: request.taskId,
        event_type: "release",
        amount_points: "6",
        status: "released",
        idempotency_key: request.idempotencyKey,
        moling_reserve_id: "hold_001",
        moling_entitlement_id: 62,
        created_at: "2026-07-09T00:00:00.000Z",
        updated_at: "2026-07-09T00:00:00.000Z"
      }
    });
  }

  settle(request: SettleBillingRequest): Promise<SettleBillingResult> {
    this.settleRequests.push(request);

    return Promise.resolve({
      settled: this.settleShouldSucceed,
      billing_event: {
        id: "billing_settle_event_001",
        owner_user_id: request.ownerUserId,
        task_id: request.taskId,
        event_type: "settle",
        amount_points: request.actualAmount ?? "6",
        status: this.settleShouldSucceed ? "settled" : "settle_pending",
        idempotency_key: request.idempotencyKey,
        moling_reserve_id: "hold_001",
        moling_entitlement_id: 62,
        created_at: "2026-07-09T00:00:00.000Z",
        updated_at: "2026-07-09T00:00:00.000Z"
      }
    });
  }
}

class FakeImageTaskAuditLogger {
  readonly events: ImageTaskAuditEvent[] = [];

  record(event: ImageTaskAuditEvent): void {
    this.events.push(event);
  }
}

class FakeImageTaskModelResolver implements ImageTaskModelResolver {
  constructor(public result: { gatewayModelCode: string; gatewayCapability: string } | null) {}

  resolveTaskModel(): Promise<{ gatewayModelCode: string; gatewayCapability: string } | null> {
    return Promise.resolve(this.result);
  }
}

class InsufficientBillingService {
  reserve(): Promise<ReserveBillingResult> {
    return Promise.reject(
      new BillingServiceError("BILLING_BALANCE_INSUFFICIENT", "积分余额不足。", 402)
    );
  }

  release(): Promise<ReleaseBillingResult> {
    return Promise.reject(new Error("余额不足测试不需要释放预占"));
  }

  settle(): Promise<SettleBillingResult> {
    return Promise.reject(new Error("余额不足测试不需要结算预占"));
  }
}

class DisabledPricingBillingService {
  reserveAttempts = 0;
  gatewayReserveAttempts = 0;

  reserve(): Promise<ReserveBillingResult> {
    this.reserveAttempts += 1;
    // 价格匹配阶段即拒绝请求，因此不会进入墨灵权益预占调用。
    return Promise.reject(
      new BillingServiceError("BILLING_RULE_NOT_FOUND", "当前任务没有可用价格规则。", 409)
    );
  }

  release(): Promise<ReleaseBillingResult> {
    throw new Error("规则禁用时不应释放未发生的预占");
  }

  settle(): Promise<SettleBillingResult> {
    throw new Error("规则禁用时不应结算未发生的预占");
  }
}
