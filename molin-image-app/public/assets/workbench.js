import {
  createImageTask,
  deleteHistoryItem,
  estimateBilling,
  favoriteHistoryItem,
  getCurrentUser,
  getImageHistory,
  getImageModels,
  retryImageTask,
  uploadImageFile
} from "./api-client.js";

const modeConfig = {
  text_to_image: {
    title: "文生图",
    eyebrow: "TEXT TO IMAGE",
    capability: "image_generation",
    placeholder: "输入画面主题、风格、主体、背景和细节",
    requiresUpload: false
  },
  image_to_text: {
    title: "图生文",
    eyebrow: "IMAGE TO TEXT",
    capability: "vision_text",
    placeholder: "可选：说明希望生成描述、标题、标签、商品文案或社媒文案",
    requiresUpload: true
  },
  image_to_image: {
    title: "图生图",
    eyebrow: "IMAGE TO IMAGE",
    capability: "image_edit",
    placeholder: "描述需要保持、替换或增强的画面部分",
    requiresUpload: true
  },
  image_restore: {
    title: "图片修复",
    eyebrow: "IMAGE RESTORE",
    capability: "image_edit",
    placeholder: "描述修复目标，例如去噪、增强清晰度、色彩修复",
    requiresUpload: true
  },
  upscale: {
    title: "高清放大",
    eyebrow: "IMAGE UPSCALE",
    capability: "image_edit",
    placeholder: "高清放大将保持原图内容并增强细节",
    requiresUpload: true
  }
};

const state = {
  mode: "text_to_image",
  models: [],
  estimate: null,
  isSubmitting: false,
  referenceFileId: null
};

const elements = {
  sessionSummary: document.querySelector("#sessionSummary"),
  modelHealth: document.querySelector("#modelHealth"),
  refreshButton: document.querySelector("#refreshButton"),
  errorBanner: document.querySelector("#errorBanner"),
  modeTabs: Array.from(document.querySelectorAll(".mode-tab")),
  modeEyebrow: document.querySelector("#modeEyebrow"),
  modeTitle: document.querySelector("#modeTitle"),
  promptField: document.querySelector("#promptField"),
  promptInput: document.querySelector("#promptInput"),
  imageUploadField: document.querySelector("#imageUploadField"),
  imageInput: document.querySelector("#imageInput"),
  uploadHint: document.querySelector("#uploadHint"),
  editModeField: document.querySelector("#editModeField"),
  editModeSelect: document.querySelector("#editModeSelect"),
  restoreTypeField: document.querySelector("#restoreTypeField"),
  restoreTypeSelect: document.querySelector("#restoreTypeSelect"),
  upscaleFactorField: document.querySelector("#upscaleFactorField"),
  upscaleFactorSelect: document.querySelector("#upscaleFactorSelect"),
  modelSelect: document.querySelector("#modelSelect"),
  sizeField: document.querySelector("#sizeField"),
  sizeSelect: document.querySelector("#sizeSelect"),
  countField: document.querySelector("#countField"),
  countSelect: document.querySelector("#countSelect"),
  estimateStrip: document.querySelector("#estimateStrip"),
  estimatePoints: document.querySelector("#estimatePoints"),
  estimateBalance: document.querySelector("#estimateBalance"),
  primaryAction: document.querySelector("#primaryAction"),
  actionHint: document.querySelector("#actionHint"),
  taskProgress: document.querySelector("#taskProgress"),
  modelList: document.querySelector("#modelList"),
  resultList: document.querySelector("#resultList"),
  historyList: document.querySelector("#historyList")
};

elements.refreshButton.addEventListener("click", () => {
  void bootstrapWorkbench();
});
elements.sizeSelect.addEventListener("change", () => {
  void refreshEstimate();
});
elements.countSelect.addEventListener("change", () => {
  void refreshEstimate();
});
elements.upscaleFactorSelect.addEventListener("change", () => {
  void refreshEstimate();
});
elements.primaryAction.addEventListener("click", () => {
  void submitCurrentTask();
});
elements.imageInput.addEventListener("change", () => {
  // 用户重新选择本地图片时，清掉“继续编辑”带来的历史文件引用，避免一次提交混用两个输入来源。
  state.referenceFileId = null;
  renderUploadHint();
});

