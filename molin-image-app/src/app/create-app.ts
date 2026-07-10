import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, normalize, resolve, sep } from "node:path";

import type { AppConfig } from "../config/app-config.js";
import type { BillingService } from "../modules/billing/billing-service.js";
import { BillingServiceError } from "../modules/billing/billing-service.js";
import type { FileService } from "../modules/files/file-service.js";
import { FileServiceError } from "../modules/files/file-service.js";
import type {
  ImageTaskService,
  ImageTaskStatus
} from "../modules/image-tasks/image-task-service.js";
import { ImageTaskServiceError } from "../modules/image-tasks/image-task-service.js";
import type { ImageModelService } from "../modules/image-models/image-model-service.js";
import {
  MolingTicketError,
  type LaunchTicketVerifier
} from "../infrastructure/moling/moling-client.js";
import { createHealthResponse } from "../modules/health/health.service.js";
import type { ImageGenerationWorkerService } from "../workers/image-generation-worker-service.js";
import {
  InMemorySessionStore,
  readCookie,
  serializeExpiredSessionCookie,
  serializeSessionCookie
} from "../modules/auth/session-store.js";

export interface AppDependencies {
  launchTicketVerifier: LaunchTicketVerifier;
  sessionStore?: InMemorySessionStore;
  fileService?: Pick<
    FileService,
    "uploadFile" | "createDownloadUrl" | "createPreviewUrls" | "assertFilesOwned"
  >;
  imageModelService?: Pick<ImageModelService, "listVisibleImageModels">;
  imageTaskService?: Pick<
    ImageTaskService,
    | "createTask"
    | "deleteHistoryItem"
    | "favoriteHistoryItem"
    | "getTask"
    | "listHistory"
    | "retryTask"
    | "transitionTask"
  >;
  billingService?: Pick<BillingService, "estimate">;
  imageGenerationWorkerService?: Pick<ImageGenerationWorkerService, "processTask">;
}

