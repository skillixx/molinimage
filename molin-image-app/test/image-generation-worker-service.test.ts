import assert from "node:assert/strict";
import test from "node:test";

import type {
  AiGatewayImageEditClient,
  AiGatewayImageGenerationClient,
  AiGatewayVisionTextClient,
  AnalyzeImageInput,
  AnalyzeImageResult,
  EditImageInput,
  EditImageResult,
  GenerateImageInput,
  GenerateImageResult
} from "../src/infrastructure/ai/ai-gateway-client.js";
import type {
  AiGatewayCallLogsRepository,
  CreateAiGatewayCallLogInput
} from "../src/infrastructure/database/ai-gateway-call-logs-repository.js";
import type {
  CreateFileRecordInput,
  FileRecord,
  FilesRepository
} from "../src/infrastructure/database/files-repository.js";
import type {
  CreateImageTaskRecordInput,
  ImageTaskRecord,
  ImageTasksRepository,
  TransitionImageTaskInput
} from "../src/infrastructure/database/image-tasks-repository.js";
import type {
  PresignedUrlInput,
  StorageService,
  StoredObject,
  UploadObjectInput
} from "../src/infrastructure/storage/storage-service.js";
import { FileService } from "../src/modules/files/file-service.js";
import { ImageTaskService } from "../src/modules/image-tasks/image-task-service.js";
import { ImageGenerationWorkerService } from "../src/workers/image-generation-worker-service.js";
import type {
  ReleaseBillingRequest,
  ReleaseBillingResult,
  ReserveBillingResult,
  SettleBillingResult
} from "../src/modules/billing/billing-service.js";