for (const tab of elements.modeTabs) {
  tab.addEventListener("click", () => {
    const nextMode = tab.dataset.mode;

    if (nextMode === undefined || !(nextMode in modeConfig)) {
      return;
    }

    state.mode = nextMode;
    state.referenceFileId = null;
    elements.imageInput.value = "";
    elements.resultList.replaceChildren();
    renderMode();
    renderModelOptions();
    renderProgress("idle");
    void refreshEstimate();
    void refreshHistory();
  });
}

void bootstrapWorkbench();

async function bootstrapWorkbench() {
  clearError();
  setModelHealth("模型加载中", "loading");

  try {
    const [user, modelCatalog] = await Promise.all([getCurrentUser(), getImageModels()]);
    state.models = modelCatalog.items ?? [];
    elements.sessionSummary.textContent = `用户 ${String(user.user_id)} · 应用 ${String(user.app_id)}`;
    setModelHealth(
      resolveModelHealthText(modelCatalog),
      modelCatalog.message === null ? "ready" : "warning"
    );
    renderMode();
    renderModelOptions();
    renderModelList(modelCatalog);
    renderProgress("idle");
    await Promise.all([refreshEstimate(), refreshHistory()]);
  } catch (error) {
    elements.sessionSummary.textContent = "未建立应用会话";
    state.models = [];
    setModelHealth("模型不可用", "warning");
    renderMode();
    renderModelOptions();
    renderModelList({ items: [], message: "请从墨灵平台进入应用后重试。" });
    renderProgress("idle");
    showError(error instanceof Error ? error.message : "工作台加载失败。");
  }
}

function renderMode() {
  const config = modeConfig[state.mode];

  elements.modeEyebrow.textContent = config.eyebrow;
  elements.modeTitle.textContent = config.title;
  elements.promptInput.placeholder = config.placeholder;
  elements.imageUploadField.hidden = !config.requiresUpload;
  elements.promptField.hidden = state.mode === "upscale";
  elements.editModeField.hidden = state.mode !== "image_to_image";
  elements.restoreTypeField.hidden = state.mode !== "image_restore";
  elements.upscaleFactorField.hidden = state.mode !== "upscale";
  elements.sizeField.hidden = state.mode === "upscale";
  elements.countField.hidden = state.mode === "upscale";
  elements.sizeSelect.disabled = state.mode === "image_to_text";
  elements.countSelect.disabled = state.mode === "image_to_text";
  renderUploadHint();

  if (state.mode === "image_to_text" || state.mode === "upscale") {
    elements.countSelect.value = "1";
  }

  elements.actionHint.textContent =
    state.mode === "image_to_text"
      ? "上传图片后将生成可复制的描述、标题、标签或文案"
      : "提交后将预占积分并生成图片";

  for (const tab of elements.modeTabs) {
    tab.classList.toggle("is-active", tab.dataset.mode === state.mode);
  }

  updatePrimaryActionState();
}

async function refreshEstimate() {
  state.estimate = null;
  elements.estimatePoints.textContent = "--";
  elements.estimateBalance.textContent = "余额校验中";
  elements.estimateStrip.dataset.tone = "loading";
  updatePrimaryActionState();

  try {
    const estimate = await estimateBilling({
      task_type: state.mode,
      image_count: state.mode === "image_to_text" ? 1 : Number(elements.countSelect.value),
      image_size:
        state.mode === "image_to_text" || state.mode === "upscale"
          ? undefined
          : elements.sizeSelect.value,
      upscale_factor:
        state.mode === "upscale" ? Number(elements.upscaleFactorSelect.value) : undefined
    });

    state.estimate = estimate;
    elements.estimatePoints.textContent = `${estimate.estimated_points} ${estimate.unit}`;
    elements.estimateBalance.textContent = estimate.enough_balance
      ? `余额 ${estimate.balance_points}`
      : "余额不足";
    elements.estimateStrip.dataset.tone = estimate.enough_balance ? "ready" : "warning";
    updatePrimaryActionState();
  } catch (error) {
    state.estimate = null;
    elements.estimatePoints.textContent = "--";
    elements.estimateBalance.textContent = error instanceof Error ? error.message : "计费估算失败";
    elements.estimateStrip.dataset.tone = "warning";
    updatePrimaryActionState();
  }
}

