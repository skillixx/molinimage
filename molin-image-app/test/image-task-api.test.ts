import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createAppRequestHandler } from "../src/app/create-app.js";
import type { AppConfig } from "../src/config/app-config.js";
import type {
  LaunchTicketVerifier,
  MolingLaunchIdentity
} from "../src/infrastructure/moling/moling-client.js";
import type {
  CreateImageTaskRequest,
  ImageTaskResult,
  TransitionImageTaskRequest
} from "../src/modules/image-tasks/image-task-service.js";

const testConfig: AppConfig = {
  appBaseUrl: "http://127.0.0.1",
  databaseUrl: "mysql://user:password@127.0.0.1:3306/molinimage",
  redisUrl: "redis://127.0.0.1:6379/0",
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
  trustProxy: true,
  internalApiToken: "test_internal_token",
  sessionCookieName: "molinimage_session",
  sessionCookieSecure: false,
  sessionTtlSeconds: 86400,
  port: 0
};

void test("图片任务创建接口必须登录，并把 session 用户绑定为 owner_user_id", async () => {
  const imageTaskService = new FakeImageTaskService();
  const app = await startTestApp(imageTaskService);

  try {
    const unauthorizedResponse = await fetch(`${app.baseUrl}/api/image/tasks`, {
      method: "POST",
      body: "{}"
    });
    const cookie = await createSessionCookie(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/api/image/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "task_create_api_001",
        "x-forwarded-for": "203.0.113.9, 10.0.0.2",
        cookie
      },
      body: JSON.stringify({
        task_type: "text_to_image",
        prompt: "一张 AI 海报",
        image_count: 1
      })
    });
    const body = (await response.json()) as ImageTaskResult;

    assert.equal(unauthorizedResponse.status, 401);
    assert.equal(response.status, 201);
    assert.equal(imageTaskService.createRequests[0]?.ownerUserId, 479);
    assert.equal(imageTaskService.createRequests[0]?.idempotencyKey, "task_create_api_001");
    assert.equal(imageTaskService.createRequests[0]?.requestIp, "203.0.113.9");
    assert.equal(body.task.owner_user_id, 479);
    assert.equal(body.task.status, "billing_reserved");
  } finally {
    await app.close();
  }
});

