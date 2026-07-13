import { listStylePresets, saveStylePreset, setStylePresetEnabled } from "./admin-styles-api.js";

const elements = {
  form: document.querySelector("#stylePresetForm"),
  presetId: document.querySelector("#presetId"),
  title: document.querySelector("#styleFormTitle"),
  name: document.querySelector("#presetName"),
  category: document.querySelector("#presetCategory"),
  taskType: document.querySelector("#presetTaskType"),
  promptTemplate: document.querySelector("#presetPromptTemplate"),
  previewUrl: document.querySelector("#presetPreviewUrl"),
  sortOrder: document.querySelector("#presetSortOrder"),
  enabled: document.querySelector("#presetEnabled"),
  reset: document.querySelector("#resetStyleForm"),
  error: document.querySelector("#styleError"),
  rows: document.querySelector("#stylePresetRows")
};
let presets = [];
let isMutating = false;

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void savePreset();
});
elements.reset.addEventListener("click", resetForm);
void loadPresets();

async function loadPresets() {
  try {
    const result = await listStylePresets();
    presets = result.items ?? [];
    renderPresets();
  } catch (error) {
    showError(error);
  }
}

async function savePreset() {
  if (isMutating) return;

  clearError();
  try {
    setMutating(true);
    await saveStylePreset(elements.presetId.value, {
      name: elements.name.value.trim(),
      category: elements.category.value.trim(),
      task_type: elements.taskType.value,
      prompt_template: elements.promptTemplate.value.trim(),
      preview_image_url: emptyToNull(elements.previewUrl.value),
      enabled: elements.enabled.checked,
      sort_order: Number(elements.sortOrder.value || "0")
    });
    resetForm();
    await loadPresets();
  } catch (error) {
    showError(error);
  } finally {
    setMutating(false);
  }
}

function renderPresets() {
  elements.rows.replaceChildren();

  if (presets.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "admin-empty";
    cell.textContent = "暂无风格模板。";
    row.append(cell);
    elements.rows.append(row);
    return;
  }

  for (const preset of presets) {
    const row = document.createElement("tr");
    appendCell(row, preset.name);
    appendCell(row, `${preset.category}\n${preset.task_type}`);
    appendCell(row, summarize(preset.prompt_template));
    appendCell(row, String(preset.sort_order));
    appendCell(row, preset.enabled ? "启用" : "停用");
    const actions = document.createElement("td");
    const edit = createButton("编辑", () => editPreset(preset));
    const toggle = createButton(preset.enabled ? "停用" : "启用", () => void togglePreset(preset));
    actions.className = "admin-row-actions";
    actions.append(edit, toggle);
    row.append(actions);
    elements.rows.append(row);
  }
}

function editPreset(preset) {
  elements.presetId.value = preset.id;
  elements.title.textContent = "编辑模板";
  elements.name.value = preset.name;
  elements.category.value = preset.category;
  elements.taskType.value = preset.task_type;
  elements.promptTemplate.value = preset.prompt_template;
  elements.previewUrl.value = preset.preview_image_url ?? "";
  elements.sortOrder.value = preset.sort_order;
  elements.enabled.checked = preset.enabled;
  elements.form.scrollIntoView({ behavior: "smooth" });
}

async function togglePreset(preset) {
  if (isMutating) return;
  if (preset.enabled && !window.confirm(`确认停用 ${preset.name}？`)) return;

  clearError();
  try {
    setMutating(true);
    await setStylePresetEnabled(preset.id, !preset.enabled);
    await loadPresets();
  } catch (error) {
    showError(error);
  } finally {
    setMutating(false);
  }
}

function setMutating(mutating) {
  isMutating = mutating;
  // 保存或启停期间锁定按钮，避免同一个模板被连续提交导致展示状态短暂错乱。
  for (const button of document.querySelectorAll("button")) {
    button.disabled = mutating;
  }
}

function resetForm() {
  elements.form.reset();
  elements.presetId.value = "";
  elements.title.textContent = "新建模板";
  elements.enabled.checked = true;
  clearError();
}

function emptyToNull(value) {
  const text = value.trim();
  return text.length === 0 ? null : text;
}

function summarize(value) {
  const text = value.replace(/\s+/gu, " ").trim();
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function appendCell(row, text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  row.append(cell);
}

function createButton(text, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost-button";
  button.textContent = text;
  button.addEventListener("click", action);
  return button;
}

function clearError() {
  elements.error.hidden = true;
  elements.error.textContent = "";
}

function showError(error) {
  elements.error.textContent = error instanceof Error ? error.message : "风格模板操作失败。";
  elements.error.hidden = false;
}