async function submitCurrentTask() {
  if (state.mode === "text_to_image") {
    await submitTextToImageTask();
    return;
  }

  if (state.mode === "image_to_text") {
    await submitImageToTextTask();
    return;
  }

  if (state.mode === "image_to_image") {
    await submitImageToImageTask();
    return;
  }

  if (state.mode === "image_restore") {
    await submitImageRestoreTask();
    return;
  }

  if (state.mode === "upscale") {
    await submitUpscaleTask();
    return;
  }

  showError("当前模式暂不可用。");
}

async function submitTextToImageTask() {
  clearError();

  const prompt = elements.promptInput.value.trim();
  const modelCode = elements.modelSelect.value;

  if (prompt.length === 0) {
    showError("请输入提示词。");
    return;
  }

  if (modelCode.length === 0) {
    showError("当前模式暂无可用模型。");
    return;
  }

  setSubmitting(true, "正在预占积分并调用 AI 网关生成图片");
  renderProgress("generating");

  try {
    const result = await createImageTask({
      task_type: "text_to_image",
      prompt,
      gateway_model_code: modelCode,
      gateway_capability: "image_generation",
      image_size: elements.sizeSelect.value,
      image_count: Number(elements.countSelect.value)
    });

    renderTaskResult(result);
    renderProgress(result.task.status === "failed" ? "failed" : "completed");
    elements.actionHint.textContent = `任务 ${result.task.id} 已完成`;
    await Promise.all([refreshEstimate(), refreshHistory()]);
  } catch (error) {
    renderProgress("failed");
    showError(error instanceof Error ? error.message : "文生图任务提交失败。");
  } finally {
    setSubmitting(false);
  }
}

async function submitImageToTextTask() {
  clearError();

  const modelCode = elements.modelSelect.value;
  const file = elements.imageInput.files?.[0];

  if (modelCode.length === 0) {
    showError("当前模式暂无可用模型。");
    return;
  }

  if (file === undefined) {
    showError("请先上传一张图片。");
    return;
  }

  setSubmitting(true, "正在上传图片并调用图生文模型");
  renderProgress("uploading");

  try {
    const uploaded = await uploadImageFile({
      file_name: file.name,
      mime_type: file.type,
      content_base64: await readFileAsBase64(file),
      file_type: "input"
    });
    renderProgress("generating");
    const result = await createImageTask({
      task_type: "image_to_text",
      prompt: elements.promptInput.value.trim(),
      input_file_ids: [uploaded.file.id],
      gateway_model_code: modelCode,
      gateway_capability: "vision_text",
      image_count: 1
    });

    renderTaskResult(result);
    renderProgress(result.task.status === "failed" ? "failed" : "completed");
    elements.actionHint.textContent = `任务 ${result.task.id} 已完成`;
    await Promise.all([refreshEstimate(), refreshHistory()]);
  } catch (error) {
    renderProgress("failed");
    showError(error instanceof Error ? error.message : "图生文任务提交失败。");
  } finally {
    setSubmitting(false);
  }
}

