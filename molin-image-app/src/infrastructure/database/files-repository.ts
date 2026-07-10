import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export interface FileRecord {
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

export interface CreateFileRecordInput {
  id: string;
  owner_user_id: number;
  file_type: string;
  original_name: string | null;
  mime_type: string;
  storage_provider: string;
  storage_bucket: string;
  storage_key: string;
  size_bytes: number;
  checksum: string;
}

export interface FilesRepository {
  create(input: CreateFileRecordInput): Promise<FileRecord>;
  findById(fileId: string): Promise<FileRecord | undefined>;
  findManyByIds(fileIds: string[]): Promise<FileRecord[]>;
}

interface FileRow extends RowDataPacket, FileRecord {}

export class MySqlFilesRepository implements FilesRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateFileRecordInput): Promise<FileRecord> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO files (
        id,
        owner_user_id,
        file_type,
        original_name,
        mime_type,
        storage_provider,
        storage_bucket,
        storage_key,
        size_bytes,
        checksum
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.owner_user_id,
        input.file_type,
        input.original_name,
        input.mime_type,
        input.storage_provider,
        input.storage_bucket,
        input.storage_key,
        input.size_bytes,
        input.checksum
      ]
    );

    const createdFile = await this.findById(input.id);

    if (createdFile === undefined) {
      // 插入后立刻回读是为了统一接口返回的时间字段和数据库真实状态。
      throw new Error("文件元数据写入后回读失败");
    }

    return createdFile;
  }

  async findById(fileId: string): Promise<FileRecord | undefined> {
    const [rows] = await this.pool.execute<FileRow[]>(
      `SELECT
        id,
        owner_user_id,
        file_type,
        original_name,
        mime_type,
        storage_provider,
        storage_bucket,
        storage_key,
        size_bytes,
        width,
        height,
        checksum,
        DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at
       FROM files
       WHERE id = ?
       LIMIT 1`,
      [fileId]
    );

    return rows[0];
  }

  async findManyByIds(fileIds: string[]): Promise<FileRecord[]> {
    if (fileIds.length === 0) {
      return [];
    }

    const placeholders = fileIds.map(() => "?").join(", ");
    const [rows] = await this.pool.execute<FileRow[]>(
      `SELECT
        id,
        owner_user_id,
        file_type,
        original_name,
        mime_type,
        storage_provider,
        storage_bucket,
        storage_key,
        size_bytes,
        width,
        height,
        checksum,
        DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at
       FROM files
       WHERE id IN (${placeholders})`,
      fileIds
    );

    return rows;
  }
}
