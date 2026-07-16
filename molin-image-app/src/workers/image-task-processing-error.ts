export interface ImageTaskProcessingErrorOptions {
  code: string;
  message: string;
  retryable: boolean;
  cause?: unknown;
}

/**
 * Worker 内部统一错误契约。
 * retryable 只描述本次失败是否值得由队列再次执行，最终任务状态仍由 Job Processor 决定。
 */
export class ImageTaskProcessingError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(options: ImageTaskProcessingErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "ImageTaskProcessingError";
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

export function toImageTaskProcessingError(
  error: unknown,
  fallback: { code: string; message: string; retryable: boolean }
): ImageTaskProcessingError {
  if (error instanceof ImageTaskProcessingError) {
    return error;
  }

  return new ImageTaskProcessingError({ ...fallback, cause: error });
}
