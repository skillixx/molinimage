import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export interface ImageModelConfigRecord {
  id: string;
  gateway_model_code: string;
  display_name: string;
  description: string;
  capability: string;
  source_capability: string;
  source_status: "active" | "inactive";
  source_available: boolean;
  admin_enabled: boolean;
  quality_tier: string;
  supported_task_types: string[];
  supported_image_sizes: string[];
  supported_input_types: string[];
  supported_output_types: string[];
  max_input_files: number;
  max_output_count: number;
  sort_order: number;
  default_task_types: string[];
  synced_at: string;
  created_at: string;
  updated_at: string;
}

export interface SaveImageModelConfigInput {
  id: string;
  gateway_model_code: string;
  display_name: string;
  description: string;
  capability: string;
  source_capability: string;
  source_status: "active" | "inactive";
  source_available: boolean;
  admin_enabled: boolean;
  quality_tier: string;
  supported_task_types: string[];
  supported_image_sizes: string[];
  supported_input_types: string[];
  supported_output_types: string[];
  max_input_files: number;
  max_output_count: number;
  sort_order: number;
}

export interface UpdateImageModelConfigInput {
  id: string;
  display_name?: string;
  description?: string;
  capability?: string;
  admin_enabled?: boolean;
  supported_task_types?: string[];
  supported_image_sizes?: string[];
  max_input_files?: number;
  max_output_count?: number;
  sort_order?: number;
  default_task_types?: string[];
}

export interface ImageModelConfigsRepository {
  listAll(): Promise<ImageModelConfigRecord[]>;
  findById(modelId: string): Promise<ImageModelConfigRecord | undefined>;
  upsertFromCatalog(input: SaveImageModelConfigInput): Promise<void>;
  markMissingSourceModels(activeModelIds: string[]): Promise<void>;
  update(input: UpdateImageModelConfigInput): Promise<ImageModelConfigRecord | undefined>;
  replaceDefaultTaskTypes(modelId: string, taskTypes: string[]): Promise<void>;
}

interface ImageModelConfigRow extends RowDataPacket {
  id: string;
  gateway_model_code: string;
  display_name: string;
  description: string;
  capability: string;
  source_capability: string;
  source_status: "active" | "inactive";
  source_available: number;
  admin_enabled: number;
  quality_tier: string;
  supported_task_types: unknown;
  supported_image_sizes: unknown;
  supported_input_types: unknown;
  supported_output_types: unknown;
  max_input_files: number;
  max_output_count: number;
  sort_order: number;
  default_task_types: string | null;
  synced_at: string;
  created_at: string;
  updated_at: string;
}

export class MySqlImageModelConfigsRepository implements ImageModelConfigsRepository {
  constructor(private readonly pool: Pool) {}

  async listAll(): Promise<ImageModelConfigRecord[]> {
    const [rows] = await this.pool.execute<ImageModelConfigRow[]>(
      `${imageModelSelectSql} ORDER BY image_model_configs.sort_order ASC, image_model_configs.created_at ASC`
    );

    return rows.map(toImageModelConfigRecord);
  }

  async findById(modelId: string): Promise<ImageModelConfigRecord | undefined> {
    const [rows] = await this.pool.execute<ImageModelConfigRow[]>(
      `${imageModelSelectSql} WHERE image_model_configs.id = ? LIMIT 1`,
      [modelId]
    );

    const row = rows.at(0);
    return row === undefined ? undefined : toImageModelConfigRecord(row);
  }

