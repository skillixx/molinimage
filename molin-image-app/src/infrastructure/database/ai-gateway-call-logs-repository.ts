import type { Pool, ResultSetHeader } from "mysql2/promise";

export interface CreateAiGatewayCallLogInput {
  id: string;
  task_id: string | null;
  request_id: string;
  gateway_model_code: string;
  gateway_capability: string;
  operation: string;
  latency_ms: number | null;
  success: boolean;
  usage_json: Record<string, unknown> | null;
  input_summary: string | null;
  output_summary: string | null;
  error_code: string | null;
  error_message: string | null;
}

export interface AiGatewayCallLogsRepository {
  create(input: CreateAiGatewayCallLogInput): Promise<void>;
}

export class MySqlAiGatewayCallLogsRepository implements AiGatewayCallLogsRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateAiGatewayCallLogInput): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO ai_gateway_call_logs (
        id,
        task_id,
        request_id,
        gateway_model_code,
        gateway_capability,
        operation,
        latency_ms,
        success,
        usage_json,
        input_summary,
        output_summary,
        error_code,
        error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.task_id,
        input.request_id,
        input.gateway_model_code,
        input.gateway_capability,
        input.operation,
        input.latency_ms,
        input.success ? 1 : 0,
        input.usage_json === null ? null : JSON.stringify(input.usage_json),
        input.input_summary,
        input.output_summary,
        input.error_code,
        input.error_message
      ]
    );
  }
}