export function createAppRequestHandler(config: AppConfig, dependencies: AppDependencies) {
  const sessionStore = dependencies.sessionStore ?? new InMemorySessionStore();

  return (request: IncomingMessage, response: ServerResponse): void => {
    void handleRequest(request, response, config, dependencies, sessionStore);
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: AppConfig,
  dependencies: AppDependencies,
  sessionStore: InMemorySessionStore
): Promise<void> {
  const requestId = randomUUID();
  const url = new URL(request.url ?? "/", config.appBaseUrl);
  const sessionToken = readCookie(request, config.sessionCookieName);
  const session = sessionStore.getSession(sessionToken);

  response.setHeader("X-Request-Id", requestId);

  if (
    request.method === "GET" &&
    (url.pathname === "/" || url.pathname === "/enter" || url.pathname === "/auth/launch")
  ) {
    if (url.searchParams.has("ticket")) {
      await handleLaunch(
        url,
        response,
        requestId,
        config,
        dependencies.launchTicketVerifier,
        sessionStore
      );
      return;
    }

    if (url.pathname === "/enter" || url.pathname === "/auth/launch") {
      writeError(
        response,
        400,
        requestId,
        "LAUNCH_TICKET_REQUIRED",
        "缺少 ticket，请从墨灵平台重新进入应用。"
      );
      return;
    }

    await servePublicFile(response, requestId, "index.html");
    return;
  }

  if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
    await servePublicFile(response, requestId, url.pathname.slice(1));
    return;
  }

  if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/health")) {
    writeJson(response, 200, createHealthResponse());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/me") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    writeJson(response, 200, {
      user_id: session.user_id,
      app_id: session.app_id,
      product_id: session.product_id,
      entitlement_id: session.entitlement_id ?? null,
      session_expires_at: session.expires_at
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/image/models") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (dependencies.imageModelService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "IMAGE_MODEL_SERVICE_UNAVAILABLE",
        "模型目录服务暂不可用。"
      );
      return;
    }

    await handleImageModels(response, requestId, session.user_id, dependencies.imageModelService);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/billing/estimate") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (dependencies.billingService === undefined) {
      writeError(response, 503, requestId, "BILLING_SERVICE_UNAVAILABLE", "计费服务暂不可用。");
      return;
    }

    await handleBillingEstimate(
      request,
      response,
      requestId,
      session.user_id,
      dependencies.billingService
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/files") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (dependencies.fileService === undefined) {
      writeError(response, 503, requestId, "FILE_SERVICE_UNAVAILABLE", "文件服务暂不可用。");
      return;
    }

    await handleFileUpload(request, response, requestId, session.user_id, dependencies.fileService);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/image/tasks") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (dependencies.imageTaskService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "IMAGE_TASK_SERVICE_UNAVAILABLE",
        "图片任务服务暂不可用。"
      );
      return;
    }

    await handleCreateImageTask(
      request,
      response,
      requestId,
      session.user_id,
      session.entitlement_id,
      dependencies.imageTaskService,
      dependencies.imageGenerationWorkerService,
      dependencies.fileService
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/image/history") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (dependencies.imageTaskService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "IMAGE_TASK_SERVICE_UNAVAILABLE",
        "图片任务服务暂不可用。"
      );
      return;
    }

    await handleImageHistory(
      url,
      response,
      requestId,
      session.user_id,
      dependencies.imageTaskService,
      dependencies.fileService
    );
    return;
  }

  const imageHistoryFavoriteMatch = /^\/api\/image\/history\/([^/]+)\/favorite$/u.exec(
    url.pathname
  );

  if (request.method === "POST" && imageHistoryFavoriteMatch !== null) {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (dependencies.imageTaskService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "IMAGE_TASK_SERVICE_UNAVAILABLE",
        "图片任务服务暂不可用。"
      );
      return;
    }

    await handleFavoriteHistoryItem(
      response,
      requestId,
      session.user_id,
      imageHistoryFavoriteMatch[1],
      dependencies.imageTaskService,
      dependencies.fileService
    );
    return;
  }

  const imageHistoryDeleteMatch = /^\/api\/image\/history\/([^/]+)$/u.exec(url.pathname);

  if (request.method === "DELETE" && imageHistoryDeleteMatch !== null) {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (dependencies.imageTaskService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "IMAGE_TASK_SERVICE_UNAVAILABLE",
        "图片任务服务暂不可用。"
      );
      return;
    }

    await handleDeleteHistoryItem(
      response,
      requestId,
      session.user_id,
      imageHistoryDeleteMatch[1],
      dependencies.imageTaskService
    );
    return;
  }

  const imageTaskMatch = /^\/api\/image\/tasks\/([^/]+)$/u.exec(url.pathname);

  if (request.method === "GET" && imageTaskMatch !== null) {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (dependencies.imageTaskService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "IMAGE_TASK_SERVICE_UNAVAILABLE",
        "图片任务服务暂不可用。"
      );
      return;
    }

    await handleGetImageTask(
      response,
      requestId,
      session.user_id,
      imageTaskMatch[1],
      dependencies.imageTaskService,
      dependencies.fileService
    );
    return;
  }

  const imageTaskRetryMatch = /^\/api\/image\/tasks\/([^/]+)\/retry$/u.exec(url.pathname);

  if (request.method === "POST" && imageTaskRetryMatch !== null) {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (dependencies.imageTaskService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "IMAGE_TASK_SERVICE_UNAVAILABLE",
        "图片任务服务暂不可用。"
      );
      return;
    }

    await handleRetryImageTask(
      response,
      requestId,
      session.user_id,
      session.entitlement_id,
      imageTaskRetryMatch[1],
      dependencies.imageTaskService,
      dependencies.imageGenerationWorkerService,
      dependencies.fileService
    );
    return;
  }

  const imageTaskTransitionMatch = /^\/api\/image\/tasks\/([^/]+)\/transitions$/u.exec(
    url.pathname
  );

  if (request.method === "POST" && imageTaskTransitionMatch !== null) {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (dependencies.imageTaskService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "IMAGE_TASK_SERVICE_UNAVAILABLE",
        "图片任务服务暂不可用。"
      );
      return;
    }

    await handleTransitionImageTask(
      request,
      response,
      requestId,
      session.user_id,
      imageTaskTransitionMatch[1],
      dependencies.imageTaskService
    );
    return;
  }

  const downloadUrlMatch = /^\/api\/files\/([^/]+)\/download-url$/u.exec(url.pathname);

  if (request.method === "GET" && downloadUrlMatch !== null) {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (dependencies.fileService === undefined) {
      writeError(response, 503, requestId, "FILE_SERVICE_UNAVAILABLE", "文件服务暂不可用。");
      return;
    }

    await handleDownloadUrl(
      response,
      requestId,
      session.user_id,
      downloadUrlMatch[1],
      dependencies.fileService
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    sessionStore.deleteSession(sessionToken);
    response.setHeader(
      "Set-Cookie",
      serializeExpiredSessionCookie(config.sessionCookieName, config.sessionCookieSecure)
    );
    writeJson(response, 200, { ok: true });
    return;
  }

  writeError(response, 404, requestId, "NOT_FOUND", "接口不存在。");
}

