import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";

import { createAppRequestHandler } from "../src/app/create-app.js";
import type { AppConfig } from "../src/config/app-config.js";
import { InMemorySessionStore } from "../src/modules/auth/session-store.js";
import type {
  LaunchTicketVerifier,
  MolingLaunchIdentity
} from "../src/infrastructure/moling/moling-client.js";
import type { ImageModelListResult } from "../src/modules/image-models/image-model-service.js";

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
  sessionCookieName: "molinimage_session",
  sessionCookieSecure: false,
  sessionTtlSeconds: 86400,
  port: 0
};

void test("根路径返回工作台首屏 HTML，静态资源可访问", async () => {
  const app = await startTestApp();

  try {
    const htmlResponse = await fetch(`${app.baseUrl}/`);
    const html = await htmlResponse.text();
    const jsResponse = await fetch(`${app.baseUrl}/assets/workbench.js`);
    const imageEditModesResponse = await fetch(`${app.baseUrl}/assets/image-to-image-modes.js`);
    const imageRestoreModesResponse = await fetch(`${app.baseUrl}/assets/image-restore-modes.js`);
    const cssResponse = await fetch(`${app.baseUrl}/assets/styles.css`);

    assert.equal(htmlResponse.status, 200);
    assert.match(htmlResponse.headers.get("content-type") ?? "", /text\/html/);
    assert.match(html, /墨灵 AI 图片创作/);
    assert.match(html, /id="modelList"/);
    assert.match(html, /id="stylePresetList"/);
    assert.match(html, /id="taskProgress"/);
    assert.match(html, /id="parameterPanelToggle"/);
    assert.match(html, /id="textToImageSteps"/);
    assert.match(html, /data-creation-step="1"/);
    assert.match(html, /data-creation-step="4"/);
    assert.match(html, /id="styleCategoryFilters"/);
    assert.match(html, /id="textToImageParameterChoices"/);
    assert.match(html, /id="textToImageConfirmation"/);
    assert.match(html, /id="workflowNextButton"/);
    assert.match(html, /id="imageToImageSteps"/);
    assert.match(html, /data-image-edit-step="4"/);
    assert.match(html, /id="imageRestoreSteps"/);
    assert.match(html, /data-image-restore-step="4"/);
    assert.equal(jsResponse.status, 200);
    assert.match(jsResponse.headers.get("content-type") ?? "", /text\/javascript/);
    assert.equal(cssResponse.status, 200);
    assert.match(cssResponse.headers.get("content-type") ?? "", /text\/css/);
    assert.equal(imageEditModesResponse.status, 200);
    assert.equal(imageRestoreModesResponse.status, 200);
  } finally {
    await app.close();
  }
});

