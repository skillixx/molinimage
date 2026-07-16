import assert from "node:assert/strict";
import test from "node:test";

import type {
  CreateFileRecordInput,
  FileRecord,
  FilesRepository
} from "../src/infrastructure/database/files-repository.js";
import type {
  PresignedUrlInput,
  StorageService,
  StoredObject,
  UploadObjectInput
} from "../src/infrastructure/storage/storage-service.js";
import { FileService, FileServiceError } from "../src/modules/files/file-service.js";

void test("上传文件时内容写入存储，MySQL 元数据只保存 provider、bucket、key", async () => {
  const repository = new InMemoryFilesRepository();
  const storage = new FakeStorageService();
  const service = new FileService(repository, storage, {
    storageProvider: "minio",
    storageBucket: "molinimage",
    storagePresignedUrlTtlSeconds: 300
  });

  const png = createPngHeader(320, 180);
  const result = await service.uploadFile({
    ownerUserId: 479,
    fileName: "avatar.png",
    mimeType: "image/png",
    contentBase64: png.toString("base64")
  });

  assert.equal(storage.uploads.length, 1);
  assert.deepEqual(storage.uploads[0]?.body, png);
  assert.equal(result.file.storage_provider, "minio");
  assert.equal(result.file.storage_bucket, "molinimage");
  assert.match(result.file.storage_key, /^uploads\/479\/\d{4}\/\d{2}\/file_[a-f0-9]+\.png$/u);
  assert.equal(Object.hasOwn(result.file, "content_base64"), false);
  assert.equal(result.file.width, 320);
  assert.equal(result.file.height, 180);
});

void test("高清放大结果可超过用户上传 10MB 限制但仍受生成资产上限保护", async () => {
  const repository = new InMemoryFilesRepository();
  const storage = new FakeStorageService();
  const service = new FileService(repository, storage, {
    storageProvider: "minio",
    storageBucket: "molinimage",
    storagePresignedUrlTtlSeconds: 300
  });
  const largePng = Buffer.alloc(10 * 1024 * 1024 + 1);
  createPngHeader(4096, 4096).copy(largePng);
  const contentBase64 = largePng.toString("base64");

  await assert.rejects(
    () =>
      service.uploadFile({
        ownerUserId: 479,
        fileName: "large-upload.png",
        mimeType: "image/png",
        contentBase64
      }),
    (error: unknown) => error instanceof FileServiceError && error.code === "FILE_TOO_LARGE"
  );
  const generated = await service.uploadFile({
    ownerUserId: 479,
    fileName: "upscale-output.png",
    mimeType: "image/png",
    contentBase64,
    generatedAsset: true,
    expectedWidth: 4096,
    expectedHeight: 4096
  });

  assert.equal(generated.file.size_bytes, largePng.byteLength);
  assert.equal(generated.file.width, 4096);
  assert.equal(generated.file.height, 4096);
});

void test("Worker 使用稳定文件幂等键时重试不会重复写入 MinIO 或文件记录", async () => {
  const repository = new InMemoryFilesRepository();
  const storage = new FakeStorageService();
  const service = new FileService(repository, storage, {
    storageProvider: "minio",
    storageBucket: "molinimage",
    storagePresignedUrlTtlSeconds: 300
  });
  const request = {
    ownerUserId: 479,
    fileName: "task-result.png",
    mimeType: "image/png",
    contentBase64: createPngHeader(1024, 1024).toString("base64"),
    fileType: "output",
    idempotencyKey: "task_001:text_to_image:1"
  };

  const first = await service.uploadFile(request);
  const retried = await service.uploadFile(request);

  assert.equal(retried.file.id, first.file.id);
  assert.equal(storage.uploads.length, 1);
  assert.match(first.file.id, /^file_[a-f0-9]{32}$/u);
});

void test("只能为自己的文件生成预签名 URL", async () => {
  const repository = new InMemoryFilesRepository();
  const storage = new FakeStorageService();
  const service = new FileService(repository, storage, {
    storageProvider: "minio",
    storageBucket: "molinimage",
    storagePresignedUrlTtlSeconds: 300
  });
  const ownFile = await repository.create(
    createRecord("file_own", 479, "uploads/479/file_own.png")
  );
  await repository.create(createRecord("file_other", 480, "uploads/480/file_other.png"));

  const ownUrl = await service.createDownloadUrl(479, ownFile.id);

  assert.equal(ownUrl.url, "https://storage.example.com/uploads/479/file_own.png?expires=300");
  assert.equal(storage.presignedInputs.length, 1);
  await assert.rejects(
    () => service.createDownloadUrl(479, "file_other"),
    (error: unknown) => error instanceof FileServiceError && error.code === "FILE_FORBIDDEN"
  );
  assert.equal(storage.presignedInputs.length, 1);
});

