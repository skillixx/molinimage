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
  assert.match(frontendSource, /\/api\/billing\/estimate/);
  assert.match(frontendSource, /\/api\/image\/tasks/);
  assert.match(frontendSource, /\/retry/);
  assert.match(frontendSource, /\/api\/files/);
  assert.match(frontendSource, /\/api\/image\/history/);
  assert.match(frontendSource, /\/favorite/);
  assert.match(frontendSource, /retryImageTask/);
  assert.match(frontendSource, /uploadImageFile/);
  assert.match(frontendSource, /window\.confirm/);
  assert.match(frontendSource, /积分已释放/);
  assert.doesNotMatch(frontendSource, /openrouter\.ai/i);
  assert.doesNotMatch(frontendSource, /minio/i);
  assert.doesNotMatch(frontendSource, /\/api\/internal/i);
});

void test("MVP 前端源码覆盖余额禁用、进度、下载和复制结果体验", async () => {
  const html = await readFile(resolve("public", "index.html"), "utf8");
  const workbench = await readFile(resolve("public", "assets", "workbench.js"), "utf8");
  const taskDetailFormat = await readFile(
    resolve("public", "assets", "task-detail-format.js"),
    "utf8"
  );
  const styles = await readFile(resolve("public", "assets", "styles.css"), "utf8");

  assert.match(html, /预计积分/);
  assert.match(html, /id="imageInput"/);
  assert.match(html, /id="editModeSelect"/);
  assert.match(html, /id="restoreTypeSelect"/);
  assert.match(html, /data-mode="upscale"/);
  assert.match(html, /id="upscaleFactorSelect"/);
  assert.match(html, /value="2">2x/);
  assert.match(html, /value="4">4x/);
  // 高清放大保留模型选择，只隐藏不适用的尺寸与数量控件。
  assert.match(html, /<span>模型<\/span>\s*<select id="modelSelect"><\/select>/);
  assert.match(html, /id="sizeField">\s*<span>尺寸<\/span>/);
  assert.match(html, /id="countField">\s*<span>数量<\/span>/);
  assert.match(html, /id="referencePreview"/);
  assert.match(html, /id="taskDetailDrawer"/);
  assert.match(html, /id="taskDetailContent"/);
  assert.match(html, /id="taskDetailClose"/);
  assert.match(html, /老照片修复/);
  assert.match(html, /去噪增强/);
  assert.match(html, /模糊变清晰/);
  assert.match(html, /色彩增强/);
  assert.match(workbench, /state\.estimate\?\.enough_balance === true/);
  assert.match(
    workbench,
    /elements\.primaryAction\.disabled = estimateUnavailable \|\| !hasEnoughBalance \|\| !hasModel/
  );
  assert.match(workbench, /renderProgress\("generating"\)/);
  assert.match(workbench, /结果可下载/);
  assert.match(workbench, /结果可复制/);
  assert.match(workbench, /navigator\.clipboard\.writeText/);
  assert.match(workbench, /file\.download_url/);
  assert.match(workbench, /submitImageToImageTask/);
  assert.match(workbench, /submitImageRestoreTask/);
  assert.match(workbench, /task_type: "image_restore"/);
  assert.match(workbench, /submitUpscaleTask/);
  assert.match(workbench, /task_type: "upscale"/);
  assert.match(workbench, /upscale_factor:/);
  assert.match(workbench, /file\.file\.width/);
  assert.match(workbench, /file\.file\.height/);
  assert.match(workbench, /confirmHighConsumptionTask/);
  assert.match(workbench, /图片修复属于高消耗任务/);
  assert.match(workbench, /gateway_capability: "image_edit"/);
  assert.match(workbench, /model\.supported_task_types\.includes\(state\.mode\)/);
  assert.match(workbench, /再次编辑/);
  assert.match(workbench, /useTaskForReedit/);
  assert.match(workbench, /source_task_id: state\.sourceTaskId/);
  assert.match(workbench, /elements\.promptInput\.value = task\.prompt \?\? ""/);
  assert.match(workbench, /state\.referenceFileId = file\.file\.id/);
  assert.match(workbench, /elements\.editModeSelect\.value = "keep_subject"/);
  assert.match(workbench, /elements\.countSelect\.value = "1"/);
  assert.match(workbench, /history-image-item/);
  assert.match(workbench, /useTaskForReedit\(task, file\)/);
  assert.match(workbench, /clearReeditSource/);
  assert.match(workbench, /getImageTask/);
  assert.match(workbench, /openTaskDetail/);
  assert.match(workbench, /查看详情/);
  assert.match(workbench, /输入参数/);
  assert.match(workbench, /输入文件/);
  assert.match(workbench, /输出结果/);
  assert.match(workbench, /消耗积分/);
  assert.match(workbench, /resolveTaskFailureMessage/);
  assert.match(taskDetailFormat, /任务执行失败，请稍后重试。/);
  assert.doesNotMatch(workbench, /files\.slice\(0, 4\)/);
  assert.match(workbench, /input_files/);
  assert.match(styles, /@media \(max-width: 900px\)/);
  assert.match(styles, /\.reference-result/);
  assert.match(styles, /\.task-progress/);
  assert.match(styles, /\.task-detail-drawer/);
  assert.match(styles, /\.task-detail-grid/);
});

void test("任务详情格式化能输出中文失败原因并区分积分状态", async () => {
  const source = await readFile(resolve("public", "assets", "task-detail-format.js"), "utf8");
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const formatter = (await import(moduleUrl)) as {
    formatTaskPoints(task: Record<string, unknown>): string;
    resolveTaskFailureMessage(task: Record<string, unknown>): string;
  };

  assert.equal(
    formatter.resolveTaskFailureMessage({
      error_code: "AI_GATEWAY_FAILED",
      error_message: "Provider timeout"
    }),
    "AI 模型服务调用失败，请稍后重试。"
  );
  assert.equal(
    formatter.resolveTaskFailureMessage({ error_code: "UNKNOWN", error_message: "timeout" }),
    "任务执行失败，请稍后重试。"
  );
  assert.equal(
    formatter.formatTaskPoints({
      status: "billing_pending",
      error_code: "BILLING_SETTLE_PENDING",
      cost_points: "6"
    }),
    "6 积分（结算待对账）"
  );
  assert.equal(
    formatter.formatTaskPoints({
      status: "failed",
      error_code: "BILLING_RELEASE_PENDING",
      cost_points: "6"
    }),
    "6 积分（释放待对账）"
  );
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