async function submitImageToImageTask() {
  clearError();

  const prompt = elements.promptInput.value.trim();
  const modelCode = elements.modelSelect.value;
  const file = elements.imageInput.files?.[0];

  if (modelCode.length === 0) {
    showError("当前模式暂无可用模型。");
    return;
  }

  if (prompt.length === 0) {
    showError("请描述希望如何编辑参考图。");
    return;
  }

  if (file === undefined && state.referenceFileId === null) {
    showError("请先上传一张参考图，或从生成结果中选择继续编辑。");
    return;
  }

  setSubmitting(true, "正在上传参考图并调用图生图模型");
  renderProgress(file === undefined ? "generating" : "uploading");

  try {
    let inputFileId = state.referenceFileId;

    if (file !== undefined) {
      const uploaded = await uploadImageFile({
        file_name: file.name,
        mime_type: file.type,
        content_base64: await readFileAsBase64(file),
        file_type: "input"
      });

      inputFileId = uploaded.file.id;
    }

    if (inputFileId === null) {
      showError("参考图不可用，请重新上传图片。");
      return;
    }

    renderProgress("generating");
    const result = await createImageTask({
      task_type: "image_to_image",
      prompt,
      style_preset_id: elements.editModeSelect.value,
      input_file_ids: [inputFileId],
      gateway_model_code: modelCode,
      gateway_capability: "image_edit",
      image_size: elements.sizeSelect.value,
      image_count: Number(elements.countSelect.value)
    });

    renderTaskResult(result);
    renderProgress(result.task.status === "failed" ? "failed" : "completed");
    elements.actionHint.textContent = `任务 ${result.task.id} 已完成`;
    await Promise.all([refreshEstimate(), refreshHistory()]);
  } catch (error) {
    renderProgress("failed");
    showError(error instanceof Error ? error.message : "图生图任务提交失败。");
  } finally {
    setSubmitting(false);
  }
}

async function submitImageRestoreTask() {
  clearError();

  const modelCode = elements.modelSelect.value;
  const file = elements.imageInput.files?.[0];

  if (modelCode.length === 0) {
    showError("当前模式暂无可用模型。");
    return;
  }

  if (file === undefined) {
    showError("请先上传一张需要修复的原图。");
    return;
  }

  if (!confirmHighConsumptionTask("图片修复")) {
    elements.actionHint.textContent = "已取消图片修复，本次不会预占积分";
    return;
  }

  setSubmitting(true, "正在上传原图并调用图片修复模型");
  renderProgress("uploading");

  try {
    const uploaded = await uploadImageFile({
      file_name: file.name,
      mime_type: file.type,
      content_base64: await readFileAsBase64(file),
      file_type: "input"
    });

    renderProgress("generating");
    const result = await createImageTask({
      task_type: "image_restore",
      prompt: elements.promptInput.value.trim(),
      style_preset_id: elements.restoreTypeSelect.value,
      input_file_ids: [uploaded.file.id],
      gateway_model_code: modelCode,
      gateway_capability: "image_edit",
      image_size: elements.sizeSelect.value,
      image_count: Number(elements.countSelect.value)
    });

    renderTaskResult(result);
    renderProgress(result.task.status === "failed" ? "failed" : "completed");
    elements.actionHint.textContent = `修复任务 ${result.task.id} 已完成`;
    await Promise.all([refreshEstimate(), refreshHistory()]);
  } catch (error) {
    renderProgress("failed");
    showError(error instanceof Error ? error.message : "图片修复任务提交失败。");
  } finally {
    setSubmitting(false);
  }
}

async function submitUpscaleTask() {
  clearError();

  const modelCode = elements.modelSelect.value;
  const file = elements.imageInput.files?.[0];
  const upscaleFactor = Number(elements.upscaleFactorSelect.value);

  if (modelCode.length === 0) {
    showError("当前模式暂无可用模型。");
    return;
  }

  if (file === undefined) {
    showError("请先上传一张需要放大的原图。");
    return;
  }

  if (!confirmHighConsumptionTask(`高清放大 ${String(upscaleFactor)}x`)) {
    elements.actionHint.textContent = "已取消高清放大，本次不会预占积分";
    return;
  }

  setSubmitting(true, "正在上传原图并调用高清放大模型");
  renderProgress("uploading");

  try {
    const uploaded = await uploadImageFile({
      file_name: file.name,
      mime_type: file.type,
      content_base64: await readFileAsBase64(file),
      file_type: "input"
    });

    renderProgress("generating");
    const result = await createImageTask({
      task_type: "upscale",
      upscale_factor: upscaleFactor,
      input_file_ids: [uploaded.file.id],
      gateway_model_code: modelCode,
      gateway_capability: "image_edit",
      image_count: 1
    });

    renderTaskResult(result);
    renderProgress(result.task.status === "failed" ? "failed" : "completed");
    elements.actionHint.textContent = `放大任务 ${result.task.id} 已完成`;
    await Promise.all([refreshEstimate(), refreshHistory()]);
  } catch (error) {
    renderProgress("failed");
    showError(error instanceof Error ? error.message : "高清放大任务提交失败。");
  } finally {
    setSubmitting(false);
  }
}

