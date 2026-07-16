import { Client } from "minio";

import type { AppConfig } from "../../config/app-config.js";
import type {
  PresignedUrlInput,
  StorageService,
  StoredObject,
  UploadObjectInput
} from "./storage-service.js";

export class MinioStorageService implements StorageService {
  private readonly client: Client;

  constructor(
    private readonly config: Pick<
      AppConfig,
      | "storageEndpoint"
      | "storageBucket"
      | "storageAccessKeyId"
      | "storageSecretAccessKey"
      | "storageProvider"
    >
  ) {
    const endpoint = new URL(config.storageEndpoint);

    this.client = new Client({
      endPoint: endpoint.hostname,
      port:
        endpoint.port.length > 0
          ? Number(endpoint.port)
          : endpoint.protocol === "https:"
            ? 443
            : 80,
      useSSL: endpoint.protocol === "https:",
      accessKey: config.storageAccessKeyId,
      secretKey: config.storageSecretAccessKey
    });
  }

  async uploadObject(input: UploadObjectInput): Promise<StoredObject> {
    // 业务层只传稳定对象 key 和内容类型，MinIO 细节被限制在适配层内，便于后续迁移到阿里云 OSS。
    await this.client.putObject(
      this.config.storageBucket,
      input.key,
      input.body,
      input.body.byteLength,
      {
        "Content-Type": input.contentType
      }
    );

    return {
      provider: this.config.storageProvider,
      bucket: this.config.storageBucket,
      key: input.key
    };
  }

  async readObject(key: string): Promise<Buffer> {
    // 图生文等 worker 只能在后端读取用户已授权的对象；读取前的 owner 校验放在 FileService 中。
    const stream = await this.client.getObject(this.config.storageBucket, key);
    const chunks: Buffer[] = [];

    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }

    return Buffer.concat(chunks);
  }

  async createPresignedGetUrl(input: PresignedUrlInput): Promise<string> {
    // 下载或预览都必须先经过后端权限校验，再生成短期 URL；前端不直接持有永久对象地址。
    return await this.client.presignedGetObject(
      this.config.storageBucket,
      input.key,
      input.expiresInSeconds
    );
  }

  async checkHealth(): Promise<void> {
    // bucketExists 同时验证 MinIO 网络、凭据与目标 Bucket，可避免只检查端口造成假就绪。
    const exists = await this.client.bucketExists(this.config.storageBucket);

    if (!exists) {
      throw new Error("对象存储 Bucket 不存在");
    }
  }
}
