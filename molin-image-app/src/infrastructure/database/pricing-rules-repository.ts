import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export interface PricingRuleRecord {
  id: string;
  task_type: string;
  gateway_model_code: string | null;
  gateway_capability: string | null;
  quality: string | null;
  image_size: string | null;
  upscale_factor: number | null;
  usage_type: string;
  unit: string;
  points_per_unit: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SavePricingRuleInput {
  id: string;
  task_type: string;
  gateway_model_code: string | null;
  gateway_capability: string | null;
  quality: string | null;
  image_size: string | null;
  upscale_factor: number | null;
  usage_type: string;
  unit: string;
  points_per_unit: string;
  active: boolean;
}

export interface PricingRulesRepository {
  listAll(): Promise<PricingRuleRecord[]>;
  findById(ruleId: string): Promise<PricingRuleRecord | undefined>;
  create(input: SavePricingRuleInput): Promise<PricingRuleRecord>;
  update(input: SavePricingRuleInput): Promise<PricingRuleRecord | undefined>;
}

export class PricingRuleRepositoryConflictError extends Error {
  constructor() {
    super("相同任务和价格维度的规则已存在");
    this.name = "PricingRuleRepositoryConflictError";
  }
}

interface PricingRuleRow extends RowDataPacket {
  id: string;
  task_type: string;
  gateway_model_code: string | null;
  gateway_capability: string | null;
  quality: string | null;
  image_size: string | null;
  upscale_factor: number | null;
  usage_type: string;
  unit: string;
  points_per_unit: string;
  active: number;
  created_at: string;
  updated_at: string;
}

export class MySqlPricingRulesRepository implements PricingRulesRepository {
  constructor(private readonly pool: Pool) {}

  async listAll(): Promise<PricingRuleRecord[]> {
    const [rows] = await this.pool.execute<PricingRuleRow[]>(
      `${pricingRuleSelectSql} ORDER BY task_type ASC, created_at ASC`
    );

    return rows.map(toPricingRuleRecord);
  }

  async findById(ruleId: string): Promise<PricingRuleRecord | undefined> {
    const [rows] = await this.pool.execute<PricingRuleRow[]>(
      `${pricingRuleSelectSql} WHERE id = ? LIMIT 1`,
      [ruleId]
    );

    const row = rows.at(0);
    return row === undefined ? undefined : toPricingRuleRecord(row);
  }

  async create(input: SavePricingRuleInput): Promise<PricingRuleRecord> {
    try {
      await this.pool.execute<ResultSetHeader>(
        `INSERT INTO pricing_rules (
        id, task_type, gateway_model_code, gateway_capability, quality, image_size,
        upscale_factor, usage_type, unit, points_per_unit, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        toSqlParameters(input)
      );
    } catch (error: unknown) {
      throwPricingConflict(error);
    }

    const created = await this.findById(input.id);

    if (created === undefined) {
      throw new Error("价格规则写入后回读失败");
    }

    return created;
  }

  async update(input: SavePricingRuleInput): Promise<PricingRuleRecord | undefined> {
    let result: ResultSetHeader;

    try {
      [result] = await this.pool.execute<ResultSetHeader>(
        `UPDATE pricing_rules SET
        task_type = ?, gateway_model_code = ?, gateway_capability = ?, quality = ?,
        image_size = ?, upscale_factor = ?, usage_type = ?, unit = ?, points_per_unit = ?, active = ?
       WHERE id = ?`,
        [...toSqlParameters(input).slice(1), input.id]
      );
    } catch (error: unknown) {
      throwPricingConflict(error);
    }

    return result.affectedRows === 0 ? undefined : await this.findById(input.id);
  }
}

function throwPricingConflict(error: unknown): never {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ER_DUP_ENTRY"
  ) {
    throw new PricingRuleRepositoryConflictError();
  }

  throw error;
}

const pricingRuleSelectSql = `SELECT
  id, task_type, gateway_model_code, gateway_capability, quality, image_size,
  upscale_factor, usage_type, unit, CAST(points_per_unit AS CHAR) AS points_per_unit,
  active,
  DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
  DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at
 FROM pricing_rules`;

function toSqlParameters(input: SavePricingRuleInput): (string | number | null)[] {
  return [
    input.id,
    input.task_type,
    input.gateway_model_code,
    input.gateway_capability,
    input.quality,
    input.image_size,
    input.upscale_factor,
    input.usage_type,
    input.unit,
    input.points_per_unit,
    input.active ? 1 : 0
  ];
}

function toPricingRuleRecord(row: PricingRuleRow): PricingRuleRecord {
  return {
    ...row,
    active: row.active === 1
  };
}