function confirmHighConsumptionTask(operationLabel) {
  const estimatedPoints = state.estimate?.estimated_points ?? "--";
  const outputCount = elements.countSelect.value;

  // 图片修复和高清放大属于高消耗操作，在上传原图和预占积分之前要求用户明确确认。
  const confirmationLabel =
    operationLabel === "图片修复" ? "图片修复属于高消耗任务" : `${operationLabel}属于高消耗任务`;

  return window.confirm(
    `${confirmationLabel}，预计消耗 ${estimatedPoints} 积分并生成 ${outputCount} 张结果。确认继续吗？`
  );
}

function setSubmitting(isSubmitting, message = "") {
  state.isSubmitting = isSubmitting;
  elements.primaryAction.textContent = isSubmitting ? "生成中" : "创建任务";
  elements.actionHint.textContent = isSubmitting ? message : elements.actionHint.textContent;
  updatePrimaryActionState();
}

function renderTaskResult(result) {
  elements.resultList.replaceChildren();

  if (result.task.status === "failed") {
    elements.resultList.append(createFailedResultCard(result.task));
    return;
  }

  if (result.task.text_result !== null && result.task.text_result.length > 0) {
    elements.resultList.append(createTextResultCard(result.task.text_result));
    return;
  }

  const files = result.result_files ?? [];
  const inputFiles = result.input_files ?? [];

  if (inputFiles.length > 0) {
    elements.resultList.append(createInputReferenceCard(inputFiles));
  }

  if (files.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-text";
    empty.textContent = "任务已提交，暂无结果文件。";
    elements.resultList.append(empty);
    return;
  }

  for (const file of files) {
    elements.resultList.append(createImageResultCard(file));
  }
}

function createInputReferenceCard(files) {
  const item = document.createElement("article");
  const title = document.createElement("strong");
  const grid = document.createElement("div");

  item.className = "reference-result";
  title.textContent = "参考图";
  grid.className = "reference-grid";

  for (const file of files) {
    const image = document.createElement("img");

    image.alt = "输入参考图";
    image.src = file.preview_url;
    grid.append(image);
  }

  item.append(title, grid);

  return item;
}

function createImageResultCard(file) {
  const item = document.createElement("article");
  const image = document.createElement("img");
  const actions = document.createElement("div");
  const downloadLink = document.createElement("a");
  const continueButton = document.createElement("button");
  const dimensions = document.createElement("small");

  item.className = "result-item";
  image.alt = "生成结果";
  image.src = file.preview_url;
  actions.className = "result-actions";
  downloadLink.href = file.download_url;
  downloadLink.target = "_blank";
  downloadLink.rel = "noreferrer";
  downloadLink.textContent = "下载";
  continueButton.type = "button";
  continueButton.className = "ghost-button copy-button";
  continueButton.textContent = "继续编辑";
  continueButton.addEventListener("click", () => {
    useFileAsReference(file.file.id);
  });

  dimensions.className = "result-dimensions";
  dimensions.textContent =
    file.file.width !== null && file.file.height !== null
      ? `${String(file.file.width)} x ${String(file.file.height)}`
      : "尺寸未知";

  actions.append(dimensions, downloadLink, continueButton);
  item.append(image, actions);

  return item;
}