  async upsertFromCatalog(input: SaveImageModelConfigInput): Promise<void> {
    // 同步来源目录只刷新模型来源元数据；管理员改过的开关、能力标签和任务类型不能被 env 覆盖。
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO image_model_configs (
        id, gateway_model_code, display_name, description, capability, source_capability,
        source_status, source_available, admin_enabled, quality_tier, supported_task_types,
        supported_image_sizes, supported_input_types, supported_output_types, max_input_files,
        max_output_count, sort_order, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE
        display_name = VALUES(display_name),
        description = VALUES(description),
        source_status = VALUES(source_status),
        source_available = 1,
        quality_tier = VALUES(quality_tier),
        supported_image_sizes = VALUES(supported_image_sizes),
        supported_input_types = VALUES(supported_input_types),
        supported_output_types = VALUES(supported_output_types),
        max_input_files = VALUES(max_input_files),
        max_output_count = VALUES(max_output_count),
        sort_order = VALUES(sort_order),
        synced_at = CURRENT_TIMESTAMP(3)`,
      [
        input.id,
        input.gateway_model_code,
        input.display_name,
        input.description,
        input.capability,
        input.source_capability,
        input.source_status,
        input.source_available ? 1 : 0,
        input.admin_enabled ? 1 : 0,
        input.quality_tier,
        JSON.stringify(input.supported_task_types),
        JSON.stringify(input.supported_image_sizes),
        JSON.stringify(input.supported_input_types),
        JSON.stringify(input.supported_output_types),
        input.max_input_files,
        input.max_output_count,
        input.sort_order
      ]
    );
  }

  async markMissingSourceModels(activeModelIds: string[]): Promise<void> {
    if (activeModelIds.length === 0) {
      // 来源目录为空时保留历史配置但全部标记不可用，避免用户继续提交已下线模型。
      await this.pool.execute("UPDATE image_model_configs SET source_available = 0");
      return;
    }

    const placeholders = activeModelIds.map(() => "?").join(", ");
    // 不删除已移除模型，保留后台审计和恢复空间；用户端按 source_available 过滤不可见。
    await this.pool.execute(
      `UPDATE image_model_configs SET source_available = 0 WHERE id NOT IN (${placeholders})`,
      activeModelIds
    );
  }

  async update(input: UpdateImageModelConfigInput): Promise<ImageModelConfigRecord | undefined> {
    const assignments: string[] = [];
    const values: (string | number)[] = [];

    addStringAssignment(assignments, values, "display_name", input.display_name);
    addStringAssignment(assignments, values, "description", input.description);
    addStringAssignment(assignments, values, "capability", input.capability);
    addBooleanAssignment(assignments, values, "admin_enabled", input.admin_enabled);
    addJsonAssignment(assignments, values, "supported_task_types", input.supported_task_types);
    addJsonAssignment(assignments, values, "supported_image_sizes", input.supported_image_sizes);
    addNumberAssignment(assignments, values, "max_input_files", input.max_input_files);
    addNumberAssignment(assignments, values, "max_output_count", input.max_output_count);
    addNumberAssignment(assignments, values, "sort_order", input.sort_order);

    if (assignments.length > 0) {
      // PATCH 只更新请求中出现的字段，避免单独切换开关时误清空能力、尺寸或默认配置。
      const [result] = await this.pool.execute<ResultSetHeader>(
        `UPDATE image_model_configs SET ${assignments.join(", ")} WHERE id = ?`,
        [...values, input.id]
      );

      if (result.affectedRows === 0) {
        return undefined;
      }
    }

    if (input.default_task_types !== undefined) {
      await this.replaceDefaultTaskTypes(input.id, input.default_task_types);
    }

    return await this.findById(input.id);
  }

  async replaceDefaultTaskTypes(modelId: string, taskTypes: string[]): Promise<void> {
    // 默认模型按任务类型唯一；先移除当前模型旧关系，再让新任务类型覆盖其它模型。
    await this.pool.execute("DELETE FROM image_model_defaults WHERE model_config_id = ?", [
      modelId
    ]);

    for (const taskType of taskTypes) {
      await this.pool.execute(
        `INSERT INTO image_model_defaults (task_type, model_config_id)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE model_config_id = VALUES(model_config_id)`,
        [taskType, modelId]
      );
    }
  }
}

const imageModelSelectSql = `SELECT
  image_model_configs.id,
  image_model_configs.gateway_model_code,
  image_model_configs.display_name,
  image_model_configs.description,
  image_model_configs.capability,
  image_model_configs.source_capability,
  image_model_configs.source_status,
  image_model_configs.source_available,
  image_model_configs.admin_enabled,
  image_model_configs.quality_tier,
  image_model_configs.supported_task_types,
  image_model_configs.supported_image_sizes,
  image_model_configs.supported_input_types,
  image_model_configs.supported_output_types,
  image_model_configs.max_input_files,
  image_model_configs.max_output_count,
  image_model_configs.sort_order,
  GROUP_CONCAT(image_model_defaults.task_type ORDER BY image_model_defaults.task_type SEPARATOR ',') AS default_task_types,
  DATE_FORMAT(image_model_configs.synced_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS synced_at,
  DATE_FORMAT(image_model_configs.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
  DATE_FORMAT(image_model_configs.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at
 FROM image_model_configs
 LEFT JOIN image_model_defaults
   ON image_model_defaults.model_config_id = image_model_configs.id
 GROUP BY image_model_configs.id`;

function addStringAssignment(
  assignments: string[],
  values: (string | number)[],
  column: string,
  value: string | undefined
): void {
  if (value === undefined) return;
  assignments.push(`${column} = ?`);
  values.push(value);
}

function addBooleanAssignment(
  assignments: string[],
  values: (string | number)[],
  column: string,
  value: boolean | undefined
): void {
  if (value === undefined) return;
  assignments.push(`${column} = ?`);
  values.push(value ? 1 : 0);
}

function addNumberAssignment(
  assignments: string[],
  values: (string | number)[],
  column: string,
  value: number | undefined
): void {
  if (value === undefined) return;
  assignments.push(`${column} = ?`);
  values.push(value);
}

function addJsonAssignment(
  assignments: string[],
  values: (string | number)[],
  column: string,
  value: string[] | undefined
): void {
  if (value === undefined) return;
  assignments.push(`${column} = ?`);
  values.push(JSON.stringify(value));
}

function toImageModelConfigRecord(row: ImageModelConfigRow): ImageModelConfigRecord {
  return {
    id: row.id,
    gateway_model_code: row.gateway_model_code,
    display_name: row.display_name,
    description: row.description,
    capability: row.capability,
    source_capability: row.source_capability,
    source_status: row.source_status,
    source_available: row.source_available === 1,
    admin_enabled: row.admin_enabled === 1,
    quality_tier: row.quality_tier,
    supported_task_types: parseJsonArray(row.supported_task_types),
    supported_image_sizes: parseJsonArray(row.supported_image_sizes),
    supported_input_types: parseJsonArray(row.supported_input_types),
    supported_output_types: parseJsonArray(row.supported_output_types),
    max_input_files: row.max_input_files,
    max_output_count: row.max_output_count,
    sort_order: row.sort_order,
    default_task_types:
      row.default_task_types === null || row.default_task_types.length === 0
        ? []
        : row.default_task_types.split(","),
    synced_at: row.synced_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function parseJsonArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("模型配置 JSON 字段格式异常");
  }

  return parsed;
}
