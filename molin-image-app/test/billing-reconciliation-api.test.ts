import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createAppRequestHandler } from "../src/app/create-app.js";
import type { AppConfig } from "../src/config/app-config.js";
import { InMemorySessionStore } from "../src/modules/auth/session-store.js";
import type { ImageTaskStatus } from "../src/infrastructure/database/image-tasks-repository.js";
import type {
  LaunchTicketVerifier,
  MolingLaunchIdentity
} from "../src/infrastructure/moling/moling-client.js";

const testConfig: AppConfig = {
  appBaseUrl: "http://127.0.0.1",
  databaseUrl: "mysql://user:password@127.0.0.1:3306/molinimage",
  redisUrl: "redis://127.0.0.1:6379/0",
  redisKeyPrefix: "molinimage:test",
  redisConnectTimeoutMs: 10000,
  redisCommandTimeoutMs: 5000,
  redisMaxRetriesPerRequest: 3,
  imageTaskQueueName: "molinimage-image-tasks",
  imageTaskWorkerConcurrency: 2,
  imageTaskJobAttempts: 3,
  imageTaskJobTimeoutMs: 120000,
  imageTaskExecutionMode: "inline",
  imageTaskOutboxPollIntervalMs: 1000,
  imageTaskOutboxBatchSize: 20,
  imageTaskOutboxMaxWaitMs: 300000,
  imageTaskOutboxMaxBackoffMs: 60000,
  storageProvider: "minio",
  storageEndpoint: "http://127.0.0.1:9000",
  storageBucket: "molinimage",
  storageAccessKeyId: "test_storage_access_key",
  storageSecretAccessKey: "test_storage_secret_key",
  storagePresignedUrlTtlSeconds: 300,
  molingApiBaseUrl: "http://127.0.0.1:8080",
  molingAppId: 990008,
  molingProductId: 990107,
  aiGatewayBaseUrl: "http://127.0.0.1:8080/v1",
  aiGatewayApiKey: "test_ai_gateway_api_key",
  imageModelCatalogJson: "[]",
  imageModelEnabledCapabilities: ["image_generation", "vision_text", "moderation"],
  imageModelRequiredCapabilities: ["image_generation", "vision_text", "moderation"],
  billingRulesJson: "[]",
  billingMockBalancePoints: "100",
  riskControlWindowSeconds: 60,
  riskControlUserLimit: 20,
  riskControlIpLimit: 60,
  riskControlDisabledTaskTypes: [],
  riskControlDisabledCapabilities: [],
  trustProxy: false,
  internalApiToken: "test_internal_token",
  sessionStore: "memory",
  adminUserIds: [479],
  sessionCookieName: "molinimage_session",
  sessionCookieSecure: false,
  sessionTtlSeconds: 86400,
  port: 0
};

void test("管理员可打开对账页、查看待对账列表并触发重试", async () => {
  const reconciliationService = new FakeBillingReconciliationService();
  const app = await startTestApp(reconciliationService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const pageResponse = await fetch(`${app.baseUrl}/admin/reconciliation`, {
      headers: { cookie }
    });
    const listResponse = await fetch(`${app.baseUrl}/api/admin/image/billing-reconciliation`, {
      headers: { cookie }
    });
    const settleResponse = await fetch(
      `${app.baseUrl}/api/admin/image/billing-reconciliation/task_settle/retry-settle`,
      { method: "POST", headers: { cookie } }
    );
    const releaseResponse = await fetch(
      `${app.baseUrl}/api/admin/image/billing-reconciliation/task_release/retry-release`,
      { method: "POST", headers: { cookie } }
    );
    const listBody = (await listResponse.json()) as { items: { id: string }[] };

    assert.equal(pageResponse.status, 200);
    assert.equal(listResponse.status, 200);
    assert.deepEqual(
      listBody.items.map((item) => item.id),
      ["task_settle", "task_release"]
    );
    assert.equal(settleResponse.status, 200);
    assert.equal(releaseResponse.status, 200);
    assert.deepEqual(reconciliationService.settleTaskIds, ["task_settle"]);
    assert.deepEqual(reconciliationService.releaseTaskIds, ["task_release"]);
  } finally {
    await app.close();
  }
});

void test("管理员可查看最终失败任务并人工重新投递", async () => {
  const recoveryService = new FakeImageTaskRecoveryService();
  const app = await startTestApp(new FakeBillingReconciliationService(), recoveryService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const pageResponse = await fetch(`${app.baseUrl}/admin/task-recovery`, {
      headers: { cookie }
    });
    const listResponse = await fetch(`${app.baseUrl}/api/admin/image/task-recovery`, {
      headers: { cookie }
    });
    const replayResponse = await fetch(
      `${app.baseUrl}/api/admin/image/task-recovery/task_failed/replay`,
      { method: "POST", headers: { cookie } }
    );
    const listBody = (await listResponse.json()) as { items: { error_code: string }[] };

    assert.equal(pageResponse.status, 200);
    assert.equal(listResponse.status, 200);
    assert.equal(listBody.items[0]?.error_code, "AI_GATEWAY_FAILED");
    assert.equal(replayResponse.status, 201);
    assert.deepEqual(recoveryService.replayedTaskIds, ["task_failed"]);
  } finally {
    await app.close();
  }
});

class FakeBillingReconciliationService {
  readonly settleTaskIds: string[] = [];
  readonly releaseTaskIds: string[] = [];