void test("前端 API 封装只访问应用后端接口", async () => {
  const apiClient = await readFile(resolve("public", "assets", "api-client.js"), "utf8");
  const workbench = await readFile(resolve("public", "assets", "workbench.js"), "utf8");
  const frontendSource = `${apiClient}\n${workbench}`;

  assert.match(frontendSource, /\/api\/me/);
  assert.match(frontendSource, /\/api\/image\/models/);
  assert.match(frontendSource, /\/api\/image\/prompts\/optimize/);
  assert.match(frontendSource, /\/api\/image\/style-presets/);
  assert.match(frontendSource, /\/api\/billing\/estimate/);
  assert.match(frontendSource, /\/api\/image\/tasks/);
  assert.match(frontendSource, /\/api\/files/);
  assert.match(frontendSource, /\/api\/image\/history/);
  assert.match(apiClient, /page_size/);
  assert.match(frontendSource, /renderHistoryLoadError/);
  assert.match(workbench, /summarizeTextResult/);
  assert.match(workbench, /history-text-open/);
  assert.match(workbench, /new DataTransfer\(\)/);
  assert.doesNotMatch(frontendSource, /catch\s*\{\s*renderHistory\(\[\]\)/);
  assert.match(frontendSource, /retryImageTask/);
  assert.match(frontendSource, /uploadImageFile/);
  assert.match(frontendSource, /window\.confirm/);
  assert.doesNotMatch(frontendSource, /openrouter\.ai/i);
  assert.doesNotMatch(frontendSource, /minio/i);
  assert.doesNotMatch(frontendSource, /\/api\/internal/i);
});

void test("工作台五种图片能力统一使用异步轮询、幂等提交和刷新恢复", async () => {
  const apiClient = await readFile(resolve("public", "assets", "api-client.js"), "utf8");
  const workbench = await readFile(resolve("public", "assets", "workbench.js"), "utf8");
  const poller = await readFile(resolve("public", "assets", "image-task-poller.js"), "utf8");

  assert.match(apiClient, /"idempotency-key"/);
  // 五种首次提交路径加一条刷新重放路径，全部复用同一提交函数。
  assert.equal(workbench.match(/await createQueuedImageTask\(/g)?.length, 6);
  assert.match(workbench, /molinimage:active-image-task:v1/);
  assert.match(workbench, /molinimage:pending-image-submission:v1/);
  assert.match(workbench, /window\.sessionStorage\.setItem/);
  assert.match(workbench, /restoreActiveImageTask\(\)/);
  assert.match(workbench, /window\.addEventListener\("pagehide"/);
  assert.match(workbench, /window\.addEventListener\("online"/);
  assert.match(workbench, /retryImageTask[\s\S]*acceptAsyncImageTask/);
  assert.match(poller, /nextDelayMs \* 2/);
  assert.match(poller, /onTransientError/);
  assert.match(poller, /onTerminalError/);
  assert.match(poller, /isTerminalImageTaskStatus/);
  assert.match(poller, /isActiveImageTaskStatus/);
  assert.match(workbench, /clearActiveImageTask/);
});

void test("终态结果统一提供创建新任务入口并防止重复点击", async () => {
  const workbench = await readFile(resolve("public", "assets", "workbench.js"), "utf8");
  const styles = await readFile(resolve("public", "assets", "styles.css"), "utf8");

  assert.match(workbench, /appendTerminalTaskActions/);
  assert.match(workbench, /创建新任务/);
  assert.match(workbench, /isStartingNewTask/);
  assert.match(workbench, /task.status === "failed"[\s\S]*重试/);
  assert.match(styles, /\.terminal-task-actions/);
  assert.match(styles, /@media[\s\S]*\.terminal-task-actions/);
});

void test("创建新任务会建立新的幂等草稿并安全清理旧任务上下文", async () => {
  const workbench = await readFile(resolve("public", "assets", "workbench.js"), "utf8");

  assert.match(workbench, /function startNewDraft/);
  assert.match(workbench, /draftIdempotencyKey/);
  assert.match(workbench, /state\.draftIdempotencyKey \?\? createSubmissionIdempotencyKey\(\)/);
  assert.match(
    workbench,
    /function startNewDraft[\s\S]*clearActiveImageTask\(\)[\s\S]*sessionStorage\.removeItem\(pendingSubmissionStorageKey\)/
  );
  assert.match(workbench, /function resetCreationFormForMode/);
  assert.match(workbench, /textToImageStep = 1/);
  assert.match(workbench, /imageToImageStep = 1/);
  assert.match(workbench, /imageRestoreStep = 1/);
  assert.match(workbench, /imageTaskPoller\.stop\(\)/);
});

void test("MVP 前端源码覆盖余额禁用、进度、下载、复制和风格模板体验", async () => {
  const html = await readFile(resolve("public", "index.html"), "utf8");
  const workbench = await readFile(resolve("public", "assets", "workbench.js"), "utf8");
  const modelDisplay = await readFile(resolve("public", "assets", "model-display.js"), "utf8");
  const workbenchModes = await readFile(resolve("public", "assets", "workbench-modes.js"), "utf8");
  const imageEditModes = await readFile(
    resolve("public", "assets", "image-to-image-modes.js"),
    "utf8"
  );
  const imageRestoreModes = await readFile(
    resolve("public", "assets", "image-restore-modes.js"),
    "utf8"
  );
  const annotationEditor = await readFile(
    resolve("public", "assets", "image-annotation-editor.js"),
    "utf8"
  );
  const envExample = await readFile(resolve(".env.example"), "utf8");
  const taskDetailFormat = await readFile(
    resolve("public", "assets", "task-detail-format.js"),
    "utf8"
  );
  const styles = await readFile(resolve("public", "assets", "styles.css"), "utf8");

  assert.match(html, /预计积分/);
  assert.match(html, /id="imageInput"/);
  assert.match(html, /id="promptOptimizeButton"/);
  assert.match(html, /id="promptOptimizationOverlay"/);
  assert.match(html, /id="historyLoadMore"/);
  assert.match(html, /id="stylePresetSelect"/);
  assert.match(html, /id="stylePresetList"/);
  assert.match(html, /id="imageToImageModePicker"/);
  assert.match(html, /id="imageToImageParameterChoices"/);
  assert.match(html, /id="imageToImageConfirmation"/);
  assert.match(html, /id="openImageMaskEditor"/);
  assert.match(html, /id="imageRestoreModePicker"/);
  assert.match(html, /id="imageRestoreParameterChoices"/);
  assert.match(html, /id="imageRestoreConfirmation"/);
  assert.match(html, /id="openRestoreMaskEditor"/);
  assert.match(html, /data-annotation-tool="eraser"/);
  assert.match(html, /data-mode="image_to_text"/);
  assert.match(html, /data-mode="upscale"/);
  assert.match(html, /id="upscaleFactorSelect"/);
  assert.match(html, /id="sizeGuide"/);
  assert.match(html, /模型目录/);
  assert.doesNotMatch(html, /MODEL CATALOG/);
  assert.match(html, /768x1024/);
  assert.match(html, /1536x1024/);
  assert.doesNotMatch(html, /1792x1024/);
  assert.doesNotMatch(html, /2048x1536/);
  assert.match(workbenchModes, /imageSizeOptions/);
  assert.match(workbenchModes, /supportsPromptInput: false/);
  assert.match(workbench, /config\.supportsPromptInput !== true/);
  assert.match(workbench, /prompt: undefined/);
  assert.match(workbenchModes, /PPT 配图/);
  assert.match(workbenchModes, /横版封面/);
  assert.doesNotMatch(workbenchModes, /1536x2048/);
  assert.match(workbench, /optimizeCurrentPrompt/);
  assert.match(workbench, /setPromptOptimizationLoading\(true\)/);
  assert.match(workbench, /setPromptOptimizationLoading\(false\)/);
  assert.match(workbench, /renderGenerationLoading/);
  assert.match(workbench, /updateGenerationLoadingStage\(stage\)/);
  assert.match(workbench, /primaryAction\.dataset\.loading/);
  assert.match(workbench, /refreshHistory\(\{ append: true \}\)/);
  assert.match(workbench, /getImageHistory\(state\.mode, page, state\.historyPageSize\)/);
  assert.doesNotMatch(workbench, /items\.slice\(0, 6\)/);
  assert.match(workbench, /AI 优化/);
  assert.match(styles, /compact-button/);
  assert.match(workbench, /renderImageSizeOptions/);
  assert.match(workbench, /renderImageToImageWorkflow/);
  assert.match(workbench, /validateImageToImageStep/);
  assert.match(workbench, /renderImageEditModeCards/);
  assert.match(workbench, /renderImageEditDynamicParameters/);
  assert.match(workbench, /selectHistoryImageSource/);
  assert.match(workbench, /composeImageEditPrompt/);
  assert.match(workbench, /isSelectedImageEditModelCompatible/);
  assert.match(workbench, /renderImageRestoreWorkflow/);
  assert.match(workbench, /validateImageRestoreStep/);
  assert.match(workbench, /isSelectedImageRestoreModelCompatible/);
  assert.match(workbench, /createImageRestoreComparison/);
  assert.match(workbench, /imageRestoreAnnotationApplied/);
  assert.match(imageRestoreModes, /smart_restore/);
  assert.match(imageRestoreModes, /local_repair/);
  assert.match(imageRestoreModes, /remove_object/);
  assert.match(imageRestoreModes, /composeImageRestorePrompt/);
  assert.match(imageRestoreModes, /validateImageRestoreMode/);
  assert.match(workbench, /renderImageSizeGuide/);
  assert.match(workbench, /尺寸用途说明从统一配置渲染/);
  assert.match(workbench, /supported_image_sizes/);
  assert.match(workbench, /当前模型不支持/);
  assert.match(workbench, /resolveModelCapabilityLabel/);
  assert.match(modelDisplay, /图片生成/);
  assert.match(modelDisplay, /图片编辑/);
  assert.match(modelDisplay, /图片理解/);
  assert.match(modelDisplay, /提示词优化/);
  assert.match(modelDisplay, /内容审核/);
  assert.match(modelDisplay, /高清放大/);
  assert.match(modelDisplay, /其他能力/);
  assert.match(workbench, /resolveModelDisplayName/);
  assert.doesNotMatch(workbench, /"模型", task\.gateway_model_code/);
  assert.match(envExample, /"display_name":"通用图片生成"/);
  assert.match(envExample, /"display_name":"通用图生图"/);
  assert.match(envExample, /"display_name":"通用图片理解"/);
  assert.match(envExample, /"display_name":"通用提示词优化"/);
  assert.match(envExample, /"display_name":"通用内容审核"/);
  assert.doesNotMatch(envExample, /General Image|Prompt Optimization|Content Moderation/);
  assert.match(html, /id="taskDetailDrawer"/);
  assert.match(html, /id="annotationEditor"/);
  assert.match(html, /id="annotationCanvas"/);
  assert.match(html, /data-annotation-tool="brush"/);
  assert.match(html, /data-annotation-tool="rectangle"/);
  assert.match(html, /data-annotation-tool="marker"/);
  assert.match(html, /id="annotationPrompt"/);
  assert.match(workbench, /state\.estimate\?\.enough_balance === true/);
  assert.match(workbench, /renderProgress\("generating"\)/);
  assert.match(styles, /\.ai-operation-overlay/);
  assert.match(styles, /\.generation-loading/);
  assert.match(styles, /\.image-restore-mode-card/);
  assert.match(styles, /\.restore-compare-canvas/);
  assert.match(styles, /\.toggle-choice/);
  assert.match(styles, /@keyframes loading-track-move/);
  assert.match(styles, /@keyframes image-scan-line/);
  assert.match(styles, /\.field:has\(> select\)::after/);
  assert.match(styles, /#primaryAction\[data-loading="true"\]::before/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
  assert.match(workbench, /navigator\.clipboard\.writeText/);
  assert.match(workbench, /file\.download_url/);
  assert.match(workbench, /history-preview-button/);
  assert.match(workbench, /openTaskDetail\(task\.id, file\.file\.id\)/);
  assert.match(workbench, /focusedFileId/);
  assert.match(workbench, /下载原图/);
  assert.match(workbench, /submitImageToImageTask/);
  assert.match(workbench, /submitImageRestoreTask/);
  assert.match(workbench, /submitUpscaleTask/);
  assert.match(workbench, /getStylePresets/);
  assert.match(workbench, /style_preset_id: elements\.stylePresetSelect\.value \|\| undefined/);
  assert.match(workbench, /renderStylePresetList/);
  assert.match(workbench, /resolveStyleCategoryLabel/);
  assert.match(workbench, /renderTextToImageWorkflow/);
  assert.match(workbench, /validateTextToImageStep/);
  assert.match(workbench, /captureTextToImageDraft/);
  assert.match(workbench, /restoreTextToImageDraft/);
  assert.match(workbench, /renderCreationSummary/);
  assert.match(workbench, /createCreationSummarySection/);
  assert.match(workbench, /aria-current", "step"/);
  assert.match(workbench, /智能匹配/);
  assert.match(workbenchModes, /imageSizeGroups/);
  assert.match(workbenchModes, /styleCategoryOptions/);
  assert.match(workbench, /preset\.preview_image_url/);
  assert.match(workbench, /source_task_id: state\.sourceTaskId/);
  assert.match(workbench, /source_file_id: state\.sourceFileId/);
  assert.match(workbench, /state\.annotatedInputFile \?\? elements\.imageInput\.files/);
  assert.match(workbench, /openAnnotationEditor/);
  assert.match(workbench, /applyAnnotationForReedit/);
  assert.match(workbench, /toggleParameterPanel/);
  assert.match(workbench, /history-actions-trigger/);
  assert.match(workbench, /history-menu-action/);
  assert.match(workbench, /生成结果中不要保留任何标注/);
  assert.match(taskDetailFormat, /resolveTaskFailureMessage/);
  assert.match(taskDetailFormat, /maximumFractionDigits: 6/);
  assert.match(taskDetailFormat, /displayPoints/);
  assert.match(styles, /\.style-preset-card/);
  assert.match(styles, /\.creation-steps/);
  assert.match(styles, /\.creation-step\[data-status="active"\]/);
  assert.match(styles, /\.choice-filter\[data-selected="true"\]/);
  assert.match(styles, /\.size-choice-list/);
  assert.match(styles, /\.creation-summary-section/);
  assert.match(styles, /\.summary-edit-button/);
  assert.match(styles, /\.creation-step:not\(:last-child\)::after/);
  assert.match(styles, /\.workflow-actions/);
  assert.match(styles, /\.size-guide/);
  assert.match(styles, /\.tool-panel/);
  assert.match(styles, /\.submit-dock/);
  assert.match(styles, /\.model-catalog/);
  assert.match(styles, /\.annotation-editor/);
  assert.match(styles, /\.annotation-toolbar/);
  assert.equal(
    styles.match(/^:root\s*\{/gmu)?.length,
    1,
    "工作台只能保留一套根级设计变量，避免再次叠加多轮主题覆盖"
  );
  assert.match(styles, /\.history-action-menu/);
  assert.match(styles, /\.upload-dropzone/);
  assert.match(styles, /\.history-item\.is-text-result/);
  assert.match(styles, /history-menu-action\[data-action="delete"\]/);
  assert.match(styles, /\.history-preview-button/);
  assert.match(styles, /\.task-detail-file\.is-focused/);
  assert.match(styles, /body\.is-parameter-collapsed/);
  assert.match(styles, /position: fixed;/);
  assert.match(html, /class="creation-block creation-block-primary"/);
  assert.match(html, /class="size-guide-disclosure"/);
  assert.match(
    workbench,
    /elements\.sizeField\.hidden =\s+isTextToImage \|\| state\.mode === "image_to_text" \|\| state\.mode === "upscale"/
  );
  assert.match(
    workbench,
    /elements\.countField\.hidden =\s+isTextToImage \|\| state\.mode === "image_to_text" \|\| state\.mode === "upscale"/
  );
  assert.match(styles, /@media \(max-width: 900px\)/);
  assert.match(styles, /\.image-edit-mode-card/);
  assert.match(styles, /\.image-edit-dynamic-parameters/);
  assert.match(styles, /@keyframes image-edit-step-enter/);
  assert.match(styles, /body\[data-active-mode="image_to_image"\] \.submit-dock/);
  assert.match(annotationEditor, /"eraser"/);
  assert.match(annotationEditor, /橡皮擦只清除标注/);

  for (const modeCode of [
    "keep_subject",
    "change_background",
    "change_style",
    "variation",
    "inpaint",
    "outpaint",
    "product_scene",
    "portrait_retouch"
  ]) {
    assert.match(imageEditModes, new RegExp(`mode_code: "${modeCode}"`));
  }

  for (const configField of [
    "mode_code",
    "display_name",
    "description",
    "category",
    "preview",
    "prompt_placeholder",
    "supported_capabilities",
    "parameter_schema",
    "defaults"
  ]) {
    assert.match(imageEditModes, new RegExp(configField));
  }
});

void test("价格管理页覆盖多维规则、编辑和启停操作", async () => {
  const html = await readFile(resolve("public", "admin-pricing.html"), "utf8");
  const script = await readFile(resolve("public", "assets", "admin-pricing.js"), "utf8");
  const apiClient = await readFile(resolve("public", "assets", "admin-pricing-api.js"), "utf8");

  assert.match(html, /价格规则管理/);
  assert.match(html, /id="ruleCapability"/);
  assert.match(html, /id="ruleQuality"/);
  assert.match(html, /id="ruleImageSize"/);
  assert.match(html, /id="rulePoints"/);
  assert.match(script, /setPricingRuleActive\(rule\.id, !rule\.active\)/);
  assert.match(script, /window\.confirm/);
  assert.doesNotMatch(script, /\bfetch\(/);
  assert.match(apiClient, /\/api\/admin\/image\/pricing-rules/);
  assert.match(apiClient, /method: "PATCH"/);
});

void test("模型管理页覆盖同步、能力标签、默认模型和启停操作", async () => {
  const html = await readFile(resolve("public", "admin-models.html"), "utf8");
  const script = await readFile(resolve("public", "assets", "admin-models.js"), "utf8");
  const apiClient = await readFile(resolve("public", "assets", "admin-models-api.js"), "utf8");

  assert.match(html, /模型管理/);
  assert.match(html, /id="syncModels"/);
  assert.match(html, /id="capability"/);
  assert.match(html, /id="supportedTaskTypes"/);
  assert.match(html, /id="defaultTaskTypes"/);
  assert.match(script, /syncImageModels\(\)/);
  assert.match(script, /admin_enabled: elements\.adminEnabled\.checked/);
  assert.match(script, /updateImageModel\(model\.id, \{ admin_enabled: !model\.admin_enabled \}\)/);
  assert.doesNotMatch(script, /\bfetch\(/);
  assert.match(apiClient, /\/api\/admin\/image\/models/);
  assert.match(apiClient, /\/sync/);
  assert.match(apiClient, /method: "PATCH"/);
});

void test("风格模板管理页覆盖名称、分类、prompt、预览图、排序、启停和可见任务类型", async () => {
  const html = await readFile(resolve("public", "admin-styles.html"), "utf8");
  const script = await readFile(resolve("public", "assets", "admin-styles.js"), "utf8");
  const apiClient = await readFile(resolve("public", "assets", "admin-styles-api.js"), "utf8");

  assert.match(html, /风格模板管理/);
  assert.match(html, /id="presetName"/);
  assert.match(html, /id="presetCategory"/);
  assert.match(html, /id="presetPromptTemplate"/);
  assert.match(html, /id="presetPreviewUrl"/);
  assert.match(html, /id="presetSortOrder"/);
  assert.match(html, /id="presetEnabled"/);
  assert.match(html, /value="text_to_image"/);
  assert.match(html, /value="image_to_image"/);
  assert.match(html, /value="image_restore"/);
  assert.doesNotMatch(html, /value="image_to_text"/);
  assert.doesNotMatch(html, /value="upscale"/);
  assert.match(script, /setStylePresetEnabled\(preset\.id, !preset\.enabled\)/);
  assert.match(script, /prompt_template: elements\.promptTemplate\.value\.trim\(\)/);
  assert.match(script, /preview_image_url: emptyToNull\(elements\.previewUrl\.value\)/);
  assert.doesNotMatch(script, /\bfetch\(/);
  assert.match(apiClient, /\/api\/admin\/image\/style-presets/);
  assert.match(apiClient, /method: "PATCH"/);
});

void test("对账管理页覆盖待对账列表、重试结算、重试释放和结果追踪", async () => {
  const html = await readFile(resolve("public", "admin-reconciliation.html"), "utf8");
  const script = await readFile(resolve("public", "assets", "admin-reconciliation.js"), "utf8");
  const apiClient = await readFile(
    resolve("public", "assets", "admin-reconciliation-api.js"),
    "utf8"
  );

  assert.match(html, /对账管理/);
  assert.match(html, /id="reconciliationRows"/);
  assert.match(html, /id="reconciliationPrev"/);
  assert.match(html, /id="reconciliationNext"/);
  assert.match(script, /retrySettleTask\(task\.id\)/);
  assert.match(script, /retryReleaseTask\(task\.id\)/);
  assert.match(script, /pageSize = 20/);
  assert.match(script, /latest_reconciliation_result/);
  assert.match(script, /latest_billing_event_error_message/);
  assert.doesNotMatch(script, /\bfetch\(/);
  assert.match(apiClient, /\/api\/admin\/image\/billing-reconciliation/);
  assert.match(apiClient, /page_size/);
  assert.match(apiClient, /retry-settle/);
  assert.match(apiClient, /retry-release/);
});

void test("任务恢复管理页展示失败原因、计费状态并支持人工重投", async () => {
  const html = await readFile(resolve("public", "admin-task-recovery.html"), "utf8");
  const script = await readFile(resolve("public", "assets", "admin-task-recovery.js"), "utf8");
  const apiClient = await readFile(
    resolve("public", "assets", "admin-task-recovery-api.js"),
    "utf8"
  );

  assert.match(html, /最终失败任务/u);
  assert.match(html, /失败原因/u);
  assert.match(html, /计费状态/u);
  assert.match(script, /replayFailedTask/u);
  assert.match(script, /worker_attempt_count/u);
  assert.match(apiClient, /\/api\/admin\/image\/task-recovery/u);
  assert.match(apiClient, /\/replay/u);
});

void test("余额与消耗页覆盖积分汇总、消耗记录和任务详情跳转", async () => {
  const html = await readFile(resolve("public", "billing.html"), "utf8");
  const script = await readFile(resolve("public", "assets", "billing-records.js"), "utf8");
  const apiClient = await readFile(resolve("public", "assets", "api-client.js"), "utf8");

  assert.match(html, /消耗记录/);
  assert.match(html, /id="balancePoints"/);
  assert.match(html, /id="billingRecordList"/);
  assert.match(html, /id="billingPrevButton"/);
  assert.match(script, /getBillingRecords/);
  assert.match(script, /getBillingBalance/);
  assert.match(script, /record\.task_detail_url/);
  assert.match(script, /status_label/);
  assert.doesNotMatch(script, /\bfetch\(/);
  assert.match(apiClient, /\/api\/billing\/records/);
});

class FakeLaunchTicketVerifier implements LaunchTicketVerifier {
  verifyLaunchTicket(): Promise<MolingLaunchIdentity> {
    return Promise.resolve({
      user_id: 479,
      app_id: 990008,
      product_id: 990107
    });
  }
}

class FakeImageModelService {
  listVisibleImageModels(): Promise<ImageModelListResult> {
    return Promise.resolve({
      items: [],
      required_capabilities: ["image_generation", "vision_text", "moderation"],
      missing_required_capabilities: ["image_generation", "vision_text", "moderation"],
      message: "当前暂无可用图片模型，请稍后再试。",
      source: "env"
    });
  }
}

async function startTestApp(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer(
    createAppRequestHandler(testConfig, {
      launchTicketVerifier: new FakeLaunchTicketVerifier(),
      sessionStore: new InMemorySessionStore(),
      imageModelService: new FakeImageModelService()
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
