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
  DownloadUrlResult,
  UploadFileRequest,
  UploadFileResult
} from "../src/modules/files/file-service.js";

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
  trustProxy: false,
  internalApiToken: "test_internal_token",
  sessionCookieName: "molinimage_session",
  sessionCookieSecure: false,
  sessionTtlSeconds: 86400,
  port: 0
};

void test("文件上传接口必须登录，并把当前用户 ID 传给文件服务", async () => {
  const fileService = new FakeFileService();
  const app = await startTestApp(fileService);

  try {
    const unauthorizedResponse = await fetch(`${app.baseUrl}/api/files`, {
      method: "POST",
      body: "{}"
    });
    const cookie = await createSessionCookie(app.baseUrl);
    const uploadResponse = await fetch(`${app.baseUrl}/api/files`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie
      },
      body: JSON.stringify({
        file_name: "demo.png",
        mime_type: "image/png",
        content_base64: Buffer.from("image").toString("base64")
      })
    });
    const uploadBody = (await uploadResponse.json()) as UploadFileResult;

    assert.equal(unauthorizedResponse.status, 401);
    assert.equal(uploadResponse.status, 201);
    assert.equal(fileService.uploadRequests[0]?.ownerUserId, 479);
    assert.equal(uploadBody.file.storage_key, "uploads/479/file_api.png");
  } finally {
    await app.close();
  }
});

void test("下载预签名接口使用当前 session 用户做权限边界", async () => {
  const fileService = new FakeFileService();
  const app = await startTestApp(fileService);

  try {
    const cookie = await createSessionCookie(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/api/files/file_api/download-url`, {
      headers: {
        cookie
      }
    });
    const body = (await response.json()) as DownloadUrlResult;

    assert.equal(response.status, 200);
    assert.equal(fileService.downloadRequests[0]?.ownerUserId, 479);
    assert.equal(fileService.downloadRequests[0]?.fileId, "file_api");
    assert.equal(body.url, "https://storage.example.com/uploads/479/file_api.png");
  } finally {
    await app.close();
  }
});

class FakeFileService {
  readonly uploadRequests: UploadFileRequest[] = [];
  readonly downloadRequests: { ownerUserId: number; fileId: string }[] = [];

  uploadFile(request: UploadFileRequest): Promise<UploadFileResult> {
    this.uploadRequests.push(request);

    return Promise.resolve({
      file: {
        id: "file_api",
        owner_user_id: request.ownerUserId,
        file_type: "input",
        original_name: request.fileName,
        mime_type: request.mimeType,
        storage_provider: "minio",
        storage_bucket: "molinimage",
        storage_key: `uploads/${String(request.ownerUserId)}/file_api.png`,
        size_bytes: 5,
        width: null,
        height: null,
        checksum: "checksum",
        created_at: "2026-07-09T00:00:00.000Z"
      }
    });
  }

  createDownloadUrl(ownerUserId: number, fileId: string): Promise<DownloadUrlResult> {
    this.downloadRequests.push({ ownerUserId, fileId });

    return Promise.resolve({
      file: {
        id: fileId,
        owner_user_id: ownerUserId,
        file_type: "input",
        original_name: "demo.png",
        mime_type: "image/png",
        storage_provider: "minio",
        storage_bucket: "molinimage",
        storage_key: `uploads/${String(ownerUserId)}/${fileId}.png`,
        size_bytes: 5,
        width: null,
        height: null,
        checksum: "checksum",
        created_at: "2026-07-09T00:00:00.000Z"
      },
      url: `https://storage.example.com/uploads/${String(ownerUserId)}/${fileId}.png`,
      expires_at: "2026-07-09T00:05:00.000Z"
    });
  }

  createPreviewUrls(): Promise<[]> {
    return Promise.resolve([]);
  }

  assertFilesOwned(): Promise<void> {
    return Promise.resolve();
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

async function startTestApp(fileService: FakeFileService): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createServer(
    createAppRequestHandler(testConfig, {
      launchTicketVerifier: new FakeLaunchTicketVerifier(),
      fileService
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
