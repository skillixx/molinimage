import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";

import type { AppConfig } from "../../config/app-config.js";
import type {
  FileRecord,
  FilesRepository
} from "../../infrastructure/database/files-repository.js";
import type { StorageService } from "../../infrastructure/storage/storage-service.js";

export interface UploadFileRequest {
  ownerUserId: number;
  fileName: string;
  mimeType: string;
  contentBase64: string;
  fileType?: string;
}

export interface UploadFileResult {
  file: PublicFileRecord;
}

export interface DownloadUrlResult {
  file: PublicFileRecord;
  url: string;
  expires_at: string;
}

export interface FilePreviewResult {
  file: PublicFileRecord;
  preview_url: string;
  download_url: string;
  expires_at: string;
}

export interface FileContentResult {
  file: PublicFileRecord;
  content_base64: string;
}

export interface PublicFileRecord {
  id: string;
  owner_user_id: number;
  file_type: string;
  original_name: string | null;
  mime_type: string;
  storage_provider: string;
  storage_bucket: string;
  storage_key: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  checksum: string | null;
  created_at: string;
}

export class FileServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "FileServiceError";
  }
}

export class FileService {
  private readonly maxUploadBytes = 10 * 1024 * 1024;
  private readonly allowedMimeTypes = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif"
  ]);

  constructor(
    private readonly repository: FilesRepository,
    private readonly storageService: StorageService,
    private readonly config: Pick<
      AppConfig,
      "storageProvider" | "storageBucket" | "storagePresignedUrlTtlSeconds"
    >
  ) {}

  async uploadFile(request: UploadFileRequest): Promise<UploadFileResult> {
    const fileName = sanitizeFileName(request.fileName);
    const mimeType = request.mimeType.trim().toLowerCase();

    if (!this.allowedMimeTypes.has(mimeType)) {
      throw new FileServiceError(
        "UNSUPPORTED_FILE_TYPE",
        "当前只支持 png、jpeg、webp 和 gif 图片。",
        400
      );
    }

    const body = decodeBase64(request.contentBase64);

    if (body.byteLength === 0) {
      throw new FileServiceError("FILE_EMPTY", "文件内容不能为空。", 400);
    }

    if (body.byteLength > this.maxUploadBytes) {
      throw new FileServiceError("FILE_TOO_LARGE", "文件不能超过 10MB。", 413);
    }

    const fileId = `file_${randomUUID().replaceAll("-", "")}`;
    const storageKey = buildStorageKey({
      ownerUserId: request.ownerUserId,
      fileId,
      fileName,
      mimeType,
      fileType: request.fileType ?? "input"
    });
    const storedObject = await this.storageService.uploadObject({
      key: storageKey,
      body,
      contentType: mimeType
    });
    const checksum = createHash("sha256").update(body).digest("hex");
    const file = await this.repository.create({
      id: fileId,
      owner_user_id: request.ownerUserId,
      file_type: request.fileType ?? "input",
      original_name: fileName,
      mime_type: mimeType,
      // 数据库只保存 provider、bucket、key，不保存 endpoint 拼接出的完整 URL。
      storage_provider: storedObject.provider,
      storage_bucket: storedObject.bucket,
      storage_key: storedObject.key,
      size_bytes: body.byteLength,
      checksum
    });

    return {
      file: toPublicFileRecord(file)
    };
  }

  async createDownloadUrl(ownerUserId: number, fileId: string): Promise<DownloadUrlResult> {
    const file = await this.repository.findById(fileId);

    if (file === undefined) {
      throw new FileServiceError("FILE_NOT_FOUND", "文件不存在。", 404);
    }

    if (file.owner_user_id !== ownerUserId) {
      // 所有下载入口必须先按 owner_user_id 校验，不能让用户拿他人的 file_id 换预签名 URL。
      throw new FileServiceError("FILE_FORBIDDEN", "不能访问他人的文件。", 403);
    }

    const url = await this.storageService.createPresignedGetUrl({
      key: file.storage_key,
      expiresInSeconds: this.config.storagePresignedUrlTtlSeconds
    });
    const expiresAt = new Date(
      Date.now() + this.config.storagePresignedUrlTtlSeconds * 1000
    ).toISOString();

    return {
      file: toPublicFileRecord(file),
      url,
      expires_at: expiresAt
    };
  }

  async assertFilesOwned(ownerUserId: number, fileIds: string[]): Promise<void> {
    await this.loadOwnedFiles(ownerUserId, fileIds);
  }

  async readFileContentBase64(ownerUserId: number, fileId: string): Promise<FileContentResult> {
    const [file] = await this.loadOwnedFiles(ownerUserId, [fileId]);

    // worker 调用 vision 模型需要图片二进制内容；这里返回 base64，避免上层接触 MinIO 细节。
    const content = await this.storageService.readObject(file.storage_key);

    return {
      file: toPublicFileRecord(file),
      content_base64: content.toString("base64")
    };
  }

  async createPreviewUrls(ownerUserId: number, fileIds: string[]): Promise<FilePreviewResult[]> {
    const files = await this.loadOwnedFiles(ownerUserId, fileIds);
    const expiresAt = new Date(
      Date.now() + this.config.storagePresignedUrlTtlSeconds * 1000
    ).toISOString();

    return await Promise.all(
      files.map(async (file) => {
        const url = await this.storageService.createPresignedGetUrl({
          key: file.storage_key,
          expiresInSeconds: this.config.storagePresignedUrlTtlSeconds
        });

        return {
          file: toPublicFileRecord(file),
          preview_url: url,
          download_url: url,
          expires_at: expiresAt
        };
      })
    );
  }

  private async loadOwnedFiles(ownerUserId: number, fileIds: string[]): Promise<FileRecord[]> {
    const files = await this.repository.findManyByIds(fileIds);

    if (files.length !== fileIds.length) {
      throw new FileServiceError("FILE_NOT_FOUND", "文件不存在。", 404);
    }

    for (const file of files) {
      if (file.owner_user_id !== ownerUserId) {
        // 输入图、预览图和下载都必须走 owner_user_id 校验，避免用户拿他人 file_id 发起图生文。
        throw new FileServiceError("FILE_FORBIDDEN", "不能访问他人的文件。", 403);
      }
    }

    return files;
  }
}

