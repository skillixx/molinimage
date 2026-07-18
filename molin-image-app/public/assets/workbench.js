import {
  createImageTask,
  deleteHistoryItem,
  estimateBilling,
  favoriteHistoryItem,
  getCurrentUser,
  getImageHistory,
  getImageTask,
  getImageModels,
  getStylePresets,
  retryImageTask,
  optimizePrompt,
  uploadImageFile
} from "./api-client.js";
import { createImageAnnotationEditor } from "./image-annotation-editor.js";
import {
  createImageTaskPoller,
  isActiveImageTaskStatus,
  resolveImageTaskProgressStage
} from "./image-task-poller.js";
import {
  composeImageRestorePrompt,
  createImageRestoreParameterValues,
  getImageRestoreMode,
  imageRestoreCategoryOptions,
  imageRestoreModes,
  validateImageRestoreMode
} from "./image-restore-modes.js";
import {
  composeImageEditPrompt,
  createImageEditParameterValues,
  getImageEditMode,
  imageEditCategoryOptions,
  imageEditModes
} from "./image-to-image-modes.js";
import {
  formatTaskPoints,
  formatTaskStatus,
  resolveTaskFailureMessage
} from "./task-detail-format.js";
import { resolveModelCapabilityLabel, resolveModelDisplayName } from "./model-display.js";
import {
  findTaskModel,
  hasStylePresetSupport,
  imageSizeGroups,
  imageSizeOptions,
  modeConfig,
  isReferenceImageTaskModelCompatible,
  styleCategoryOptions
} from "./workbench-modes.js";

const state = {
  mode: "text_to_image",
  models: [],
  stylePresets: [],
  estimate: null,
  estimateRequestId: 0,
  isSubmitting: false,
  isStartingNewTask: false,
  draftIdempotencyKey: createSubmissionIdempotencyKey(),
  activeTaskId: null,
  activeTaskType: null,
  referenceFileId: null,
  referencePreviewUrl: null,
  sourceTaskId: null,
  sourceFileId: null,
  annotatedInputFile: null,
  annotatedPreviewUrl: null,
  annotationSourceTask: null,
  annotationSourceFile: null,
  annotationPurpose: null,
  isOptimizingPrompt: false,
  historyPage: 0,
  historyPageSize: 12,
  historyTotal: 0,
  isHistoryLoading: false,
  textToImageStep: 1,
  textToImageCompletedStep: 0,
  textToImageStyleCategory: "all",
  textToImageSizeGroup: "square",
  textToImageDraft: null,
  localPreviewUrl: null,
  imageToImageStep: 1,
  imageToImageCompletedStep: 0,
  imageToImageCategory: "common",
  imageToImageSizeGroup: "square",
  imageToImageSmartMode: true,
  imageToImageParameterValues: createImageEditParameterValues(),
  imageToImageUploadMeta: null,
  imageToImageUploadError: null,
  isValidatingImage: false,
  imageRestoreStep: 1,
  imageRestoreCompletedStep: 0,
  imageRestoreCategory: "all",
  imageRestoreModeCode: "smart_restore",
  imageRestoreParameterValues: createImageRestoreParameterValues(),
  imageRestoreOutputPolicy: "keep_original",
  imageRestoreAnnotationApplied: false
};

const elements = {
  sessionSummary: document.querySelector("#sessionSummary"),
  modelHealth: document.querySelector("#modelHealth"),
  refreshButton: document.querySelector("#refreshButton"),
  parameterPanelToggle: document.querySelector("#parameterPanelToggle"),
  errorBanner: document.querySelector("#errorBanner"),
  modeTabs: Array.from(document.querySelectorAll(".mode-tab")),
  modeEyebrow: document.querySelector("#modeEyebrow"),
  modeTitle: document.querySelector("#modeTitle"),
  textToImageSteps: document.querySelector("#textToImageSteps"),
  imageToImageSteps: document.querySelector("#imageToImageSteps"),
  imageRestoreSteps: document.querySelector("#imageRestoreSteps"),
  creationSteps: Array.from(document.querySelectorAll("[data-creation-step]")),
  imageEditSteps: Array.from(document.querySelectorAll("[data-image-edit-step]")),
  imageRestoreStepButtons: Array.from(document.querySelectorAll("[data-image-restore-step]")),
  creationContentBlock: document.querySelector("#creationContentBlock"),
  modeOptionsBlock: document.querySelector("#modeOptionsBlock"),
  parameterBlock: document.querySelector("#parameterBlock"),
  promptField: document.querySelector("#promptField"),
  promptOptimizeButton: document.querySelector("#promptOptimizeButton"),
  promptOptimizationOverlay: document.querySelector("#promptOptimizationOverlay"),
  promptInput: document.querySelector("#promptInput"),
  promptValidationMessage: document.querySelector("#promptValidationMessage"),
  promptCharacterCount: document.querySelector("#promptCharacterCount"),
  imageUploadField: document.querySelector("#imageUploadField"),
  imageInput: document.querySelector("#imageInput"),
  imageUploadTitle: document.querySelector("#imageUploadTitle"),
  imageUploadDescription: document.querySelector("#imageUploadDescription"),
  uploadHint: document.querySelector("#uploadHint"),
  referencePreview: document.querySelector("#referencePreview"),
  referencePreviewImage: document.querySelector("#referencePreviewImage"),
  referencePreviewText: document.querySelector("#referencePreviewText"),
  referencePreviewMeta: document.querySelector("#referencePreviewMeta"),
  imageToImageUploadActions: document.querySelector("#imageToImageUploadActions"),
  replaceImageButton: document.querySelector("#replaceImageButton"),
  removeImageButton: document.querySelector("#removeImageButton"),
  chooseHistoryImageButton: document.querySelector("#chooseHistoryImageButton"),
  editModeField: document.querySelector("#editModeField"),
  editModeSelect: document.querySelector("#editModeSelect"),
  imageToImageModePicker: document.querySelector("#imageToImageModePicker"),
  imageEditCategoryFilters: document.querySelector("#imageEditCategoryFilters"),
  imageEditModeList: document.querySelector("#imageEditModeList"),
  restoreTypeField: document.querySelector("#restoreTypeField"),
  restoreTypeSelect: document.querySelector("#restoreTypeSelect"),
  imageRestoreModePicker: document.querySelector("#imageRestoreModePicker"),
  imageRestoreCategoryFilters: document.querySelector("#imageRestoreCategoryFilters"),
  imageRestoreModeList: document.querySelector("#imageRestoreModeList"),
  stylePresetField: document.querySelector("#stylePresetField"),
  stylePresetSelect: document.querySelector("#stylePresetSelect"),
  styleCategoryFilters: document.querySelector("#styleCategoryFilters"),
  stylePresetList: document.querySelector("#stylePresetList"),
  upscaleFactorField: document.querySelector("#upscaleFactorField"),
  upscaleFactorSelect: document.querySelector("#upscaleFactorSelect"),
  modelSelect: document.querySelector("#modelSelect"),
  modelCapabilityHint: document.querySelector("#modelCapabilityHint"),
  parameterBlockTitle: document.querySelector("#parameterBlockTitle"),
  parameterBlockHint: document.querySelector("#parameterBlockHint"),
  imageToImagePromptSlot: document.querySelector("#imageToImagePromptSlot"),
  imageRestorePromptSlot: document.querySelector("#imageRestorePromptSlot"),
  qualityField: document.querySelector("#qualityField"),
  qualitySelect: document.querySelector("#qualitySelect"),
  sizeField: document.querySelector("#sizeField"),
  sizeSelect: document.querySelector("#sizeSelect"),
  sizeGuide: document.querySelector("#sizeGuide"),
  countField: document.querySelector("#countField"),
  countSelect: document.querySelector("#countSelect"),
  textToImageParameterChoices: document.querySelector("#textToImageParameterChoices"),
  qualityChoiceList: document.querySelector("#qualityChoiceList"),
  sizeGroupFilters: document.querySelector("#sizeGroupFilters"),
  sizeChoiceList: document.querySelector("#sizeChoiceList"),
  countChoiceList: document.querySelector("#countChoiceList"),
  imageToImageParameterChoices: document.querySelector("#imageToImageParameterChoices"),
  imageEditCompatibilityHint: document.querySelector("#imageEditCompatibilityHint"),
  imageEditModelChoices: document.querySelector("#imageEditModelChoices"),
  imageEditQualityChoices: document.querySelector("#imageEditQualityChoices"),
  imageEditSizeGroupFilters: document.querySelector("#imageEditSizeGroupFilters"),
  imageEditSizeChoices: document.querySelector("#imageEditSizeChoices"),
  imageEditCountChoices: document.querySelector("#imageEditCountChoices"),
  imageEditDynamicHint: document.querySelector("#imageEditDynamicHint"),
  imageEditDynamicParameters: document.querySelector("#imageEditDynamicParameters"),
  openImageMaskEditor: document.querySelector("#openImageMaskEditor"),
  imageRestoreParameterChoices: document.querySelector("#imageRestoreParameterChoices"),
  imageRestoreCompatibilityHint: document.querySelector("#imageRestoreCompatibilityHint"),
  imageRestoreModelChoices: document.querySelector("#imageRestoreModelChoices"),
  imageRestoreDynamicHint: document.querySelector("#imageRestoreDynamicHint"),
  imageRestoreDynamicParameters: document.querySelector("#imageRestoreDynamicParameters"),
  imageRestoreOutputPolicyChoices: document.querySelector("#imageRestoreOutputPolicyChoices"),
  imageRestoreSizeChoices: document.querySelector("#imageRestoreSizeChoices"),
  imageRestoreCountChoices: document.querySelector("#imageRestoreCountChoices"),
  openRestoreMaskEditor: document.querySelector("#openRestoreMaskEditor"),
  imageRestoreAnnotationStatus: document.querySelector("#imageRestoreAnnotationStatus"),
  textToImageConfirmation: document.querySelector("#textToImageConfirmation"),
  creationSummary: document.querySelector("#creationSummary"),
  imageToImageConfirmation: document.querySelector("#imageToImageConfirmation"),
  imageEditSummary: document.querySelector("#imageEditSummary"),
  imageRestoreConfirmation: document.querySelector("#imageRestoreConfirmation"),
  imageRestoreSummary: document.querySelector("#imageRestoreSummary"),
  textToImageStepActions: document.querySelector("#textToImageStepActions"),
  workflowBackButton: document.querySelector("#workflowBackButton"),
  workflowNextButton: document.querySelector("#workflowNextButton"),
  workflowActionHint: document.querySelector("#workflowActionHint"),
  submitDock: document.querySelector("#submitDock"),
  estimateStrip: document.querySelector("#estimateStrip"),
  estimatePoints: document.querySelector("#estimatePoints"),
  estimateBalance: document.querySelector("#estimateBalance"),
  primaryAction: document.querySelector("#primaryAction"),
  actionHint: document.querySelector("#actionHint"),
  taskProgress: document.querySelector("#taskProgress"),
  modelList: document.querySelector("#modelList"),
  resultList: document.querySelector("#resultList"),
  historyList: document.querySelector("#historyList"),
  historyLoadMore: document.querySelector("#historyLoadMore"),
  taskDetailBackdrop: document.querySelector("#taskDetailBackdrop"),
  taskDetailDrawer: document.querySelector("#taskDetailDrawer"),
  taskDetailTitle: document.querySelector("#taskDetailTitle"),
  taskDetailClose: document.querySelector("#taskDetailClose"),
  taskDetailContent: document.querySelector("#taskDetailContent"),
  annotationBackdrop: document.querySelector("#annotationBackdrop"),
  annotationEditor: document.querySelector("#annotationEditor"),
  annotationTitle: document.querySelector("#annotationTitle"),
  annotationClose: document.querySelector("#annotationClose"),
  annotationCancel: document.querySelector("#annotationCancel"),
  annotationApply: document.querySelector("#annotationApply"),
  annotationCanvas: document.querySelector("#annotationCanvas"),
  annotationLoading: document.querySelector("#annotationLoading"),
  annotationPrompt: document.querySelector("#annotationPrompt"),
  annotationError: document.querySelector("#annotationError"),
  annotationColor: document.querySelector("#annotationColor"),
  annotationWidth: document.querySelector("#annotationWidth"),
  annotationUndo: document.querySelector("#annotationUndo"),
  annotationReset: document.querySelector("#annotationReset"),
  annotationTools: Array.from(document.querySelectorAll("[data-annotation-tool]"))
};

const annotationEditor = createImageAnnotationEditor(elements.annotationCanvas);
const activeTaskStorageKey = "molinimage:active-image-task:v1";
const pendingSubmissionStorageKey = "molinimage:pending-image-submission:v1";
const imageTaskPoller = createImageTaskPoller({
  loadTask: getImageTask,
  onTask: handlePolledImageTask,
  onTransientError: handleTaskPollingError,
  onTerminalError: handleTaskPollingTerminalError
});

window.addEventListener("pagehide", () => {
  // 页面离开时停止定时器；任务 ID 已持久化，重新进入后会继续恢复。
  imageTaskPoller.stop();
});
window.addEventListener("online", () => {
  // 离线刷新导致初始化失败时，网络恢复后重新建立会话上下文并恢复待提交任务。
  if (state.activeTaskId === null && readPendingSubmission() !== null) {
    void bootstrapWorkbench();
  }
});

elements.refreshButton.addEventListener("click", () => {
  void bootstrapWorkbench();
});
elements.parameterPanelToggle.addEventListener("click", () => {
  toggleParameterPanel();
});
elements.sizeSelect.addEventListener("change", () => {
  syncTextToImageSizeGroup();
  syncImageToImageSizeGroup();
  renderTextToImageParameterChoices();
  renderImageToImageParameterChoices();
  renderImageRestoreParameterChoices();
  renderCreationSummary();
  renderImageEditSummary();
  renderImageRestoreSummary();
  void refreshEstimate();
});
elements.countSelect.addEventListener("change", () => {
  renderTextToImageParameterChoices();
  renderImageToImageParameterChoices();
  renderImageRestoreParameterChoices();
  renderCreationSummary();
  renderImageEditSummary();
  renderImageRestoreSummary();
  void refreshEstimate();
});
elements.upscaleFactorSelect.addEventListener("change", () => {
  void refreshEstimate();
});
elements.modelSelect.addEventListener("change", () => {
  renderModelCapabilityHint();
  renderImageSizeOptions();
  syncTextToImageSizeGroup();
  syncImageToImageSizeGroup();
  renderTextToImageParameterChoices();
  renderImageToImageParameterChoices();
  renderImageRestoreParameterChoices();
  renderCreationSummary();
  renderImageEditSummary();
  renderImageRestoreSummary();
  void refreshEstimate();
});
elements.qualitySelect.addEventListener("change", () => {
  renderTextToImageParameterChoices();
  renderImageToImageParameterChoices();
  renderImageRestoreParameterChoices();
  renderCreationSummary();
  renderImageEditSummary();
  renderImageRestoreSummary();
  void refreshEstimate();
});
elements.stylePresetSelect.addEventListener("change", () => {
  renderStylePresetList();
  renderCreationSummary();
});
elements.editModeSelect.addEventListener("change", () => {
  state.imageToImageSmartMode = false;
  applySelectedImageEditMode();
});
elements.restoreTypeSelect.addEventListener("change", () => {
  renderStylePresetList();
});
elements.primaryAction.addEventListener("click", () => {
  void submitCurrentTask();
});
elements.promptOptimizeButton.addEventListener("click", () => {
  void optimizeCurrentPrompt();
});
elements.promptInput.addEventListener("input", () => {
  // 提示词变化会立即更新步骤校验，但不会触发模型、模板或计费请求。
  syncPromptInputState();
  renderCreationSummary();
  if (state.mode === "image_to_image" && state.imageToImageSmartMode) {
    const inferredModeCode = inferImageEditModeCode(elements.promptInput.value);

    if (inferredModeCode !== elements.editModeSelect.value) {
      elements.editModeSelect.value = inferredModeCode;
      applySelectedImageEditMode({ preserveSmartMode: true });
    }
  }
  renderImageEditSummary();
  renderImageRestoreSummary();
  syncTextToImageWorkflowControls();
  syncImageToImageWorkflowControls();
  syncImageRestoreWorkflowControls();
  updatePrimaryActionState();
});
elements.workflowBackButton.addEventListener("click", () => {
  if (state.mode === "image_to_image") {
    goToImageToImageStep(state.imageToImageStep - 1);
    return;
  }

  if (state.mode === "image_restore") {
    goToImageRestoreStep(state.imageRestoreStep - 1);
    return;
  }

  goToTextToImageStep(state.textToImageStep - 1);
});
elements.workflowNextButton.addEventListener("click", () => {
  if (state.mode === "image_to_image") {
    goToImageToImageStep(state.imageToImageStep + 1);
    return;
  }

  if (state.mode === "image_restore") {
    goToImageRestoreStep(state.imageRestoreStep + 1);
    return;
  }

  goToTextToImageStep(state.textToImageStep + 1);
});
for (const stepButton of elements.creationSteps) {
  stepButton.addEventListener("click", () => {
    const step = Number(stepButton.dataset.creationStep);

    if (Number.isInteger(step)) {
      goToTextToImageStep(step);
    }
  });
}
for (const stepButton of elements.imageEditSteps) {
  stepButton.addEventListener("click", () => {
    const step = Number(stepButton.dataset.imageEditStep);

    if (Number.isInteger(step)) {
      goToImageToImageStep(step);
    }
  });
}
for (const stepButton of elements.imageRestoreStepButtons) {
  stepButton.addEventListener("click", () => {
    const step = Number(stepButton.dataset.imageRestoreStep);

    if (Number.isInteger(step)) {
      goToImageRestoreStep(step);
    }
  });
}
elements.historyLoadMore.addEventListener("click", () => {
  void refreshHistory({ append: true });
});
elements.imageInput.addEventListener("change", () => {
  const selectedFile = elements.imageInput.files?.[0];

  // 部分浏览器取消文件选择时会发出空 change；此时必须保留已选历史图片和预览状态。
  if (selectedFile === undefined) {
    return;
  }

  // 用户重新选择本地图片时，清掉“再次编辑”带来的历史关系，避免一次提交混用两个输入来源。
  clearReeditSource();
  state.imageRestoreAnnotationApplied = false;
  void inspectSelectedImage();
});
elements.replaceImageButton.addEventListener("click", () => {
  elements.imageInput.click();
});
elements.removeImageButton.addEventListener("click", () => {
  clearCurrentImageInput();
});
elements.chooseHistoryImageButton.addEventListener("click", () => {
  // 历史作品区仍由服务端权限控制，按钮只负责把用户带到可选择的作品列表。
  document.querySelector(".history-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  elements.actionHint.textContent = "请在作品历史中点击“用作原图”";
  document.querySelector(".history-panel")?.classList.add("is-selecting-source");
});
elements.openImageMaskEditor.addEventListener("click", () => {
  void openCurrentImageMaskEditor();
});
elements.openRestoreMaskEditor.addEventListener("click", () => {
  void openCurrentRestoreMaskEditor();
});
for (const eventName of ["dragenter", "dragover"]) {
  elements.imageUploadField.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.imageUploadField.classList.add("is-dragover");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.imageUploadField.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.imageUploadField.classList.remove("is-dragover");
  });
}
elements.imageUploadField.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];

  if (file === undefined) {
    return;
  }

  // 拖入文件后仍写回原生 file input，后续上传、校验和计费流程无需分叉。
  const transfer = new DataTransfer();
  transfer.items.add(file);
  elements.imageInput.files = transfer.files;
  elements.imageInput.dispatchEvent(new Event("change", { bubbles: true }));
});
elements.taskDetailClose.addEventListener("click", closeTaskDetail);
elements.taskDetailBackdrop.addEventListener("click", closeTaskDetail);
elements.annotationClose.addEventListener("click", closeAnnotationEditor);
elements.annotationCancel.addEventListener("click", closeAnnotationEditor);
elements.annotationBackdrop.addEventListener("click", closeAnnotationEditor);
elements.annotationApply.addEventListener("click", () => {
  void applyAnnotationForReedit();
});
elements.annotationColor.addEventListener("input", () => {
  annotationEditor.setColor(elements.annotationColor.value);
});
elements.annotationWidth.addEventListener("input", () => {
  annotationEditor.setWidth(elements.annotationWidth.value);
});
elements.annotationUndo.addEventListener("click", () => {
  annotationEditor.undo();
});
elements.annotationReset.addEventListener("click", () => {
  annotationEditor.reset();
});

