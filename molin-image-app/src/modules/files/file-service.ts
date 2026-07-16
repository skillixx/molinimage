import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";

import { imageSize } from "image-size";

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
  expectedWidth?: number;
  expectedHeight?: number;
  generatedAsset?: boolean;
  /** Worker 结果使用稳定键，重试时复用同一文件记录和对象路径。 */
  idempotencyKey?: string;
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

export interface FileBinaryResult {
  file: PublicFileRecord;
  body: Buffer;
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
  private readonly maxGeneratedAssetBytes = 100 * 1024 * 1024;
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

    const maxFileBytes = request.generatedAsset ? this.maxGeneratedAssetBytes : this.maxUploadBytes;

    if (body.byteLength > maxFileBytes) {
      // 用户上传保持 10MB 限制，worker 生成的高清资产允许更大体积但仍设置硬上限。
      const maxSizeLabel = request.generatedAsset ? "100MB" : "10MB";
      throw new FileServiceError("FILE_TOO_LARGE", `文件不能超过 ${maxSizeLabel}。`, 413);
    }

    const dimensions = readImageDimensions(body);

    if (
      request.expectedWidth !== undefined &&
      request.expectedHeight !== undefined &&
      (dimensions?.width !== request.expectedWidth || dimensions.height !== request.expectedHeight)
    ) {
      // 高清放大结果必须以实际二进制尺寸验收，模型只返回图片但未真正放大时任务失败。
      throw new FileServiceError(
        "IMAGE_DIMENSIONS_MISMATCH",
        `图片实际尺寸不是目标 ${String(request.expectedWidth)}x${String(request.expectedHeight)}。`,
        502
      );
    }

    const fileId =
      request.idempotencyKey === undefined
        ? `file_${randomUUID().replaceAll("-", "")}`
        : buildIdempotentFileId(request.ownerUserId, request.idempotencyKey);
    const storageKey = buildStorageKey({
      ownerUserId: request.ownerUserId,
      fileId,
      fileName,
      mimeType,
      fileType: request.fileType ?? "input"
    });
    const checksum = createHash("sha256").update(body).digest("hex");
    const existingFile = await this.repository.findById(fileId);

    if (existingFile !== undefined) {
      // Worker 崩溃重试时先核对既有文件，匹配则直接复用，避免再次覆盖 MinIO 或产生孤立记录。
      assertIdempotentFileMatches(existingFile, request.ownerUserId, mimeType, checksum);
      return { file: toPublicFileRecord(existingFile) };
    }

    const storedObject = await this.storageService.uploadObject({
      key: storageKey,
      body,
      contentType: mimeType
    });
    let file: FileRecord;

    try {
      file = await this.repository.create({
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
        // 宽高来自实际图片二进制，不信任浏览器或 AI 网关声明的目标尺寸。
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        checksum
      });
    } catch (error: unknown) {
      const concurrentFile = await this.repository.findById(fileId);

      if (concurrentFile === undefined || request.idempotencyKey === undefined) {
        throw error;
      }

      // 极小概率的并发插入由唯一文件 ID 吸收，但必须核对内容，不能把不同结果误认为同一文件。
      assertIdempotentFileMatches(concurrentFile, request.ownerUserId, mimeType, checksum);
      file = concurrentFile;
    }

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

    return files.map((file) => {
      const fileId = encodeURIComponent(file.id);
      // 预览图走应用后端代理，不把 MinIO 内网地址或预签名 URL 暴露给浏览器。
      const previewUrl = `/api/files/${fileId}/preview`;
      const downloadUrl = `/api/files/${fileId}/preview?download=1`;

      return {
        file: toPublicFileRecord(file),
        preview_url: previewUrl,
        download_url: downloadUrl,
        expires_at: expiresAt
      };
    });
  }

  async readPreviewFile(ownerUserId: number, fileId: string): Promise<FileBinaryResult> {
    const [file] = await this.loadOwnedFiles(ownerUserId, [fileId]);
    // 浏览器预览通过后端代理读取对象，既保留 owner 校验，也避免客户端直连 MinIO 内网地址。
    const body = await this.storageService.readObject(file.storage_key);

    return {
      file: toPublicFileRecord(file),
      body
    };
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

function buildIdempotentFileId(ownerUserId: number, idempotencyKey: string): string {
  const normalizedKey = idempotencyKey.trim();

  if (normalizedKey.length === 0) {
    throw new FileServiceError("FILE_IDEMPOTENCY_KEY_INVALID", "文件幂等键不能为空。", 400);
  }

  const digest = createHash("sha256")
    .update(`${String(ownerUserId)}:${normalizedKey}`)
    .digest("hex")
    .slice(0, 32);

  return `file_${digest}`;
}

function assertIdempotentFileMatches(
  file: FileRecord,
  ownerUserId: number,
  mimeType: string,
  checksum: string
): void {
  if (
    file.owner_user_id !== ownerUserId ||
    file.mime_type !== mimeType ||
    file.checksum !== checksum
  ) {
    throw new FileServiceError(
      "FILE_IDEMPOTENCY_CONFLICT",
      "同一任务输出位置已存在不同文件，请检查任务恢复状态。",
      409
    );
  }
}

function readImageDimensions(body: Buffer): { width: number; height: number } | undefined {
  try {
    const dimensions = imageSize(body);

    if (
      !Number.isInteger(dimensions.width) ||
      !Number.isInteger(dimensions.height) ||
      dimensions.width < 1 ||
      dimensions.height < 1
    ) {
      return undefined;
    }

    return {
      width: dimensions.width,
      height: dimensions.height
    };
  } catch {
    // 普通上传保持兼容；依赖尺寸的高清放大会在 worker 中明确拒绝无宽高图片。
    return undefined;
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