async function handleCreateImageTask(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  entitlementId: number | undefined,
  imageTaskService: Pick<ImageTaskService, "createTask">,
  imageGenerationWorkerService: Pick<ImageGenerationWorkerService, "processTask"> | undefined,
  fileService: Pick<FileService, "createPreviewUrls" | "assertFilesOwned"> | undefined
): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const taskType = readStringField(body, "task_type");
    const inputFileIds = readOptionalStringArrayField(body, "input_file_ids");

    if (
      (taskType === "image_to_text" ||
        taskType === "image_to_image" ||
        taskType === "image_restore" ||
        taskType === "upscale") &&
      fileService !== undefined
    ) {
      // 创建依赖输入图的任务前先校验归属，避免还没进 worker 就写入越权 file_id。
      await fileService.assertFilesOwned(ownerUserId, inputFileIds ?? []);
    }

    const result = await imageTaskService.createTask({
      ownerUserId,
      taskType,
      prompt: readOptionalStringField(body, "prompt"),
      negativePrompt: readOptionalStringField(body, "negative_prompt"),
      stylePresetId: readOptionalStringField(body, "style_preset_id"),
      inputFileIds,
      gatewayModelCode: readOptionalStringField(body, "gateway_model_code"),
      gatewayCapability: readOptionalStringField(body, "gateway_capability"),
      quality: readOptionalStringField(body, "quality"),
      imageSize: readOptionalStringField(body, "image_size"),
      imageCount: readOptionalNumberField(body, "image_count"),
      upscaleFactor: readOptionalNumberField(body, "upscale_factor"),
      sourceTaskId: readOptionalStringField(body, "source_task_id"),
      idempotencyKey:
        readHeader(request, "idempotency-key") ?? readOptionalStringField(body, "idempotency_key"),
      entitlementId
    });

    if (taskType === "text_to_image" && imageGenerationWorkerService !== undefined) {
      // P2 阶段先使用进程内 worker 处理单个任务；后续接 Redis 后复用同一个 processTask。
      const processedResult = await imageGenerationWorkerService.processTask(result.task.id);
      const enrichedResult = await attachOutputPreviews(processedResult, ownerUserId, fileService);

      writeJson(response, 201, enrichedResult);
      return;
    }

    if (
      (taskType === "image_to_text" ||
        taskType === "image_to_image" ||
        taskType === "image_restore" ||
        taskType === "upscale") &&
      imageGenerationWorkerService !== undefined
    ) {
      // 依赖输入图的任务复用进程内 worker，后续接 Redis 后只需投递 task_id。
      const processedResult = await imageGenerationWorkerService.processTask(result.task.id);

      writeJson(
        response,
        201,
        await attachOutputPreviews(processedResult, ownerUserId, fileService)
      );
      return;
    }

    writeJson(response, 201, await attachOutputPreviews(result, ownerUserId, fileService));
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleBillingEstimate(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  billingService: Pick<BillingService, "estimate">
): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const result = billingService.estimate({
      ownerUserId,
      taskType: readStringField(body, "task_type"),
      imageCount: readOptionalNumberField(body, "image_count"),
      quality: readOptionalStringField(body, "quality"),
      imageSize: readOptionalStringField(body, "image_size"),
      upscaleFactor: readOptionalNumberField(body, "upscale_factor")
    });

    writeJson(response, 200, result);
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleGetImageTask(
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  taskId: string,
  imageTaskService: Pick<ImageTaskService, "getTask">,
  fileService: Pick<FileService, "createPreviewUrls"> | undefined
): Promise<void> {
  try {
    const result = await imageTaskService.getTask(ownerUserId, decodeURIComponent(taskId));

    writeJson(response, 200, await attachOutputPreviews(result, ownerUserId, fileService));
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleRetryImageTask(
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  entitlementId: number | undefined,
  taskId: string,
  imageTaskService: Pick<ImageTaskService, "retryTask">,
  imageGenerationWorkerService: Pick<ImageGenerationWorkerService, "processTask"> | undefined,
  fileService: Pick<FileService, "createPreviewUrls"> | undefined
): Promise<void> {
  try {
    const retryResult = await imageTaskService.retryTask(
      ownerUserId,
      decodeURIComponent(taskId),
      entitlementId
    );

    if (imageGenerationWorkerService !== undefined) {
      // P2 阶段沿用进程内 worker；后续接 Redis 后这里只需要返回新 task 并由队列异步处理。
      const processedResult = await imageGenerationWorkerService.processTask(retryResult.task.id);

      writeJson(response, 201, {
        ...(await attachOutputPreviews(processedResult, ownerUserId, fileService)),
        retried_from_task_id: retryResult.retried_from_task_id
      });
      return;
    }

    writeJson(response, 201, {
      ...(await attachOutputPreviews(retryResult, ownerUserId, fileService)),
      retried_from_task_id: retryResult.retried_from_task_id
    });
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleImageHistory(
  url: URL,
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  imageTaskService: Pick<ImageTaskService, "listHistory">,
  fileService: Pick<FileService, "createPreviewUrls"> | undefined
): Promise<void> {
  try {
    const history = await imageTaskService.listHistory({
      ownerUserId,
      taskType: url.searchParams.get("task_type") ?? undefined,
      page: readPositiveIntegerQuery(url, "page", 1),
      pageSize: readPositiveIntegerQuery(url, "page_size", 20)
    });
    const items = await Promise.all(
      history.items.map(async (task) => {
        const enriched = await attachOutputPreviews({ task }, ownerUserId, fileService);

        return {
          ...task,
          input_files: enriched.input_files,
          result_files: enriched.result_files
        };
      })
    );

    // 历史接口遵循统一分页结构，文本结果直接随 task.text_result 返回，图片结果附带短期预览 URL。
    writeJson(response, 200, {
      items,
      page: history.page,
      page_size: history.page_size,
      total: history.total
    });
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleFavoriteHistoryItem(
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  taskId: string,
  imageTaskService: Pick<ImageTaskService, "favoriteHistoryItem">,
  fileService: Pick<FileService, "createPreviewUrls"> | undefined
): Promise<void> {
  try {
    const result = await imageTaskService.favoriteHistoryItem(
      ownerUserId,
      decodeURIComponent(taskId)
    );

    // 收藏后回传最新任务状态和预览 URL，方便前端无需额外刷新即可更新卡片。
    writeJson(response, 200, await attachOutputPreviews(result, ownerUserId, fileService));
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleDeleteHistoryItem(
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  taskId: string,
  imageTaskService: Pick<ImageTaskService, "deleteHistoryItem">
): Promise<void> {
  try {
    const result = await imageTaskService.deleteHistoryItem(
      ownerUserId,
      decodeURIComponent(taskId)
    );

    // 删除历史仅软删除数据库记录，响应保持轻量，前端随后刷新当前筛选列表。
    writeJson(response, 200, result);
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function attachOutputPreviews(
  result: Awaited<ReturnType<Pick<ImageTaskService, "getTask">["getTask"]>>,
  ownerUserId: number,
  fileService: Pick<FileService, "createPreviewUrls"> | undefined
) {
  if (fileService === undefined) {
    return {
      ...result,
      input_files: [],
      result_files: []
    };
  }

  return {
    ...result,
    input_files:
      result.task.input_file_ids.length > 0
        ? await fileService.createPreviewUrls(ownerUserId, result.task.input_file_ids)
        : [],
    result_files:
      result.task.output_file_ids.length > 0
        ? await fileService.createPreviewUrls(ownerUserId, result.task.output_file_ids)
        : []
  };
}

async function handleTransitionImageTask(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  taskId: string,
  imageTaskService: Pick<ImageTaskService, "transitionTask">
): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const result = await imageTaskService.transitionTask({
      ownerUserId,
      taskId: decodeURIComponent(taskId),
      toStatus: readStringField(body, "status") as ImageTaskStatus,
      outputFileIds: readOptionalStringArrayField(body, "output_file_ids"),
      textResult: readOptionalStringField(body, "text_result"),
      gatewayRequestId: readOptionalStringField(body, "gateway_request_id"),
      billingEventId: readOptionalStringField(body, "billing_event_id"),
      errorCode: readOptionalStringField(body, "error_code"),
      errorMessage: readOptionalStringField(body, "error_message")
    });

    writeJson(response, 200, result);
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleFileUpload(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  fileService: Pick<FileService, "uploadFile">
): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const result = await fileService.uploadFile({
      ownerUserId,
      fileName: readStringField(body, "file_name"),
      mimeType: readStringField(body, "mime_type"),
      contentBase64: readStringField(body, "content_base64"),
      fileType: readOptionalStringField(body, "file_type")
    });

    writeJson(response, 201, result);
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleImageModels(
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  imageModelService: Pick<ImageModelService, "listVisibleImageModels">
): Promise<void> {
  try {
    // 模型目录仍经过后端 session 边界；当前 env 实现对所有登录用户一致，后续网关实现可按 ownerUserId 过滤。
    const result = await imageModelService.listVisibleImageModels(ownerUserId);

    writeJson(response, 200, result);
  } catch {
    void requestId;
    writeJson(response, 200, {
      items: [],
      required_capabilities: configSafeRequiredCapabilitiesFallback(),
      missing_required_capabilities: configSafeRequiredCapabilitiesFallback(),
      message: "当前暂无可用图片模型，请检查 IMAGE_MODEL_CATALOG_JSON 或稍后再试。",
      source: "env"
    });
  }
}

function configSafeRequiredCapabilitiesFallback(): string[] {
  return ["image_generation", "vision_text", "moderation"];
}

async function handleDownloadUrl(
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  fileId: string,
  fileService: Pick<FileService, "createDownloadUrl">
): Promise<void> {
  try {
    const result = await fileService.createDownloadUrl(ownerUserId, decodeURIComponent(fileId));

    writeJson(response, 200, result);
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleLaunch(
  url: URL,
  response: ServerResponse,
  requestId: string,
  config: AppConfig,
  launchTicketVerifier: LaunchTicketVerifier,
  sessionStore: InMemorySessionStore
): Promise<void> {
  const ticket = url.searchParams.get("ticket")?.trim();

  if (ticket === undefined || ticket.length === 0) {
    writeError(
      response,
      400,
      requestId,
      "LAUNCH_TICKET_REQUIRED",
      "缺少 ticket，请从墨灵平台重新进入应用。"
    );
    return;
  }

  try {
    const identity = await launchTicketVerifier.verifyLaunchTicket(ticket);

    if (identity.app_id !== config.molingAppId || identity.product_id !== config.molingProductId) {
      // ticket 必须绑定当前应用和商品，避免其它应用的票据被拿来串用。
      writeError(response, 403, requestId, "LAUNCH_APP_MISMATCH", "票据不属于当前应用或商品。");
      return;
    }

    const createdSession = sessionStore.createSession(identity, config.sessionTtlSeconds);

    response.statusCode = 302;
    response.setHeader("Location", "/");
    response.setHeader(
      "Set-Cookie",
      serializeSessionCookie({
        cookieName: config.sessionCookieName,
        token: createdSession.token,
        ttlSeconds: config.sessionTtlSeconds,
        secure: config.sessionCookieSecure
      })
    );
    response.end();
  } catch (error: unknown) {
    if (error instanceof MolingTicketError) {
      const statusCode = error.code === "LAUNCH_TICKET_INVALID" ? 401 : 502;
      writeError(response, statusCode, requestId, error.code, error.message);
      return;
    }

    writeError(response, 502, requestId, "MOLING_VERIFY_FAILED", "墨灵票据校验失败，请稍后重试。");
  }
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);

  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  response.end(payload);
}

async function servePublicFile(
  response: ServerResponse,
  requestId: string,
  publicPath: string
): Promise<void> {
  try {
    const publicRoot = resolve(process.cwd(), "public");
    const filePath = resolve(publicRoot, normalize(publicPath));

    if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${sep}`)) {
      writeError(response, 404, requestId, "NOT_FOUND", "资源不存在。");
      return;
    }

    const content = await readFile(filePath);
    const contentType = resolveStaticContentType(filePath);

    response.writeHead(200, {
      "content-type": contentType,
      "content-length": content.byteLength,
      "cache-control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=300"
    });
    response.end(content);
  } catch {
    writeError(response, 404, requestId, "NOT_FOUND", "资源不存在。");
  }
}

function resolveStaticContentType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();

  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }

  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }

  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }

  return "application/octet-stream";
}

function writeError(
  response: ServerResponse,
  statusCode: number,
  requestId: string,
  code: string,
  message: string
): void {
  writeJson(response, statusCode, {
    error: {
      code,
      message,
      request_id: requestId
    }
  });
}

function writePublicError(response: ServerResponse, requestId: string, error: unknown): void {
  if (error instanceof FileServiceError) {
    writeError(response, error.statusCode, requestId, error.code, error.message);
    return;
  }

  if (error instanceof ImageTaskServiceError) {
    writeError(response, error.statusCode, requestId, error.code, error.message);
    return;
  }

  if (error instanceof BillingServiceError) {
    writeError(response, error.statusCode, requestId, error.code, error.message);
    return;
  }

  if (error instanceof RequestBodyError) {
    writeError(response, error.statusCode, requestId, error.code, error.message);
    return;
  }

  writeError(response, 500, requestId, "INTERNAL_ERROR", "服务器内部错误。");
}

class RequestBodyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "RequestBodyError";
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const maxBodyBytes = 12 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    receivedBytes += buffer.byteLength;

    if (receivedBytes > maxBodyBytes) {
      throw new RequestBodyError("REQUEST_BODY_TOO_LARGE", "请求体过大。", 413);
    }

    chunks.push(buffer);
  }

  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;

    if (!isRecord(payload)) {
      throw new RequestBodyError("REQUEST_JSON_INVALID", "请求 JSON 格式不正确。", 400);
    }

    return payload;
  } catch (error: unknown) {
    if (error instanceof RequestBodyError) {
      throw error;
    }

    throw new RequestBodyError("REQUEST_JSON_INVALID", "请求 JSON 格式不正确。", 400);
  }
}

function readStringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RequestBodyError("REQUEST_FIELD_REQUIRED", `缺少字段 ${key}。`, 400);
  }

  return value;
}

function readOptionalStringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new RequestBodyError("REQUEST_FIELD_INVALID", `字段 ${key} 格式不正确。`, 400);
  }

  const trimmed = value.trim();

  // 可选字符串允许浏览器表单提交空值；服务端统一按未传处理，避免前端空输入破坏可选契约。
  return trimmed.length === 0 ? undefined : trimmed;
}

function readOptionalStringArrayField(
  body: Record<string, unknown>,
  key: string
): string[] | undefined {
  const value = body[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new RequestBodyError("REQUEST_FIELD_INVALID", `字段 ${key} 格式不正确。`, 400);
  }

  return value;
}

function readOptionalNumberField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number") {
    throw new RequestBodyError("REQUEST_FIELD_INVALID", `字段 ${key} 格式不正确。`, 400);
  }

  return value;
}

function readPositiveIntegerQuery(url: URL, key: string, defaultValue: number): number {
  const rawValue = url.searchParams.get(key);

  if (rawValue === null || rawValue.trim().length === 0) {
    return defaultValue;
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value < 1) {
    throw new RequestBodyError("REQUEST_FIELD_INVALID", `字段 ${key} 必须是正整数。`, 400);
  }

  return value;
}

function readHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