function decodeBase64(contentBase64: string): Buffer {
  const normalized = contentBase64.trim();

  try {
    const buffer = Buffer.from(normalized, "base64");

    if (buffer.toString("base64").replace(/=+$/u, "") !== normalized.replace(/=+$/u, "")) {
      throw new Error("invalid base64");
    }

    return buffer;
  } catch {
    throw new FileServiceError("FILE_CONTENT_INVALID", "文件内容不是合法 base64。", 400);
  }
}

function sanitizeFileName(fileName: string): string {
  const trimmedName = fileName.trim();

  if (trimmedName.length === 0 || trimmedName.length > 255) {
    throw new FileServiceError("FILE_NAME_INVALID", "文件名不能为空且不能超过 255 个字符。", 400);
  }

  return trimmedName.replace(/[\\/:*?"<>|]/gu, "_");
}

function buildStorageKey(input: {
  ownerUserId: number;
  fileId: string;
  fileName: string;
  mimeType: string;
  fileType: string;
}): string {
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const extension = resolveFileExtension(input.fileName, input.mimeType);
  const prefix = resolveStoragePrefix(input.fileType);

  return `${prefix}/${String(input.ownerUserId)}/${year}/${month}/${input.fileId}${extension}`;
}

function resolveStoragePrefix(fileType: string): string {
  if (fileType === "thumbnail") {
    return "thumbnails";
  }

  if (fileType === "output") {
    return "generated";
  }

  return "uploads";
}

function resolveFileExtension(fileName: string, mimeType: string): string {
  const extension = extname(fileName).toLowerCase();

  if (extension.length > 0) {
    return extension;
  }

  const mimeExtensionMap: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif"
  };

  return mimeExtensionMap[mimeType] ?? ".bin";
}

function toPublicFileRecord(file: FileRecord): PublicFileRecord {
  return {
    id: file.id,
    owner_user_id: file.owner_user_id,
    file_type: file.file_type,
    original_name: file.original_name,
    mime_type: file.mime_type,
    storage_provider: file.storage_provider,
    storage_bucket: file.storage_bucket,
    storage_key: file.storage_key,
    size_bytes: file.size_bytes,
    width: file.width,
    height: file.height,
    checksum: file.checksum,
    created_at: file.created_at
  };
}
