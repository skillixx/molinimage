import type {
  ImageTaskExecutionMetrics,
  ImageTaskExecutionMetricsLogger
} from "./image-task-job-processor.js";

export interface StructuredMetricsSink {
  info(message: string): void;
}

export class ConsoleImageTaskExecutionMetricsLogger implements ImageTaskExecutionMetricsLogger {
  constructor(private readonly sink: StructuredMetricsSink = console) {}

  record(metrics: ImageTaskExecutionMetrics): void {
    // 白名单对象只包含关联 ID、状态和耗时，禁止把任务记录整体序列化进日志。
    this.sink.info(
      JSON.stringify({
        event: "image_task_execution",
        request_id: metrics.request_id,
        task_id: metrics.task_id,
        job_id: metrics.job_id,
        outcome: metrics.outcome,
        attempt_number: metrics.attempt_number,
        queue_wait_ms: metrics.queue_wait_ms,
        execution_ms: metrics.execution_ms,
        end_to_end_ms: metrics.end_to_end_ms
      })
    );
  }
}