void test("文生图 worker 调用 AI 网关、保存结果文件、写日志并把任务置为 succeeded", async () => {
  const taskRepository = new InMemoryImageTasksRepository();
  const fileRepository = new InMemoryFilesRepository();
  const storage = new FakeStorageService();
  const aiGateway = new FakeAiGatewayImageGenerationClient();
  const aiLogs = new InMemoryAiGatewayCallLogsRepository();
  const fileService = new FileService(fileRepository, storage, {
    storageProvider: "minio",
    storageBucket: "molinimage",
    storagePresignedUrlTtlSeconds: 300
  });
  const taskService = new ImageTaskService(taskRepository);
  const worker = new ImageGenerationWorkerService(
    taskRepository,
    taskService,
    fileService,
    aiGateway,
    aiLogs
  );
  const task = await taskRepository.create({
    id: "task_text_to_image_001",
    owner_user_id: 479,
    task_type: "text_to_image",
    status: "billing_reserved",
    prompt: "一张蓝色科技海报",
    negative_prompt: null,
    style_preset_id: null,
    input_file_ids: [],
    gateway_model_code: "image-gen-default",
    gateway_capability: "image_generation",
    quality: "standard",
    image_size: "1024x1024",
    image_count: 1,
    cost_points: "6",
    billing_event_id: "billing_001",
    idempotency_key: "task_create_001"
  });

  const result = await worker.processTask(task.id);
  const previewUrls = await fileService.createPreviewUrls(479, result.task.output_file_ids);

  assert.equal(result.task.status, "succeeded");
  assert.equal(result.task.gateway_request_id, "gateway_request_001");
  assert.equal(result.task.output_file_ids.length, 1);
  assert.equal(fileRepository.records.length, 1);
  assert.equal(fileRepository.records[0]?.file_type, "output");
  assert.match(fileRepository.records[0]?.storage_key ?? "", /^generated\/479\//u);
  assert.equal(storage.uploads[0]?.body.toString("utf8"), "fake png bytes");
  assert.equal(
    previewUrls[0]?.preview_url,
    `https://storage.example.com/${fileRepository.records[0]?.storage_key}`
  );
  assert.equal(previewUrls[0]?.download_url, previewUrls[0]?.preview_url);
  assert.equal(aiGateway.inputs[0]?.model, "image-gen-default");
  assert.equal(aiGateway.inputs[0]?.count, 1);
  assert.equal(aiLogs.records.length, 1);
  assert.equal(aiLogs.records[0]?.task_id, task.id);
  assert.equal(aiLogs.records[0]?.success, true);
  assert.equal(aiLogs.records[0]?.gateway_capability, "image_generation");
});

void test("图生文 worker 校验输入图归属、调用 vision_text 并保存文本结果", async () => {
  const taskRepository = new InMemoryImageTasksRepository();
  const fileRepository = new InMemoryFilesRepository();
  const storage = new FakeStorageService();
  const aiGateway = new FakeAiGatewayImageGenerationClient();
  const visionText = new FakeAiGatewayVisionTextClient();
  const aiLogs = new InMemoryAiGatewayCallLogsRepository();
  const fileService = new FileService(fileRepository, storage, {
    storageProvider: "minio",
    storageBucket: "molinimage",
    storagePresignedUrlTtlSeconds: 300
  });
  const taskService = new ImageTaskService(taskRepository);
  const worker = new ImageGenerationWorkerService(
    taskRepository,
    taskService,
    fileService,
    aiGateway,
    aiLogs,
    visionText
  );
  const inputFile = await fileRepository.create({
    id: "file_input_001",
    owner_user_id: 479,
    file_type: "input",
    original_name: "input.png",
    mime_type: "image/png",
    storage_provider: "minio",
    storage_bucket: "molinimage",
    storage_key: "uploads/479/input.png",
    size_bytes: 14,
    checksum: "checksum"
  });
  const task = await taskRepository.create({
    id: "task_image_to_text_001",
    owner_user_id: 479,
    task_type: "image_to_text",
    status: "billing_reserved",
    prompt: "生成标题、标签和短文案",
    negative_prompt: null,
    style_preset_id: null,
    input_file_ids: [inputFile.id],
    gateway_model_code: "vision-text-default",
    gateway_capability: "vision_text",
    quality: "standard",
    image_size: null,
    image_count: 1,
    cost_points: "1",
    billing_event_id: "billing_vision_001",
    idempotency_key: "task_create_vision_001"
  });

  const result = await worker.processTask(task.id);

  assert.equal(result.task.status, "succeeded");
  assert.match(result.task.text_result ?? "", /标题/);
  assert.equal(result.task.gateway_request_id, "vision_request_001");
  assert.equal(visionText.inputs[0]?.model, "vision-text-default");
  assert.equal(visionText.inputs[0]?.imageMimeType, "image/png");
  assert.equal(
    Buffer.from(visionText.inputs[0]?.imageBase64 ?? "", "base64").toString("utf8"),
    "fake png bytes"
  );
  assert.equal(aiLogs.records.at(-1)?.gateway_capability, "vision_text");
  assert.equal(aiLogs.records.at(-1)?.operation, "image_to_text");
});

void test("图生图 worker 校验输入图归属、调用 image_edit 并保存输出图片", async () => {
  const taskRepository = new InMemoryImageTasksRepository();
  const fileRepository = new InMemoryFilesRepository();
  const storage = new FakeStorageService();
  const aiGateway = new FakeAiGatewayImageGenerationClient();
  const visionText = new FakeAiGatewayVisionTextClient();
  const imageEdit = new FakeAiGatewayImageEditClient();
  const aiLogs = new InMemoryAiGatewayCallLogsRepository();
  const fileService = new FileService(fileRepository, storage, {
    storageProvider: "minio",
    storageBucket: "molinimage",
    storagePresignedUrlTtlSeconds: 300
  });
  const taskService = new ImageTaskService(taskRepository);
  const worker = new ImageGenerationWorkerService(
    taskRepository,
    taskService,
    fileService,
    aiGateway,
    aiLogs,
    visionText,
    imageEdit
  );
  const inputFile = await fileRepository.create({
    id: "file_input_edit_001",
    owner_user_id: 479,
    file_type: "input",
    original_name: "reference.png",
    mime_type: "image/png",
    storage_provider: "minio",
    storage_bucket: "molinimage",
    storage_key: "uploads/479/reference.png",
    size_bytes: 14,
    checksum: "checksum"
  });
  const task = await taskRepository.create({
    id: "task_image_to_image_001",
    owner_user_id: 479,
    task_type: "image_to_image",
    status: "billing_reserved",
    prompt: "把背景换成赛博城市夜景",
    negative_prompt: null,
    style_preset_id: "change_background",
    input_file_ids: [inputFile.id],
    gateway_model_code: "image-edit-default",
    gateway_capability: "image_edit",
    quality: "standard",
    image_size: "1024x1024",
    image_count: 1,
    cost_points: "8",
    billing_event_id: "billing_edit_001",
    idempotency_key: "task_create_edit_001"
  });

  const result = await worker.processTask(task.id);

  assert.equal(result.task.status, "succeeded");
  assert.equal(result.task.gateway_request_id, "edit_request_001");
  assert.equal(result.task.output_file_ids.length, 1);
  assert.equal(imageEdit.inputs[0]?.model, "image-edit-default");
  assert.equal(imageEdit.inputs[0]?.imageMimeType, "image/png");
  assert.match(imageEdit.inputs[0]?.prompt ?? "", /换背景|赛博城市/u);
  assert.equal(
    Buffer.from(imageEdit.inputs[0]?.imageBase64 ?? "", "base64").toString("utf8"),
    "fake png bytes"
  );
  assert.equal(fileRepository.records.at(-1)?.file_type, "output");
  assert.equal(aiLogs.records.at(-1)?.gateway_capability, "image_edit");
  assert.equal(aiLogs.records.at(-1)?.operation, "image_to_image");
});

void test("图片修复 worker 根据修复类型调用 image_edit 并保存关联输出", async () => {
  const taskRepository = new InMemoryImageTasksRepository();
  const fileRepository = new InMemoryFilesRepository();
  const storage = new FakeStorageService();
  const aiGateway = new FakeAiGatewayImageGenerationClient();
  const imageEdit = new FakeAiGatewayImageEditClient();
  const aiLogs = new InMemoryAiGatewayCallLogsRepository();
  const fileService = new FileService(fileRepository, storage, {
    storageProvider: "minio",
    storageBucket: "molinimage",
    storagePresignedUrlTtlSeconds: 300
  });
  const taskService = new ImageTaskService(taskRepository);
  const worker = new ImageGenerationWorkerService(
    taskRepository,
    taskService,
    fileService,
    aiGateway,
    aiLogs,
    undefined,
    imageEdit
  );
  const inputFile = await fileRepository.create({
    id: "file_input_restore_001",
    owner_user_id: 479,
    file_type: "input",
    original_name: "old-photo.png",
    mime_type: "image/png",
    storage_provider: "minio",
    storage_bucket: "molinimage",
    storage_key: "uploads/479/old-photo.png",
    size_bytes: 14,
    checksum: "checksum"
  });
  const task = await taskRepository.create({
    id: "task_image_restore_001",
    owner_user_id: 479,
    task_type: "image_restore",
    status: "billing_reserved",
    prompt: "保留人物真实五官",
    negative_prompt: null,
    style_preset_id: "old_photo",
    input_file_ids: [inputFile.id],
    gateway_model_code: "image-edit-default",
    gateway_capability: "image_edit",
    quality: "standard",
    image_size: "1024x1024",
    image_count: 1,
    cost_points: "5",
    billing_event_id: "billing_restore_001",
    idempotency_key: "task_create_restore_001"
  });

  const result = await worker.processTask(task.id);

  assert.equal(result.task.status, "succeeded");
  assert.deepEqual(result.task.input_file_ids, [inputFile.id]);
  assert.equal(result.task.output_file_ids.length, 1);
  assert.match(imageEdit.inputs[0]?.prompt ?? "", /修复老照片/);
  assert.match(imageEdit.inputs[0]?.prompt ?? "", /保留人物真实五官/);
  assert.equal(aiLogs.records.at(-1)?.gateway_capability, "image_edit");
  assert.equal(aiLogs.records.at(-1)?.operation, "image_restore");
});

void test("高清放大 worker 按 4x 目标尺寸调用 image_edit 并记录结果宽高", async () => {
  const taskRepository = new InMemoryImageTasksRepository();
  const fileRepository = new InMemoryFilesRepository();
  const storage = new FakeStorageService();
  const aiGateway = new FakeAiGatewayImageGenerationClient();
  const imageEdit = new FakeUpscaleImageEditClient();
  const aiLogs = new InMemoryAiGatewayCallLogsRepository();
  const fileService = new FileService(fileRepository, storage, {
    storageProvider: "minio",
    storageBucket: "molinimage",
    storagePresignedUrlTtlSeconds: 300
  });
  const taskService = new ImageTaskService(taskRepository);
  const worker = new ImageGenerationWorkerService(
    taskRepository,
    taskService,
    fileService,
    aiGateway,
    aiLogs,
    undefined,
    imageEdit
  );
  const inputFile = await fileRepository.create({
    id: "file_input_upscale_001",
    owner_user_id: 479,
    file_type: "input",
    original_name: "small.png",
    mime_type: "image/png",
    storage_provider: "minio",
    storage_bucket: "molinimage",
    storage_key: "uploads/479/small.png",
    size_bytes: 24,
    width: 120,
    height: 80,
    checksum: "checksum"
  });
  const task = await taskRepository.create({
    id: "task_upscale_001",
    owner_user_id: 479,
    task_type: "upscale",
    status: "billing_reserved",
    prompt: null,
    negative_prompt: null,
    style_preset_id: null,
    input_file_ids: [inputFile.id],
    gateway_model_code: "image-edit-default",
    gateway_capability: "image_edit",
    quality: null,
    image_size: null,
    image_count: 1,
    upscale_factor: 4,
    cost_points: "8",
    billing_event_id: "billing_upscale_001",
    idempotency_key: "task_create_upscale_001"
  });

  const result = await worker.processTask(task.id);
  const outputFile = fileRepository.records.find((file) =>
    result.task.output_file_ids.includes(file.id)
  );

  assert.equal(result.task.status, "succeeded");
  assert.equal(imageEdit.inputs[0]?.size, "480x320");
  assert.match(imageEdit.inputs[0]?.prompt ?? "", /4 倍/);
  assert.ok(outputFile);
  assert.equal(outputFile.width, 480);
  assert.equal(outputFile.height, 320);
  assert.equal(aiLogs.records.at(-1)?.operation, "upscale");
});

void test("图片修复网关失败时任务失败并释放预占积分", async () => {
  const taskRepository = new InMemoryImageTasksRepository();
  const fileRepository = new InMemoryFilesRepository();
  const storage = new FakeStorageService();
  const aiGateway = new FakeAiGatewayImageGenerationClient();
  const imageEdit = new FailingAiGatewayImageEditClient();
  const aiLogs = new FailingAiGatewayCallLogsRepository();
  const billingService = new FakeBillingService();
  const fileService = new FileService(fileRepository, storage, {
    storageProvider: "minio",
    storageBucket: "molinimage",
    storagePresignedUrlTtlSeconds: 300
  });
  const taskService = new ImageTaskService(taskRepository, billingService);
  const worker = new ImageGenerationWorkerService(
    taskRepository,
    taskService,
    fileService,
    aiGateway,
    aiLogs,
    undefined,
    imageEdit
  );
  const inputFile = await fileRepository.create({
    id: "file_input_restore_failed_001",
    owner_user_id: 479,
    file_type: "input",
    original_name: "blurred.png",
    mime_type: "image/png",
    storage_provider: "minio",
    storage_bucket: "molinimage",
    storage_key: "uploads/479/blurred.png",
    size_bytes: 14,
    checksum: "checksum"
  });
  const task = await taskRepository.create({
    id: "task_image_restore_failed_001",
    owner_user_id: 479,
    task_type: "image_restore",
    status: "billing_reserved",
    prompt: null,
    negative_prompt: null,
    style_preset_id: "deblur",
    input_file_ids: [inputFile.id],
    gateway_model_code: "image-edit-default",
    gateway_capability: "image_edit",
    quality: "standard",
    image_size: "1024x1024",
    image_count: 1,
    cost_points: "5",
    billing_event_id: "billing_restore_failed_001",
    idempotency_key: "task_create_restore_failed_001"
  });

  const result = await worker.processTask(task.id);

  assert.equal(result.task.status, "failed");
  assert.equal(result.task.error_code, "AI_GATEWAY_FAILED");
  assert.equal(billingService.releaseRequests.length, 1);
  assert.equal(
    billingService.releaseRequests[0]?.idempotencyKey,
    "task_image_restore_failed_001:image_restore:release"
  );
  // 即使审计日志存储失败，任务失败路径也必须继续释放预占积分。
  assert.equal(aiLogs.records.at(-1)?.operation, "image_restore");
});

void test("文件存储失败时 worker 标记失败并释放预占积分", async () => {
  const taskRepository = new InMemoryImageTasksRepository();
  const fileRepository = new InMemoryFilesRepository();
  const storage = new FailingUploadStorageService();
  const aiGateway = new FakeAiGatewayImageGenerationClient();
  const aiLogs = new InMemoryAiGatewayCallLogsRepository();
  const billingService = new FakeBillingService();
  const fileService = new FileService(fileRepository, storage, {
    storageProvider: "minio",
    storageBucket: "molinimage",
    storagePresignedUrlTtlSeconds: 300
  });
  const taskService = new ImageTaskService(taskRepository, billingService);
  const worker = new ImageGenerationWorkerService(
    taskRepository,
    taskService,
    fileService,
    aiGateway,
    aiLogs
  );
  const task = await taskRepository.create({
    id: "task_storage_failed_001",
    owner_user_id: 479,
    task_type: "text_to_image",
    status: "billing_reserved",
    prompt: "一张蓝色科技海报",
    negative_prompt: null,
    style_preset_id: null,
    input_file_ids: [],
    gateway_model_code: "image-gen-default",
    gateway_capability: "image_generation",
    quality: "standard",
    image_size: "1024x1024",
    image_count: 1,
    cost_points: "6",
    billing_event_id: "billing_storage_failed_001",
    idempotency_key: "task_create_storage_failed_001"
  });

  const result = await worker.processTask(task.id);

  assert.equal(result.task.status, "failed");
  assert.equal(result.task.error_code, "FILE_STORAGE_FAILED");
  assert.equal(fileRepository.records.length, 0);
  assert.equal(billingService.releaseRequests.length, 1);
  assert.equal(
    billingService.releaseRequests[0]?.idempotencyKey,
    "task_storage_failed_001:text_to_image:release"
  );
});

class InMemoryImageTasksRepository implements ImageTasksRepository {
  readonly records = new Map<string, ImageTaskRecord>();

  create(input: CreateImageTaskRecordInput): Promise<ImageTaskRecord> {
    const now = new Date("2026-07-09T00:00:00.000Z").toISOString();
    const record: ImageTaskRecord = {
      ...input,
      source_task_id: input.source_task_id ?? null,
      entitlement_id: input.entitlement_id ?? null,
      upscale_factor: input.upscale_factor ?? null,
      output_file_ids: [],
      text_result: null,
      gateway_request_id: null,
      error_code: null,
      error_message: null,
      is_favorited: false,
      deleted_at: null,
      created_at: now,
      updated_at: now
    };

    this.records.set(record.id, record);

    return Promise.resolve(record);
  }

  findById(taskId: string): Promise<ImageTaskRecord | undefined> {
    return Promise.resolve(this.records.get(taskId));
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<ImageTaskRecord | undefined> {
    return Promise.resolve(
      Array.from(this.records.values()).find((record) => record.idempotency_key === idempotencyKey)
    );
  }

  updateStatus(input: TransitionImageTaskInput): Promise<ImageTaskRecord | undefined> {
    const record = this.records.get(input.taskId);

    if (record?.owner_user_id !== input.ownerUserId || record.status !== input.fromStatus) {
      return Promise.resolve(undefined);
    }

    const updated: ImageTaskRecord = {
      ...record,
      status: input.toStatus,
      output_file_ids: input.outputFileIds ?? record.output_file_ids,
      text_result: input.textResult ?? record.text_result,
      gateway_request_id: input.gatewayRequestId ?? record.gateway_request_id,
      billing_event_id: input.billingEventId ?? record.billing_event_id,
      error_code: input.errorCode ?? null,
      error_message: input.errorMessage ?? null,
      updated_at: new Date("2026-07-09T00:01:00.000Z").toISOString()
    };

    this.records.set(updated.id, updated);

    return Promise.resolve(updated);
  }

  findHistoryByOwner(input: {
    ownerUserId: number;
    taskType?: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: ImageTaskRecord[]; total: number }> {
    const items = Array.from(this.records.values()).filter(
      (record) =>
        record.owner_user_id === input.ownerUserId &&
        record.status === "succeeded" &&
        record.deleted_at === null &&
        (input.taskType === undefined || record.task_type === input.taskType)
    );

    return Promise.resolve({
      items: items.slice((input.page - 1) * input.pageSize, input.page * input.pageSize),
      total: items.length
    });
  }

  markFavorite(): Promise<ImageTaskRecord | undefined> {
    return Promise.resolve(undefined);
  }

  softDeleteHistoryItem(): Promise<ImageTaskRecord | undefined> {
    return Promise.resolve(undefined);
  }
}

class InMemoryFilesRepository implements FilesRepository {
  readonly records: FileRecord[] = [];

  create(input: CreateFileRecordInput): Promise<FileRecord> {
    const record: FileRecord = {
      ...input,
      width: input.width ?? null,
      height: input.height ?? null,
      created_at: new Date("2026-07-09T00:00:00.000Z").toISOString()
    };

    this.records.push(record);

    return Promise.resolve(record);
  }

  findById(fileId: string): Promise<FileRecord | undefined> {
    return Promise.resolve(this.records.find((record) => record.id === fileId));
  }

  findManyByIds(fileIds: string[]): Promise<FileRecord[]> {
    return Promise.resolve(this.records.filter((record) => fileIds.includes(record.id)));
  }
}

class FakeStorageService implements StorageService {
  readonly uploads: UploadObjectInput[] = [];

  uploadObject(input: UploadObjectInput): Promise<StoredObject> {
    this.uploads.push(input);

    return Promise.resolve({
      provider: "minio",
      bucket: "molinimage",
      key: input.key
    });
  }

  readObject(): Promise<Buffer> {
    return Promise.resolve(Buffer.from("fake png bytes"));
  }

  createPresignedGetUrl(input: PresignedUrlInput): Promise<string> {
    return Promise.resolve(`https://storage.example.com/${input.key}`);
  }
}

class FailingUploadStorageService extends FakeStorageService {
  override uploadObject(input: UploadObjectInput): Promise<StoredObject> {
    this.uploads.push(input);

    return Promise.reject(new Error("对象存储写入失败。"));
  }
}

class FakeAiGatewayImageGenerationClient implements AiGatewayImageGenerationClient {
  readonly inputs: GenerateImageInput[] = [];

  generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
    this.inputs.push(input);

    return Promise.resolve({
      request_id: "gateway_request_001",
      images: [
        {
          mime_type: "image/png",
          content_base64: Buffer.from("fake png bytes").toString("base64")
        }
      ],
      usage: {
        image_count: 1
      }
    });
  }
}

class FakeAiGatewayVisionTextClient implements AiGatewayVisionTextClient {
  readonly inputs: AnalyzeImageInput[] = [];

  analyzeImage(input: AnalyzeImageInput): Promise<AnalyzeImageResult> {
    this.inputs.push(input);

    return Promise.resolve({
      request_id: "vision_request_001",
      text: "标题：清晨咖啡\n标签：咖啡、生活方式\n文案：用一杯咖啡开启灵感。",
      usage: {
        prompt_tokens: 10
      }
    });
  }
}

class FakeAiGatewayImageEditClient implements AiGatewayImageEditClient {
  readonly inputs: EditImageInput[] = [];

  editImage(input: EditImageInput): Promise<EditImageResult> {
    this.inputs.push(input);

    return Promise.resolve({
      request_id: "edit_request_001",
      images: [
        {
          mime_type: "image/png",
          content_base64: Buffer.from("fake edited png bytes").toString("base64")
        }
      ],
      usage: {
        image_count: 1
      }
    });
  }
}

class FakeUpscaleImageEditClient implements AiGatewayImageEditClient {
  readonly inputs: EditImageInput[] = [];

  editImage(input: EditImageInput): Promise<EditImageResult> {
    this.inputs.push(input);
    const [width, height] = input.size.split("x").map(Number);

    return Promise.resolve({
      request_id: "upscale_request_001",
      images: [
        {
          mime_type: "image/png",
          content_base64: createPngHeader(width, height).toString("base64")
        }
      ],
      usage: { image_count: 1 }
    });
  }
}

class FailingAiGatewayImageEditClient implements AiGatewayImageEditClient {
  editImage(): Promise<EditImageResult> {
    return Promise.reject(new Error("图片修复模型调用失败。"));
  }
}

class InMemoryAiGatewayCallLogsRepository implements AiGatewayCallLogsRepository {
  readonly records: CreateAiGatewayCallLogInput[] = [];

  create(input: CreateAiGatewayCallLogInput): Promise<void> {
    this.records.push(input);

    return Promise.resolve();
  }
}

class FailingAiGatewayCallLogsRepository extends InMemoryAiGatewayCallLogsRepository {
  override create(input: CreateAiGatewayCallLogInput): Promise<void> {
    this.records.push(input);

    return Promise.reject(new Error("AI 调用日志写入失败。"));
  }
}

class FakeBillingService {
  readonly releaseRequests: ReleaseBillingRequest[] = [];

  reserve(): Promise<ReserveBillingResult> {
    return Promise.reject(new Error("worker 测试不需要预占"));
  }

  release(request: ReleaseBillingRequest): Promise<ReleaseBillingResult> {
    this.releaseRequests.push(request);

    return Promise.resolve({
      released: true,
      billing_event: {
        id: "billing_release_storage_failed_001",
        owner_user_id: request.ownerUserId,
        task_id: request.taskId,
        event_type: "release",
        amount_points: "6",
        status: "released",
        idempotency_key: request.idempotencyKey,
        moling_reserve_id: "hold_storage_failed_001",
        moling_entitlement_id: 62,
        created_at: "2026-07-09T00:00:00.000Z",
        updated_at: "2026-07-09T00:00:00.000Z"
      }
    });
  }

  settle(): Promise<SettleBillingResult> {
    return Promise.reject(new Error("失败 worker 测试不需要结算预占"));
  }
}

function createPngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);

  return buffer;
}