function createFailedResultCard(task) {
  const item = document.createElement("article");
  const title = document.createElement("strong");
  const message = document.createElement("p");
  const retryButton = document.createElement("button");

  item.className = "failed-result";
  title.textContent = "生成失败，积分已释放";
  message.textContent = task.error_message ?? "任务失败，本次不会扣除积分。";
  retryButton.type = "button";
  retryButton.className = "primary-button";
  retryButton.textContent = "重试";
  retryButton.addEventListener("click", async () => {
    await runHistoryAction(retryButton, "重试中", async () => {
      const retryResult = await retryImageTask(task.id);

      renderTaskResult(retryResult);
      renderProgress(retryResult.task.status === "failed" ? "failed" : "completed");
      elements.actionHint.textContent = `重试任务 ${retryResult.task.id} 已处理`;
      await Promise.all([refreshEstimate(), refreshHistory()]);
    });
  });

  item.append(title, message, retryButton);

  return item;
}

function renderProgress(stage) {
  const steps = resolveProgressSteps();

  elements.taskProgress.replaceChildren();

  for (const step of steps) {
    const item = document.createElement("div");
    const dot = document.createElement("span");
    const label = document.createElement("strong");
    const detail = document.createElement("small");
    const status = resolveProgressStatus(step.id, stage);

    item.className = "progress-step";
    item.dataset.status = status;
    dot.className = "progress-dot";
    label.textContent = step.label;
    detail.textContent = progressStatusText(status);
    item.append(dot, label, detail);
    elements.taskProgress.append(item);
  }
}

function resolveProgressSteps() {
  if (
    state.mode === "image_to_text" ||
    state.mode === "image_to_image" ||
    state.mode === "image_restore" ||
    state.mode === "upscale"
  ) {
    return [
      { id: "upload", label: "上传图片" },
      { id: "reserve", label: "预占积分" },
      {
        id: "generate",
        label:
          state.mode === "image_to_text"
            ? "生成文本"
            : state.mode === "image_restore"
              ? "修复图片"
              : state.mode === "upscale"
                ? "高清放大"
                : "编辑图片"
      },
      {
        id: "result",
        label: state.mode === "image_to_text" ? "结果可复制" : "结果可下载"
      }
    ];
  }

  return [
    { id: "reserve", label: "预占积分" },
    { id: "generate", label: "生成图片" },
    { id: "store", label: "保存结果" },
    { id: "result", label: "结果可下载" }
  ];
}

function resolveProgressStatus(stepId, stage) {
  const order = resolveProgressSteps().map((step) => step.id);
  const activeStepByStage = {
    idle: "",
    uploading: "upload",
    generating: "generate",
    completed: "result",
    failed: ""
  };

  if (stage === "failed") {
    return "failed";
  }

  const activeStep = activeStepByStage[stage] ?? "";
  const activeIndex = order.indexOf(activeStep);
  const stepIndex = order.indexOf(stepId);

  if (stage === "idle" || activeIndex === -1) {
    return "pending";
  }

  if (stepIndex < activeIndex || stage === "completed") {
    return "done";
  }

  if (stepIndex === activeIndex) {
    return "active";
  }

  return "pending";
}

function progressStatusText(status) {
  const map = {
    active: "进行中",
    done: "完成",
    failed: "失败",
    pending: "等待"
  };

  return map[status] ?? "等待";
}

function updatePrimaryActionState() {
  if (state.isSubmitting) {
    elements.primaryAction.disabled = true;
    return;
  }

  const estimateUnavailable = state.estimate === null;
  const hasEnoughBalance = state.estimate?.enough_balance === true;
  const hasModel = elements.modelSelect.value.length > 0;

  elements.primaryAction.disabled = estimateUnavailable || !hasEnoughBalance || !hasModel;

  if (estimateUnavailable) {
    elements.actionHint.textContent = "正在校验余额和模型";
    return;
  }

  if (!hasEnoughBalance) {
    elements.actionHint.textContent = "余额不足，暂不能创建任务";
    return;
  }

  if (!hasModel) {
    elements.actionHint.textContent = "当前模式暂无可用模型";
    return;
  }

  elements.actionHint.textContent =
    state.mode === "image_to_text"
      ? "上传图片后将生成可复制的描述、标题、标签或文案"
      : state.mode === "image_to_image"
        ? "上传参考图后将按编辑模式生成新图"
        : state.mode === "image_restore"
          ? "图片修复属于高消耗任务，提交前需要二次确认"
          : state.mode === "upscale"
            ? "高清放大价格随倍率变化，提交前需要二次确认"
            : "提交后将预占积分并生成图片";
}

