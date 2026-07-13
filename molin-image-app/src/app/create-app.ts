import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, normalize, resolve, sep } from "node:path";

import type { AppConfig } from "../config/app-config.js";
import type { BillingService } from "../modules/billing/billing-service.js";
import { BillingServiceError } from "../modules/billing/billing-service.js";
import type { BillingRecordService } from "../modules/billing/billing-record-service.js";
import { BillingRecordServiceError } from "../modules/billing/billing-record-service.js";
import type { BillingReconciliationService } from "../modules/billing/billing-reconciliation-service.js";
import { BillingReconciliationServiceError } from "../modules/billing/billing-reconciliation-service.js";
import type {
  PricingRuleAuditContext,
  PricingRuleService,
  SavePricingRuleRequest
} from "../modules/billing/pricing-rule-service.js";
import { PricingRuleServiceError } from "../modules/billing/pricing-rule-service.js";
import type { FileService } from "../modules/files/file-service.js";
import { FileServiceError } from "../modules/files/file-service.js";
import type {
  SaveStylePresetRequest,
  StylePresetService
} from "../modules/style-presets/style-preset-service.js";
import { StylePresetServiceError } from "../modules/style-presets/style-preset-service.js";
import type {
  ImageTaskService,
  ImageTaskStatus
} from "../modules/image-tasks/image-task-service.js";
import { ImageTaskServiceError } from "../modules/image-tasks/image-task-service.js";
import { RiskControlServiceError } from "../modules/risk-control/risk-control-service.js";
import type { ImageModelService } from "../modules/image-models/image-model-service.js";
import { ImageModelServiceError } from "../modules/image-models/image-model-service.js";
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
    | "uploadFile"
    | "createDownloadUrl"
    | "createPreviewUrls"
    | "readPreviewFile"
    | "assertFilesOwned"
  >;
  imageModelService?: Pick<ImageModelService, "listVisibleImageModels"> &
    Partial<
      Pick<ImageModelService, "listManagedModels" | "syncModelCatalog" | "updateManagedModel">
    >;
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
  billingService?: Pick<BillingService, "estimate" | "getBalance">;
  billingRecordService?: Pick<BillingRecordService, "listUserRecords">;
  billingReconciliationService?: Pick<
    BillingReconciliationService,
    "listPending" | "retryRelease" | "retrySettle"
  >;
  pricingRuleService?: Pick<PricingRuleService, "listRules" | "createRule" | "updateRule">;
  stylePresetService?: Pick<
    StylePresetService,
    "createPreset" | "listManagedPresets" | "listVisiblePresets" | "updatePreset"
  >;
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

  if (request.method === "GET" && url.pathname === "/admin/pricing") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (!isAdminUser(session.user_id, config.adminUserIds)) {
      writeError(response, 403, requestId, "ADMIN_FORBIDDEN", "当前用户没有价格管理权限。");
      return;
    }

    await servePublicFile(response, requestId, "admin-pricing.html");
    return;
  }

  if (request.method === "GET" && url.pathname === "/admin/models") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (!isAdminUser(session.user_id, config.adminUserIds)) {
      writeError(response, 403, requestId, "ADMIN_FORBIDDEN", "当前用户没有模型管理权限。");
      return;
    }

    await servePublicFile(response, requestId, "admin-models.html");
    return;
  }

  if (request.method === "GET" && url.pathname === "/admin/styles") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (!isAdminUser(session.user_id, config.adminUserIds)) {
      writeError(response, 403, requestId, "ADMIN_FORBIDDEN", "当前用户没有风格模板管理权限。");
      return;
    }

    await servePublicFile(response, requestId, "admin-styles.html");
    return;
  }

  if (request.method === "GET" && url.pathname === "/admin/reconciliation") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (!isAdminUser(session.user_id, config.adminUserIds)) {
      writeError(response, 403, requestId, "ADMIN_FORBIDDEN", "当前用户没有对账管理权限。");
      return;
    }

    await servePublicFile(response, requestId, "admin-reconciliation.html");
    return;
  }

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

  if (request.method === "GET" && url.pathname === "/billing") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    // 消耗记录页包含用户积分流水，只允许已建立墨灵应用 session 的用户访问。
    await servePublicFile(response, requestId, "billing.html");
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

  if (url.pathname === "/api/admin/image/pricing-rules") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (!isAdminUser(session.user_id, config.adminUserIds)) {
      writeError(response, 403, requestId, "ADMIN_FORBIDDEN", "当前用户没有价格管理权限。");
      return;
    }

    if (dependencies.pricingRuleService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "PRICING_RULE_SERVICE_UNAVAILABLE",
        "价格规则服务暂不可用。"
      );
      return;
    }

    await handlePricingRules(request, response, requestId, dependencies.pricingRuleService, {
      actorUserId: session.user_id,
      source: "admin_session",
      requestId
    });
    return;
  }

  const adminPricingRuleMatch = /^\/api\/admin\/image\/pricing-rules\/([^/]+)$/u.exec(url.pathname);

  if (request.method === "PATCH" && adminPricingRuleMatch !== null) {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (!isAdminUser(session.user_id, config.adminUserIds)) {
      writeError(response, 403, requestId, "ADMIN_FORBIDDEN", "当前用户没有价格管理权限。");
      return;
    }

    if (dependencies.pricingRuleService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "PRICING_RULE_SERVICE_UNAVAILABLE",
        "价格规则服务暂不可用。"
      );
      return;
    }

    await handleUpdatePricingRule(
      request,
      response,
      requestId,
      decodeURIComponent(adminPricingRuleMatch[1]),
      dependencies.pricingRuleService,
      { actorUserId: session.user_id, source: "admin_session", requestId }
    );
    return;
  }

  if (url.pathname === "/api/internal/image/pricing-rules") {
    if (!hasValidInternalToken(request, config.internalApiToken)) {
      writeError(response, 401, requestId, "INTERNAL_UNAUTHORIZED", "内部接口令牌无效。");
      return;
    }

    if (dependencies.pricingRuleService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "PRICING_RULE_SERVICE_UNAVAILABLE",
        "价格规则服务暂不可用。"
      );
      return;
    }

    await handlePricingRules(request, response, requestId, dependencies.pricingRuleService, {
      actorUserId: null,
      source: "internal_api",
      requestId
    });
    return;
  }

  const pricingRuleMatch = /^\/api\/internal\/image\/pricing-rules\/([^/]+)$/u.exec(url.pathname);

  if (request.method === "PATCH" && pricingRuleMatch !== null) {
    if (!hasValidInternalToken(request, config.internalApiToken)) {
      writeError(response, 401, requestId, "INTERNAL_UNAUTHORIZED", "内部接口令牌无效。");
      return;
    }

    if (dependencies.pricingRuleService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "PRICING_RULE_SERVICE_UNAVAILABLE",
        "价格规则服务暂不可用。"
      );
      return;
    }

    await handleUpdatePricingRule(
      request,
      response,
      requestId,
      decodeURIComponent(pricingRuleMatch[1]),
      dependencies.pricingRuleService,
      { actorUserId: null, source: "internal_api", requestId }
    );
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

  if (request.method === "GET" && url.pathname === "/api/image/style-presets") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (dependencies.stylePresetService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "STYLE_PRESET_SERVICE_UNAVAILABLE",
        "风格模板服务暂不可用。"
      );
      return;
    }

    await handleVisibleStylePresets(url, response, requestId, dependencies.stylePresetService);
    return;
  }

  if (url.pathname === "/api/admin/image/models") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (!isAdminUser(session.user_id, config.adminUserIds)) {
      writeError(response, 403, requestId, "ADMIN_FORBIDDEN", "当前用户没有模型管理权限。");
      return;
    }

    if (
      dependencies.imageModelService?.listManagedModels === undefined ||
      dependencies.imageModelService.syncModelCatalog === undefined
    ) {
      writeError(
        response,
        503,
        requestId,
        "IMAGE_MODEL_SERVICE_UNAVAILABLE",
        "模型管理服务暂不可用。"
      );
      return;
    }

    await handleAdminImageModels(
      request,
      response,
      requestId,
      session.user_id,
      dependencies.imageModelService as Pick<
        ImageModelService,
        "listManagedModels" | "syncModelCatalog"
      >
    );
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/admin/image/models/sync") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (!isAdminUser(session.user_id, config.adminUserIds)) {
      writeError(response, 403, requestId, "ADMIN_FORBIDDEN", "当前用户没有模型管理权限。");
      return;
    }

    if (dependencies.imageModelService?.syncModelCatalog === undefined) {
      writeError(
        response,
        503,
        requestId,
        "IMAGE_MODEL_SERVICE_UNAVAILABLE",
        "模型管理服务暂不可用。"
      );
      return;
    }

    await handleSyncImageModels(
      response,
      requestId,
      session.user_id,
      dependencies.imageModelService as Pick<ImageModelService, "syncModelCatalog">
    );
    return;
  }

  const adminImageModelMatch = /^\/api\/admin\/image\/models\/([^/]+)$/u.exec(url.pathname);

  if (request.method === "PATCH" && adminImageModelMatch !== null) {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (!isAdminUser(session.user_id, config.adminUserIds)) {
      writeError(response, 403, requestId, "ADMIN_FORBIDDEN", "当前用户没有模型管理权限。");
      return;
    }

    if (dependencies.imageModelService?.updateManagedModel === undefined) {
      writeError(
        response,
        503,
        requestId,
        "IMAGE_MODEL_SERVICE_UNAVAILABLE",
        "模型管理服务暂不可用。"
      );
      return;
    }

    await handleUpdateImageModel(
      request,
      response,
      requestId,
      session.user_id,
      decodeURIComponent(adminImageModelMatch[1]),
      dependencies.imageModelService as Pick<ImageModelService, "updateManagedModel">
    );
    return;
  }

  if (url.pathname === "/api/admin/image/style-presets") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (!isAdminUser(session.user_id, config.adminUserIds)) {
      writeError(response, 403, requestId, "ADMIN_FORBIDDEN", "当前用户没有风格模板管理权限。");
      return;
    }

    if (dependencies.stylePresetService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "STYLE_PRESET_SERVICE_UNAVAILABLE",
        "风格模板服务暂不可用。"
      );
      return;
    }

    await handleAdminStylePresets(request, response, requestId, dependencies.stylePresetService);
    return;
  }

  const adminStylePresetMatch = /^\/api\/admin\/image\/style-presets\/([^/]+)$/u.exec(url.pathname);

  if (request.method === "PATCH" && adminStylePresetMatch !== null) {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (!isAdminUser(session.user_id, config.adminUserIds)) {
      writeError(response, 403, requestId, "ADMIN_FORBIDDEN", "当前用户没有风格模板管理权限。");
      return;
    }

    if (dependencies.stylePresetService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "STYLE_PRESET_SERVICE_UNAVAILABLE",
        "风格模板服务暂不可用。"
      );
      return;
    }

    await handleUpdateStylePreset(
      request,
      response,
      requestId,
      decodeURIComponent(adminStylePresetMatch[1]),
      dependencies.stylePresetService
    );
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

  if (request.method === "GET" && url.pathname === "/api/billing/balance") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (dependencies.billingService === undefined) {
      writeError(response, 503, requestId, "BILLING_SERVICE_UNAVAILABLE", "计费服务暂不可用。");
      return;
    }

    // 余额查询使用当前 session 的 user_id 和 entitlement_id，浏览器不能指定他人权益。
    await handleBillingBalance(
      response,
      requestId,
      session.user_id,
      session.entitlement_id,
      dependencies.billingService
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/billing/records") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (dependencies.billingRecordService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "BILLING_RECORD_SERVICE_UNAVAILABLE",
        "消耗记录服务暂不可用。"
      );
      return;
    }

    // 消耗记录只允许按当前 session 用户分页读取，避免 URL 参数越权查询其他用户流水。
    await handleBillingRecords(
      url,
      response,
      requestId,
      session.user_id,
      dependencies.billingRecordService
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/admin/image/billing-reconciliation") {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (!isAdminUser(session.user_id, config.adminUserIds)) {
      writeError(response, 403, requestId, "ADMIN_FORBIDDEN", "当前用户没有对账管理权限。");
      return;
    }

    if (dependencies.billingReconciliationService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "BILLING_RECONCILIATION_SERVICE_UNAVAILABLE",
        "对账管理服务暂不可用。"
      );
      return;
    }

    await handleBillingReconciliationList(
      url,
      response,
      requestId,
      dependencies.billingReconciliationService
    );
    return;
  }

  const billingReconciliationActionMatch =
    /^\/api\/admin\/image\/billing-reconciliation\/([^/]+)\/(retry-settle|retry-release)$/u.exec(
      url.pathname
    );

  if (request.method === "POST" && billingReconciliationActionMatch !== null) {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (!isAdminUser(session.user_id, config.adminUserIds)) {
      writeError(response, 403, requestId, "ADMIN_FORBIDDEN", "当前用户没有对账管理权限。");
      return;
    }

    if (dependencies.billingReconciliationService === undefined) {
      writeError(
        response,
        503,
        requestId,
        "BILLING_RECONCILIATION_SERVICE_UNAVAILABLE",
        "对账管理服务暂不可用。"
      );
      return;
    }

    await handleBillingReconciliationAction(
      response,
      requestId,
      session.user_id,
      decodeURIComponent(billingReconciliationActionMatch[1]),
      billingReconciliationActionMatch[2],
      dependencies.billingReconciliationService
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
      config,
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
      request,
      response,
      requestId,
      config,
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
  const filePreviewMatch = /^\/api\/files\/([^/]+)\/preview$/u.exec(url.pathname);

  if (request.method === "GET" && filePreviewMatch !== null) {
    if (session === undefined) {
      writeError(response, 401, requestId, "UNAUTHORIZED", "请先从墨灵平台进入应用。");
      return;
    }

    if (dependencies.fileService === undefined) {
      writeError(response, 503, requestId, "FILE_SERVICE_UNAVAILABLE", "文件服务暂不可用。");
      return;
    }

    await handleFilePreview(
      url,
      response,
      requestId,
      session.user_id,
      filePreviewMatch[1],
      dependencies.fileService
    );
    return;
  }

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
  config: AppConfig,
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
      expectedPricingRuleId: readNullableStringField(body, "expected_price_rule_id"),
      expectedPoints: readOptionalStringField(body, "expected_points"),
      idempotencyKey:
        readHeader(request, "idempotency-key") ?? readOptionalStringField(body, "idempotency_key"),
      requestId,
      requestIp: getClientIp(request, config.trustProxy),
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
    const result = await billingService.estimate({
      ownerUserId,
      taskType: readStringField(body, "task_type"),
      imageCount: readOptionalNumberField(body, "image_count"),
      quality: readOptionalStringField(body, "quality"),
      imageSize: readOptionalStringField(body, "image_size"),
      upscaleFactor: readOptionalNumberField(body, "upscale_factor"),
      gatewayModelCode: readOptionalStringField(body, "gateway_model_code"),
      gatewayCapability: readOptionalStringField(body, "gateway_capability")
    });

    writeJson(response, 200, result);
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleBillingBalance(
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  entitlementId: number | undefined,
  billingService: Pick<BillingService, "getBalance">
): Promise<void> {
  try {
    writeJson(
      response,
      200,
      await billingService.getBalance({
        ownerUserId,
        entitlementId
      })
    );
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleBillingRecords(
  url: URL,
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  billingRecordService: Pick<BillingRecordService, "listUserRecords">
): Promise<void> {
  try {
    // 这里不读取 owner_user_id 查询参数，确保服务层始终使用当前 session 的用户身份。
    const records = await billingRecordService.listUserRecords({
      ownerUserId,
      page: readPositiveIntegerQuery(url, "page", 1),
      pageSize: readPositiveIntegerQuery(url, "page_size", 20)
    });

    writeJson(response, 200, records);
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handlePricingRules(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  service: Pick<PricingRuleService, "listRules" | "createRule">,
  auditContext: PricingRuleAuditContext
): Promise<void> {
  try {
    if (request.method === "GET") {
      writeJson(response, 200, await service.listRules());
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request);
      writeJson(
        response,
        201,
        await service.createRule(
          readPricingRuleRequest(body, false) as SavePricingRuleRequest,
          auditContext
        )
      );
      return;
    }

    writeError(response, 405, requestId, "METHOD_NOT_ALLOWED", "请求方法不支持。");
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleUpdatePricingRule(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  ruleId: string,
  service: Pick<PricingRuleService, "updateRule">,
  auditContext: PricingRuleAuditContext
): Promise<void> {
  try {
    const body = await readJsonBody(request);
    writeJson(
      response,
      200,
      await service.updateRule(ruleId, readPricingRuleRequest(body, true), auditContext)
    );
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

function readPricingRuleRequest(
  body: Record<string, unknown>,
  partial: boolean
): SavePricingRuleRequest | Partial<SavePricingRuleRequest> {
  if (!partial) {
    return {
      taskType: readStringField(body, "task_type"),
      gatewayModelCode: readNullableStringField(body, "gateway_model_code"),
      gatewayCapability: readNullableStringField(body, "gateway_capability"),
      quality: readNullableStringField(body, "quality"),
      imageSize: readNullableStringField(body, "image_size"),
      upscaleFactor: readNullableNumberField(body, "upscale_factor"),
      usageType: readStringField(body, "usage_type"),
      unit: readOptionalStringField(body, "unit"),
      pointsPerUnit: readStringField(body, "points_per_unit"),
      active: readOptionalBooleanField(body, "active")
    };
  }

  const result: Partial<SavePricingRuleRequest> = {};

  // PATCH 只传递请求中实际出现的字段，避免禁用规则时意外清空模型、质量或尺寸维度。
  assignIfPresent(body, "task_type", result, "taskType", readOptionalStringField);
  assignIfPresent(body, "gateway_model_code", result, "gatewayModelCode", readNullableStringField);
  assignIfPresent(body, "gateway_capability", result, "gatewayCapability", readNullableStringField);
  assignIfPresent(body, "quality", result, "quality", readNullableStringField);
  assignIfPresent(body, "image_size", result, "imageSize", readNullableStringField);
  assignIfPresent(body, "upscale_factor", result, "upscaleFactor", readNullableNumberField);
  assignIfPresent(body, "usage_type", result, "usageType", readOptionalStringField);
  assignIfPresent(body, "unit", result, "unit", readOptionalStringField);
  assignIfPresent(body, "points_per_unit", result, "pointsPerUnit", readOptionalStringField);
  assignIfPresent(body, "active", result, "active", readOptionalBooleanField);

  return result;
}

function assignIfPresent<Target extends object, Key extends keyof Target>(
  body: Record<string, unknown>,
  sourceKey: string,
  target: Target,
  targetKey: Key,
  reader: (body: Record<string, unknown>, key: string) => Target[Key]
): void {
  if (sourceKey in body) {
    target[targetKey] = reader(body, sourceKey);
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
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  config: AppConfig,
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
      entitlementId,
      { requestId, requestIp: getClientIp(request, config.trustProxy) }
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
        const enriched = await attachOutputPreviewsForHistory({ task }, ownerUserId, fileService);

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

async function attachOutputPreviewsForHistory(
  result: Awaited<ReturnType<Pick<ImageTaskService, "getTask">["getTask"]>>,
  ownerUserId: number,
  fileService: Pick<FileService, "createPreviewUrls"> | undefined
) {
  try {
    return await attachOutputPreviews(result, ownerUserId, fileService);
  } catch {
    // 历史列表不能因为某个旧文件的预览 URL 生成失败就整体变空；任务记录先返回，详情页再暴露具体文件问题。
    return {
      ...result,
      input_files: [],
      result_files: []
    };
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

async function handleBillingReconciliationList(
  url: URL,
  response: ServerResponse,
  requestId: string,
  reconciliationService: Pick<BillingReconciliationService, "listPending">
): Promise<void> {
  try {
    const result = await reconciliationService.listPending({
      page: readPositiveIntegerQuery(url, "page", 1),
      pageSize: readPositiveIntegerQuery(url, "page_size", 20)
    });

    writeJson(response, 200, result);
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleBillingReconciliationAction(
  response: ServerResponse,
  requestId: string,
  actorUserId: number,
  taskId: string,
  action: string,
  reconciliationService: Pick<BillingReconciliationService, "retryRelease" | "retrySettle">
): Promise<void> {
  try {
    const result =
      action === "retry-settle"
        ? await reconciliationService.retrySettle({ actorUserId, taskId, requestId })
        : await reconciliationService.retryRelease({ actorUserId, taskId, requestId });

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

async function handleAdminImageModels(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  imageModelService: Pick<ImageModelService, "listManagedModels" | "syncModelCatalog">
): Promise<void> {
  try {
    if (request.method === "GET") {
      const result = await imageModelService.listManagedModels(ownerUserId);
      writeJson(response, 200, result);
      return;
    }

    writeError(response, 405, requestId, "METHOD_NOT_ALLOWED", "请求方法不支持。");
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleSyncImageModels(
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  imageModelService: Pick<ImageModelService, "syncModelCatalog">
): Promise<void> {
  try {
    // 同步只读取服务端模型目录环境变量并写入管理态，不接收浏览器传入的模型密钥或网关参数。
    const result = await imageModelService.syncModelCatalog(ownerUserId);
    writeJson(response, 200, result);
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleUpdateImageModel(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  modelId: string,
  imageModelService: Pick<ImageModelService, "updateManagedModel">
): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const result = await imageModelService.updateManagedModel(
      modelId,
      readUpdateImageModelRequest(body),
      ownerUserId
    );

    writeJson(response, 200, result);
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

function readUpdateImageModelRequest(body: Record<string, unknown>) {
  const result: {
    displayName?: string;
    description?: string;
    capability?: string;
    adminEnabled?: boolean;
    supportedTaskTypes?: string[];
    supportedImageSizes?: string[];
    maxInputFiles?: number;
    maxOutputCount?: number;
    sortOrder?: number;
    defaultTaskTypes?: string[];
  } = {};

  assignIfPresent(body, "display_name", result, "displayName", readOptionalStringField);
  assignIfPresent(body, "description", result, "description", readOptionalStringField);
  assignIfPresent(body, "capability", result, "capability", readOptionalStringField);
  assignIfPresent(body, "admin_enabled", result, "adminEnabled", readOptionalBooleanField);
  assignIfPresent(
    body,
    "supported_task_types",
    result,
    "supportedTaskTypes",
    readOptionalStringArrayField
  );
  assignIfPresent(
    body,
    "supported_image_sizes",
    result,
    "supportedImageSizes",
    readOptionalStringArrayField
  );
  assignIfPresent(body, "max_input_files", result, "maxInputFiles", readOptionalNumberField);
  assignIfPresent(body, "max_output_count", result, "maxOutputCount", readOptionalNumberField);
  assignIfPresent(body, "sort_order", result, "sortOrder", readOptionalNumberField);
  assignIfPresent(
    body,
    "default_task_types",
    result,
    "defaultTaskTypes",
    readOptionalStringArrayField
  );

  return result;
}

async function handleVisibleStylePresets(
  url: URL,
  response: ServerResponse,
  requestId: string,
  stylePresetService: Pick<StylePresetService, "listVisiblePresets">
): Promise<void> {
  try {
    const result = await stylePresetService.listVisiblePresets(
      url.searchParams.get("task_type") ?? undefined
    );

    writeJson(response, 200, result);
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleAdminStylePresets(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  stylePresetService: Pick<StylePresetService, "createPreset" | "listManagedPresets">
): Promise<void> {
  try {
    if (request.method === "GET") {
      const result = await stylePresetService.listManagedPresets();
      writeJson(response, 200, result);
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request);
      const result = await stylePresetService.createPreset(readSaveStylePresetRequest(body));
      writeJson(response, 201, result);
      return;
    }

    writeError(response, 405, requestId, "METHOD_NOT_ALLOWED", "请求方法不支持。");
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

async function handleUpdateStylePreset(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  presetId: string,
  stylePresetService: Pick<StylePresetService, "updatePreset">
): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const result = await stylePresetService.updatePreset(
      presetId,
      readPatchStylePresetRequest(body)
    );

    writeJson(response, 200, result);
  } catch (error: unknown) {
    writePublicError(response, requestId, error);
  }
}

function readSaveStylePresetRequest(body: Record<string, unknown>): SaveStylePresetRequest {
  return {
    name: readStringField(body, "name"),
    category: readStringField(body, "category"),
    taskType: readStringField(body, "task_type"),
    promptTemplate: readStringField(body, "prompt_template"),
    previewImageFileId: readNullableStringField(body, "preview_image_file_id"),
    previewImageUrl: readNullableStringField(body, "preview_image_url"),
    enabled: readOptionalBooleanField(body, "enabled"),
    sortOrder: readOptionalNumberField(body, "sort_order")
  };
}

function readPatchStylePresetRequest(
  body: Record<string, unknown>
): Partial<SaveStylePresetRequest> {
  const result: Partial<SaveStylePresetRequest> = {};

  assignIfPresent(body, "name", result, "name", readOptionalStringField);
  assignIfPresent(body, "category", result, "category", readOptionalStringField);
  assignIfPresent(body, "task_type", result, "taskType", readOptionalStringField);
  assignIfPresent(body, "prompt_template", result, "promptTemplate", readOptionalStringField);
  assignIfPresent(
    body,
    "preview_image_file_id",
    result,
    "previewImageFileId",
    readNullableStringField
  );
  assignIfPresent(body, "preview_image_url", result, "previewImageUrl", readNullableStringField);
  assignIfPresent(body, "enabled", result, "enabled", readOptionalBooleanField);
  assignIfPresent(body, "sort_order", result, "sortOrder", readOptionalNumberField);

  return result;
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

async function handleFilePreview(
  url: URL,
  response: ServerResponse,
  requestId: string,
  ownerUserId: number,
  fileId: string,
  fileService: Pick<FileService, "readPreviewFile">
): Promise<void> {
  try {
    const result = await fileService.readPreviewFile(ownerUserId, decodeURIComponent(fileId));

    response.statusCode = 200;
    response.setHeader("X-Request-Id", requestId);
    response.setHeader("content-type", result.file.mime_type);
    response.setHeader("content-length", String(result.body.byteLength));
    response.setHeader("cache-control", "private, max-age=300");

    if (url.searchParams.get("download") === "1") {
      response.setHeader(
        "content-disposition",
        `attachment; filename="${encodeHeaderFileName(result.file.original_name ?? result.file.id)}"`
      );
    }

    response.end(result.body);
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

function encodeHeaderFileName(fileName: string): string {
  // Content-Disposition 只放 ASCII 安全文件名，避免换行或引号破坏响应头。
  return fileName.replace(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 120);
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

  if (error instanceof BillingRecordServiceError) {
    writeError(response, error.statusCode, requestId, error.code, error.message);
    return;
  }

  if (error instanceof BillingReconciliationServiceError) {
    writeError(response, error.statusCode, requestId, error.code, error.message);
    return;
  }

  if (error instanceof PricingRuleServiceError) {
    writeError(response, error.statusCode, requestId, error.code, error.message);
    return;
  }

  if (error instanceof ImageModelServiceError) {
    writeError(response, error.statusCode, requestId, error.code, error.message);
    return;
  }

  if (error instanceof StylePresetServiceError) {
    writeError(response, error.statusCode, requestId, error.code, error.message);
    return;
  }

  if (error instanceof RiskControlServiceError) {
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

function readNullableStringField(
  body: Record<string, unknown>,
  key: string
): string | null | undefined {
  if (!(key in body)) {
    return undefined;
  }

  const value = body[key];

  if (value === null || value === "") {
    return null;
  }

  return readOptionalStringField(body, key);
}

function readNullableNumberField(
  body: Record<string, unknown>,
  key: string
): number | null | undefined {
  if (!(key in body)) {
    return undefined;
  }

  return body[key] === null ? null : readOptionalNumberField(body, key);
}

function readOptionalBooleanField(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new RequestBodyError("REQUEST_FIELD_INVALID", `字段 ${key} 格式不正确。`, 400);
  }

  return value;
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

function getClientIp(request: IncomingMessage, trustProxy: boolean): string {
  const forwardedFor = readHeader(request, "x-forwarded-for");
  const firstForwardedIp = forwardedFor?.split(",")[0]?.trim();

  // 只有确认入口代理会覆盖 X-Forwarded-For 时才信任该头，避免直连用户伪造 IP 绕过限流。
  return trustProxy && firstForwardedIp && firstForwardedIp.length > 0
    ? firstForwardedIp
    : (request.socket.remoteAddress ?? "unknown");
}

function hasValidInternalToken(request: IncomingMessage, expectedToken: string): boolean {
  const authorization = readHeader(request, "authorization") ?? "";
  const suppliedToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(expectedToken);

  // 长度不同不能调用 timingSafeEqual；统一拒绝且不把 token 写入日志或错误响应。
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isAdminUser(userId: number, adminUserIds: number[] | undefined): boolean {
  // 管理权限只来源于服务端白名单，浏览器提交的 user_id 不参与判断。
  return adminUserIds?.includes(userId) === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