void test("图片任务查询和状态流转接口按当前 session 用户调用服务", async () => {
  const imageTaskService = new FakeImageTaskService();
  const fileService = new FakeFileService();
  const app = await startTestApp(imageTaskService, undefined, fileService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const getResponse = await fetch(`${app.baseUrl}/api/image/tasks/task_api_001`, {
      headers: {
        cookie
      }
    });
    const getBody = (await getResponse.json()) as ImageTaskResult & {
      input_files: { preview_url: string }[];
      result_files: { preview_url: string }[];
    };
    const transitionResponse = await fetch(
      `${app.baseUrl}/api/image/tasks/task_api_001/transitions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie
        },
        body: JSON.stringify({
          status: "failed",
          error_code: "AI_GATEWAY_FAILED",
          error_message: "AI 网关调用失败。"
        })
      }
    );
    const transitionBody = (await transitionResponse.json()) as ImageTaskResult;

    assert.equal(getResponse.status, 200);
    assert.equal(imageTaskService.getRequests[0]?.ownerUserId, 479);
    assert.equal(imageTaskService.getRequests[0]?.taskId, "task_api_001");
    assert.equal(getBody.task.cost_points, "6");
    assert.equal(getBody.input_files[0]?.preview_url, "https://storage.example.com/input.png");
    assert.equal(getBody.result_files[0]?.preview_url, "https://storage.example.com/generated.png");
    assert.equal(transitionResponse.status, 200);
    assert.equal(imageTaskService.transitionRequests[0]?.ownerUserId, 479);
    assert.equal(imageTaskService.transitionRequests[0]?.taskId, "task_api_001");
    assert.equal(imageTaskService.transitionRequests[0]?.toStatus, "failed");
    assert.equal(transitionBody.task.error_code, "AI_GATEWAY_FAILED");
  } finally {
    await app.close();
  }
});

void test("文生图任务创建后可由 worker 返回 succeeded 和结果预览文件", async () => {
  const imageTaskService = new FakeImageTaskService();
  const imageGenerationWorkerService = new FakeImageGenerationWorkerService();
  const fileService = new FakeFileService();
  const app = await startTestApp(imageTaskService, imageGenerationWorkerService, fileService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/api/image/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie
      },
      body: JSON.stringify({
        task_type: "text_to_image",
        prompt: "一张 AI 海报",
        gateway_model_code: "image-gen-default",
        gateway_capability: "image_generation",
        image_count: 1
      })
    });
    const body = (await response.json()) as ImageTaskResult & {
      result_files: { preview_url: string; download_url: string }[];
    };

    assert.equal(response.status, 201);
    assert.equal(imageGenerationWorkerService.taskIds[0], "task_api_001");
    assert.equal(body.task.status, "succeeded");
    assert.equal(body.result_files[0]?.preview_url, "https://storage.example.com/generated.png");
    assert.equal(body.result_files[0]?.download_url, "https://storage.example.com/generated.png");
  } finally {
    await app.close();
  }
});

void test("图生文任务创建会校验输入文件并返回可复制文本结果", async () => {
  const imageTaskService = new FakeImageTaskService();
  const imageGenerationWorkerService = new FakeImageGenerationWorkerService();
  const fileService = new FakeFileService();
  const app = await startTestApp(imageTaskService, imageGenerationWorkerService, fileService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/api/image/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie
      },
      body: JSON.stringify({
        task_type: "image_to_text",
        prompt: "生成标题和标签",
        input_file_ids: ["file_input_001"],
        gateway_model_code: "vision-text-default",
        gateway_capability: "vision_text",
        image_count: 1
      })
    });
    const body = (await response.json()) as ImageTaskResult;

    assert.equal(response.status, 201);
    assert.deepEqual(fileService.assertOwnedRequests[0], {
      ownerUserId: 479,
      fileIds: ["file_input_001"]
    });
    assert.equal(imageTaskService.createRequests[0]?.taskType, "image_to_text");
    assert.deepEqual(imageTaskService.createRequests[0]?.inputFileIds, ["file_input_001"]);
    assert.equal(imageGenerationWorkerService.taskIds[0], "task_api_001");
    assert.equal(body.task.status, "succeeded");
    assert.match(body.task.text_result ?? "", /标题/);
  } finally {
    await app.close();
  }
});

void test("图生图任务创建会校验输入文件并返回输入图与输出图预览", async () => {
  const imageTaskService = new FakeImageTaskService();
  const imageGenerationWorkerService = new FakeImageGenerationWorkerService();
  const fileService = new FakeFileService();
  const app = await startTestApp(imageTaskService, imageGenerationWorkerService, fileService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/api/image/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie
      },
      body: JSON.stringify({
        task_type: "image_to_image",
        prompt: "换成海边黄昏背景",
        style_preset_id: "change_background",
        input_file_ids: ["file_input_001"],
        source_task_id: "task_history_source_001",
        source_file_id: "file_source_result_001",
        gateway_model_code: "image-edit-default",
        gateway_capability: "image_edit",
        image_size: "1024x1024",
        image_count: 1
      })
    });
    const body = (await response.json()) as ImageTaskResult & {
      input_files: { preview_url: string }[];
      result_files: { preview_url: string }[];
    };

    assert.equal(response.status, 201);
    assert.deepEqual(fileService.assertOwnedRequests[0], {
      ownerUserId: 479,
      fileIds: ["file_input_001"]
    });
    assert.equal(imageTaskService.createRequests[0]?.taskType, "image_to_image");
    assert.equal(imageTaskService.createRequests[0]?.stylePresetId, "change_background");
    assert.equal(imageTaskService.createRequests[0]?.sourceTaskId, "task_history_source_001");
    assert.equal(imageTaskService.createRequests[0]?.sourceFileId, "file_source_result_001");
    assert.equal(imageTaskService.createRequests[0]?.gatewayCapability, "image_edit");
    assert.equal(imageGenerationWorkerService.taskIds[0], "task_api_001");
    assert.equal(body.task.status, "succeeded");
    assert.equal(body.input_files[0]?.preview_url, "https://storage.example.com/input.png");
    assert.equal(body.result_files[0]?.preview_url, "https://storage.example.com/generated.png");
  } finally {
    await app.close();
  }
});

void test("图片修复任务会校验原图归属、进入 worker 并保留原图结果关联", async () => {
  const imageTaskService = new FakeImageTaskService();
  const imageGenerationWorkerService = new FakeImageGenerationWorkerService();
  const fileService = new FakeFileService();
  const app = await startTestApp(imageTaskService, imageGenerationWorkerService, fileService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/api/image/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie
      },
      body: JSON.stringify({
        task_type: "image_restore",
        prompt: "尽量保留人物五官",
        style_preset_id: "old_photo",
        input_file_ids: ["file_input_001"],
        gateway_model_code: "image-edit-default",
        gateway_capability: "image_edit",
        image_size: "1024x1024",
        image_count: 1
      })
    });
    const body = (await response.json()) as ImageTaskResult & {
      input_files: { preview_url: string }[];
      result_files: { preview_url: string }[];
    };

    assert.equal(response.status, 201);
    assert.deepEqual(fileService.assertOwnedRequests[0], {
      ownerUserId: 479,
      fileIds: ["file_input_001"]
    });
    assert.equal(imageTaskService.createRequests[0]?.taskType, "image_restore");
    assert.equal(imageTaskService.createRequests[0]?.stylePresetId, "old_photo");
    assert.equal(imageGenerationWorkerService.taskIds[0], "task_api_001");
    assert.equal(body.input_files[0]?.preview_url, "https://storage.example.com/input.png");
    assert.equal(body.result_files[0]?.preview_url, "https://storage.example.com/generated.png");
  } finally {
    await app.close();
  }
});

void test("高清放大任务传递倍率并返回带宽高的结果文件", async () => {
  const imageTaskService = new FakeImageTaskService();
  const imageGenerationWorkerService = new FakeImageGenerationWorkerService();
  const fileService = new FakeFileService();
  const app = await startTestApp(imageTaskService, imageGenerationWorkerService, fileService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/api/image/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie
      },
      body: JSON.stringify({
        task_type: "upscale",
        upscale_factor: 4,
        input_file_ids: ["file_input_001"],
        gateway_model_code: "image-edit-default",
        gateway_capability: "image_edit",
        image_count: 1
      })
    });
    const body = (await response.json()) as ImageTaskResult & {
      result_files: { file: { width: number | null; height: number | null } }[];
    };

    assert.equal(response.status, 201);
    assert.deepEqual(fileService.assertOwnedRequests[0], {
      ownerUserId: 479,
      fileIds: ["file_input_001"]
    });
    assert.equal(imageTaskService.createRequests[0]?.taskType, "upscale");
    assert.equal(imageTaskService.createRequests[0]?.upscaleFactor, 4);
    assert.equal(imageGenerationWorkerService.taskIds[0], "task_api_001");
    assert.equal(body.result_files[0]?.file.width, 480);
    assert.equal(body.result_files[0]?.file.height, 320);
  } finally {
    await app.close();
  }
});

void test("作品历史接口按当前 session 用户返回分页结果", async () => {
  const imageTaskService = new FakeImageTaskService();
  const app = await startTestApp(imageTaskService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/api/image/history?task_type=image_to_text`, {
      headers: {
        cookie
      }
    });
    const body = (await response.json()) as {
      items: ImageTaskResult["task"][];
      page: number;
      page_size: number;
      total: number;
    };

    assert.equal(response.status, 200);
    assert.equal(imageTaskService.historyRequests[0]?.ownerUserId, 479);
    assert.equal(imageTaskService.historyRequests[0]?.taskType, "image_to_text");
    assert.equal(body.page, 1);
    assert.equal(body.page_size, 20);
    assert.equal(body.total, 1);
    assert.match(body.items[0]?.text_result ?? "", /标题/);
  } finally {
    await app.close();
  }
});

