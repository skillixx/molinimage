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
  const styles = await readFile(resolve("public", "assets", "styles.css"), "utf8");

  assert.match(html, /预计积分/);
  assert.match(html, /id="imageInput"/);
  assert.match(html, /id="editModeSelect"/);
  assert.match(html, /id="restoreTypeSelect"/);
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
  assert.match(workbench, /confirmHighConsumptionTask/);
  assert.match(workbench, /图片修复属于高消耗任务/);
  assert.match(workbench, /gateway_capability: "image_edit"/);
  assert.match(workbench, /useFileAsReference/);
  assert.match(workbench, /input_files/);
  assert.match(styles, /@media \(max-width: 900px\)/);
  assert.match(styles, /\.reference-result/);
  assert.match(styles, /\.task-progress/);
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