void test("worker 读取图片内容时仍然校验文件归属", async () => {
  const repository = new InMemoryFilesRepository();
  const storage = new FakeStorageService();
  const service = new FileService(repository, storage, {
    storageProvider: "minio",
    storageBucket: "molinimage",
    storagePresignedUrlTtlSeconds: 300
  });
  const ownFile = await repository.create(
    createRecord("file_own", 479, "uploads/479/file_own.png")
  );
  await repository.create(createRecord("file_other", 480, "uploads/480/file_other.png"));

  const result = await service.readFileContentBase64(479, ownFile.id);

  assert.equal(Buffer.from(result.content_base64, "base64").toString("utf8"), "stored image bytes");
  assert.equal(result.file.id, ownFile.id);
  await assert.rejects(
    () => service.readFileContentBase64(479, "file_other"),
    (error: unknown) => error instanceof FileServiceError && error.code === "FILE_FORBIDDEN"
  );
});

void test("预览地址走应用后端代理且读取内容仍校验归属", async () => {
  const repository = new InMemoryFilesRepository();
  const storage = new FakeStorageService();
  const service = new FileService(repository, storage, {
    storageProvider: "minio",
    storageBucket: "molinimage",
    storagePresignedUrlTtlSeconds: 300
  });
  const ownFile = await repository.create(
    createRecord("file_preview", 479, "generated/479/file_preview.png")
  );
  await repository.create(createRecord("file_other", 480, "generated/480/file_other.png"));

  const [preview] = await service.createPreviewUrls(479, [ownFile.id]);
  const binary = await service.readPreviewFile(479, ownFile.id);

  assert.equal(preview.preview_url, "/api/files/file_preview/preview");
  assert.equal(preview.download_url, "/api/files/file_preview/preview?download=1");
  assert.equal(storage.presignedInputs.length, 0);
  assert.equal(binary.body.toString("utf8"), "stored image bytes");
  await assert.rejects(
    () => service.readPreviewFile(479, "file_other"),
    (error: unknown) => error instanceof FileServiceError && error.code === "FILE_FORBIDDEN"
  );
});

class InMemoryFilesRepository implements FilesRepository {
  private readonly records = new Map<string, FileRecord>();

  create(input: CreateFileRecordInput): Promise<FileRecord> {
    const record: FileRecord = {
      ...input,
      width: input.width ?? null,
      height: input.height ?? null,
      created_at: new Date("2026-07-09T00:00:00.000Z").toISOString()
    };

    this.records.set(record.id, record);

    return Promise.resolve(record);
  }

  findById(fileId: string): Promise<FileRecord | undefined> {
    return Promise.resolve(this.records.get(fileId));
  }

  findManyByIds(fileIds: string[]): Promise<FileRecord[]> {
    return Promise.resolve(
      fileIds
        .map((fileId) => this.records.get(fileId))
        .filter((file): file is FileRecord => file !== undefined)
    );
  }
}

class FakeStorageService implements StorageService {
  readonly uploads: UploadObjectInput[] = [];
  readonly presignedInputs: PresignedUrlInput[] = [];

  uploadObject(input: UploadObjectInput): Promise<StoredObject> {
    this.uploads.push(input);

    return Promise.resolve({
      provider: "minio",
      bucket: "molinimage",
      key: input.key
    });
  }

  readObject(): Promise<Buffer> {
    return Promise.resolve(Buffer.from("stored image bytes"));
  }

  createPresignedGetUrl(input: PresignedUrlInput): Promise<string> {
    this.presignedInputs.push(input);

    return Promise.resolve(
      `https://storage.example.com/${input.key}?expires=${String(input.expiresInSeconds)}`
    );
  }
}

function createRecord(
  fileId: string,
  ownerUserId: number,
  storageKey: string
): CreateFileRecordInput {
  return {
    id: fileId,
    owner_user_id: ownerUserId,
    file_type: "input",
    original_name: `${fileId}.png`,
    mime_type: "image/png",
    storage_provider: "minio",
    storage_bucket: "molinimage",
    storage_key: storageKey,
    size_bytes: 10,
    checksum: "checksum"
  };
}

function createPngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);

  return buffer;
}