void test("作品历史收藏接口按当前 session 用户操作并返回最新卡片状态", async () => {
  const imageTaskService = new FakeImageTaskService();
  const fileService = new FakeFileService();
  const app = await startTestApp(imageTaskService, undefined, fileService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/api/image/history/task_history_001/favorite`, {
      method: "POST",
      headers: {
        cookie
      }
    });
    const body = (await response.json()) as ImageTaskResult & {
      result_files: { preview_url: string }[];
    };

    assert.equal(response.status, 200);
    assert.deepEqual(imageTaskService.favoriteRequests[0], {
      ownerUserId: 479,
      taskId: "task_history_001"
    });
    assert.equal(body.task.is_favorited, true);
    assert.equal(body.result_files[0]?.preview_url, "https://storage.example.com/generated.png");
  } finally {
    await app.close();
  }
});

void test("作品历史删除接口按当前 session 用户执行软删除", async () => {
  const imageTaskService = new FakeImageTaskService();
  const app = await startTestApp(imageTaskService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/api/image/history/task_history_001`, {
      method: "DELETE",
      headers: {
        cookie
      }
    });
    const body = (await response.json()) as { deleted: true; task_id: string };

    assert.equal(response.status, 200);
    assert.deepEqual(imageTaskService.deleteRequests[0], {
      ownerUserId: 479,
      taskId: "task_history_001"
    });
    assert.equal(body.deleted, true);
    assert.equal(body.task_id, "task_history_001");
  } finally {
    await app.close();
  }
});

