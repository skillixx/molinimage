import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";

import { createAppRequestHandler } from "../src/app/create-app.js";
import type { AppConfig } from "../src/config/app-config.js";
import type {
  LaunchTicketVerifier,
  MolingLaunchIdentity
} from "../src/infrastructure/moling/moling-client.js";
import type { ImageModelListResult } from "../src/modules/image-models/image-model-service.js";

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
  internalApiToken: "test_internal_token",
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
    const cssResponse = await fetch(`${app.baseUrl}/assets/styles.css`);

    assert.equal(htmlResponse.status, 200);
    assert.match(htmlResponse.headers.get("content-type") ?? "", /text\/html/);
    assert.match(html, /墨灵 AI 图片创作/);
    assert.match(html, /id="modelList"/);
    assert.match(html, /id="stylePresetList"/);
    assert.match(html, /id="taskProgress"/);
    assert.equal(jsResponse.status, 200);
    assert.match(jsResponse.headers.get("content-type") ?? "", /text\/javascript/);
    assert.equal(cssResponse.status, 200);
    assert.match(cssResponse.headers.get("content-type") ?? "", /text\/css/);
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
  assert.match(frontendSource, /\/api\/image\/style-presets/);
  assert.match(frontendSource, /\/api\/billing\/estimate/);
  assert.match(frontendSource, /\/api\/image\/tasks/);
  assert.match(frontendSource, /\/api\/files/);
  assert.match(frontendSource, /\/api\/image\/history/);
  assert.match(frontendSource, /retryImageTask/);
  assert.match(frontendSource, /uploadImageFile/);
  assert.match(frontendSource, /window\.confirm/);
  assert.doesNotMatch(frontendSource, /openrouter\.ai/i);
  assert.doesNotMatch(frontendSource, /minio/i);
  assert.doesNotMatch(frontendSource, /\/api\/internal/i);
});

void test("MVP 前端源码覆盖余额禁用、进度、下载、复制和风格模板体验", async () => {
  const html = await readFile(resolve("public", "index.html"), "utf8");
  const workbench = await readFile(resolve("public", "assets", "workbench.js"), "utf8");
  const taskDetailFormat = await readFile(
    resolve("public", "assets", "task-detail-format.js"),
    "utf8"
  );
  const styles = await readFile(resolve("public", "assets", "styles.css"), "utf8");

  assert.match(html, /预计积分/);
  assert.match(html, /id="imageInput"/);
  assert.match(html, /id="stylePresetSelect"/);
  assert.match(html, /id="stylePresetList"/);
  assert.match(html, /data-mode="image_to_text"/);
  assert.match(html, /data-mode="upscale"/);
  assert.match(html, /id="upscaleFactorSelect"/);
  assert.match(html, /id="taskDetailDrawer"/);
  assert.match(workbench, /state\.estimate\?\.enough_balance === true/);
  assert.match(workbench, /renderProgress\("generating"\)/);
  assert.match(workbench, /navigator\.clipboard\.writeText/);
  assert.match(workbench, /file\.download_url/);
  assert.match(workbench, /submitImageToImageTask/);
  assert.match(workbench, /submitImageRestoreTask/);
  assert.match(workbench, /submitUpscaleTask/);
  assert.match(workbench, /getStylePresets/);
  assert.match(workbench, /style_preset_id: elements\.stylePresetSelect\.value \|\| undefined/);
  assert.match(workbench, /renderStylePresetList/);
  assert.match(workbench, /preset\.preview_image_url/);
  assert.match(workbench, /source_task_id: state\.sourceTaskId/);
  assert.match(taskDetailFormat, /resolveTaskFailureMessage/);
  assert.match(styles, /\.style-preset-card/);
  assert.match(styles, /@media \(max-width: 900px\)/);
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
