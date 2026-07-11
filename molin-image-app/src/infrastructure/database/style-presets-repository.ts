import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export interface StylePresetRecord {
  id: string;
  name: string;
  category: string;
  task_type: string;
  prompt_template: string;
  preview_image_file_id: string | null;
  preview_image_url: string | null;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface SaveStylePresetInput {
  id: string;
  name: string;
  category: string;
  task_type: string;
  prompt_template: string;
  preview_image_file_id: string | null;
  preview_image_url: string | null;
  enabled: boolean;
  sort_order: number;
}

export interface StylePresetsRepository {
  listAll(): Promise<StylePresetRecord[]>;
  listEnabled(taskType?: string): Promise<StylePresetRecord[]>;
  findById(presetId: string): Promise<StylePresetRecord | undefined>;
  findEnabledByTaskAndId(
    taskType: string,
    presetId: string
  ): Promise<StylePresetRecord | undefined>;
  create(input: SaveStylePresetInput): Promise<StylePresetRecord>;
  update(input: SaveStylePresetInput): Promise<StylePresetRecord | undefined>;
}

interface StylePresetRow extends RowDataPacket {
  id: string;
  name: string;
  category: string;
  task_type: string;
  prompt_template: string;
  preview_image_file_id: string | null;
  preview_image_url: string | null;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export class MySqlStylePresetsRepository implements StylePresetsRepository {
  constructor(private readonly pool: Pool) {}

  async listAll(): Promise<StylePresetRecord[]> {
    const [rows] = await this.pool.execute<StylePresetRow[]>(
      `${stylePresetSelectSql} ORDER BY task_type ASC, category ASC, sort_order ASC, created_at ASC`
    );

    return rows.map(toStylePresetRecord);
  }

  async listEnabled(taskType?: string): Promise<StylePresetRecord[]> {
    // 用户端查询只返回 enabled=1，管理端停用后会立即从工作台模板列表消失。
    const where =
      taskType === undefined ? "WHERE enabled = 1" : "WHERE enabled = 1 AND task_type = ?";
    const parameters = taskType === undefined ? [] : [taskType];
    const [rows] = await this.pool.execute<StylePresetRow[]>(
      `${stylePresetSelectSql} ${where} ORDER BY task_type ASC, category ASC, sort_order ASC, created_at ASC`,
      parameters
    );

    return rows.map(toStylePresetRecord);
  }

  async findById(presetId: string): Promise<StylePresetRecord | undefined> {
    const [rows] = await this.pool.execute<StylePresetRow[]>(
      `${stylePresetSelectSql} WHERE id = ? LIMIT 1`,
      [presetId]
    );

    const row = rows.at(0);
    return row === undefined ? undefined : toStylePresetRecord(row);
  }

  async findEnabledByTaskAndId(
    taskType: string,
    presetId: string
  ): Promise<StylePresetRecord | undefined> {
    const [rows] = await this.pool.execute<StylePresetRow[]>(
      `${stylePresetSelectSql} WHERE id = ? AND task_type = ? AND enabled = 1 LIMIT 1`,
      [presetId, taskType]
    );

    const row = rows.at(0);
    return row === undefined ? undefined : toStylePresetRecord(row);
  }

  async create(input: SaveStylePresetInput): Promise<StylePresetRecord> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO style_presets (
        id, name, category, task_type, prompt_template, preview_image_file_id,
        preview_image_url, enabled, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      toSqlParameters(input)
    );

    const created = await this.findById(input.id);

    if (created === undefined) {
      throw new Error("风格模板写入后回读失败。");
    }

    return created;
  }

  async update(input: SaveStylePresetInput): Promise<StylePresetRecord | undefined> {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE style_presets SET
        name = ?, category = ?, task_type = ?, prompt_template = ?,
        preview_image_file_id = ?, preview_image_url = ?, enabled = ?, sort_order = ?
       WHERE id = ?`,
      [...toSqlParameters(input).slice(1), input.id]
    );

    return result.affectedRows === 0 ? undefined : await this.findById(input.id);
  }
}

const stylePresetSelectSql = `SELECT
  id,
  name,
  category,
  task_type,
  prompt_template,
  preview_image_file_id,
  preview_image_url,
  enabled,
  sort_order,
  DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
  DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at
 FROM style_presets`;

function toSqlParameters(input: SaveStylePresetInput): (string | number | null)[] {
  return [
    input.id,
    input.name,
    input.category,
    input.task_type,
    input.prompt_template,
    input.preview_image_file_id,
    input.preview_image_url,
    input.enabled ? 1 : 0,
    input.sort_order
  ];
}

function toStylePresetRecord(row: StylePresetRow): StylePresetRecord {
  return {
    ...row,
    enabled: row.enabled === 1
  };
}