function createTextResultCard(text) {
  const item = document.createElement("article");
  item.className = "text-result";
  const content = document.createElement("pre");
  const copyButton = document.createElement("button");

  content.textContent = text;
  copyButton.type = "button";
  copyButton.className = "ghost-button copy-button";
  copyButton.textContent = "复制";
  copyButton.addEventListener("click", async () => {
    await copyTextToClipboard(text, copyButton);
  });

  item.append(content, copyButton);

  return item;
}

function renderModelOptions() {
  const config = modeConfig[state.mode];
  const models = state.models.filter(
    (model) =>
      model.capability === config.capability &&
      Array.isArray(model.supported_task_types) &&
      model.supported_task_types.includes(state.mode)
  );

  elements.modelSelect.replaceChildren();

  if (models.length === 0) {
    const option = document.createElement("option");
    option.textContent = "当前模式暂无模型";
    option.value = "";
    elements.modelSelect.append(option);
    return;
  }

  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.gateway_model_code;
    option.textContent = model.display_name;
    elements.modelSelect.append(option);
  }
}

function renderModelList(modelCatalog) {
  elements.modelList.replaceChildren();

  if (state.models.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-text";
    empty.textContent = modelCatalog.message ?? "当前暂无可用图片模型。";
    elements.modelList.append(empty);
    return;
  }

  for (const model of state.models) {
    const item = document.createElement("article");
    item.className = "model-item";
    item.innerHTML = `
      <div>
        <strong></strong>
        <span></span>
      </div>
      <small></small>
    `;
    item.querySelector("strong").textContent = model.display_name;
    item.querySelector("span").textContent = model.capability;
    item.querySelector("small").textContent = model.description;
    elements.modelList.append(item);
  }
}

async function refreshHistory() {
  if (elements.historyList === null) {
    return;
  }

  try {
    const history = await getImageHistory(state.mode);
    renderHistory(history.items ?? []);
  } catch {
    renderHistory([]);
  }
}

function renderHistory(items) {
  elements.historyList.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-text";
    empty.textContent = "暂无历史作品。";
    elements.historyList.append(empty);
    return;
  }

  for (const task of items.slice(0, 6)) {
    const item = document.createElement("article");
    item.className = "history-item";
    const title = document.createElement("strong");
    const meta = document.createElement("small");
    const actions = document.createElement("div");

    title.textContent =
      task.text_result !== null && task.text_result.length > 0
        ? summarize(task.text_result)
        : `${task.task_type} · ${task.output_file_ids.length} 个文件`;
    meta.textContent = `${formatTaskType(task.task_type)} · ${task.created_at}`;
    actions.className = "history-actions";
    item.append(title, meta);

    const files = task.result_files ?? [];

    if (files.length > 0) {
      const imageGrid = document.createElement("div");
      imageGrid.className = "history-image-grid";

      for (const file of files.slice(0, 4)) {
        const link = document.createElement("a");
        const image = document.createElement("img");

        link.href = file.download_url;
        link.target = "_blank";
        link.rel = "noreferrer";
        image.alt = "历史图片结果";
        image.src = file.preview_url;
        link.append(image);
        imageGrid.append(link);
      }

      item.append(imageGrid);

      const continueButton = document.createElement("button");
      continueButton.type = "button";
      continueButton.className = "ghost-button copy-button";
      continueButton.textContent = "继续编辑";
      continueButton.addEventListener("click", () => {
        const firstFileId = files[0]?.file?.id;

        if (firstFileId !== undefined) {
          useFileAsReference(firstFileId);
        }
      });
      actions.append(continueButton);
    }

    if (task.text_result !== null && task.text_result.length > 0) {
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "ghost-button copy-button";
      copyButton.textContent = "复制";
      copyButton.addEventListener("click", async () => {
        await copyTextToClipboard(task.text_result, copyButton);
      });
      actions.append(copyButton);
    }

    const favoriteButton = document.createElement("button");
    favoriteButton.type = "button";
    favoriteButton.className = "ghost-button copy-button";
    favoriteButton.textContent = task.is_favorited ? "已收藏" : "收藏";
    favoriteButton.disabled = task.is_favorited === true;
    favoriteButton.addEventListener("click", async () => {
      await runHistoryAction(favoriteButton, "收藏中", async () => {
        await favoriteHistoryItem(task.id);
        await refreshHistory();
      });
    });
    actions.append(favoriteButton);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "ghost-button danger-button";
    deleteButton.textContent = "删除";
    deleteButton.addEventListener("click", async () => {
      // 删除作品会从当前历史列表隐藏，所以必须让用户二次确认，避免误删刚生成的结果。
      const confirmed = window.confirm("确认删除这个作品吗？删除后将不再出现在作品历史中。");

      if (!confirmed) {
        return;
      }

      await runHistoryAction(deleteButton, "删除中", async () => {
        await deleteHistoryItem(task.id);
        await refreshHistory();
      });
    });
    actions.append(deleteButton);

    item.append(actions);

    elements.historyList.append(item);
  }
}

