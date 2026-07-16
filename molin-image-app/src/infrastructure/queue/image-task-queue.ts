export const IMAGE_TASK_JOB_NAME = "process-image-task" as const;

export interface ImageTaskJobData {
  task_id: string;
}

export interface ImageTaskQueue {
  enqueue(taskId: string): Promise<void>;
  close(): Promise<void>;
}

export class ImageTaskQueueError extends Error {
  readonly code = "IMAGE_TASK_QUEUE_UNAVAILABLE";

  constructor(options?: ErrorOptions) {
    super("图片任务队列暂不可用。", options);
    this.name = "ImageTaskQueueError";
  }
}
