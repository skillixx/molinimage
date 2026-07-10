export interface StoredObject {
  provider: string;
  bucket: string;
  key: string;
}

export interface UploadObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface PresignedUrlInput {
  key: string;
  expiresInSeconds: number;
}

export interface StorageService {
  uploadObject(input: UploadObjectInput): Promise<StoredObject>;
  readObject(key: string): Promise<Buffer>;
  createPresignedGetUrl(input: PresignedUrlInput): Promise<string>;
}
