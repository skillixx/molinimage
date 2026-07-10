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

  const result = await service.uploadFile({
    ownerUserId: 479,
    fileName: "avatar.png",
    mimeType: "image/png",
    contentBase64: Buffer.from("fake image bytes").toString("base64")
  });

  assert.equal(storage.uploads.length, 1);
  assert.equal(storage.uploads[0]?.body.toString("utf8"), "fake image bytes");
  assert.equal(result.file.storage_provider, "minio");
  assert.equal(result.file.storage_bucket, "molinimage");
  assert.match(result.file.storage_key, /^uploads\/479\/\d{4}\/\d{2}\/file_[a-f0-9]+\.png$/u);
  assert.equal(Object.hasOwn(result.file, "content_base64"), false);
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

class InMemoryFilesRepository implements FilesRepository {
  private readonly records = new Map<string, FileRecord>();

  create(input: CreateFileRecordInput): Promise<FileRecord> {
    const record: FileRecord = {
      ...input,
      width: null,
      height: null,
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