for (const tool of elements.annotationTools) {
  tool.addEventListener("click", () => {
    const nextTool = tool.dataset.annotationTool;

    if (nextTool === undefined) {
      return;
    }

    annotationEditor.setTool(nextTool);

    for (const candidate of elements.annotationTools) {
      candidate.classList.toggle("is-active", candidate === tool);
    }
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.annotationEditor.hidden) {
    closeAnnotationEditor();
    return;
  }

  if (event.key === "Escape" && !elements.taskDetailDrawer.hidden) {
    closeTaskDetail();
  }
});

for (const tab of elements.modeTabs) {
  tab.addEventListener("click", () => {
    const nextMode = tab.dataset.mode;

    if (nextMode === undefined || !(nextMode in modeConfig)) {
      return;
    }

    if (state.activeTaskId !== null) {
      showError("当前任务仍在处理中，完成后即可切换其他创作能力。");
      return;
    }

    const previousMode = state.mode;

    if (previousMode === "text_to_image" && nextMode !== "text_to_image") {
      captureTextToImageDraft();
    }

    state.mode = nextMode;
    clearReeditSource();
    revokeLocalPreviewUrl();
    elements.imageInput.value = "";
    state.imageToImageUploadMeta = null;
    state.imageToImageUploadError = null;
    state.isValidatingImage = false;
    if (nextMode === "image_to_image") {
      state.imageToImageStep = 1;
      state.imageToImageCompletedStep = 0;
      state.imageToImageSmartMode = true;
      elements.editModeSelect.value = "keep_subject";
      elements.promptInput.value = "";
    }
    if (nextMode === "image_restore") {
      state.imageRestoreStep = 1;
      state.imageRestoreCompletedStep = 0;
      state.imageRestoreCategory = "all";
      state.imageRestoreModeCode = "smart_restore";
      state.imageRestoreOutputPolicy = "keep_original";
      state.imageRestoreAnnotationApplied = false;
      elements.promptInput.value = "";
      elements.restoreTypeSelect.value = getImageRestoreMode("smart_restore").backend_preset_id;
    }
    elements.resultList.replaceChildren();
    renderActiveModeControls({ restoreTextDraft: nextMode === "text_to_image" });
    renderProgress("idle");
    void refreshEstimate();
    void refreshHistory();
  });
}

restoreParameterPanelPreference();
void bootstrapWorkbench();

function restoreParameterPanelPreference() {
  // 收起状态只影响当前浏览器布局，不参与任务参数，也不会写入服务端。
  const shouldCollapse = window.localStorage.getItem("molinimage:parameter-panel") === "collapsed";

  document.body.classList.toggle("is-parameter-collapsed", shouldCollapse);
  syncParameterPanelToggle(shouldCollapse);
}

function toggleParameterPanel() {
  const shouldCollapse = !document.body.classList.contains("is-parameter-collapsed");

  document.body.classList.toggle("is-parameter-collapsed", shouldCollapse);
  window.localStorage.setItem(
    "molinimage:parameter-panel",
    shouldCollapse ? "collapsed" : "expanded"
  );
  syncParameterPanelToggle(shouldCollapse);
}

function syncParameterPanelToggle(isCollapsed) {
  elements.parameterPanelToggle.setAttribute("aria-expanded", String(!isCollapsed));
  elements.parameterPanelToggle.setAttribute(
    "aria-label",
    isCollapsed ? "展开创作参数" : "收起创作参数"
  );
  elements.parameterPanelToggle.title = isCollapsed ? "展开创作参数" : "收起创作参数";
  elements.parameterPanelToggle.querySelector("span").textContent = isCollapsed ? "›" : "‹";
}

async function bootstrapWorkbench() {
  clearError();
  setModelHealth("模型加载中", "loading");
  restoreActiveImageTask();

  try {
    const [user, modelCatalog, stylePresetCatalog] = await Promise.all([
      getCurrentUser(),
      getImageModels(),
      getStylePresets()
    ]);
    state.models = modelCatalog.items ?? [];
    state.stylePresets = stylePresetCatalog.items ?? [];
    elements.sessionSummary.textContent = `用户 ${String(user.user_id)} · 应用 ${String(user.app_id)}`;
    setModelHealth(
      resolveModelHealthText(modelCatalog),
      modelCatalog.message === null ? "ready" : "warning"
    );
    renderMode();
    renderModelOptions();
    renderImageSizeOptions();
    renderImageSizeGuide();
    renderStylePresetOptions();
    renderStylePresetList();
    renderImageRestoreWorkflow();
    renderModelList(modelCatalog);
    renderProgress(state.activeTaskId === null ? "idle" : "generating");
    await Promise.all([refreshEstimate(), refreshHistory()]);
    if (state.activeTaskId === null && readPendingSubmission() !== null) {
      void resumePendingImageTaskSubmission();
    }
    openInitialTaskDetailFromUrl();
  } catch (error) {
    elements.sessionSummary.textContent = "未建立应用会话";
    state.models = [];
    state.stylePresets = [];
    setModelHealth("模型不可用", "warning");
    renderMode();
    renderModelOptions();
    renderImageSizeOptions();
    renderImageSizeGuide();
    renderStylePresetOptions();
    renderStylePresetList();
    renderImageRestoreWorkflow();
    renderModelList({ items: [], message: "请从墨灵平台进入应用后重试。" });
    renderProgress(state.activeTaskId === null ? "idle" : "generating");
    showError(error instanceof Error ? error.message : "工作台加载失败。");
  }
}

function renderActiveModeControls({ restoreTextDraft = false } = {}) {
  // 模式切换与刷新恢复共用同一渲染入口，避免控件、尺寸和模板状态发生漂移。
  renderMode();
  renderModelOptions();
  renderImageSizeOptions();
  renderImageSizeGuide();
  renderStylePresetOptions();
  if (restoreTextDraft) restoreTextToImageDraft();
  renderStylePresetList();
  renderTextToImageWorkflow();
  renderImageToImageWorkflow();
  renderImageRestoreWorkflow();
}

function openInitialTaskDetailFromUrl() {
  const taskId = new URLSearchParams(window.location.search).get("task_id");

  if (taskId === null || taskId.trim().length === 0) {
    return;
  }

  void openTaskDetail(taskId);
}

function renderMode() {
  const config = modeConfig[state.mode];
  const isTextToImage = state.mode === "text_to_image";
  const isImageToText = state.mode === "image_to_text";
  const isImageToImage = state.mode === "image_to_image";
  const isImageRestore = state.mode === "image_restore";

  document.body.dataset.activeMode = state.mode;
  elements.modeEyebrow.textContent = config.eyebrow;
  elements.modeTitle.textContent = config.title;
  elements.promptInput.placeholder = isImageToImage
    ? getImageEditMode(elements.editModeSelect.value).prompt_placeholder
    : isImageRestore
      ? "可选：说明需要重点保留、修复或移除的内容"
      : config.placeholder;
  syncPromptFieldPlacement();
  elements.imageUploadField.hidden = !config.requiresUpload;
  elements.promptField.hidden = config.supportsPromptInput !== true;
  elements.promptOptimizeButton.hidden = config.supportsPromptInput !== true;
  elements.parameterBlockTitle.textContent = isImageToText
    ? "识别设置"
    : isImageToImage
      ? "设置生成参数"
      : isImageRestore
        ? "设置修复参数"
        : "生成参数";
  elements.parameterBlockHint.textContent = isImageToText
    ? "自动匹配图片理解能力"
    : isImageToImage
      ? "参数会随编辑模式变化"
      : isImageRestore
        ? "参数会随修复方式变化"
        : "按模型能力自动匹配";
  // 图生图使用配置驱动的模式卡片，原生 select 仅保留为提交值，不直接展示给用户。
  elements.editModeField.hidden = true;
  elements.imageToImageModePicker.hidden = !isImageToImage;
  elements.restoreTypeField.hidden = true;
  elements.imageRestoreModePicker.hidden = !isImageRestore;
  // 文生图使用模板卡片作为主要入口，原生 select 只保留为真实提交值。
  elements.stylePresetField.hidden = true;
  elements.stylePresetList.hidden =
    !hasStylePresetSupport(state.mode) ||
    state.mode === "image_to_image" ||
    state.mode === "image_restore";
  elements.upscaleFactorField.hidden = state.mode !== "upscale";
  // 图生文由输入图决定内容，高清放大由倍率决定输出，两种模式都不展示无效的尺寸选项。
  elements.sizeField.hidden =
    isTextToImage || state.mode === "image_to_text" || state.mode === "upscale";
  elements.sizeGuide.hidden = state.mode === "image_to_text" || state.mode === "upscale";
  elements.qualityField.hidden =
    isTextToImage || state.mode === "image_to_text" || state.mode === "upscale";
  // 图生文和高清放大当前都固定单结果，隐藏数量控件避免用户误以为可以批量提交。
  elements.countField.hidden =
    isTextToImage || state.mode === "image_to_text" || state.mode === "upscale";
  elements.sizeSelect.disabled = state.mode === "image_to_text";
  elements.countSelect.disabled = state.mode === "image_to_text";
  renderUploadHint();

  if (state.mode === "image_to_text" || state.mode === "upscale") {
    elements.countSelect.value = "1";
  }

  if (config.supportsPromptInput !== true) {
    // 不需要用户提示词的模式要清空隐藏输入，避免从其他模式切换过来时提交旧提示词。
    elements.promptInput.value = "";
  }

  elements.actionHint.textContent =
    state.mode === "image_to_text"
      ? "上传图片后将生成可复制的描述、标题、标签或文案"
      : "提交后将预占积分并生成图片";

  for (const tab of elements.modeTabs) {
    tab.classList.toggle("is-active", tab.dataset.mode === state.mode);
  }

  syncPromptInputState();
  renderTextToImageWorkflow();
  renderImageToImageWorkflow();
  renderImageRestoreWorkflow();
  updatePrimaryActionState();
}

function syncPromptFieldPlacement() {
  const target =
    state.mode === "image_to_image"
      ? elements.imageToImagePromptSlot
      : state.mode === "image_restore"
        ? elements.imageRestorePromptSlot
        : elements.creationContentBlock;

  if (elements.promptField.parentElement !== target) {
    // 图生图和图片修复在第三步填写说明，其余模式仍放在创作内容区，避免维护两套输入值。
    target.prepend(elements.promptField);
  }
}

function renderTextToImageWorkflow() {
  const isTextToImage = state.mode === "text_to_image";
  const step = state.textToImageStep;

  elements.textToImageSteps.hidden = !isTextToImage;
  elements.textToImageStepActions.hidden = !isTextToImage;
  elements.textToImageStepActions.dataset.step = String(step);
  elements.textToImageParameterChoices.hidden = !isTextToImage;
  elements.styleCategoryFilters.hidden = !isTextToImage || step !== 2;

  if (!isTextToImage) {
    if (state.mode === "image_to_image" || state.mode === "image_restore") {
      return;
    }

    elements.creationContentBlock.hidden = false;
    elements.modeOptionsBlock.hidden = false;
    elements.parameterBlock.hidden = false;
    elements.textToImageConfirmation.hidden = true;
    elements.imageToImageConfirmation.hidden = true;
    elements.imageRestoreConfirmation.hidden = true;
    elements.submitDock.hidden = false;
    return;
  }

  elements.creationContentBlock.hidden = step !== 1;
  elements.modeOptionsBlock.hidden = step !== 2;
  elements.parameterBlock.hidden = step !== 3;
  elements.textToImageConfirmation.hidden = step !== 4;
  elements.imageToImageConfirmation.hidden = true;
  elements.submitDock.hidden = step !== 4;

  for (const stepButton of elements.creationSteps) {
    const buttonStep = Number(stepButton.dataset.creationStep);
    const isActive = buttonStep === step;
    const isComplete = buttonStep <= state.textToImageCompletedStep;
    const isReachable = buttonStep <= state.textToImageCompletedStep + 1;

    stepButton.dataset.status = isActive ? "active" : isComplete ? "done" : "pending";
    stepButton.disabled = !isReachable || state.isSubmitting;
    if (isActive) {
      stepButton.setAttribute("aria-current", "step");
    } else {
      stepButton.removeAttribute("aria-current");
    }
  }

  renderStyleCategoryFilters();
  renderTextToImageParameterChoices();
  renderCreationSummary();
  syncTextToImageWorkflowControls();
}

function renderImageToImageWorkflow() {
  const isImageToImage = state.mode === "image_to_image";
  const step = state.imageToImageStep;

  elements.imageToImageSteps.hidden = !isImageToImage;
  elements.imageToImageParameterChoices.hidden = !isImageToImage || step !== 3;

  if (!isImageToImage) {
    elements.imageToImageConfirmation.hidden = true;
    return;
  }

  elements.textToImageStepActions.hidden = false;
  elements.textToImageStepActions.dataset.step = String(step);
  elements.creationContentBlock.hidden = step !== 1;
  elements.modeOptionsBlock.hidden = step !== 2;
  elements.parameterBlock.hidden = step !== 3;
  elements.textToImageConfirmation.hidden = true;
  elements.imageToImageConfirmation.hidden = step !== 4;
  elements.submitDock.hidden = step !== 4;
  document.querySelector(".prompt-panel").dataset.workflowStep = String(step);

  for (const stepButton of elements.imageEditSteps) {
    const buttonStep = Number(stepButton.dataset.imageEditStep);
    const isActive = buttonStep === step;
    const isComplete = buttonStep <= state.imageToImageCompletedStep;
    const isReachable = buttonStep <= state.imageToImageCompletedStep + 1;

    stepButton.dataset.status = isActive ? "active" : isComplete ? "done" : "pending";
    stepButton.disabled = !isReachable || state.isSubmitting;
    stepButton.toggleAttribute("aria-current", isActive);
    if (isActive) {
      stepButton.setAttribute("aria-current", "step");
    }
  }

  renderImageEditCategoryFilters();
  renderImageEditModeCards();
  renderImageToImageParameterChoices();
  renderImageEditSummary();
  syncImageToImageWorkflowControls();
}

function renderImageRestoreWorkflow() {
  const isImageRestore = state.mode === "image_restore";
  const step = state.imageRestoreStep;

  elements.imageRestoreSteps.hidden = !isImageRestore;
  elements.imageRestoreParameterChoices.hidden = !isImageRestore || step !== 3;

  if (!isImageRestore) {
    elements.imageRestoreConfirmation.hidden = true;
    return;
  }

  elements.textToImageStepActions.hidden = false;
  elements.textToImageStepActions.dataset.step = String(step);
  elements.creationContentBlock.hidden = step !== 1;
  elements.modeOptionsBlock.hidden = step !== 2;
  elements.parameterBlock.hidden = step !== 3;
  elements.textToImageConfirmation.hidden = true;
  elements.imageToImageConfirmation.hidden = true;
  elements.imageRestoreConfirmation.hidden = step !== 4;
  elements.submitDock.hidden = step !== 4;
  document.querySelector(".prompt-panel").dataset.workflowStep = String(step);

  for (const stepButton of elements.imageRestoreStepButtons) {
    const buttonStep = Number(stepButton.dataset.imageRestoreStep);
    const isActive = buttonStep === step;
    const isComplete = buttonStep <= state.imageRestoreCompletedStep;
    const isReachable = buttonStep <= state.imageRestoreCompletedStep + 1;

    stepButton.dataset.status = isActive ? "active" : isComplete ? "done" : "pending";
    stepButton.disabled = !isReachable || state.isSubmitting;
    stepButton.toggleAttribute("aria-current", isActive);
    if (isActive) {
      stepButton.setAttribute("aria-current", "step");
    }
  }

  renderImageRestoreCategoryFilters();
  renderImageRestoreModeCards();
  renderImageRestoreParameterChoices();
  renderImageRestoreSummary();
  syncImageRestoreWorkflowControls();
}

function validateImageRestoreStep(step) {
  if (step === 1) {
    if (state.isValidatingImage) {
      return { valid: false, message: "正在读取图片信息，请稍候" };
    }

    if (state.imageToImageUploadError !== null) {
      return { valid: false, message: state.imageToImageUploadError };
    }

    return hasCurrentImageInput()
      ? { valid: true, message: "原图已就绪，可以选择修复方式" }
      : { valid: false, message: "请上传原图，或从作品历史中选择" };
  }

  if (step === 2) {
    const mode = getImageRestoreMode(state.imageRestoreModeCode);
    return mode === undefined
      ? { valid: false, message: "请选择一种修复方式" }
      : { valid: true, message: `${mode.display_name}已选择，将显示对应参数` };
  }

  if (step === 3) {
    const mode = getImageRestoreMode(state.imageRestoreModeCode);
    const modeValidation = validateImageRestoreMode(mode, state.imageRestoreAnnotationApplied);

    if (!modeValidation.valid) {
      return modeValidation;
    }

    if (!isSelectedImageRestoreModelCompatible()) {
      return { valid: false, message: "当前模型不支持图片修复或参考图输入" };
    }

    if (elements.sizeSelect.value.length === 0) {
      return { valid: false, message: "当前模型没有可用输出尺寸" };
    }

    if (state.estimate === null) {
      return { valid: false, message: "正在校验模型与预计积分" };
    }

    if (state.estimate.enough_balance !== true) {
      return { valid: false, message: "积分余额不足，无法继续创建" };
    }

    return { valid: true, message: "修复参数、模型和积分均已校验" };
  }

  return { valid: true, message: "确认内容后即可创建修复任务" };
}

function goToImageRestoreStep(targetStep) {
  if (state.mode !== "image_restore" || state.isSubmitting) {
    return;
  }

  const nextStep = Math.min(4, Math.max(1, targetStep));

  if (nextStep > state.imageRestoreStep) {
    const validation = validateImageRestoreStep(state.imageRestoreStep);

    if (!validation.valid) {
      elements.workflowActionHint.textContent = validation.message;
      focusCurrentImageRestoreStep();
      return;
    }

    state.imageRestoreCompletedStep = Math.max(
      state.imageRestoreCompletedStep,
      state.imageRestoreStep
    );
  }

  if (nextStep > state.imageRestoreCompletedStep + 1) {
    return;
  }

  state.imageRestoreStep = nextStep;
  clearError();
  renderImageRestoreWorkflow();
  updatePrimaryActionState();
  elements.imageRestoreSteps.scrollIntoView({ block: "nearest" });
}

function focusCurrentImageRestoreStep() {
  if (state.imageRestoreStep === 1) {
    elements.imageUploadField.querySelector(".upload-dropzone")?.focus();
    return;
  }

  if (state.imageRestoreStep === 3) {
    const mode = getImageRestoreMode(state.imageRestoreModeCode);
    if (mode.requires_annotation && !state.imageRestoreAnnotationApplied) {
      elements.openRestoreMaskEditor.focus();
    }
  }
}

function syncImageRestoreWorkflowControls() {
  if (state.mode !== "image_restore") {
    return;
  }

  const validation = validateImageRestoreStep(state.imageRestoreStep);
  const isConfirmation = state.imageRestoreStep === 4;

  elements.workflowBackButton.disabled = state.imageRestoreStep === 1 || state.isSubmitting;
  elements.workflowNextButton.hidden = isConfirmation;
  elements.workflowNextButton.disabled = !validation.valid || state.isSubmitting;
  elements.workflowActionHint.textContent = validation.message;
}