void test("失败任务重试接口按当前 session 用户创建 retry task 并交给 worker", async () => {
  const imageTaskService = new FakeImageTaskService();
  const imageGenerationWorkerService = new FakeImageGenerationWorkerService();
  const fileService = new FakeFileService();
  const app = await startTestApp(imageTaskService, imageGenerationWorkerService, fileService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/api/image/tasks/task_failed_001/retry`, {
      method: "POST",
      headers: {
        cookie
      }
    });
    const body = (await response.json()) as ImageTaskResult & {
      retried_from_task_id: string;
      result_files: { preview_url: string }[];
    };

    assert.equal(response.status, 201);
    assert.deepEqual(imageTaskService.retryRequests[0], {
      ownerUserId: 479,
      taskId: "task_failed_001",
      entitlementId: undefined
    });
    assert.equal(imageGenerationWorkerService.taskIds[0], "task_retry_001");
    assert.equal(body.retried_from_task_id, "task_failed_001");
    assert.equal(body.task.status, "succeeded");
    assert.equal(body.result_files[0]?.preview_url, "https://storage.example.com/generated.png");
  } finally {
    await app.close();
  }
});

void test("提示词优化接口必须登录，并按当前 session 用户选择模型优化", async () => {
  const imageTaskService = new FakeImageTaskService();
  const promptOptimizationService = new FakePromptOptimizationService();
  const app = await startTestApp(imageTaskService, undefined, undefined, promptOptimizationService);

  try {
    const unauthorizedResponse = await fetch(`${app.baseUrl}/api/image/prompts/optimize`, {
      method: "POST",
      body: JSON.stringify({ prompt: "蓝色杯子" })
    });
    const cookie = await createSessionCookie(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/api/image/prompts/optimize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie
      },
      body: JSON.stringify({
        prompt: "蓝色杯子",
        task_type: "text_to_image"
      })
    });
    const body = (await response.json()) as {
      original_prompt: string;
      optimized_prompt: string;
      gateway_model_code: string;
      request_id: string;
    };

    assert.equal(unauthorizedResponse.status, 401);
    assert.equal(response.status, 200);
    assert.deepEqual(promptOptimizationService.requests[0], {
      ownerUserId: 479,
      prompt: "蓝色杯子",
      taskType: "text_to_image"
    });
    assert.equal(body.original_prompt, "蓝色杯子");
    assert.equal(body.optimized_prompt, "玻璃质感的蓝色杯子，柔和自然光，干净背景。");
    assert.equal(body.gateway_model_code, "prompt-optimize-default");
    assert.equal(body.request_id, "prompt_request_api_001");
  } finally {
    await app.close();
  }
});

class FakeImageTaskService {
  readonly createRequests: CreateImageTaskRequest[] = [];
  readonly getRequests: { ownerUserId: number; taskId: string }[] = [];
  readonly transitionRequests: TransitionImageTaskRequest[] = [];
  readonly historyRequests: {
    ownerUserId: number;
    taskType?: string;
    page?: number;
    pageSize?: number;
  }[] = [];
  readonly favoriteRequests: { ownerUserId: number; taskId: string }[] = [];
  readonly deleteRequests: { ownerUserId: number; taskId: string }[] = [];
  readonly retryRequests: {
    ownerUserId: number;
    taskId: string;
    entitlementId?: number;
  }[] = [];

  createTask(request: CreateImageTaskRequest): Promise<ImageTaskResult> {
    this.createRequests.push(request);

    return Promise.resolve({
      task: {
        ...createTaskResult("task_api_001", request.ownerUserId, "billing_reserved"),
        task_type: request.taskType,
        upscale_factor: request.upscaleFactor ?? null,
        source_task_id: request.sourceTaskId ?? null,
        source_file_id: request.sourceFileId ?? null
      }
    });
  }

  getTask(ownerUserId: number, taskId: string): Promise<ImageTaskResult> {
    this.getRequests.push({ ownerUserId, taskId });

    return Promise.resolve({
      task: {
        ...createTaskResult(taskId, ownerUserId, "succeeded"),
        input_file_ids: ["file_input_001"],
        output_file_ids: ["file_generated_001"],
        cost_points: "6"
      }
    });
  }

  transitionTask(request: TransitionImageTaskRequest): Promise<ImageTaskResult> {
    this.transitionRequests.push(request);

    return Promise.resolve({
      task: {
        ...createTaskResult(request.taskId, request.ownerUserId, request.toStatus),
        error_code: request.errorCode ?? null,
        error_message: request.errorMessage ?? null
      }
    });
  }

  listHistory(request: {
    ownerUserId: number;
    taskType?: string;
    page?: number;
    pageSize?: number;
  }) {
    this.historyRequests.push(request);

    return Promise.resolve({
      items: [
        {
          ...createTaskResult("task_history_001", request.ownerUserId, "succeeded"),
          task_type: "image_to_text",
          input_file_ids: ["file_input_001"],
          text_result: "标题：清晨咖啡\n标签：咖啡、生活方式"
        }
      ],
      page: request.page ?? 1,
      page_size: request.pageSize ?? 20,
      total: 1
    });
  }

  favoriteHistoryItem(ownerUserId: number, taskId: string): Promise<ImageTaskResult> {
    this.favoriteRequests.push({ ownerUserId, taskId });

    return Promise.resolve({
      task: {
        ...createTaskResult(taskId, ownerUserId, "succeeded"),
        is_favorited: true,
        output_file_ids: ["file_generated_001"]
      }
    });
  }

  deleteHistoryItem(
    ownerUserId: number,
    taskId: string
  ): Promise<{ deleted: true; task_id: string }> {
    this.deleteRequests.push({ ownerUserId, taskId });

    return Promise.resolve({
      deleted: true,
      task_id: taskId
    });
  }

  retryTask(
    ownerUserId: number,
    taskId: string,
    entitlementId?: number
  ): Promise<ImageTaskResult & { retried_from_task_id: string }> {
    this.retryRequests.push({ ownerUserId, taskId, entitlementId });

    return Promise.resolve({
      task: {
        ...createTaskResult("task_retry_001", ownerUserId, "billing_reserved"),
        prompt: "重试原提示词"
      },
      retried_from_task_id: taskId
    });
  }
}

class FakePromptOptimizationService {
  readonly requests: { ownerUserId: number; prompt: string; taskType?: string | null }[] = [];

  optimizePrompt(request: { ownerUserId: number; prompt: string; taskType?: string | null }) {
    this.requests.push(request);

    return Promise.resolve({
      original_prompt: request.prompt,
      optimized_prompt: "玻璃质感的蓝色杯子，柔和自然光，干净背景。",
      gateway_model_code: "prompt-optimize-default",
      request_id: "prompt_request_api_001"
    });
  }
}

class FakeImageGenerationWorkerService {
  readonly taskIds: string[] = [];

  processTask(taskId: string): Promise<ImageTaskResult> {
    this.taskIds.push(taskId);

    return Promise.resolve({
      task: {
        ...createTaskResult(taskId, 479, "succeeded"),
        input_file_ids: ["file_input_001"],
        output_file_ids: ["file_generated_001"],
        text_result: "标题：清晨咖啡\n标签：咖啡、生活方式",
        gateway_request_id: "gateway_request_001"
      }
    });
  }
}

class FakeFileService {
  readonly assertOwnedRequests: { ownerUserId: number; fileIds: string[] }[] = [];

  assertFilesOwned(ownerUserId: number, fileIds: string[]) {
    this.assertOwnedRequests.push({ ownerUserId, fileIds });

    return Promise.resolve();
  }

  uploadFile() {
    return Promise.reject(new Error("测试不需要上传文件"));
  }

  createDownloadUrl() {
    return Promise.reject(new Error("测试不需要下载文件"));
  }

  readPreviewFile() {
    return Promise.reject(new Error("测试不需要预览文件"));
  }

  createPreviewUrls(_ownerUserId: number, fileIds: string[]) {
    return Promise.resolve(
      fileIds.map((fileId) => {
        const isInput = fileId.startsWith("file_input");

        return {
          file: {
            id: fileId,
            owner_user_id: 479,
            file_type: isInput ? "input" : "output",
            original_name: isInput ? "input.png" : "generated.png",
            mime_type: "image/png",
            storage_provider: "minio",
            storage_bucket: "molinimage",
            storage_key: isInput ? "uploads/479/input.png" : "generated/479/generated.png",
            size_bytes: 10,
            width: isInput ? 120 : 480,
            height: isInput ? 80 : 320,
            checksum: "checksum",
            created_at: "2026-07-09T00:00:00.000Z"
          },
          preview_url: isInput
            ? "https://storage.example.com/input.png"
            : "https://storage.example.com/generated.png",
          download_url: isInput
            ? "https://storage.example.com/input.png"
            : "https://storage.example.com/generated.png",
          expires_at: "2026-07-09T00:05:00.000Z"
        };
      })
    );
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
  imageTaskService: FakeImageTaskService,
  imageGenerationWorkerService?: FakeImageGenerationWorkerService,
  fileService?: FakeFileService,
  promptOptimizationService?: FakePromptOptimizationService
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer(
    createAppRequestHandler(testConfig, {
      launchTicketVerifier: new FakeLaunchTicketVerifier(),
      imageTaskService,
      imageGenerationWorkerService,
      fileService,
      promptOptimizationService
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

function createTaskResult(
  id: string,
  ownerUserId: number,
  status: ImageTaskResult["task"]["status"]
) {
  return {
    id,
    owner_user_id: ownerUserId,
    task_type: "text_to_image",
    status,
    prompt: "一张 AI 海报",
    negative_prompt: null,
    style_preset_id: null,
    input_file_ids: [],
    output_file_ids: [],
    text_result: null,
    gateway_model_code: "image-gen-default",
    gateway_capability: "image_generation",
    gateway_request_id: null,
    quality: null,
    image_size: "1024x1024",
    image_count: 1,
    upscale_factor: null,
    source_task_id: null,
    source_file_id: null,
    cost_points: null,
    billing_event_id: null,
    error_code: null,
    error_message: null,
    is_favorited: false,
    deleted_at: null,
    created_at: "2026-07-09T00:00:00.000Z",
    updated_at: "2026-07-09T00:00:00.000Z"
  };
}