  listPending() {
    return Promise.resolve({
      items: [
        createTask("task_settle", "billing_pending", "BILLING_SETTLE_PENDING"),
        createTask("task_release", "failed", "BILLING_RELEASE_PENDING")
      ],
      page: 1,
      page_size: 20,
      total: 2
    });
  }

  retrySettle(input: { actorUserId: number; taskId: string; requestId: string }) {
    this.settleTaskIds.push(input.taskId);

    return Promise.resolve(createActionResult(input.taskId, "retry_settle"));
  }

  retryRelease(input: { actorUserId: number; taskId: string; requestId: string }) {
    this.releaseTaskIds.push(input.taskId);

    return Promise.resolve(createActionResult(input.taskId, "retry_release"));
  }
}

class FakeImageTaskRecoveryService {
  readonly replayedTaskIds: string[] = [];

  listFailedTasks() {
    return Promise.resolve({
      items: [
        {
          id: "task_failed",
          owner_user_id: 479,
          task_type: "text_to_image",
          error_code: "AI_GATEWAY_FAILED",
          error_message: "AI 模型服务调用失败。",
          worker_attempt_count: 3,
          billing_event_id: "billing_reserve_001",
          billing_status: "released",
          created_at: "2026-07-16T00:00:00.000Z",
          updated_at: "2026-07-16T00:05:00.000Z"
        }
      ],
      page: 1,
      page_size: 20,
      total: 1
    });
  }

  replayFailedTask(input: { taskId: string }) {
    this.replayedTaskIds.push(input.taskId);
    return Promise.resolve({
      task: createPublicTask("task_retry"),
      retried_from_task_id: input.taskId
    });
  }
}

class FakeLaunchTicketVerifier implements LaunchTicketVerifier {
  verifyLaunchTicket(): Promise<MolingLaunchIdentity> {
    return Promise.resolve({
      user_id: 479,
      app_id: 990008,
      product_id: 990107
    });
  }
}

async function startTestApp(
  reconciliationService: FakeBillingReconciliationService,
  recoveryService?: FakeImageTaskRecoveryService
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer(
    createAppRequestHandler(testConfig, {
      launchTicketVerifier: new FakeLaunchTicketVerifier(),
      sessionStore: new InMemorySessionStore(),
      billingReconciliationService: reconciliationService,
      imageTaskRecoveryService: recoveryService
    })
  );

  await listen(server);
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("测试服务监听地址异常");
  }

  const tcpAddress: AddressInfo = address;

  return {
    baseUrl: `http://127.0.0.1:${String(tcpAddress.port)}`,
    close: () => close(server)
  };
}

function createPublicTask(id: string) {
  return {
    id,
    source_task_id: null,
    source_file_id: null,
    owner_user_id: 479,
    task_type: "text_to_image",
    status: "billing_reserved" as const,
    prompt: "测试",
    negative_prompt: null,
    style_preset_id: null,
    input_file_ids: [],
    output_file_ids: [],
    text_result: null,
    gateway_model_code: "image-model",
    gateway_capability: "image_generation",
    gateway_request_id: null,
    quality: "standard",
    image_size: "1024x1024",
    image_count: 1,
    upscale_factor: null,
    cost_points: "6",
    billing_event_id: "billing_retry",
    error_code: null,
    error_message: null,
    is_favorited: false,
    deleted_at: null,
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z"
  };
}

async function createSessionCookie(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/enter?ticket=valid_ticket`, {
    redirect: "manual"
  });
  const setCookieHeader = response.headers.get("set-cookie");

  if (setCookieHeader === null) {
    throw new Error("测试响应缺少 Set-Cookie");
  }

  return setCookieHeader.split(";")[0] ?? "";
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }

      reject(error);
    });
  });
}

function createActionResult(taskId: string, action: "retry_settle" | "retry_release") {
  return {
    task: createTask(taskId, action === "retry_settle" ? "succeeded" : "failed", null),
    attempt: {
      id: `attempt_${taskId}`,
      task_id: taskId,
      owner_user_id: 479,
      actor_user_id: 479,
      action,
      before_task_status: action === "retry_settle" ? "billing_pending" : "failed",
      after_task_status: action === "retry_settle" ? "succeeded" : "failed",
      before_error_code:
        action === "retry_settle" ? "BILLING_SETTLE_PENDING" : "BILLING_RELEASE_PENDING",
      after_error_code: null,
      billing_event_id: "billing_event_001",
      billing_event_status: action === "retry_settle" ? "settled" : "released",
      result: "succeeded" as const,
      error_code: null,
      error_message: null,
      request_id: "req_001",
      created_at: "2026-07-12T00:00:00.000Z"
    },
    attempts: []
  };
}

function createTask(id: string, status: ImageTaskStatus, errorCode: string | null) {
  return {
    id,
    owner_user_id: 479,
    task_type: "text_to_image",
    status,
    cost_points: "6",
    billing_event_id: "billing_reserve_001",
    error_code: errorCode,
    error_message: errorCode === null ? null : "等待对账",
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z",
    latest_billing_event_id: "billing_event_001",
    latest_billing_event_type: status === "billing_pending" ? "settle" : "release",
    latest_billing_event_status:
      status === "billing_pending" ? "settle_pending" : "release_pending",
    latest_billing_event_error_code: errorCode,
    latest_billing_event_error_message: "等待对账",
    latest_reconciliation_result: null,
    latest_reconciliation_error_code: null,
    latest_reconciliation_error_message: null,
    latest_reconciliation_created_at: null
  };
}