function renderImageRestoreCategoryFilters() {
  elements.imageRestoreCategoryFilters.replaceChildren();
  if (state.mode !== "image_restore") {
    return;
  }

  for (const category of imageRestoreCategoryOptions) {
    const button = document.createElement("button");
    const isSelected = category.value === state.imageRestoreCategory;
    button.type = "button";
    button.className = "choice-filter";
    button.dataset.selected = String(isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
    button.textContent = category.label;
    button.addEventListener("click", () => {
      state.imageRestoreCategory = category.value;
      renderImageRestoreCategoryFilters();
      renderImageRestoreModeCards();
    });
    elements.imageRestoreCategoryFilters.append(button);
  }
}

function renderImageRestoreModeCards() {
  elements.imageRestoreModeList.replaceChildren();
  if (state.mode !== "image_restore") {
    return;
  }

  const modes = imageRestoreModes.filter((mode) =>
    mode.category.includes(state.imageRestoreCategory)
  );
  const previewUrl = currentInputPreviewUrl();

  for (const mode of modes) {
    const card = document.createElement("button");
    const visual = document.createElement("span");
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    const description = document.createElement("small");
    const tags = document.createElement("span");
    const check = document.createElement("span");
    const isSelected = mode.mode_code === state.imageRestoreModeCode;

    card.type = "button";
    card.className = "image-restore-mode-card";
    card.dataset.selected = String(isSelected);
    card.setAttribute("aria-pressed", String(isSelected));
    visual.className = `image-restore-mode-preview preview-${mode.preview}`;
    if (previewUrl !== null) {
      const image = document.createElement("img");
      image.src = previewUrl;
      image.alt = "";
      visual.append(image);
    }
    check.className = "restore-mode-check";
    check.textContent = "✓";
    visual.append(check);
    copy.className = "image-restore-mode-copy";
    name.textContent = mode.display_name;
    description.textContent = mode.description;
    tags.className = "image-edit-mode-tags";
    for (const tagText of mode.scene_tags) {
      const tag = document.createElement("span");
      tag.textContent = tagText;
      tags.append(tag);
    }
    copy.append(name, description, tags);
    card.append(visual, copy);
    card.addEventListener("click", () => {
      state.imageRestoreModeCode = mode.mode_code;
      state.imageRestoreAnnotationApplied = false;
      elements.restoreTypeSelect.value = mode.backend_preset_id;
      renderImageRestoreModeCards();
      renderImageRestoreParameterChoices();
      renderImageRestoreSummary();
      syncImageRestoreWorkflowControls();
    });
    elements.imageRestoreModeList.append(card);
  }
}

function renderImageRestoreParameterChoices() {
  if (state.mode !== "image_restore") {
    elements.imageRestoreParameterChoices.hidden = true;
    return;
  }

  elements.imageRestoreParameterChoices.hidden = state.imageRestoreStep !== 3;
  if (state.imageRestoreOutputPolicy === "keep_original") {
    selectClosestRestoreSize();
  }
  renderImageRestoreModelChoices();
  renderImageRestoreDynamicParameters();
  renderImageRestoreOutputPolicyChoices();
  renderImageRestoreSizeChoices();
  renderSegmentedChoiceList(
    elements.imageRestoreCountChoices,
    elements.countSelect,
    (option) => `${option.value} 张`
  );
}

function renderImageRestoreModelChoices() {
  elements.imageRestoreModelChoices.replaceChildren();
  for (const option of Array.from(elements.modelSelect.options)) {
    if (option.value.length === 0) continue;

    const model = findTaskModel(state.models, option.value, "image_restore");
    const button = document.createElement("button");
    const name = document.createElement("strong");
    const detail = document.createElement("small");
    const isSelected = option.value === elements.modelSelect.value;
    button.type = "button";
    button.className = "model-choice";
    button.dataset.selected = String(isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
    name.textContent = option.textContent;
    detail.textContent = model?.quality_tier === "hd" ? "高清修复" : "通用图片修复";
    button.append(name, detail);
    button.addEventListener("click", () => {
      elements.modelSelect.value = option.value;
      elements.modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    elements.imageRestoreModelChoices.append(button);
  }

  const selectedModel = currentSelectedModel();
  const compatible = isSelectedImageRestoreModelCompatible();
  elements.imageRestoreCompatibilityHint.textContent = compatible
    ? `已匹配 ${selectedModel?.display_name ?? "图片修复模型"}`
    : "没有支持参考图修复的可用模型";
  elements.imageRestoreCompatibilityHint.dataset.tone = compatible ? "ready" : "warning";
}

function isSelectedImageRestoreModelCompatible() {
  const model = currentSelectedModel();
  return isReferenceImageTaskModelCompatible(model, "image_restore", elements.sizeSelect.value);
}

function renderImageRestoreDynamicParameters() {
  elements.imageRestoreDynamicParameters.replaceChildren();
  if (state.mode !== "image_restore") return;

  const mode = getImageRestoreMode(state.imageRestoreModeCode);
  const values = state.imageRestoreParameterValues[mode.mode_code];
  elements.imageRestoreDynamicHint.textContent = mode.display_name;
  for (const parameter of mode.parameter_schema) {
    elements.imageRestoreDynamicParameters.append(
      createImageRestoreParameterControl(parameter, values)
    );
  }

  elements.openRestoreMaskEditor.hidden = !mode.requires_annotation;
  elements.openRestoreMaskEditor.disabled = !hasCurrentImageInput();
  elements.imageRestoreAnnotationStatus.hidden = !mode.requires_annotation;
  elements.imageRestoreAnnotationStatus.dataset.tone = state.imageRestoreAnnotationApplied
    ? "ready"
    : "warning";
  elements.imageRestoreAnnotationStatus.textContent = state.imageRestoreAnnotationApplied
    ? "标注区域已就绪，可以继续"
    : "此修复方式需要先标注处理区域";
}

function createImageRestoreParameterControl(parameter, values) {
  const field = document.createElement("label");
  const heading = document.createElement("span");
  const label = document.createElement("strong");
  field.className = "image-edit-dynamic-field";
  heading.className = "image-edit-dynamic-heading";
  label.textContent = parameter.label;
  heading.append(label);
  field.append(heading);

  const update = () => {
    renderImageRestoreSummary();
    syncImageRestoreWorkflowControls();
  };

  if (parameter.type === "range") {
    const output = document.createElement("output");
    const input = document.createElement("input");
    output.textContent = `${String(values[parameter.key])}${parameter.unit ?? ""}`;
    heading.append(output);
    input.type = "range";
    input.min = String(parameter.min);
    input.max = String(parameter.max);
    input.step = String(parameter.step);
    input.value = String(values[parameter.key]);
    input.addEventListener("input", () => {
      values[parameter.key] = Number(input.value);
      output.textContent = `${input.value}${parameter.unit ?? ""}`;
      update();
    });
    field.append(input);
  } else if (parameter.type === "toggle") {
    const toggle = document.createElement("button");
    const enabled = values[parameter.key] === true;
    toggle.type = "button";
    toggle.className = "toggle-choice";
    toggle.dataset.selected = String(enabled);
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(enabled));
    toggle.innerHTML = `<span aria-hidden="true"></span><strong>${enabled ? "已开启" : "已关闭"}</strong>`;
    toggle.addEventListener("click", () => {
      values[parameter.key] = values[parameter.key] !== true;
      renderImageRestoreDynamicParameters();
      update();
    });
    field.append(toggle);
  } else {
    const options = document.createElement("span");
    options.className = "segmented-choice-list image-edit-inline-options";
    for (const option of parameter.options ?? []) {
      const button = document.createElement("button");
      const isSelected = values[parameter.key] === option.value;
      button.type = "button";
      button.className = "segmented-choice";
      button.dataset.selected = String(isSelected);
      button.setAttribute("aria-pressed", String(isSelected));
      button.textContent = option.label;
      button.addEventListener("click", () => {
        values[parameter.key] = option.value;
        renderImageRestoreDynamicParameters();
        update();
      });
      options.append(button);
    }
    field.append(options);
  }

  if (parameter.helper !== undefined) {
    const helper = document.createElement("small");
    helper.textContent = parameter.helper;
    field.append(helper);
  }
  return field;
}

function renderImageRestoreOutputPolicyChoices() {
  elements.imageRestoreOutputPolicyChoices.replaceChildren();
  const policies = [
    { value: "keep_original", label: "保持原图比例" },
    { value: "model_size", label: "适配模型尺寸" }
  ];
  for (const policy of policies) {
    const button = document.createElement("button");
    const isSelected = policy.value === state.imageRestoreOutputPolicy;
    button.type = "button";
    button.className = "segmented-choice";
    button.dataset.selected = String(isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
    button.textContent = policy.label;
    button.addEventListener("click", () => {
      state.imageRestoreOutputPolicy = policy.value;
      if (policy.value === "keep_original") selectClosestRestoreSize();
      renderImageRestoreParameterChoices();
      renderImageRestoreSummary();
      void refreshEstimate();
    });
    elements.imageRestoreOutputPolicyChoices.append(button);
  }
}

function renderImageRestoreSizeChoices() {
  elements.imageRestoreSizeChoices.replaceChildren();
  elements.imageRestoreSizeChoices.hidden = state.imageRestoreOutputPolicy === "keep_original";
  if (elements.imageRestoreSizeChoices.hidden) return;

  const enabledSizes = new Set(
    Array.from(elements.sizeSelect.options)
      .filter((option) => !option.disabled)
      .map((option) => option.value)
  );
  for (const size of imageSizeOptions.filter((item) => enabledSizes.has(item.value))) {
    const button = document.createElement("button");
    const dimensions = document.createElement("strong");
    const usage = document.createElement("small");
    const ratio = document.createElement("span");
    const isSelected = size.value === elements.sizeSelect.value;
    button.type = "button";
    button.className = "size-choice compact-size-choice";
    button.dataset.selected = String(isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
    dimensions.textContent = size.value.replace("x", " × ");
    usage.textContent = size.usage;
    ratio.className = "size-choice-ratio";
    ratio.textContent = size.ratio;
    button.append(dimensions, usage, ratio);
    button.addEventListener("click", () => {
      elements.sizeSelect.value = size.value;
      elements.sizeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    elements.imageRestoreSizeChoices.append(button);
  }
}

function selectClosestRestoreSize() {
  const meta = state.imageToImageUploadMeta;
  if (meta?.width === null || meta?.height === null || meta === null) return;

  const enabledSizes = imageSizeOptions.filter((item) =>
    Array.from(elements.sizeSelect.options).some(
      (option) => option.value === item.value && !option.disabled
    )
  );
  const sourceRatio = meta.width / meta.height;
  const closest = enabledSizes
    .map((item) => {
      const [width, height] = item.value.split("x").map(Number);
      return { item, score: Math.abs(width / height - sourceRatio) };
    })
    .sort((left, right) => left.score - right.score)[0]?.item;
  if (closest !== undefined) {
    elements.sizeSelect.value = closest.value;
  }
}

function validateImageToImageStep(step) {
  if (step === 1) {
    if (state.isValidatingImage) {
      return { valid: false, message: "正在校验图片，请稍候" };
    }

    if (state.imageToImageUploadError !== null) {
      return { valid: false, message: state.imageToImageUploadError };
    }

    return hasCurrentImageInput()
      ? { valid: true, message: "原图已就绪，可以选择编辑模式" }
      : { valid: false, message: "请上传原图，或从作品历史中选择" };
  }

  if (step === 2) {
    return getImageEditMode(elements.editModeSelect.value) === undefined
      ? { valid: false, message: "请选择一种编辑模式" }
      : { valid: true, message: "编辑模式已选择，将显示对应生成参数" };
  }

  if (step === 3) {
    if (elements.promptInput.value.trim().length === 0) {
      return { valid: false, message: "请说明希望如何编辑图片" };
    }

    if (!isSelectedImageEditModelCompatible()) {
      return { valid: false, message: "当前模型不支持参考图编辑，请更换模型" };
    }

    if (elements.sizeSelect.value.length === 0) {
      return { valid: false, message: "当前模型没有可用输出尺寸" };
    }

    if (state.estimate === null) {
      return { valid: false, message: "正在校验模型与预计积分" };
    }

    if (state.estimate.enough_balance !== true) {
      return { valid: false, message: "积分余额不足，无法继续创建" };
    }

    return { valid: true, message: "模型、尺寸和积分均已校验" };
  }

  return { valid: true, message: "确认内容后即可创建任务" };
}

function goToImageToImageStep(targetStep) {
  if (state.mode !== "image_to_image" || state.isSubmitting) {
    return;
  }

  const nextStep = Math.min(4, Math.max(1, targetStep));

  if (nextStep > state.imageToImageStep) {
    const validation = validateImageToImageStep(state.imageToImageStep);

    if (!validation.valid) {
      elements.workflowActionHint.textContent = validation.message;
      focusCurrentImageEditStep();
      return;
    }

    state.imageToImageCompletedStep = Math.max(
      state.imageToImageCompletedStep,
      state.imageToImageStep
    );
  }

  if (nextStep > state.imageToImageCompletedStep + 1) {
    return;
  }

  state.imageToImageStep = nextStep;
  clearError();
  renderImageToImageWorkflow();
  updatePrimaryActionState();
  elements.imageToImageSteps.scrollIntoView({ block: "nearest" });
}

function focusCurrentImageEditStep() {
  if (state.imageToImageStep === 1) {
    elements.imageUploadField.querySelector(".upload-dropzone")?.focus();
    return;
  }

  if (state.imageToImageStep === 3) {
    elements.promptInput.focus();
  }
}

function syncImageToImageWorkflowControls() {
  if (state.mode !== "image_to_image") {
    return;
  }

  const validation = validateImageToImageStep(state.imageToImageStep);
  const isConfirmation = state.imageToImageStep === 4;

  elements.workflowBackButton.disabled = state.imageToImageStep === 1 || state.isSubmitting;
  elements.workflowNextButton.hidden = isConfirmation;
  elements.workflowNextButton.disabled = !validation.valid || state.isSubmitting;
  elements.workflowActionHint.textContent = validation.message;
}

function renderImageEditCategoryFilters() {
  if (state.mode !== "image_to_image") {
    elements.imageEditCategoryFilters.replaceChildren();
    return;
  }

  elements.imageEditCategoryFilters.replaceChildren();
  for (const category of imageEditCategoryOptions) {
    const button = document.createElement("button");
    const isSelected = category.value === state.imageToImageCategory;

    button.type = "button";
    button.className = "choice-filter";
    button.dataset.selected = String(isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
    button.textContent = category.label;
    button.addEventListener("click", () => {
      state.imageToImageCategory = category.value;
      renderImageEditCategoryFilters();
      renderImageEditModeCards();
    });
    elements.imageEditCategoryFilters.append(button);
  }
}

function renderImageEditModeCards() {
  if (state.mode !== "image_to_image") {
    elements.imageEditModeList.replaceChildren();
    return;
  }

  const modes = imageEditModes.filter((mode) => mode.category.includes(state.imageToImageCategory));
  const previewUrl = currentInputPreviewUrl();
  elements.imageEditModeList.replaceChildren();
  elements.imageEditModeList.append(createSmartImageEditModeCard(previewUrl));

  for (const mode of modes) {
    const card = document.createElement("button");
    const visual = document.createElement("span");
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    const description = document.createElement("small");
    const tags = document.createElement("span");
    const isSelected =
      !state.imageToImageSmartMode && mode.mode_code === elements.editModeSelect.value;

    card.type = "button";
    card.className = "image-edit-mode-card";
    card.dataset.selected = String(isSelected);
    card.setAttribute("aria-pressed", String(isSelected));
    visual.className = `image-edit-mode-preview preview-${mode.preview}`;
    if (previewUrl !== null) {
      const image = document.createElement("img");
      image.src = previewUrl;
      image.alt = "";
      visual.append(image);
    }
    copy.className = "image-edit-mode-copy";
    name.textContent = mode.display_name;
    description.textContent = mode.description;
    tags.className = "image-edit-mode-tags";
    for (const tagText of mode.scene_tags.slice(0, 3)) {
      const tag = document.createElement("span");
      tag.textContent = tagText;
      tags.append(tag);
    }
    copy.append(name, description, tags);
    card.append(visual, copy);
    card.addEventListener("click", () => {
      elements.editModeSelect.value = mode.mode_code;
      state.imageToImageSmartMode = false;
      applySelectedImageEditMode();
    });
    elements.imageEditModeList.append(card);
  }
}

function createSmartImageEditModeCard(previewUrl) {
  const card = document.createElement("button");
  const visual = document.createElement("span");
  const mark = document.createElement("span");
  const copy = document.createElement("span");
  const name = document.createElement("strong");
  const description = document.createElement("small");
  const currentMode = getImageEditMode(elements.editModeSelect.value);

  card.type = "button";
  card.className = "image-edit-mode-card image-edit-mode-smart";
  card.dataset.selected = String(state.imageToImageSmartMode);
  card.setAttribute("aria-pressed", String(state.imageToImageSmartMode));
  visual.className = "image-edit-mode-preview preview-smart";
  if (previewUrl !== null) {
    const image = document.createElement("img");
    image.src = previewUrl;
    image.alt = "";
    visual.append(image);
  }
  mark.className = "smart-match-mark";
  mark.textContent = "✦";
  visual.append(mark);
  copy.className = "image-edit-mode-copy";
  name.textContent = "智能匹配";
  description.textContent = `根据说明自动推荐，当前匹配：${currentMode.display_name}`;
  copy.append(name, description);
  card.append(visual, copy);
  card.addEventListener("click", () => {
    state.imageToImageSmartMode = true;
    elements.editModeSelect.value = inferImageEditModeCode(elements.promptInput.value);
    applySelectedImageEditMode({ preserveSmartMode: true });
  });

  return card;
}

function inferImageEditModeCode(prompt) {
  const normalizedPrompt = prompt.toLowerCase();
  const keywordRules = [
    { mode: "product_scene", keywords: ["商品", "产品", "电商", "包装"] },
    { mode: "portrait_retouch", keywords: ["人像", "美化", "肤色", "五官"] },
    { mode: "inpaint", keywords: ["局部", "移除", "擦除", "标注", "替换区域"] },
    { mode: "outpaint", keywords: ["扩图", "扩展", "补全画面", "延伸"] },
    { mode: "change_background", keywords: ["背景", "换景", "环境"] },
    { mode: "change_style", keywords: ["风格", "水彩", "动漫", "油画", "电影感"] },
    { mode: "variation", keywords: ["变体", "变化", "多方案", "重新构图"] }
  ];

  return (
    keywordRules.find((rule) => rule.keywords.some((keyword) => normalizedPrompt.includes(keyword)))
      ?.mode ?? "keep_subject"
  );
}

function applySelectedImageEditMode(options = {}) {
  if (options.preserveSmartMode !== true) {
    state.imageToImageSmartMode = false;
  }

  const mode = getImageEditMode(elements.editModeSelect.value);
  elements.promptInput.placeholder = mode.prompt_placeholder;
  renderImageEditModeCards();
  renderImageEditDynamicParameters();
  renderImageEditSummary();
  renderModelOptions();
  renderImageSizeOptions();
  syncImageToImageWorkflowControls();
  void refreshEstimate();
}

function renderImageToImageParameterChoices() {
  if (state.mode !== "image_to_image") {
    elements.imageToImageParameterChoices.hidden = true;
    return;
  }

  elements.imageToImageParameterChoices.hidden = state.imageToImageStep !== 3;
  renderImageEditModelChoices();
  renderSegmentedChoiceList(elements.imageEditQualityChoices, elements.qualitySelect, (option) =>
    option.value === "hd" ? "高清" : "标准"
  );
  renderSegmentedChoiceList(
    elements.imageEditCountChoices,
    elements.countSelect,
    (option) => `${option.value} 张`
  );
  renderImageEditSizeGroupFilters();
  renderImageEditSizeChoices();
  renderImageEditDynamicParameters();
}

function renderImageEditModelChoices() {
  elements.imageEditModelChoices.replaceChildren();
  for (const option of Array.from(elements.modelSelect.options)) {
    if (option.value.length === 0) {
      continue;
    }

    const model = findTaskModel(state.models, option.value, state.mode);
    const button = document.createElement("button");
    const name = document.createElement("strong");
    const detail = document.createElement("small");
    const isSelected = option.value === elements.modelSelect.value;

    button.type = "button";
    button.className = "model-choice";
    button.dataset.selected = String(isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
    name.textContent = option.textContent;
    detail.textContent = model?.quality_tier === "hd" ? "高清编辑" : "通用图片编辑";
    button.append(name, detail);
    button.addEventListener("click", () => {
      elements.modelSelect.value = option.value;
      elements.modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    elements.imageEditModelChoices.append(button);
  }

  const selectedModel = currentSelectedModel();
  elements.imageEditCompatibilityHint.textContent = isSelectedImageEditModelCompatible()
    ? `已匹配 ${selectedModel?.display_name ?? "图片编辑模型"}`
    : "没有支持参考图输入的可用模型";
  elements.imageEditCompatibilityHint.dataset.tone = isSelectedImageEditModelCompatible()
    ? "ready"
    : "warning";
}

function isSelectedImageEditModelCompatible() {
  const model = currentSelectedModel();
  return isReferenceImageTaskModelCompatible(model, "image_to_image");
}

function renderImageEditSizeGroupFilters() {
  const enabledSizes = new Set(
    Array.from(elements.sizeSelect.options)
      .filter((option) => !option.disabled)
      .map((option) => option.value)
  );
  const availableGroups = imageSizeGroups.filter((group) =>
    group.sizes.some((size) => enabledSizes.has(size))
  );

  if (!availableGroups.some((group) => group.value === state.imageToImageSizeGroup)) {
    state.imageToImageSizeGroup =
      availableGroups.find((group) => group.sizes.includes(elements.sizeSelect.value))?.value ??
      availableGroups[0]?.value ??
      "square";
  }

  elements.imageEditSizeGroupFilters.replaceChildren();
  for (const group of availableGroups) {
    const button = document.createElement("button");
    const isSelected = group.value === state.imageToImageSizeGroup;

    button.type = "button";
    button.className = "choice-filter";
    button.dataset.selected = String(isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
    button.textContent = group.label;
    button.addEventListener("click", () => {
      state.imageToImageSizeGroup = group.value;
      renderImageEditSizeGroupFilters();
      renderImageEditSizeChoices();
    });
    elements.imageEditSizeGroupFilters.append(button);
  }
}

function renderImageEditSizeChoices() {
  const group = imageSizeGroups.find(
    (candidate) => candidate.value === state.imageToImageSizeGroup
  );
  const enabledSizes = new Set(
    Array.from(elements.sizeSelect.options)
      .filter((option) => !option.disabled)
      .map((option) => option.value)
  );
  const sizes = imageSizeOptions.filter(
    (size) => group?.sizes.includes(size.value) && enabledSizes.has(size.value)
  );

  elements.imageEditSizeChoices.replaceChildren();
  for (const size of sizes) {
    const button = document.createElement("button");
    const dimensions = document.createElement("strong");
    const usage = document.createElement("small");
    const ratio = document.createElement("span");
    const isSelected = size.value === elements.sizeSelect.value;

    button.type = "button";
    button.className = "size-choice compact-size-choice";
    button.dataset.selected = String(isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
    dimensions.textContent = size.value.replace("x", " × ");
    usage.textContent = size.usage;
    ratio.className = "size-choice-ratio";
    ratio.textContent = size.ratio;
    button.append(dimensions, usage, ratio);
    button.addEventListener("click", () => {
      elements.sizeSelect.value = size.value;
      elements.sizeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    elements.imageEditSizeChoices.append(button);
  }
}

function syncImageToImageSizeGroup() {
  if (state.mode !== "image_to_image") {
    return;
  }

  state.imageToImageSizeGroup =
    imageSizeGroups.find((group) => group.sizes.includes(elements.sizeSelect.value))?.value ??
    state.imageToImageSizeGroup;
}

function renderImageEditDynamicParameters() {
  if (state.mode !== "image_to_image") {
    elements.imageEditDynamicParameters.replaceChildren();
    return;
  }

  const mode = getImageEditMode(elements.editModeSelect.value);
  const values = state.imageToImageParameterValues[mode.mode_code];
  elements.imageEditDynamicHint.textContent = mode.display_name;
  elements.imageEditDynamicParameters.replaceChildren();

  for (const parameter of mode.parameter_schema) {
    elements.imageEditDynamicParameters.append(createImageEditParameterControl(parameter, values));
  }

  elements.openImageMaskEditor.hidden = mode.mode_code !== "inpaint";
  elements.openImageMaskEditor.disabled = !hasCurrentImageInput();
}

function createImageEditParameterControl(parameter, values) {
  const field = document.createElement("label");
  const heading = document.createElement("span");
  const label = document.createElement("strong");

  field.className = "image-edit-dynamic-field";
  heading.className = "image-edit-dynamic-heading";
  label.textContent = parameter.label;
  heading.append(label);
  field.append(heading);

  if (parameter.type === "range") {
    const output = document.createElement("output");
    const input = document.createElement("input");
    output.textContent = `${String(values[parameter.key])}${parameter.unit ?? ""}`;
    heading.append(output);
    input.type = "range";
    input.min = String(parameter.min);
    input.max = String(parameter.max);
    input.step = String(parameter.step);
    input.value = String(values[parameter.key]);
    input.addEventListener("input", () => {
      values[parameter.key] = Number(input.value);
      output.textContent = `${input.value}${parameter.unit ?? ""}`;
      renderImageEditSummary();
    });
    field.append(input);
  } else if (parameter.type === "textarea") {
    const input = document.createElement("textarea");
    input.rows = 3;
    input.placeholder = parameter.placeholder ?? "";
    input.value = values[parameter.key] ?? "";
    input.addEventListener("input", () => {
      values[parameter.key] = input.value;
      renderImageEditSummary();
    });
    field.append(input);
  } else {
    const options = document.createElement("span");
    options.className = "segmented-choice-list image-edit-inline-options";
    for (const option of parameter.options ?? []) {
      const button = document.createElement("button");
      const isSelected = values[parameter.key] === option.value;
      button.type = "button";
      button.className = "segmented-choice";
      button.dataset.selected = String(isSelected);
      button.setAttribute("aria-pressed", String(isSelected));
      button.textContent = option.label;
      button.addEventListener("click", () => {
        values[parameter.key] = option.value;
        renderImageEditDynamicParameters();
        renderImageEditSummary();
      });
      options.append(button);
    }
    field.append(options);
  }

  if (parameter.helper !== undefined) {
    const helper = document.createElement("small");
    helper.textContent = parameter.helper;
    field.append(helper);
  }

  return field;
}

function syncPromptInputState() {
  const prompt = elements.promptInput.value.trim();
  const isValid = prompt.length > 0;

  elements.promptCharacterCount.textContent = `${String(elements.promptInput.value.length)} 字`;
  elements.promptValidationMessage.textContent = isValid
    ? state.mode === "image_to_image"
      ? "修改说明已填写，将与模式参数一起提交"
      : state.mode === "image_restore"
        ? "补充说明已填写，将与修复参数一起提交"
        : "提示词已填写，可以继续选择风格"
    : state.mode === "image_to_image"
      ? "请描述需要保留、替换或增强的画面部分"
      : state.mode === "image_restore"
        ? "补充说明可选，系统会按修复方式和推荐参数处理"
        : "请输入想生成的主体、场景或画面效果";
  elements.promptValidationMessage.dataset.tone = isValid ? "ready" : "muted";

  if (!isValid) {
    state.textToImageCompletedStep = 0;
  }
}

function validateTextToImageStep(step) {
  if (step === 1) {
    return elements.promptInput.value.trim().length > 0
      ? { valid: true, message: "提示词已完成" }
      : { valid: false, message: "请先填写提示词" };
  }

  if (step === 2) {
    return { valid: true, message: "可使用智能匹配或选择一个模板" };
  }

  if (step === 3) {
    if (elements.modelSelect.value.length === 0) {
      return { valid: false, message: "当前没有可用的图片模型" };
    }

    if (state.estimate === null) {
      return { valid: false, message: "正在校验模型和预计积分" };
    }

    if (state.estimate.enough_balance !== true) {
      return { valid: false, message: "积分余额不足，无法继续创建" };
    }

    return { valid: true, message: "生成参数与积分校验已完成" };
  }

  return { valid: true, message: "确认内容后即可创建任务" };
}

function goToTextToImageStep(targetStep) {
  if (state.mode !== "text_to_image" || state.isSubmitting) {
    return;
  }

  const nextStep = Math.min(4, Math.max(1, targetStep));

  if (nextStep > state.textToImageStep) {
    const validation = validateTextToImageStep(state.textToImageStep);

    if (!validation.valid) {
      elements.workflowActionHint.textContent = validation.message;

      if (state.textToImageStep === 1) {
        elements.promptInput.focus();
      }

      return;
    }

    state.textToImageCompletedStep = Math.max(
      state.textToImageCompletedStep,
      state.textToImageStep
    );
  }

  if (nextStep > state.textToImageCompletedStep + 1) {
    return;
  }

  state.textToImageStep = nextStep;
  clearError();
  renderTextToImageWorkflow();
  elements.textToImageSteps.scrollIntoView({ block: "nearest" });
}

function syncTextToImageWorkflowControls() {
  if (state.mode !== "text_to_image") {
    return;
  }

  const validation = validateTextToImageStep(state.textToImageStep);
  const isConfirmation = state.textToImageStep === 4;

  elements.workflowBackButton.disabled = state.textToImageStep === 1 || state.isSubmitting;
  elements.workflowNextButton.hidden = isConfirmation;
  elements.workflowNextButton.disabled = !validation.valid || state.isSubmitting;
  elements.workflowActionHint.textContent = validation.message;
}

function captureTextToImageDraft() {
  state.textToImageDraft = {
    prompt: elements.promptInput.value,
    stylePresetId: elements.stylePresetSelect.value,
    modelCode: elements.modelSelect.value,
    quality: elements.qualitySelect.value,
    imageSize: elements.sizeSelect.value,
    imageCount: elements.countSelect.value,
    step: state.textToImageStep,
    completedStep: state.textToImageCompletedStep,
    styleCategory: state.textToImageStyleCategory,
    sizeGroup: state.textToImageSizeGroup
  };
}

function restoreTextToImageDraft() {
  const draft = state.textToImageDraft;

  if (draft === null) {
    return;
  }

  elements.promptInput.value = draft.prompt;
  setSelectValueIfAvailable(elements.stylePresetSelect, draft.stylePresetId);
  setSelectValueIfAvailable(elements.modelSelect, draft.modelCode);
  setSelectValueIfAvailable(elements.qualitySelect, draft.quality);
  renderImageSizeOptions();
  setSelectValueIfAvailable(elements.sizeSelect, draft.imageSize);
  setSelectValueIfAvailable(elements.countSelect, draft.imageCount);
  state.textToImageStep = draft.step;
  state.textToImageCompletedStep = draft.completedStep;
  state.textToImageStyleCategory = draft.styleCategory;
  state.textToImageSizeGroup = draft.sizeGroup;
  syncPromptInputState();
}

async function refreshEstimate() {
  // 只允许最后一次请求更新估价，避免用户快速切换参数时旧响应覆盖新价格。
  const requestId = ++state.estimateRequestId;
  state.estimate = null;
  elements.estimatePoints.textContent = "--";
  elements.estimateBalance.textContent = "余额校验中";
  elements.estimateStrip.dataset.tone = "loading";
  renderCreationSummary();
  renderImageEditSummary();
  renderImageRestoreSummary();
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
        state.mode === "upscale" ? Number(elements.upscaleFactorSelect.value) : undefined,
      gateway_model_code: elements.modelSelect.value || undefined,
      gateway_capability: modeConfig[state.mode].capability,
      quality:
        state.mode === "image_to_text" || state.mode === "upscale"
          ? undefined
          : elements.qualitySelect.value
    });

    if (requestId !== state.estimateRequestId) {
      return;
    }

    state.estimate = estimate;
    elements.estimatePoints.textContent = `${estimate.estimated_points} ${estimate.unit}`;
    elements.estimateBalance.textContent = estimate.enough_balance
      ? `余额 ${estimate.balance_points}`
      : "余额不足";
    elements.estimateStrip.dataset.tone = estimate.enough_balance ? "ready" : "warning";
    // 确认摘要与提交栏使用同一份最新估价，避免模式切换时显示旧积分。
    renderCreationSummary();
    renderImageEditSummary();
    renderImageRestoreSummary();
    updatePrimaryActionState();
  } catch (error) {
    if (requestId !== state.estimateRequestId) {
      return;
    }

    state.estimate = null;
    elements.estimatePoints.textContent = "--";
    elements.estimateBalance.textContent = error instanceof Error ? error.message : "计费估算失败";
    elements.estimateStrip.dataset.tone = "warning";
    renderCreationSummary();
    renderImageEditSummary();
    renderImageRestoreSummary();
    updatePrimaryActionState();
  }
}

async function handleTaskSubmitError(error, fallbackMessage) {
  renderProgress("failed");

  // 图片生成失败后立即结束加载动画，避免结果区一直停留在处理中状态。
  if (state.mode !== "image_to_text") {
    renderGenerationFailure();
  }

  if (error?.code === "BILLING_PRICE_CHANGED") {
    // 后台调价后立即获取新价格，防止用户携带旧估价反复提交失败。
    await refreshEstimate();
  }

  showError(error instanceof Error ? error.message : fallbackMessage);
}

function createSubmissionIdempotencyKey() {
  if (typeof window.crypto?.randomUUID === "function") {
    return `image-task-${window.crypto.randomUUID()}`;
  }

  return `image-task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function createQueuedImageTask(input) {
  let pendingSubmission = readPendingSubmission();

  if (pendingSubmission === null) {
    if (input === undefined) throw new Error("没有可恢复的待提交任务。");
    pendingSubmission = {
      idempotency_key: state.draftIdempotencyKey ?? createSubmissionIdempotencyKey(),
      task_type: input.task_type,
      input
    };
    // 幂等键绑定到待提交记录后，刷新恢复必须继续使用 sessionStorage 中的原值。
    state.draftIdempotencyKey = null;
    // 在发起 POST 前保存完整提交边界，刷新后必须复用同一幂等键和输入文件 ID。
    window.sessionStorage.setItem(pendingSubmissionStorageKey, JSON.stringify(pendingSubmission));
  }

  const result = await createImageTask(pendingSubmission.input, {
    idempotencyKey: pendingSubmission.idempotency_key
  });

  // 服务端已返回任务 ID 后才清除待提交记录；响应丢失时刷新可安全重放原请求。
  window.sessionStorage.removeItem(pendingSubmissionStorageKey);
  return result;
}

function readPendingSubmission() {
  const rawValue = window.sessionStorage.getItem(pendingSubmissionStorageKey);
  if (rawValue === null) return null;

  try {
    const saved = JSON.parse(rawValue);
    if (
      typeof saved.idempotency_key !== "string" ||
      typeof saved.task_type !== "string" ||
      saved.input === null ||
      typeof saved.input !== "object" ||
      saved.input.task_type !== saved.task_type
    ) {
      throw new Error("invalid pending submission");
    }
    return saved;
  } catch {
    window.sessionStorage.removeItem(pendingSubmissionStorageKey);
    return null;
  }
}

async function resumePendingImageTaskSubmission() {
  const pendingSubmission = readPendingSubmission();
  if (pendingSubmission === null || state.isSubmitting || state.activeTaskId !== null) return;

  if (modeConfig[pendingSubmission.task_type] !== undefined) {
    state.mode = pendingSubmission.task_type;
    renderActiveModeControls();
  }

  clearError();
  setSubmitting(true, "正在恢复上次未确认的任务提交");
  renderProgress("reserving");
  try {
    acceptAsyncImageTask(await createQueuedImageTask());
  } catch (error) {
    if (isPermanentSubmissionError(error)) {
      window.sessionStorage.removeItem(pendingSubmissionStorageKey);
    }
    await handleTaskSubmitError(error, "任务提交恢复失败。");
  } finally {
    setSubmitting(false);
  }
}

function isPermanentSubmissionError(error) {
  const status = Number(error?.status);
  return (
    Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
}

function acceptAsyncImageTask(result) {
  state.activeTaskId = result.task.id;
  state.activeTaskType = result.task.task_type;
  window.localStorage.setItem(
    activeTaskStorageKey,
    JSON.stringify({ task_id: result.task.id, task_type: result.task.task_type })
  );
  renderProgress(resolveImageTaskProgressStage(result.task.status));
  elements.actionHint.textContent = `任务 ${result.task.id} 已进入队列，正在等待处理`;
  updatePrimaryActionState();

  if (!isActiveImageTaskStatus(result.task.status)) {
    void handlePolledImageTask(result);
    return;
  }

  // 重试任务进入队列后移除旧终态按钮，防止用户在新任务处理中再次操作旧结果。
  if (result.task.task_type === "image_to_text") {
    elements.resultList.replaceChildren();
  } else {
    renderGenerationLoading("任务已进入队列，正在等待处理");
  }

  imageTaskPoller.start(result.task.id);
}

async function handlePolledImageTask(result) {
  const { task } = result;
  const stage = resolveImageTaskProgressStage(task.status);

  renderProgress(stage);
  elements.actionHint.textContent = resolveAsyncTaskStatusText(task);

  // 结算待处理时结果文件已经生成，可以先展示；轮询继续等待最终结算状态。
  if (!isActiveImageTaskStatus(task.status) || task.status === "billing_pending") {
    renderTaskResult(result);
  }

  if (isActiveImageTaskStatus(task.status)) {
    return;
  }

  clearActiveImageTask();
  updatePrimaryActionState();
  await Promise.all([refreshEstimate(), refreshHistory()]);
}

function handleTaskPollingError() {
  elements.actionHint.textContent = "网络连接暂时不可用，正在自动恢复任务状态";
}

function handleTaskPollingTerminalError(error) {
  clearActiveImageTask();
  renderProgress("failed");
  if (state.mode !== "image_to_text") renderGenerationFailure();
  updatePrimaryActionState();
  showError(error instanceof Error ? error.message : "任务状态无法继续查询，请重新进入工作台。");
}

function clearActiveImageTask() {
  // 活动任务只代表仍需轮询的服务端任务；终态或永久错误到达后必须同步释放内存与浏览器锁定。
  imageTaskPoller.stop();
  state.activeTaskId = null;
  state.activeTaskType = null;
  window.localStorage.removeItem(activeTaskStorageKey);
}

function resolveAsyncTaskStatusText(task) {
  const labels = {
    pending: "正在创建任务",
    billing_reserved: "积分已预占，等待进入队列",
    queued: "任务已排队，等待 Worker 处理",
    running: "AI 正在处理任务",
    billing_pending: "结果已生成，积分正在结算",
    succeeded: "任务已完成",
    failed: "任务处理失败",
    cancelled: "任务已取消"
  };

  return `任务 ${task.id}：${labels[task.status] ?? "正在处理"}`;
}

function restoreActiveImageTask() {
  const rawValue = window.localStorage.getItem(activeTaskStorageKey);
  if (rawValue === null) return;

  try {
    const saved = JSON.parse(rawValue);
    if (typeof saved.task_id !== "string" || saved.task_id.length === 0) {
      throw new Error("invalid task id");
    }

    if (typeof saved.task_type === "string" && modeConfig[saved.task_type] !== undefined) {
      state.mode = saved.task_type;
      renderActiveModeControls();
    }

    state.activeTaskId = saved.task_id;
    state.activeTaskType =
      typeof saved.task_type === "string" && modeConfig[saved.task_type] !== undefined
        ? saved.task_type
        : null;
    setSubmitting(true, "正在恢复未完成的图片任务");
    setSubmitting(false);
    renderProgress("generating");
    updatePrimaryActionState();
    imageTaskPoller.start(saved.task_id);
  } catch {
    window.localStorage.removeItem(activeTaskStorageKey);
  }
}

async function optimizeCurrentPrompt() {
  clearError();

  const prompt = elements.promptInput.value.trim();

  if (prompt.length === 0) {
    showError("请输入需要优化的提示词。");
    return;
  }

  state.isOptimizingPrompt = true;
  elements.promptOptimizeButton.disabled = true;
  elements.promptOptimizeButton.textContent = "优化中";
  elements.actionHint.textContent = "正在调用 AI 优化提示词";
  setPromptOptimizationLoading(true);

  try {
    const result = await optimizePrompt({
      prompt,
      task_type: state.mode
    });

    elements.promptInput.value = result.optimized_prompt;
    elements.actionHint.textContent = "提示词已优化，可继续调整后创建任务";
    // AI 优化会直接改写输入框，需要同步刷新步骤校验和确认摘要。
    syncPromptInputState();
    if (state.mode === "image_to_image" && state.imageToImageSmartMode) {
      elements.editModeSelect.value = inferImageEditModeCode(result.optimized_prompt);
      applySelectedImageEditMode({ preserveSmartMode: true });
    }
    renderCreationSummary();
    renderImageEditSummary();
    renderImageRestoreSummary();
    syncTextToImageWorkflowControls();
    syncImageToImageWorkflowControls();
    syncImageRestoreWorkflowControls();
    await refreshEstimate();
  } catch (error) {
    showError(error instanceof Error ? error.message : "提示词优化失败，请稍后重试。");
  } finally {
    state.isOptimizingPrompt = false;
    elements.promptOptimizeButton.disabled = false;
    elements.promptOptimizeButton.textContent = "AI 优化";
    setPromptOptimizationLoading(false);
  }
}

async function submitCurrentTask() {
  if (state.isSubmitting || state.activeTaskId !== null) {
    showError("当前已有任务正在处理，请等待完成后再创建新任务。");
    return;
  }

  if (readPendingSubmission() !== null) {
    // 上次 POST 结果未知时优先重放原请求，禁止重新上传文件或生成新的幂等键。
    await resumePendingImageTaskSubmission();
    return;
  }

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
    const result = await createQueuedImageTask({
      ...currentPricingExpectation(),
      task_type: "text_to_image",
      prompt,
      style_preset_id: elements.stylePresetSelect.value || undefined,
      gateway_model_code: modelCode,
      gateway_capability: "image_generation",
      quality: elements.qualitySelect.value,
      image_size: elements.sizeSelect.value,
      image_count: Number(elements.countSelect.value)
    });

    acceptAsyncImageTask(result);
  } catch (error) {
    await handleTaskSubmitError(error, "文生图任务提交失败。");
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
    const result = await createQueuedImageTask({
      ...currentPricingExpectation(),
      task_type: "image_to_text",
      prompt: undefined,
      input_file_ids: [uploaded.file.id],
      gateway_model_code: modelCode,
      gateway_capability: "vision_text",
      image_count: 1
    });

    acceptAsyncImageTask(result);
  } catch (error) {
    await handleTaskSubmitError(error, "图生文任务提交失败。");
  } finally {
    setSubmitting(false);
  }
}

async function submitImageToImageTask() {
  clearError();

  const mode = getImageEditMode(elements.editModeSelect.value);
  const prompt = composeImageEditPrompt(
    mode,
    elements.promptInput.value,
    state.imageToImageParameterValues[mode.mode_code]
  );
  const modelCode = elements.modelSelect.value;
  // 标注画布导出的 PNG 优先于本地选择文件，确保模型收到用户实际标记过的参考图。
  const file = state.annotatedInputFile ?? elements.imageInput.files?.[0];

  if (!isSelectedImageEditModelCompatible()) {
    showError("当前模型不支持参考图编辑，请更换模型后重试。");
    return;
  }

  if (prompt.length === 0) {
    showError("请描述希望如何编辑参考图。");
    return;
  }

  if (file === undefined && state.referenceFileId === null) {
    showError("请先上传一张参考图，或从历史结果中选择再次编辑。");
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
    const result = await createQueuedImageTask({
      ...currentPricingExpectation(),
      task_type: "image_to_image",
      prompt,
      // 只有后台确实存在同名模板时才提交 style_preset_id，新模式通过结构化提示词保持兼容。
      style_preset_id: resolveImageEditStylePresetId(mode.mode_code),
      input_file_ids: [inputFileId],
      gateway_model_code: modelCode,
      gateway_capability: "image_edit",
      quality: elements.qualitySelect.value,
      image_size: elements.sizeSelect.value,
      image_count: Number(elements.countSelect.value),
      source_task_id: state.sourceTaskId,
      // 标注 PNG 是新文件，来源文件 ID 单独用于后端验证作品链路。
      source_file_id: state.sourceFileId
    });

    acceptAsyncImageTask(result);
  } catch (error) {
    await handleTaskSubmitError(error, "图生图任务提交失败。");
  } finally {
    setSubmitting(false);
  }
}

async function submitImageRestoreTask() {
  clearError();

  const modelCode = elements.modelSelect.value;
  const file = state.annotatedInputFile ?? elements.imageInput.files?.[0];
  const mode = getImageRestoreMode(state.imageRestoreModeCode);
  const values = state.imageRestoreParameterValues[mode.mode_code];
  const prompt = composeImageRestorePrompt(mode, elements.promptInput.value, values);

  if (modelCode.length === 0) {
    showError("当前模式暂无可用模型。");
    return;
  }

  if (!hasCurrentImageInput()) {
    showError("请先上传一张需要修复的原图。");
    return;
  }

  for (const step of [1, 2, 3]) {
    const validation = validateImageRestoreStep(step);
    if (!validation.valid) {
      showError(validation.message);
      goToImageRestoreStep(step);
      return;
    }
  }

  if (!confirmHighConsumptionTask("图片修复")) {
    elements.actionHint.textContent = "已取消图片修复，本次不会预占积分";
    return;
  }

  setSubmitting(true, "正在上传原图并调用图片修复模型");
  renderProgress("uploading");

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
      showError("修复原图不可用，请重新上传图片。");
      return;
    }

    renderProgress("generating");
    const result = await createQueuedImageTask({
      ...currentPricingExpectation(),
      task_type: "image_restore",
      prompt,
      style_preset_id: mode.backend_preset_id,
      input_file_ids: [inputFileId],
      gateway_model_code: modelCode,
      gateway_capability: "image_edit",
      quality: elements.qualitySelect.value,
      image_size: elements.sizeSelect.value,
      image_count: Number(elements.countSelect.value),
      source_task_id: state.sourceTaskId,
      source_file_id: state.sourceFileId
    });

    acceptAsyncImageTask(result);
  } catch (error) {
    await handleTaskSubmitError(error, "图片修复任务提交失败。");
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
    const result = await createQueuedImageTask({
      ...currentPricingExpectation(),
      task_type: "upscale",
      upscale_factor: upscaleFactor,
      input_file_ids: [uploaded.file.id],
      gateway_model_code: modelCode,
      gateway_capability: "image_edit",
      image_count: 1
    });

    acceptAsyncImageTask(result);
  } catch (error) {
    await handleTaskSubmitError(error, "高清放大任务提交失败。");
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

function currentPricingExpectation() {
  return {
    expected_price_rule_id: state.estimate?.rule_id ?? null,
    expected_points: state.estimate?.estimated_points
  };
}

function setSubmitting(isSubmitting, message = "") {
  state.isSubmitting = isSubmitting;
  elements.primaryAction.textContent = isSubmitting ? "生成中" : "创建任务";
  elements.primaryAction.dataset.loading = String(isSubmitting);
  elements.promptOptimizeButton.disabled = isSubmitting || state.isOptimizingPrompt;
  elements.actionHint.textContent = isSubmitting ? message : elements.actionHint.textContent;

  // 只有会输出图片的任务才占用结果区展示生成动画，图生文继续使用原有进度反馈。
  if (isSubmitting && state.mode !== "image_to_text") {
    renderGenerationLoading(message);
  }

  updatePrimaryActionState();
  syncImageToImageWorkflowControls();
  syncImageRestoreWorkflowControls();
}

function setPromptOptimizationLoading(isLoading) {
  elements.promptOptimizationOverlay.hidden = !isLoading;
  document.body.classList.toggle("is-prompt-optimizing", isLoading);
}

function renderGenerationLoading(message) {
  const loading = document.createElement("section");
  const visual = document.createElement("div");
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  const detail = document.createElement("p");
  const progress = document.createElement("div");
  const progressBar = document.createElement("span");

  loading.className = "generation-loading";
  loading.setAttribute("role", "status");
  loading.setAttribute("aria-live", "polite");
  visual.className = "generation-loading-visual";
  visual.setAttribute("aria-hidden", "true");

  // 三个色块模拟图像由轮廓到细节逐步成形，动画本身不承载业务信息。
  for (let index = 0; index < 3; index += 1) {
    const block = document.createElement("span");
    visual.append(block);
  }

  copy.className = "generation-loading-copy";
  title.textContent = "正在生成图片";
  detail.textContent = message || "AI 正在构建画面，请稍候";
  progress.className = "loading-track generation-loading-track";
  progress.setAttribute("aria-hidden", "true");
  progress.append(progressBar);
  copy.append(title, detail, progress);
  loading.append(visual, copy);
  elements.resultList.replaceChildren(loading);
}

function updateGenerationLoadingStage(stage) {
  const loading = elements.resultList.querySelector(".generation-loading");

  if (loading === null) {
    return;
  }

  const title = loading.querySelector("strong");
  const detail = loading.querySelector("p");

  loading.dataset.stage = stage;

  if (stage === "uploading") {
    title.textContent = "正在上传图片";
    detail.textContent = "正在准备原图和任务参数";
    return;
  }

  title.textContent = "AI 正在生成图片";
  detail.textContent = "模型正在构建画面与细节，请保持页面开启";
}

function renderGenerationFailure() {
  const failure = document.createElement("div");
  const title = document.createElement("strong");
  const detail = document.createElement("p");

  failure.className = "generation-state generation-state-failed";
  title.textContent = "本次生成未完成";
  detail.textContent = "请查看错误提示，调整后可以重新创建任务。";
  failure.append(title, detail);
  elements.resultList.replaceChildren(failure);
}

function renderTaskResult(result) {
  elements.resultList.replaceChildren();

  if (result.task.status === "failed" || result.task.status === "cancelled") {
    elements.resultList.append(createFailedResultCard(result.task));
    appendTerminalTaskActions(result.task);
    return;
  }

  if (result.task.text_result !== null && result.task.text_result.length > 0) {
    elements.resultList.append(createTextResultCard(result.task.text_result));
    appendTerminalTaskActions(result.task);
    return;
  }

  const files = result.result_files ?? [];
  const inputFiles = result.input_files ?? [];

  if (result.task.task_type === "image_restore" && inputFiles.length > 0 && files.length > 0) {
    elements.resultList.append(createImageRestoreComparison(inputFiles[0], files[0], result.task));
    for (const file of files.slice(1)) {
      elements.resultList.append(createImageResultCard(file, result.task));
    }
    appendTerminalTaskActions(result.task);
    return;
  }

  if (inputFiles.length > 0) {
    elements.resultList.append(createInputReferenceCard(inputFiles));
  }

  if (files.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-text";
    empty.textContent = "任务已提交，暂无结果文件。";
    elements.resultList.append(empty);
    appendTerminalTaskActions(result.task);
    return;
  }

  for (const file of files) {
    elements.resultList.append(createImageResultCard(file, result.task));
  }

  appendTerminalTaskActions(result.task);
}

function appendTerminalTaskActions(task) {
  if (isActiveImageTaskStatus(task.status)) return;

  const section = document.createElement("section");
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  const detail = document.createElement("p");
  const button = document.createElement("button");

  section.className = "terminal-task-actions";
  section.dataset.taskId = task.id;
  copy.className = "terminal-task-actions-copy";
  title.textContent = task.status === "succeeded" ? "本次创作已完成" : "本次任务已结束";
  detail.textContent =
    task.status === "succeeded"
      ? "作品已保留到历史记录，可以继续创建新的内容。"
      : "可以返回新的创作草稿，重新填写内容并创建任务。";
  button.type = "button";
  button.className = "primary-button terminal-new-task-button";
  button.textContent = "创建新任务";
  button.addEventListener("click", () => {
    startNewDraft(button);
  });
  copy.append(title, detail);
  section.append(copy, button);
  elements.resultList.append(section);
}

function startNewDraft(button) {
  if (state.isStartingNewTask || state.activeTaskId !== null) return;

  // 新草稿只清理浏览器侧上下文，服务端任务、结果文件和历史作品继续保留。
  state.isStartingNewTask = true;
  button.disabled = true;
  button.textContent = "正在准备";
  clearActiveImageTask();
  window.sessionStorage.removeItem(pendingSubmissionStorageKey);
  state.draftIdempotencyKey = createSubmissionIdempotencyKey();
  // 让上一草稿仍在途的估价响应失效，避免旧价格覆盖新任务参数。
  state.estimateRequestId += 1;
  state.estimate = null;
  resetCreationFormForMode();
  clearError();
  elements.resultList.replaceChildren();
  renderProgress("idle");
  state.isStartingNewTask = false;
  updatePrimaryActionState();
  void Promise.all([refreshEstimate(), refreshHistory()]);
}

function resetCreationFormForMode() {
  // 五种能力共享上传控件，建立新草稿时统一释放本地预览、历史引用和标注结果。
  clearReeditSource();
  revokeLocalPreviewUrl();
  elements.imageInput.value = "";
  state.imageToImageUploadMeta = null;
  state.imageToImageUploadError = null;
  state.isValidatingImage = false;
  state.annotationSourceTask = null;
  state.annotationSourceFile = null;
  state.annotationPurpose = null;

  state.textToImageStep = 1;
  state.textToImageCompletedStep = 0;
  state.textToImageStyleCategory = "all";
  state.textToImageSizeGroup = "square";
  state.textToImageDraft = null;

  state.imageToImageStep = 1;
  state.imageToImageCompletedStep = 0;
  state.imageToImageCategory = "common";
  state.imageToImageSizeGroup = "square";
  state.imageToImageSmartMode = true;
  state.imageToImageParameterValues = createImageEditParameterValues();

  state.imageRestoreStep = 1;
  state.imageRestoreCompletedStep = 0;
  state.imageRestoreCategory = "all";
  state.imageRestoreModeCode = "smart_restore";
  state.imageRestoreParameterValues = createImageRestoreParameterValues();
  state.imageRestoreOutputPolicy = "keep_original";
  state.imageRestoreAnnotationApplied = false;

  elements.promptInput.value = "";
  elements.stylePresetSelect.value = "";
  elements.editModeSelect.value = "keep_subject";
  elements.restoreTypeSelect.value = getImageRestoreMode("smart_restore").backend_preset_id;
  elements.qualitySelect.value = "standard";
  elements.sizeSelect.value = "1024x1024";
  elements.countSelect.value = "1";
  elements.upscaleFactorSelect.value = "2";
  renderActiveModeControls();
  renderUploadHint();
  syncPromptInputState();
}

function createImageRestoreComparison(inputFile, resultFile, task) {
  const section = document.createElement("section");
  const heading = document.createElement("div");
  const title = document.createElement("strong");
  const meta = document.createElement("small");
  const compare = document.createElement("div");
  const before = document.createElement("img");
  const afterLayer = document.createElement("div");
  const after = document.createElement("img");
  const divider = document.createElement("span");
  const range = document.createElement("input");
  const beforeLabel = document.createElement("span");
  const afterLabel = document.createElement("span");
  const actions = document.createElement("div");
  const viewButton = createTaskDetailButton(task.id);
  const downloadLink = document.createElement("a");
  const restoreAgainButton = document.createElement("button");
  const editButton = document.createElement("button");

  section.className = "restore-comparison";
  heading.className = "restore-comparison-heading";
  title.textContent = "修复前后对比";
  meta.textContent =
    resultFile.file.width !== null && resultFile.file.height !== null
      ? `${String(resultFile.file.width)} × ${String(resultFile.file.height)} · ${formatFileSize(Number(resultFile.file.size_bytes ?? 0))}`
      : formatFileSize(Number(resultFile.file.size_bytes ?? 0));
  heading.append(title, meta);

  compare.className = "restore-compare-canvas";
  before.src = inputFile.preview_url;
  before.alt = "修复前原图";
  before.className = "restore-compare-before";
  afterLayer.className = "restore-compare-after";
  after.src = resultFile.preview_url;
  after.alt = "修复后图片";
  afterLayer.append(after);
  divider.className = "restore-compare-divider";
  range.type = "range";
  range.min = "0";
  range.max = "100";
  range.value = "50";
  range.className = "restore-compare-range";
  range.setAttribute("aria-label", "拖动查看修复前后对比");
  range.addEventListener("input", () => {
    compare.style.setProperty("--compare-position", `${range.value}%`);
  });
  beforeLabel.className = "restore-compare-label before";
  beforeLabel.textContent = "修复前";
  afterLabel.className = "restore-compare-label after";
  afterLabel.textContent = "修复后";
  compare.append(before, afterLayer, divider, range, beforeLabel, afterLabel);

  actions.className = "restore-comparison-actions";
  viewButton.textContent = "放大查看";
  downloadLink.href = resultFile.download_url;
  downloadLink.target = "_blank";
  downloadLink.rel = "noreferrer";
  downloadLink.className = "primary-button compact-action";
  downloadLink.textContent = "下载原图";
  restoreAgainButton.type = "button";
  restoreAgainButton.className = "ghost-button";
  restoreAgainButton.textContent = "再次修复";
  restoreAgainButton.addEventListener("click", () => {
    state.mode = "image_restore";
    selectHistoryImageSource(task, resultFile);
    renderMode();
    renderModelOptions();
    renderImageRestoreWorkflow();
    void refreshEstimate();
  });
  editButton.type = "button";
  editButton.className = "ghost-button";
  editButton.textContent = "进入图生图编辑";
  editButton.addEventListener("click", () => {
    prepareReeditTask(task, resultFile, task.prompt ?? "");
  });
  actions.append(viewButton, downloadLink, restoreAgainButton, editButton);
  section.append(heading, compare, actions);
  return section;
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

function createImageResultCard(file, task) {
  const item = document.createElement("article");
  const image = document.createElement("img");
  const actions = document.createElement("div");
  const downloadLink = document.createElement("a");
  const continueButton = document.createElement("button");
  const detailButton = createTaskDetailButton(task.id);
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
  continueButton.textContent = "再次编辑";
  continueButton.addEventListener("click", () => {
    void openAnnotationEditor(task, file);
  });

  dimensions.className = "result-dimensions";
  dimensions.textContent =
    file.file.width !== null && file.file.height !== null
      ? `${String(file.file.width)} x ${String(file.file.height)}`
      : "尺寸未知";

  actions.append(dimensions, downloadLink, detailButton);

  if (task.status === "succeeded") {
    actions.append(continueButton);
  }
  item.append(image, actions);

  return item;
}

function createFailedResultCard(task) {
  const item = document.createElement("article");
  const title = document.createElement("strong");
  const message = document.createElement("p");
  const retryButton = document.createElement("button");
  const detailButton = createTaskDetailButton(task.id);
  const actions = document.createElement("div");

  item.className = "failed-result";
  title.textContent = task.status === "cancelled" ? "任务已取消" : "生成失败，积分已释放";
  message.textContent = resolveTaskFailureMessage(task);
  if (task.status === "failed") {
    retryButton.type = "button";
    retryButton.className = "primary-button";
    retryButton.textContent = "重试";
    retryButton.addEventListener("click", async () => {
      await runHistoryAction(retryButton, "重试中", async () => {
        const retryResult = await retryImageTask(task.id);

        acceptAsyncImageTask(retryResult);
      });
    });
  }

  actions.className = "result-actions";
  if (task.status === "failed") actions.append(retryButton);
  actions.append(detailButton);
  item.append(title, message, actions);

  return item;
}

function renderProgress(stage) {
  const steps = resolveProgressSteps();

  // 进度步骤变化时同步更新结果区动画文案，让用户看到真实加载阶段。
  updateGenerationLoadingStage(stage);

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
  const progressMode = state.activeTaskType ?? state.mode;

  if (progressMode === "image_restore") {
    return [
      { id: "upload", label: "上传图片" },
      { id: "reserve", label: "预占积分" },
      { id: "analyze", label: "分析图片" },
      { id: "generate", label: "修复图片" },
      { id: "store", label: "保存结果" },
      { id: "result", label: "结果可下载" }
    ];
  }

  if (progressMode === "image_to_image") {
    return [
      { id: "upload", label: "上传图片" },
      { id: "reserve", label: "预占积分" },
      { id: "generate", label: "编辑图片" },
      { id: "store", label: "保存结果" },
      { id: "result", label: "结果可下载" }
    ];
  }

  if (progressMode === "image_to_text" || progressMode === "upscale") {
    return [
      { id: "upload", label: "上传图片" },
      { id: "reserve", label: "预占积分" },
      {
        id: "generate",
        label:
          progressMode === "image_to_text"
            ? "生成文本"
            : progressMode === "image_restore"
              ? "修复图片"
              : progressMode === "upscale"
                ? "高清放大"
                : "编辑图片"
      },
      {
        id: "store",
        label: progressMode === "image_to_text" ? "保存文本" : "保存结果"
      },
      {
        id: "result",
        label: progressMode === "image_to_text" ? "结果可复制" : "结果可下载"
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
    reserving: "reserve",
    generating: "generate",
    saving: "store",
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
  if (state.isSubmitting || state.activeTaskId !== null) {
    elements.primaryAction.disabled = true;
    syncTextToImageWorkflowControls();
    syncImageToImageWorkflowControls();
    syncImageRestoreWorkflowControls();
    return;
  }

  const estimateUnavailable = state.estimate === null;
  const hasEnoughBalance = state.estimate?.enough_balance === true;
  const hasModel = elements.modelSelect.value.length > 0;

  const imageEditInvalid = state.mode === "image_to_image" && !validateImageToImageStep(3).valid;
  const imageRestoreInvalid = state.mode === "image_restore" && !validateImageRestoreStep(3).valid;
  elements.primaryAction.disabled =
    estimateUnavailable ||
    !hasEnoughBalance ||
    !hasModel ||
    imageEditInvalid ||
    imageRestoreInvalid;

  if (estimateUnavailable) {
    elements.actionHint.textContent = "正在校验余额和模型";
    syncTextToImageWorkflowControls();
    syncImageToImageWorkflowControls();
    syncImageRestoreWorkflowControls();
    return;
  }

  if (!hasEnoughBalance) {
    elements.actionHint.textContent = "余额不足，暂不能创建任务";
    syncTextToImageWorkflowControls();
    syncImageToImageWorkflowControls();
    syncImageRestoreWorkflowControls();
    return;
  }

  if (!hasModel) {
    elements.actionHint.textContent = "当前模式暂无可用模型";
    syncTextToImageWorkflowControls();
    syncImageToImageWorkflowControls();
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
  syncTextToImageWorkflowControls();
  syncImageToImageWorkflowControls();
  syncImageRestoreWorkflowControls();
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
      model.supported_task_types.includes(state.mode) &&
      (!(state.mode === "image_to_image" || state.mode === "image_restore") ||
        isReferenceImageTaskModelCompatible(model, state.mode))
  );

  elements.modelSelect.replaceChildren();

  if (models.length === 0) {
    const option = document.createElement("option");
    option.textContent = "当前模式暂无模型";
    option.value = "";
    elements.modelSelect.append(option);
    renderModelCapabilityHint();
    renderImageToImageParameterChoices();
    renderImageRestoreParameterChoices();
    return;
  }

  for (const model of models) {
    const option = document.createElement("option");
    option.value = model.gateway_model_code;
    option.textContent = model.display_name;
    option.selected = Array.isArray(model.default_task_types)
      ? model.default_task_types.includes(state.mode)
      : false;
    elements.modelSelect.append(option);
  }

  renderModelCapabilityHint();
  renderImageToImageParameterChoices();
  renderImageRestoreParameterChoices();
}

function renderModelCapabilityHint() {
  const selectedModel = currentSelectedModel();

  if (selectedModel === undefined) {
    elements.modelCapabilityHint.textContent = "当前模式暂无可用模型";
    return;
  }

  elements.modelCapabilityHint.textContent =
    state.mode === "image_to_text"
      ? "用于识别画面内容并生成描述、标题、标签或文案"
      : "模型已按当前任务能力自动匹配";
}

function renderImageSizeOptions() {
  const previousValue = elements.sizeSelect.value || "1024x1024";
  const selectedModel = currentSelectedModel();
  const supportedSizes = Array.isArray(selectedModel?.supported_image_sizes)
    ? selectedModel.supported_image_sizes
    : [];
  const requiresAvailableModel = state.mode === "image_to_image" && selectedModel === undefined;
  const hasSizeLimit = supportedSizes.length > 0 || requiresAvailableModel;
  const firstEnabled =
    imageSizeOptions.find(
      (size) => !requiresAvailableModel && (!hasSizeLimit || supportedSizes.includes(size.value))
    )?.value ?? "";

  elements.sizeSelect.replaceChildren();

  for (const size of imageSizeOptions) {
    const option = document.createElement("option");
    const isSupported =
      !requiresAvailableModel && (!hasSizeLimit || supportedSizes.includes(size.value));

    option.value = size.value;
    option.textContent = isSupported ? size.label : `${size.label}（当前模型不支持）`;
    option.disabled = !isSupported;
    elements.sizeSelect.append(option);
  }

  // 当前模型可能只开放部分尺寸；切换模型后自动选择可用尺寸，避免提交时才被后端拦截。
  elements.sizeSelect.value =
    !hasSizeLimit || supportedSizes.includes(previousValue) ? previousValue : firstEnabled;
  syncTextToImageSizeGroup();
  renderTextToImageParameterChoices();
  renderImageToImageParameterChoices();
  renderCreationSummary();
  renderImageEditSummary();
}

function renderImageSizeGuide() {
  elements.sizeGuide.replaceChildren();
  const disclosure = elements.sizeGuide.closest(".size-guide-disclosure");
  const shouldHide =
    state.mode === "text_to_image" || state.mode === "image_to_text" || state.mode === "upscale";

  // 图生文和高清放大不需要选择输出尺寸，同时隐藏尺寸参考，避免出现空白操作区。
  disclosure?.toggleAttribute("hidden", shouldHide);

  if (shouldHide) {
    return;
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  const headerRow = document.createElement("tr");

  for (const title of ["尺寸", "比例", "适合用途"]) {
    const cell = document.createElement("th");

    cell.scope = "col";
    cell.textContent = title;
    headerRow.append(cell);
  }

  thead.append(headerRow);

  for (const size of imageSizeOptions) {
    const row = document.createElement("tr");

    // 尺寸用途说明从统一配置渲染，避免下拉选项和帮助表格出现两套含义。
    for (const value of [size.value, size.ratio, size.usage]) {
      const cell = document.createElement("td");

      cell.textContent = value;
      row.append(cell);
    }

    tbody.append(row);
  }

  table.append(thead, tbody);
  elements.sizeGuide.append(table);
}

function currentSelectedModel() {
  const modelCode = elements.modelSelect.value;

  // 模型代码可能被多个能力记录复用，必须结合当前任务定位准确的目录项。
  return findTaskModel(state.models, modelCode, state.mode);
}

function renderTextToImageParameterChoices() {
  if (state.mode !== "text_to_image") {
    elements.textToImageParameterChoices.hidden = true;
    return;
  }

  elements.textToImageParameterChoices.hidden = false;
  renderSegmentedChoiceList(elements.qualityChoiceList, elements.qualitySelect, (option) =>
    option.value === "hd" ? "高清" : "标准"
  );
  renderSegmentedChoiceList(
    elements.countChoiceList,
    elements.countSelect,
    (option) => `${option.value} 张`
  );
  renderSizeGroupFilters();
  renderSizeChoiceList();
}

function renderSegmentedChoiceList(container, select, labelResolver) {
  container.replaceChildren();

  for (const option of Array.from(select.options)) {
    const button = document.createElement("button");
    const isSelected = option.value === select.value;

    button.type = "button";
    button.className = "segmented-choice";
    button.dataset.selected = String(isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
    button.disabled = option.disabled;
    button.textContent = labelResolver(option);
    button.addEventListener("click", () => {
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    container.append(button);
  }
}

function renderSizeGroupFilters() {
  const enabledSizes = new Set(
    Array.from(elements.sizeSelect.options)
      .filter((option) => !option.disabled)
      .map((option) => option.value)
  );
  const availableGroups = imageSizeGroups.filter((group) =>
    group.sizes.some((size) => enabledSizes.has(size))
  );

  if (!availableGroups.some((group) => group.value === state.textToImageSizeGroup)) {
    state.textToImageSizeGroup =
      availableGroups.find((group) => group.sizes.includes(elements.sizeSelect.value))?.value ??
      availableGroups[0]?.value ??
      "square";
  }

  elements.sizeGroupFilters.replaceChildren();

  for (const group of availableGroups) {
    const button = document.createElement("button");
    const isSelected = group.value === state.textToImageSizeGroup;

    button.type = "button";
    button.className = "choice-filter";
    button.dataset.selected = String(isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
    button.textContent = group.label;
    button.addEventListener("click", () => {
      state.textToImageSizeGroup = group.value;
      renderSizeGroupFilters();
      renderSizeChoiceList();
    });
    elements.sizeGroupFilters.append(button);
  }
}

function renderSizeChoiceList() {
  const group = imageSizeGroups.find((candidate) => candidate.value === state.textToImageSizeGroup);
  const enabledSizes = new Set(
    Array.from(elements.sizeSelect.options)
      .filter((option) => !option.disabled)
      .map((option) => option.value)
  );
  const sizes = imageSizeOptions.filter(
    (size) => group?.sizes.includes(size.value) && enabledSizes.has(size.value)
  );

  elements.sizeChoiceList.replaceChildren();

  for (const size of sizes) {
    // 用真实宽高比渲染尺寸示意，用户无需只靠数字判断横图或竖图。
    const button = document.createElement("button");
    const visual = document.createElement("span");
    const copy = document.createElement("span");
    const dimensions = document.createElement("strong");
    const usage = document.createElement("small");
    const ratio = document.createElement("span");
    const isSelected = size.value === elements.sizeSelect.value;
    const [width, height] = size.value.split("x").map(Number);

    button.type = "button";
    button.className = "size-choice";
    button.dataset.selected = String(isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
    visual.className = "size-choice-visual";
    visual.setAttribute("aria-hidden", "true");
    visual.style.aspectRatio = `${String(width)} / ${String(height)}`;
    copy.className = "size-choice-copy";
    dimensions.textContent = size.value.replace("x", " × ");
    usage.textContent = size.usage;
    copy.append(dimensions, usage);
    ratio.className = "size-choice-ratio";
    ratio.textContent = size.ratio;
    button.append(visual, copy, ratio);
    button.addEventListener("click", () => {
      elements.sizeSelect.value = size.value;
      elements.sizeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    elements.sizeChoiceList.append(button);
  }
}

function syncTextToImageSizeGroup() {
  if (state.mode !== "text_to_image") {
    return;
  }

  state.textToImageSizeGroup =
    imageSizeGroups.find((group) => group.sizes.includes(elements.sizeSelect.value))?.value ??
    state.textToImageSizeGroup;
}

function renderStylePresetOptions() {
  if (state.mode === "image_to_image") {
    // 图生图模式由本地配置驱动，避免远端模板列表覆盖八种固定编辑能力。
    return;
  }

  const presets = currentModeStylePresets();
  const select =
    state.mode === "image_to_image"
      ? elements.editModeSelect
      : state.mode === "image_restore"
        ? elements.restoreTypeSelect
        : elements.stylePresetSelect;

  if (!hasStylePresetSupport(state.mode)) {
    return;
  }

  const previousValue = select.value;
  select.replaceChildren();

  if (state.mode === "text_to_image") {
    const smartOption = document.createElement("option");

    smartOption.value = "";
    smartOption.textContent = "智能匹配";
    select.append(smartOption);
  }

  if (presets.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无模板";
    select.append(option);
    return;
  }

  for (const preset of presets) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.name;
    select.append(option);
  }

  setSelectValueIfAvailable(select, previousValue);
}

function renderStyleCategoryFilters() {
  if (state.mode !== "text_to_image") {
    elements.styleCategoryFilters.replaceChildren();
    elements.styleCategoryFilters.hidden = true;
    return;
  }

  const presets = currentModeStylePresets();
  const availableCategories = styleCategoryOptions.filter(
    (option) =>
      option.value === "all" ||
      presets.some((preset) => option.categories.includes(String(preset.category).toLowerCase()))
  );

  if (!availableCategories.some((option) => option.value === state.textToImageStyleCategory)) {
    state.textToImageStyleCategory = "all";
  }

  elements.styleCategoryFilters.replaceChildren();
  elements.styleCategoryFilters.hidden = false;

  for (const option of availableCategories) {
    const button = document.createElement("button");
    const isSelected = option.value === state.textToImageStyleCategory;

    button.type = "button";
    button.className = "choice-filter";
    button.dataset.selected = String(isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
    button.textContent = option.label;
    button.addEventListener("click", () => {
      state.textToImageStyleCategory = option.value;
      renderStyleCategoryFilters();
      renderStylePresetList();
    });
    elements.styleCategoryFilters.append(button);
  }
}

function renderStylePresetList() {
  if (
    !hasStylePresetSupport(state.mode) ||
    state.mode === "image_to_image" ||
    state.mode === "image_restore"
  ) {
    elements.stylePresetList.replaceChildren();
    elements.stylePresetList.hidden = true;
    return;
  }

  const presets = filteredStylePresets();
  const selectedId = currentStylePresetId();
  elements.stylePresetList.replaceChildren();
  elements.stylePresetList.hidden = state.mode !== "text_to_image" && presets.length === 0;

  if (state.mode === "text_to_image") {
    const smartCard = document.createElement("button");
    const smartMark = document.createElement("span");
    const smartName = document.createElement("strong");
    const smartDescription = document.createElement("small");

    smartCard.type = "button";
    smartCard.className = "style-preset-card style-preset-smart";
    smartCard.dataset.selected = String(selectedId.length === 0);
    smartCard.setAttribute("aria-pressed", String(selectedId.length === 0));
    smartMark.className = "style-preset-smart-mark";
    smartMark.textContent = "✦";
    smartName.textContent = "智能匹配";
    smartDescription.textContent = "让模型根据提示词自动选择风格";
    smartCard.append(smartMark, smartName, smartDescription);
    smartCard.addEventListener("click", () => {
      setCurrentStylePresetId("");
      renderStylePresetList();
      renderCreationSummary();
    });
    elements.stylePresetList.append(smartCard);
  }

  for (const preset of presets) {
    const card = document.createElement("button");
    const image = document.createElement("img");
    const name = document.createElement("strong");
    const category = document.createElement("small");

    card.className = "style-preset-card";
    card.type = "button";
    card.dataset.selected = preset.id === selectedId ? "true" : "false";
    card.setAttribute("aria-pressed", String(preset.id === selectedId));
    image.alt = preset.name;
    image.src = preset.preview_image_url ?? "";
    name.textContent = preset.name;
    category.textContent = resolveStyleCategoryLabel(preset.category);
    card.append(image, name, category);
    card.addEventListener("click", () => {
      setCurrentStylePresetId(preset.id);
      renderStylePresetList();
      renderCreationSummary();
    });
    elements.stylePresetList.append(card);
  }
}

function resolveStyleCategoryLabel(category) {
  const normalizedCategory = String(category).toLowerCase();

  // 用户端统一展示中文分类，避免把数据库中的 anime、portrait 等技术值直接暴露出来。
  return (
    styleCategoryOptions.find(
      (option) => option.value !== "all" && option.categories.includes(normalizedCategory)
    )?.label ?? "其他"
  );
}

function filteredStylePresets() {
  const presets = currentModeStylePresets();
  const selectedCategory = styleCategoryOptions.find(
    (option) => option.value === state.textToImageStyleCategory
  );

  if (state.mode !== "text_to_image" || selectedCategory?.value === "all") {
    return presets;
  }

  return presets.filter((preset) =>
    selectedCategory?.categories.includes(String(preset.category).toLowerCase())
  );
}

function renderCreationSummary() {
  if (state.mode !== "text_to_image") {
    elements.creationSummary.replaceChildren();
    return;
  }

  const selectedPreset = currentModeStylePresets().find(
    (preset) => preset.id === elements.stylePresetSelect.value
  );
  const modelLabel = elements.modelSelect.selectedOptions[0]?.textContent ?? "暂无可用模型";
  const qualityLabel =
    elements.qualitySelect.selectedOptions[0]?.textContent ?? elements.qualitySelect.value;
  const estimatedPoints =
    state.estimate === null
      ? "校验中"
      : `${state.estimate.estimated_points} ${state.estimate.unit}`;

  elements.creationSummary.replaceChildren(
    createCreationSummarySection({
      step: 1,
      title: "提示词",
      value: elements.promptInput.value.trim() || "尚未填写提示词"
    }),
    createCreationSummarySection({
      step: 2,
      title: "风格模板",
      value: selectedPreset?.name ?? "智能匹配"
    }),
    createCreationSummarySection({
      step: 3,
      title: "生成参数",
      value: `${modelLabel} · ${qualityLabel} · ${elements.sizeSelect.value} · ${elements.countSelect.value} 张`
    }),
    createCreationSummarySection({
      step: 3,
      title: "预计积分",
      value: estimatedPoints
    })
  );
}

function renderImageEditSummary() {
  if (state.mode !== "image_to_image") {
    elements.imageEditSummary.replaceChildren();
    return;
  }

  const mode = getImageEditMode(elements.editModeSelect.value);
  const modelLabel = elements.modelSelect.selectedOptions[0]?.textContent ?? "暂无可用模型";
  const qualityLabel = elements.qualitySelect.selectedOptions[0]?.textContent ?? "标准";
  const estimatedPoints =
    state.estimate === null
      ? "校验中"
      : `${state.estimate.estimated_points} ${state.estimate.unit}`;
  const previewUrl = currentInputPreviewUrl();

  elements.imageEditSummary.replaceChildren(
    createImageEditSourceSummary(previewUrl),
    createImageEditSummarySection({
      step: 2,
      title: "编辑模式",
      value: state.imageToImageSmartMode ? `智能匹配 · ${mode.display_name}` : mode.display_name
    }),
    createImageEditSummarySection({
      step: 3,
      title: "修改说明",
      value: elements.promptInput.value.trim() || "尚未填写修改说明"
    }),
    createImageEditSummarySection({
      step: 3,
      title: "生成参数",
      value: `${modelLabel} · ${qualityLabel} · ${elements.sizeSelect.value || "无可用尺寸"} · ${elements.countSelect.value} 张`
    }),
    createImageEditSummarySection({
      step: 3,
      title: "预计积分",
      value: estimatedPoints
    })
  );
}

function renderImageRestoreSummary() {
  if (state.mode !== "image_restore") {
    elements.imageRestoreSummary.replaceChildren();
    return;
  }

  const mode = getImageRestoreMode(state.imageRestoreModeCode);
  const values = state.imageRestoreParameterValues[mode.mode_code];
  const modelLabel = elements.modelSelect.selectedOptions[0]?.textContent ?? "暂无可用模型";
  const estimatedPoints =
    state.estimate === null
      ? "校验中"
      : `${state.estimate.estimated_points} ${state.estimate.unit} · 余额 ${state.estimate.balance_points}`;
  const outputLabel =
    state.imageRestoreOutputPolicy === "keep_original"
      ? `保持原图比例 · ${elements.sizeSelect.value || "尺寸待匹配"}`
      : `适配模型 · ${elements.sizeSelect.value || "无可用尺寸"}`;

  elements.imageRestoreSummary.replaceChildren(
    createImageRestoreSourceSummary(currentInputPreviewUrl()),
    createImageRestoreSummarySection({
      step: 2,
      title: "修复方式",
      value: `${mode.display_name}${mode.requires_annotation ? " · 已启用区域标注" : ""}`
    }),
    createImageRestoreSummarySection({
      step: 3,
      title: "修复参数",
      value: summarizeImageRestoreParameters(mode, values)
    }),
    createImageRestoreSummarySection({
      step: 3,
      title: "补充说明",
      value: elements.promptInput.value.trim() || "未填写，按推荐参数自动修复"
    }),
    createImageRestoreSummarySection({
      step: 3,
      title: "模型与输出",
      value: `${modelLabel} · ${outputLabel} · ${elements.countSelect.value} 张`
    }),
    createImageRestoreSummarySection({
      step: 3,
      title: "预计积分",
      value: estimatedPoints
    })
  );
}

function summarizeImageRestoreParameters(mode, values) {
  return mode.parameter_schema
    .map((parameter) => {
      const value = values[parameter.key];
      const optionLabel = parameter.options?.find((option) => option.value === value)?.label;
      const displayValue =
        parameter.type === "toggle" ? (value ? "开启" : "关闭") : (optionLabel ?? String(value));
      return `${parameter.label} ${displayValue}${parameter.unit ?? ""}`;
    })
    .join(" · ");
}

function createImageRestoreSourceSummary(previewUrl) {
  const section = document.createElement("section");
  const preview = document.createElement("img");
  const copy = document.createElement("div");
  const heading = document.createElement("strong");
  const content = document.createElement("p");

  section.className = "creation-summary-section image-edit-source-summary";
  preview.alt = "待修复原图缩略图";
  if (previewUrl !== null) preview.src = previewUrl;
  heading.textContent = "待修复原图";
  content.textContent = formatImageUploadMeta(state.imageToImageUploadMeta) || "历史作品原图";
  copy.append(heading, content);
  section.append(preview, copy, createImageRestoreSummaryButton(1, "修改待修复原图"));
  return section;
}

function createImageRestoreSummarySection({ step, title, value }) {
  const section = document.createElement("section");
  const copy = document.createElement("div");
  const heading = document.createElement("strong");
  const content = document.createElement("p");
  section.className = "creation-summary-section";
  heading.textContent = title;
  content.textContent = value;
  copy.append(heading, content);
  section.append(copy, createImageRestoreSummaryButton(step, `修改${title}`));
  return section;
}

function createImageRestoreSummaryButton(step, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "summary-edit-button";
  button.textContent = "✎";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.addEventListener("click", () => goToImageRestoreStep(step));
  return button;
}

function createImageEditSourceSummary(previewUrl) {
  const section = document.createElement("section");
  const preview = document.createElement("img");
  const copy = document.createElement("div");
  const heading = document.createElement("strong");
  const content = document.createElement("p");
  const editButton = createImageEditSummaryButton(1, "修改输入图片");

  section.className = "creation-summary-section image-edit-source-summary";
  preview.alt = "输入原图缩略图";
  if (previewUrl !== null) {
    preview.src = previewUrl;
  }
  heading.textContent = "输入图片";
  content.textContent = formatImageUploadMeta(state.imageToImageUploadMeta) || "历史作品原图";
  copy.append(heading, content);
  section.append(preview, copy, editButton);

  return section;
}

function createImageEditSummarySection({ step, title, value }) {
  const section = document.createElement("section");
  const copy = document.createElement("div");
  const heading = document.createElement("strong");
  const content = document.createElement("p");

  section.className = "creation-summary-section";
  heading.textContent = title;
  content.textContent = value;
  copy.append(heading, content);
  const editLabel = title === "修改说明" ? "修改图片说明" : `修改${title}`;
  section.append(copy, createImageEditSummaryButton(step, editLabel));

  return section;
}

function createImageEditSummaryButton(step, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "summary-edit-button";
  button.textContent = "✎";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.addEventListener("click", () => goToImageToImageStep(step));

  return button;
}

function createCreationSummarySection({ step, title, value }) {
  const section = document.createElement("section");
  const copy = document.createElement("div");
  const heading = document.createElement("strong");
  const content = document.createElement("p");
  const editButton = document.createElement("button");

  section.className = "creation-summary-section";
  heading.textContent = title;
  content.textContent = value;
  copy.append(heading, content);
  editButton.type = "button";
  editButton.className = "summary-edit-button";
  editButton.textContent = "✎";
  editButton.setAttribute("aria-label", `修改${title}`);
  editButton.title = `修改${title}`;
  editButton.addEventListener("click", () => goToTextToImageStep(step));
  section.append(copy, editButton);

  return section;
}

function currentModeStylePresets() {
  return state.stylePresets.filter((preset) => preset.task_type === state.mode);
}

function resolveImageEditStylePresetId(modeCode) {
  return state.stylePresets.some(
    (preset) => preset.task_type === "image_to_image" && preset.id === modeCode
  )
    ? modeCode
    : undefined;
}

function currentStylePresetId() {
  if (state.mode === "image_to_image") return elements.editModeSelect.value;
  if (state.mode === "image_restore") return elements.restoreTypeSelect.value;
  return elements.stylePresetSelect.value;
}

function setCurrentStylePresetId(presetId) {
  if (state.mode === "image_to_image") {
    elements.editModeSelect.value = presetId;
    return;
  }

  if (state.mode === "image_restore") {
    elements.restoreTypeSelect.value = presetId;
    return;
  }

  elements.stylePresetSelect.value = presetId;
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
    item.querySelector("span").textContent = resolveModelCapabilityLabel(model.capability);
    item.querySelector("small").textContent = model.description;
    elements.modelList.append(item);
  }
}

async function refreshHistory(options = {}) {
  if (elements.historyList === null) {
    return;
  }

  if (state.isHistoryLoading) {
    return;
  }

  const append = options.append === true;
  const page = append ? state.historyPage + 1 : 1;
  state.isHistoryLoading = true;
  syncHistoryLoadMore();

  try {
    const history = await getImageHistory(state.mode, page, state.historyPageSize);
    renderHistory(history.items ?? [], append);
    state.historyPage = page;
    state.historyTotal = Number(history.total ?? 0);
  } catch (error) {
    if (append) {
      showError(error instanceof Error ? error.message : "更多历史作品加载失败，请稍后重试。");
    } else {
      renderHistoryLoadError(error);
      state.historyPage = 0;
      state.historyTotal = 0;
    }
  } finally {
    state.isHistoryLoading = false;
    syncHistoryLoadMore();
  }
}

function syncHistoryLoadMore() {
  const loadedCount = elements.historyList.querySelectorAll(".history-item").length;
  const hasMore = loadedCount < state.historyTotal;

  elements.historyLoadMore.hidden = !hasMore && !state.isHistoryLoading;
  elements.historyLoadMore.disabled = state.isHistoryLoading;
  elements.historyLoadMore.textContent = state.isHistoryLoading ? "加载中" : "加载更多";
}

function renderHistoryLoadError(error) {
  elements.historyList.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty-text";
  empty.textContent =
    error instanceof Error ? `历史加载失败：${error.message}` : "历史加载失败，请稍后重试。";
  elements.historyList.append(empty);
}

function renderHistory(items, append = false) {
  if (!append) {
    elements.historyList.replaceChildren();
  }

  if (items.length === 0 && !append) {
    const empty = document.createElement("p");
    empty.className = "empty-text";
    empty.textContent = "暂无历史作品。";
    elements.historyList.append(empty);
    return;
  }

  // 历史卡片按接口分页结果完整追加，不能再截取前六条，否则较早作品永远无法访问。
  for (const task of items) {
    const item = document.createElement("article");
    item.className = "history-item";
    const title = document.createElement("strong");
    const meta = document.createElement("small");
    const actions = document.createElement("details");
    const actionTrigger = document.createElement("summary");
    const actionMenu = document.createElement("div");

    const hasTextResult = task.text_result !== null && task.text_result.length > 0;

    title.textContent = hasTextResult
      ? "图片解析结果"
      : `${formatTaskType(task.task_type)} · ${String(task.output_file_ids.length)} 张`;
    meta.textContent = formatDateTime(task.created_at);
    actions.className = "history-actions";
    actionTrigger.className = "history-actions-trigger";
    actionTrigger.setAttribute("aria-label", "作品操作");
    actionTrigger.title = "作品操作";
    actionTrigger.textContent = "⋯";
    actionMenu.className = "history-action-menu";
    actionMenu.setAttribute("role", "menu");
    actions.append(actionTrigger, actionMenu);
    item.classList.toggle("is-text-result", hasTextResult);

    if (hasTextResult) {
      const excerpt = document.createElement("p");
      const footer = document.createElement("div");
      const openButton = document.createElement("button");

      excerpt.className = "history-text-excerpt";
      excerpt.textContent = summarizeTextResult(task.text_result);
      footer.className = "history-text-footer";
      openButton.type = "button";
      openButton.className = "history-text-open";
      openButton.textContent = "查看全文";
      openButton.addEventListener("click", () => {
        void openTaskDetail(task.id);
      });
      footer.append(meta, openButton);
      item.append(title, excerpt, footer);
    } else {
      item.append(title, meta);
    }

    const files = task.result_files ?? [];

    if (files.length > 0) {
      const imageGrid = document.createElement("div");
      imageGrid.className = "history-image-grid";

      for (const file of files) {
        const imageItem = document.createElement("div");
        const previewButton = document.createElement("button");
        const image = document.createElement("img");
        const previewHint = document.createElement("span");
        const reeditButton = document.createElement("button");
        const useSourceButton = document.createElement("button");

        imageItem.className = "history-image-item";
        previewButton.type = "button";
        previewButton.className = "history-preview-button";
        previewButton.setAttribute("aria-label", "在线查看图片详情");
        previewButton.title = "在线查看图片详情";
        image.alt = "历史图片结果";
        image.src = file.preview_url;
        previewHint.className = "history-preview-hint";
        previewHint.textContent = "查看详情";
        previewButton.append(image, previewHint);
        previewButton.addEventListener("click", () => {
          // 历史缩略图只负责打开在线预览，下载动作统一放到详情中，避免误触后直接下载。
          void openTaskDetail(task.id, file.file.id);
        });
        reeditButton.type = "button";
        reeditButton.className = "ghost-button history-reedit-button";
        reeditButton.textContent = "再次编辑";
        reeditButton.addEventListener("click", () => {
          void openAnnotationEditor(task, file);
        });
        useSourceButton.type = "button";
        useSourceButton.className = "ghost-button history-use-source-button";
        useSourceButton.textContent = "用作原图";
        useSourceButton.hidden = state.mode !== "image_to_image" && state.mode !== "image_restore";
        useSourceButton.addEventListener("click", () => {
          selectHistoryImageSource(task, file);
        });
        imageItem.append(previewButton, useSourceButton, reeditButton);
        imageGrid.append(imageItem);
      }

      item.append(imageGrid);
    }

    if (task.text_result !== null && task.text_result.length > 0) {
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "ghost-button copy-button history-menu-action";
      copyButton.dataset.action = "copy";
      copyButton.setAttribute("role", "menuitem");
      copyButton.textContent = "复制";
      copyButton.addEventListener("click", async () => {
        await copyTextToClipboard(task.text_result, copyButton);
      });
      actionMenu.append(copyButton);
    }

    const favoriteButton = document.createElement("button");
    favoriteButton.type = "button";
    favoriteButton.className = "ghost-button copy-button history-menu-action";
    favoriteButton.dataset.action = "favorite";
    favoriteButton.setAttribute("role", "menuitem");
    favoriteButton.textContent = task.is_favorited ? "已收藏" : "收藏";
    favoriteButton.disabled = task.is_favorited === true;
    favoriteButton.addEventListener("click", async () => {
      await runHistoryAction(favoriteButton, "收藏中", async () => {
        await favoriteHistoryItem(task.id);
        await refreshHistory();
      });
    });
    actionMenu.append(favoriteButton);

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "ghost-button danger-button history-menu-action";
    deleteButton.dataset.action = "delete";
    deleteButton.setAttribute("role", "menuitem");
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
    actionMenu.append(deleteButton);

    actionMenu.prepend(createTaskDetailButton(task.id));

    item.append(actions);

    elements.historyList.append(item);
  }
}

function createTaskDetailButton(taskId) {
  const button = document.createElement("button");

  button.type = "button";
  button.className = "ghost-button history-menu-action";
  button.dataset.action = "detail";
  button.setAttribute("role", "menuitem");
  button.textContent = "查看详情";
  button.addEventListener("click", () => {
    void openTaskDetail(taskId);
  });

  return button;
}

async function openTaskDetail(taskId, focusedFileId = null) {
  clearError();
  elements.taskDetailTitle.textContent = focusedFileId === null ? "任务详情" : "作品详情";
  elements.taskDetailContent.replaceChildren(createDetailLoadingState());
  elements.taskDetailBackdrop.hidden = false;
  elements.taskDetailDrawer.hidden = false;
  document.body.classList.add("is-detail-open");
  elements.taskDetailClose.focus();

  try {
    // 详情必须重新按当前 session 查询，不能直接信任历史卡片缓存中的用户或文件数据。
    const detail = await getImageTask(taskId);
    renderTaskDetail(detail, focusedFileId);
  } catch (error) {
    const message = document.createElement("p");

    message.className = "task-detail-error";
    message.textContent = error instanceof Error ? error.message : "任务详情加载失败。";
    elements.taskDetailContent.replaceChildren(message);
  }
}

function closeTaskDetail() {
  elements.taskDetailBackdrop.hidden = true;
  elements.taskDetailDrawer.hidden = true;
  document.body.classList.remove("is-detail-open");
}

function createDetailLoadingState() {
  const loading = document.createElement("p");

  loading.className = "empty-text";
  loading.textContent = "任务详情加载中...";

  return loading;
}

function renderTaskDetail(detail, focusedFileId = null) {
  const task = detail.task;
  const summary = document.createElement("section");
  const summaryGrid = document.createElement("div");

  summary.className = "task-detail-section task-detail-summary";
  summaryGrid.className = "task-detail-grid task-detail-summary-grid";
  summary.append(createDetailHeading("作品信息"), summaryGrid);
  appendDetailValue(summaryGrid, "任务编号", formatTaskIdentifier(task.id), false, task.id);
  appendDetailValue(summaryGrid, "任务类型", formatTaskType(task.task_type));
  appendDetailValue(summaryGrid, "当前状态", formatTaskStatus(task.status));
  appendDetailValue(summaryGrid, "消耗积分", formatTaskPoints(task));
  appendDetailValue(summaryGrid, "创建时间", formatDateTime(task.created_at));
  appendDetailValue(summaryGrid, "更新时间", formatDateTime(task.updated_at));

  const parameters = document.createElement("section");
  const parameterGrid = document.createElement("div");

  parameters.className = "task-detail-section";
  parameterGrid.className = "task-detail-grid";
  parameters.append(createDetailHeading("输入参数"), parameterGrid);
  appendDetailValue(parameterGrid, "提示词", task.prompt ?? "未填写", true);
  appendDetailValue(parameterGrid, "反向提示词", task.negative_prompt ?? "未填写", true);
  appendDetailValue(parameterGrid, "风格 / 操作", task.style_preset_id ?? "默认");
  appendDetailValue(
    parameterGrid,
    "模型",
    resolveModelDisplayName(
      state.models,
      task.gateway_model_code,
      task.gateway_capability,
      task.task_type
    )
  );
  appendDetailValue(parameterGrid, "质量档位", task.quality ?? "默认");
  appendDetailValue(parameterGrid, "尺寸", task.image_size ?? "由原图决定");
  appendDetailValue(parameterGrid, "数量", String(task.image_count));
  appendDetailValue(
    parameterGrid,
    "高清倍率",
    task.upscale_factor === null ? "不适用" : `${String(task.upscale_factor)}x`
  );

  const inputFiles = createDetailFilesSection("输入文件", detail.input_files ?? [], "输入图片");
  const outputResults = createOutputResultsSection(detail, focusedFileId);
  const statusSection = createStatusDetailSection(task);

  if (focusedFileId !== null) {
    // 从作品缩略图进入时先展示图片本身，任务参数下沉为补充信息，符合在线查看的操作预期。
    const focusedSections = [outputResults, summary, parameters];

    // 成功作品不展示空文件和重复的错误状态，只在确有输入或异常时补充对应区域。
    if ((detail.input_files ?? []).length > 0) {
      focusedSections.push(inputFiles);
    }
    if (task.status === "failed" || task.status === "billing_pending") {
      focusedSections.push(statusSection);
    }

    elements.taskDetailContent.replaceChildren(...focusedSections);
    return;
  }

  elements.taskDetailContent.replaceChildren(
    summary,
    parameters,
    inputFiles,
    outputResults,
    statusSection
  );
}

function createDetailHeading(text) {
  const heading = document.createElement("h3");

  heading.textContent = text;
  return heading;
}

function appendDetailValue(grid, label, value, fullWidth = false, fullValue = null) {
  const item = document.createElement("div");
  const term = document.createElement("span");
  const description = document.createElement("strong");

  item.className = "task-detail-value";
  item.classList.toggle("is-wide", fullWidth);
  term.textContent = label;
  description.textContent = value;
  if (fullValue !== null) {
    description.title = fullValue;
  }
  item.append(term, description);
  grid.append(item);
}

function formatTaskIdentifier(taskId) {
  if (taskId.length <= 24) {
    return taskId;
  }

  return `${taskId.slice(0, 13)}...${taskId.slice(-8)}`;
}

function createDetailFilesSection(title, files, imageAlt, focusedFileId = null) {
  const section = document.createElement("section");
  const grid = document.createElement("div");
  const sortedFiles = [...files].sort((left, right) => {
    // 被用户点击的作品排在首位，详情打开后无需在多张结果中再次寻找。
    return Number(right.file.id === focusedFileId) - Number(left.file.id === focusedFileId);
  });

  section.className = "task-detail-section";
  section.classList.toggle("is-preview-section", focusedFileId !== null);
  grid.className = "task-detail-files";
  grid.classList.toggle("has-focused-file", focusedFileId !== null);
  section.append(createDetailHeading(title));

  if (sortedFiles.length === 0) {
    grid.append(createDetailEmptyText("无文件"));
  } else {
    for (const file of sortedFiles) {
      grid.append(createDetailFileCard(file, imageAlt, file.file.id === focusedFileId));
    }
  }

  section.append(grid);
  return section;
}

function createDetailFileCard(file, imageAlt, isFocused = false) {
  const card = document.createElement("article");
  const image = document.createElement("img");
  const name = document.createElement("strong");
  const meta = document.createElement("small");
  const footer = document.createElement("div");
  const fileInfo = document.createElement("div");
  const actions = document.createElement("div");
  const openPreview = document.createElement("a");
  const download = document.createElement("a");

  card.className = "task-detail-file";
  card.classList.toggle("is-focused", isFocused);
  image.alt = imageAlt;
  image.src = file.preview_url;
  name.textContent = isFocused ? "生成图片" : (file.file.original_name ?? file.file.id);
  name.title = file.file.original_name ?? file.file.id;
  meta.textContent = formatFileMeta(file.file);
  footer.className = "task-detail-file-footer";
  fileInfo.className = "task-detail-file-info";
  actions.className = "task-detail-file-actions";
  openPreview.href = file.preview_url;
  openPreview.target = "_blank";
  openPreview.rel = "noreferrer";
  openPreview.className = "task-detail-open-preview";
  openPreview.textContent = "全屏查看";
  download.href = file.download_url;
  download.target = "_blank";
  download.rel = "noreferrer";
  download.className = "task-detail-download";
  download.textContent = "下载原图";
  actions.append(openPreview, download);
  fileInfo.append(name, meta);
  footer.append(fileInfo, actions);
  card.append(image, footer);

  return card;
}

function createOutputResultsSection(detail, focusedFileId = null) {
  const section = createDetailFilesSection(
    focusedFileId === null ? "输出结果" : "在线预览",
    detail.result_files ?? [],
    "任务输出图片",
    focusedFileId
  );
  const textResult = detail.task.text_result;

  if (textResult !== null && textResult.length > 0) {
    const text = document.createElement("pre");

    section.classList.add("has-text-result");
    section.querySelector("h3").textContent = "识别结果";
    section.querySelector(".task-detail-files").remove();
    text.className = "task-detail-text-result";
    text.textContent = textResult;
    section.append(text);
  }

  if (
    (detail.result_files ?? []).length === 0 &&
    (textResult === null || textResult.length === 0)
  ) {
    section
      .querySelector(".task-detail-files")
      .replaceChildren(createDetailEmptyText("暂无输出结果"));
  }

  return section;
}

function createStatusDetailSection(task) {
  const section = document.createElement("section");
  const grid = document.createElement("div");

  section.className = "task-detail-section";
  grid.className = "task-detail-grid";
  section.append(createDetailHeading("状态和错误信息"), grid);
  appendDetailValue(grid, "状态", formatTaskStatus(task.status));
  appendDetailValue(grid, "错误码", task.error_code ?? "无");
  appendDetailValue(
    grid,
    "失败原因",
    task.status === "failed" || task.status === "billing_pending"
      ? resolveTaskFailureMessage(task)
      : "无",
    true
  );

  return section;
}

function createDetailEmptyText(text) {
  const empty = document.createElement("p");

  empty.className = "empty-text";
  empty.textContent = text;
  return empty;
}

function formatDateTime(value) {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function formatFileMeta(file) {
  const dimensions =
    file.width === null || file.height === null
      ? "尺寸未知"
      : `${String(file.width)} x ${String(file.height)}`;
  const size = `${(file.size_bytes / 1024).toFixed(1)} KB`;

  return `${dimensions} · ${size}`;
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
  const isInteractiveImageMode = state.mode === "image_to_image" || state.mode === "image_restore";
  const hasImage = hasCurrentImageInput();
  elements.imageToImageUploadActions.hidden = !isInteractiveImageMode;
  elements.replaceImageButton.hidden = !isInteractiveImageMode || !hasImage;
  elements.removeImageButton.hidden = !isInteractiveImageMode || !hasImage;
  elements.chooseHistoryImageButton.hidden = !isInteractiveImageMode;

  if (state.isValidatingImage && isInteractiveImageMode) {
    elements.uploadHint.textContent = "正在读取图片尺寸和格式...";
    elements.imageUploadTitle.textContent = "正在校验图片";
    elements.imageUploadDescription.textContent = "请稍候，校验完成后即可继续";
    elements.imageUploadField.dataset.state = "validating";
    elements.referencePreview.hidden = true;
    syncImageToImageWorkflowControls();
    syncImageRestoreWorkflowControls();
    return;
  }

  if (state.imageToImageUploadError !== null && isInteractiveImageMode) {
    elements.uploadHint.textContent = state.imageToImageUploadError;
    elements.imageUploadTitle.textContent = "图片不可用";
    elements.imageUploadDescription.textContent = "点击重新选择符合要求的图片";
    elements.imageUploadField.dataset.state = "error";
    elements.referencePreview.hidden = true;
    elements.referencePreviewImage.removeAttribute("src");
    elements.referencePreviewMeta.textContent = "";
    syncImageToImageWorkflowControls();
    syncImageRestoreWorkflowControls();
    return;
  }

  if (state.annotatedInputFile !== null && isInteractiveImageMode) {
    elements.uploadHint.textContent = `已带入标注图 ${state.annotatedInputFile.name}，重新选择文件将取消标注。`;
    elements.imageUploadTitle.textContent = "标注图片已就绪";
    elements.imageUploadDescription.textContent = "点击可重新选择图片";
    elements.imageUploadField.dataset.state = "selected";
    elements.referencePreview.hidden = false;
    elements.referencePreviewImage.src = state.annotatedPreviewUrl ?? "";
    elements.referencePreviewText.textContent = state.annotatedInputFile.name;
    elements.referencePreviewMeta.textContent = formatImageUploadMeta(state.imageToImageUploadMeta);
    renderImageEditModeCards();
    renderImageEditSummary();
    renderImageRestoreModeCards();
    renderImageRestoreSummary();
    return;
  }

  if (state.referenceFileId !== null && isInteractiveImageMode) {
    elements.uploadHint.textContent = `已从任务 ${state.sourceTaskId ?? "未知"} 自动带入结果图。`;
    elements.imageUploadTitle.textContent = "历史图片已就绪";
    elements.imageUploadDescription.textContent = "点击可替换当前图片";
    elements.imageUploadField.dataset.state = "selected";
    elements.referencePreview.hidden = false;
    elements.referencePreviewImage.src = state.referencePreviewUrl ?? "";
    elements.referencePreviewText.textContent = "已自动带入历史结果图";
    elements.referencePreviewMeta.textContent = formatImageUploadMeta(state.imageToImageUploadMeta);
    renderImageEditModeCards();
    renderImageEditSummary();
    renderImageRestoreModeCards();
    renderImageRestoreSummary();
    return;
  }

  const localFile = elements.imageInput.files?.[0];

  if (localFile !== undefined) {
    state.localPreviewUrl ??= URL.createObjectURL(localFile);
    elements.uploadHint.textContent = "图片格式与大小将在提交时校验。";
    elements.imageUploadTitle.textContent = "图片已就绪";
    elements.imageUploadDescription.textContent = "点击或拖入新图片即可替换";
    elements.imageUploadField.dataset.state = "selected";
    elements.referencePreview.hidden = false;
    elements.referencePreviewImage.src = state.localPreviewUrl;
    elements.referencePreviewText.textContent = localFile.name;
    elements.referencePreviewMeta.textContent = formatImageUploadMeta(state.imageToImageUploadMeta);
    renderImageEditModeCards();
    renderImageEditSummary();
    renderImageRestoreModeCards();
    renderImageRestoreSummary();
    return;
  }

  revokeLocalPreviewUrl();
  elements.uploadHint.textContent = "支持 png、jpeg、webp、gif，最大 10MB。";
  elements.imageUploadTitle.textContent = "选择图片";
  elements.imageUploadDescription.textContent = "点击浏览或将图片拖到这里";
  elements.imageUploadField.dataset.state = "empty";
  elements.referencePreview.hidden = true;
  elements.referencePreviewImage.removeAttribute("src");
  elements.referencePreviewMeta.textContent = "";
  renderImageEditSummary();
  renderImageRestoreSummary();
}

async function inspectSelectedImage() {
  const file = elements.imageInput.files?.[0];

  state.imageToImageUploadError = null;
  state.imageToImageUploadMeta = null;
  if (file === undefined) {
    renderUploadHint();
    renderImageToImageWorkflow();
    renderImageRestoreWorkflow();
    return;
  }

  state.isValidatingImage = true;
  renderUploadHint();

  try {
    if (!new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]).has(file.type)) {
      throw new Error("仅支持 PNG、JPEG、WebP 或 GIF 图片。");
    }

    if (file.size > 10 * 1024 * 1024) {
      throw new Error("图片不能超过 10MB，请压缩后重新上传。");
    }

    revokeLocalPreviewUrl();
    state.localPreviewUrl = URL.createObjectURL(file);
    const dimensions = await readImageDimensions(state.localPreviewUrl);
    state.imageToImageUploadMeta = {
      name: file.name,
      mimeType: file.type,
      size: file.size,
      width: dimensions.width,
      height: dimensions.height
    };
    if (state.mode === "image_restore" && state.imageRestoreOutputPolicy === "keep_original") {
      selectClosestRestoreSize();
    }
  } catch (error) {
    state.imageToImageUploadError =
      error instanceof Error ? error.message : "图片校验失败，请重新选择。";
  } finally {
    state.isValidatingImage = false;
    renderUploadHint();
    renderImageToImageWorkflow();
    renderImageRestoreWorkflow();
  }
}

async function readImageDimensions(url) {
  const image = new Image();
  image.src = url;

  try {
    await image.decode();
  } catch {
    throw new Error("无法读取图片内容，请检查文件是否损坏。");
  }

  return { width: image.naturalWidth, height: image.naturalHeight };
}

function formatImageUploadMeta(meta) {
  if (meta === null) {
    return "";
  }

  const dimensions =
    meta.width !== null && meta.height !== null
      ? `${String(meta.width)} × ${String(meta.height)}`
      : "尺寸未知";
  const type = meta.mimeType?.replace("image/", "").toUpperCase() ?? "图片";
  return `${type} · ${dimensions} · ${formatFileSize(meta.size)}`;
}

function formatFileSize(size) {
  if (!Number.isFinite(size) || size <= 0) {
    return "大小未知";
  }

  return size >= 1024 * 1024
    ? `${(size / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(size / 1024))} KB`;
}

function hasCurrentImageInput() {
  return (
    state.imageToImageUploadError === null &&
    !state.isValidatingImage &&
    (state.annotatedInputFile !== null ||
      elements.imageInput.files?.[0] !== undefined ||
      state.referenceFileId !== null)
  );
}

function currentInputPreviewUrl() {
  if (state.annotatedPreviewUrl !== null) {
    return state.annotatedPreviewUrl;
  }

  if (state.referencePreviewUrl !== null) {
    return state.referencePreviewUrl;
  }

  return state.localPreviewUrl;
}

function clearCurrentImageInput() {
  clearReeditSource();
  revokeLocalPreviewUrl();
  elements.imageInput.value = "";
  state.imageToImageUploadMeta = null;
  state.imageToImageUploadError = null;
  state.imageToImageStep = 1;
  state.imageToImageCompletedStep = 0;
  state.imageRestoreStep = 1;
  state.imageRestoreCompletedStep = 0;
  state.imageRestoreAnnotationApplied = false;
  renderUploadHint();
  renderImageToImageWorkflow();
  renderImageRestoreWorkflow();
}

function revokeLocalPreviewUrl() {
  if (state.localPreviewUrl === null) {
    return;
  }

  URL.revokeObjectURL(state.localPreviewUrl);
  state.localPreviewUrl = null;
}

async function openAnnotationEditor(task, file) {
  clearAnnotationError();
  state.annotationSourceTask = task;
  state.annotationSourceFile = file;
  state.annotationPurpose = "history";
  elements.annotationTitle.textContent = "标注后再次编辑";
  elements.annotationPrompt.value = task.prompt ?? "";
  elements.annotationLoading.hidden = false;
  elements.annotationApply.disabled = true;
  elements.annotationBackdrop.hidden = false;
  elements.annotationEditor.hidden = false;
  document.body.classList.add("is-annotation-open");
  elements.annotationClose.focus();

  try {
    // 通过受权限保护的预览地址读取图片，画布不会绕过后端访问对象存储。
    await annotationEditor.loadImage(file.preview_url);
    elements.annotationLoading.hidden = true;
    elements.annotationApply.disabled = false;
  } catch (error) {
    showAnnotationError(error instanceof Error ? error.message : "标注画布加载失败。");
  }
}

function closeAnnotationEditor() {
  elements.annotationBackdrop.hidden = true;
  elements.annotationEditor.hidden = true;
  document.body.classList.remove("is-annotation-open");
  state.annotationSourceTask = null;
  state.annotationSourceFile = null;
  state.annotationPurpose = null;
  clearAnnotationError();
}

async function openCurrentImageMaskEditor() {
  const previewUrl = currentInputPreviewUrl();

  if (previewUrl === null) {
    showError("请先上传一张原图，再打开局部标注画布。");
    return;
  }

  clearAnnotationError();
  state.annotationPurpose = "local";
  state.annotationSourceTask = { id: "local-image", prompt: elements.promptInput.value };
  state.annotationSourceFile = { file: { id: "local-image" }, preview_url: previewUrl };
  elements.annotationTitle.textContent = "局部重绘标注";
  elements.annotationPrompt.value = elements.promptInput.value;
  elements.annotationLoading.hidden = false;
  elements.annotationApply.disabled = true;
  elements.annotationBackdrop.hidden = false;
  elements.annotationEditor.hidden = false;
  document.body.classList.add("is-annotation-open");
  elements.annotationClose.focus();

  try {
    await annotationEditor.loadImage(previewUrl);
    elements.annotationLoading.hidden = true;
    elements.annotationApply.disabled = false;
  } catch (error) {
    showAnnotationError(error instanceof Error ? error.message : "标注画布加载失败。");
  }
}

async function openCurrentRestoreMaskEditor() {
  const previewUrl = currentInputPreviewUrl();
  const mode = getImageRestoreMode(state.imageRestoreModeCode);

  if (previewUrl === null) {
    showError("请先上传一张原图，再标注需要修复的区域。");
    return;
  }

  clearAnnotationError();
  state.annotationPurpose = "restore";
  state.annotationSourceTask = { id: "restore-image", prompt: elements.promptInput.value };
  state.annotationSourceFile = { file: { id: "restore-image" }, preview_url: previewUrl };
  elements.annotationTitle.textContent =
    mode.mode_code === "remove_object" ? "标注需要去除的元素" : "标注需要修复的区域";
  elements.annotationPrompt.value = elements.promptInput.value;
  elements.annotationPrompt.placeholder =
    mode.mode_code === "remove_object"
      ? "说明标注中的物体或文字需要如何移除和补全"
      : "说明标注区域的破损、模糊或细节修复目标";
  elements.annotationLoading.hidden = false;
  elements.annotationApply.disabled = true;
  elements.annotationBackdrop.hidden = false;
  elements.annotationEditor.hidden = false;
  document.body.classList.add("is-annotation-open");
  elements.annotationClose.focus();

  try {
    await annotationEditor.loadImage(previewUrl);
    elements.annotationLoading.hidden = true;
    elements.annotationApply.disabled = false;
  } catch (error) {
    showAnnotationError(error instanceof Error ? error.message : "标注画布加载失败。");
  }
}

async function applyAnnotationForReedit() {
  clearAnnotationError();
  const task = state.annotationSourceTask;
  const file = state.annotationSourceFile;
  const description = elements.annotationPrompt.value.trim();
  const annotationPurpose = state.annotationPurpose;

  if (task === null || file === null) {
    showAnnotationError("来源作品已失效，请关闭画布后重新选择再次编辑。");
    return;
  }

  if (!annotationEditor.hasAnnotations()) {
    showAnnotationError("请先在图片上添加画笔、方框或编号标注。");
    return;
  }

  if (description.length === 0) {
    showAnnotationError("请填写修改说明，让模型理解每个标注区域的修改目标。");
    elements.annotationPrompt.focus();
    return;
  }

  elements.annotationApply.disabled = true;
  elements.annotationApply.textContent = "正在生成标注图";

  try {
    const blob = await annotationEditor.exportPngBlob();

    clearAnnotatedInputFile();
    state.annotatedInputFile = new File([blob], `annotation-${task.id}-${String(Date.now())}.png`, {
      type: "image/png"
    });
    state.annotatedPreviewUrl = URL.createObjectURL(blob);

    // 明确告诉模型标注仅用于定位，避免把线条、方框和编号绘制到最终成品中。
    const annotationPrompt = `请根据参考图中的彩色标注编辑图片：${description}。彩色线条、方框和编号仅用于定位，生成结果中不要保留任何标注。`;

    if (annotationPurpose === "local") {
      elements.promptInput.value = annotationPrompt;
      state.imageToImageUploadError = null;
      syncPromptInputState();
      renderUploadHint();
      renderImageEditSummary();
      closeAnnotationEditor();
      return;
    }

    if (annotationPurpose === "restore") {
      elements.promptInput.value = annotationPrompt;
      state.imageRestoreAnnotationApplied = true;
      state.imageToImageUploadError = null;
      syncPromptInputState();
      renderUploadHint();
      renderImageRestoreParameterChoices();
      renderImageRestoreSummary();
      syncImageRestoreWorkflowControls();
      closeAnnotationEditor();
      return;
    }

    prepareReeditTask(task, file, annotationPrompt);
    closeAnnotationEditor();
  } catch (error) {
    showAnnotationError(error instanceof Error ? error.message : "标注图片导出失败，请重试。");
  } finally {
    elements.annotationApply.disabled = false;
    elements.annotationApply.textContent = "使用标注继续编辑";
  }
}

function selectHistoryImageSource(task, file) {
  clearAnnotatedInputFile();
  revokeLocalPreviewUrl();
  elements.imageInput.value = "";
  state.referenceFileId = file.file.id;
  state.referencePreviewUrl = file.preview_url;
  state.sourceTaskId = task.id;
  state.sourceFileId = file.file.id;
  state.imageToImageUploadError = null;
  state.imageToImageUploadMeta = {
    name: file.file.original_name ?? "历史作品",
    mimeType: file.file.mime_type ?? "image/png",
    size: Number(file.file.size_bytes ?? 0),
    width: file.file.width ?? null,
    height: file.file.height ?? null
  };
  if (state.mode === "image_restore") {
    state.imageRestoreStep = 2;
    state.imageRestoreCompletedStep = Math.max(1, state.imageRestoreCompletedStep);
    state.imageRestoreAnnotationApplied = false;
  } else {
    state.imageToImageStep = 2;
    state.imageToImageCompletedStep = Math.max(1, state.imageToImageCompletedStep);
  }
  document.querySelector(".history-panel")?.classList.remove("is-selecting-source");
  renderUploadHint();
  renderImageToImageWorkflow();
  renderImageRestoreWorkflow();
  const activeSteps =
    state.mode === "image_restore" ? elements.imageRestoreSteps : elements.imageToImageSteps;
  activeSteps.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function prepareReeditTask(task, file, prompt) {
  // 从文生图历史进入再次编辑前保存草稿，返回文生图时仍可恢复四步进度。
  if (state.mode === "text_to_image") {
    captureTextToImageDraft();
  }

  state.mode = "image_to_image";
  state.referenceFileId = file.file.id;
  state.referencePreviewUrl = file.preview_url;
  state.sourceTaskId = task.id;
  state.sourceFileId = file.file.id;
  state.imageToImageUploadMeta = {
    name: file.file.original_name ?? "历史作品",
    mimeType: file.file.mime_type ?? "image/png",
    size: Number(file.file.size_bytes ?? 0),
    width: file.file.width ?? null,
    height: file.file.height ?? null
  };
  state.imageToImageUploadError = null;
  state.imageToImageStep = 3;
  state.imageToImageCompletedStep = 2;
  elements.imageInput.value = "";
  elements.resultList.replaceChildren();
  elements.promptInput.value = prompt;
  renderMode();
  renderModelOptions();
  renderStylePresetOptions();
  elements.editModeSelect.value = "keep_subject";
  elements.sizeSelect.value = "1024x1024";
  elements.countSelect.value = "1";
  setSelectValueIfAvailable(elements.editModeSelect, task.style_preset_id);
  setSelectValueIfAvailable(elements.modelSelect, task.gateway_model_code);
  renderImageSizeOptions();
  setSelectValueIfAvailable(elements.sizeSelect, task.image_size);
  setSelectValueIfAvailable(elements.countSelect, String(task.image_count));
  renderStylePresetList();
  renderImageToImageWorkflow();
  renderProgress("idle");
  void refreshEstimate();
  void refreshHistory();
  elements.actionHint.textContent = `任务 ${task.id} 的标注图和修改说明已带入，可确认参数后创建新任务`;
  elements.promptInput.focus();
}

function showAnnotationError(message) {
  elements.annotationError.textContent = message;
  elements.annotationError.hidden = false;
}

function clearAnnotationError() {
  elements.annotationError.textContent = "";
  elements.annotationError.hidden = true;
}

function setSelectValueIfAvailable(select, value) {
  if (value === null || value === undefined) {
    return;
  }

  const normalizedValue = String(value);

  if (Array.from(select.options).some((option) => option.value === normalizedValue)) {
    select.value = normalizedValue;
  }
}

function clearReeditSource() {
  clearAnnotatedInputFile();
  state.imageRestoreAnnotationApplied = false;
  state.referenceFileId = null;
  state.referencePreviewUrl = null;
  state.sourceTaskId = null;
  state.sourceFileId = null;
}

function clearAnnotatedInputFile() {
  if (state.annotatedPreviewUrl !== null) {
    URL.revokeObjectURL(state.annotatedPreviewUrl);
  }

  state.annotatedInputFile = null;
  state.annotatedPreviewUrl = null;
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

function summarizeTextResult(value) {
  const normalized = value.replace(/\s+/gu, " ").trim();

  return normalized.length > 150 ? `${normalized.slice(0, 150)}...` : normalized;
}

function formatTaskType(taskType) {
  return modeConfig[taskType]?.title ?? taskType;
}