async function runHistoryAction(button, pendingText, action) {
  clearError();

  const originalText = button.textContent;

  button.disabled = true;
  button.textContent = pendingText;

  try {
    await action();
  } catch (error) {
    showError(error instanceof Error ? error.message : "作品操作失败。");
    button.disabled = false;
    button.textContent = originalText;
  }
}

function resolveModelHealthText(modelCatalog) {
  const missing = modelCatalog.missing_required_capabilities ?? [];

  if (missing.length > 0) {
    return `缺少 ${missing.join(", ")}`;
  }

  return `${String((modelCatalog.items ?? []).length)} 个模型可用`;
}

function setModelHealth(text, tone) {
  elements.modelHealth.textContent = text;
  elements.modelHealth.dataset.tone = tone;
}

function renderUploadHint() {
  if (state.referenceFileId !== null && state.mode === "image_to_image") {
    elements.uploadHint.textContent = `已选择生成结果作为参考图：${state.referenceFileId}`;
    return;
  }

  elements.uploadHint.textContent = "支持 png、jpeg、webp、gif，最大 10MB。";
}

function useFileAsReference(fileId) {
  state.mode = "image_to_image";
  state.referenceFileId = fileId;
  elements.imageInput.value = "";
  elements.resultList.replaceChildren();
  renderMode();
  renderModelOptions();
  renderProgress("idle");
  void refreshEstimate();
  void refreshHistory();
  elements.promptInput.focus();
}

function showError(message) {
  elements.errorBanner.textContent = message;
  elements.errorBanner.hidden = false;
}

function clearError() {
  elements.errorBanner.textContent = "";
  elements.errorBanner.hidden = true;
}

async function copyTextToClipboard(text, button) {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopyText(text);
    }

    button.textContent = "已复制";
    window.setTimeout(() => {
      button.textContent = "复制";
    }, 1200);
  } catch {
    try {
      fallbackCopyText(text);
      button.textContent = "已复制";
      window.setTimeout(() => {
        button.textContent = "复制";
      }, 1200);
    } catch {
      showError("复制失败，请手动选择文本复制。");
    }
  }
}

function fallbackCopyText(text) {
  const textarea = document.createElement("textarea");

  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();

  try {
    document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => {
      const value = String(reader.result ?? "");
      const [, base64 = ""] = value.split(",");
      resolve(base64);
    });
    reader.addEventListener("error", () => {
      reject(new Error("读取图片失败。"));
    });
    reader.readAsDataURL(file);
  });
}

function summarize(value) {
  const normalized = value.replace(/\s+/gu, " ").trim();

  return normalized.length > 60 ? `${normalized.slice(0, 60)}...` : normalized;
}

function formatTaskType(taskType) {
  return modeConfig[taskType]?.title ?? taskType;
}
