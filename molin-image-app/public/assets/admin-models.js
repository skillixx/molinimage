import { listImageModels, syncImageModels, updateImageModel } from "./admin-models-api.js";

const elements = {
  sync: document.querySelector("#syncModels"),
  form: document.querySelector("#modelForm"),
  modelId: document.querySelector("#modelId"),
  modelCode: document.querySelector("#modelCode"),
  title: document.querySelector("#modelFormTitle"),
  displayName: document.querySelector("#displayName"),
  capability: document.querySelector("#capability"),
  description: document.querySelector("#description"),
  supportedTaskTypes: document.querySelector("#supportedTaskTypes"),
  defaultTaskTypes: document.querySelector("#defaultTaskTypes"),
  sortOrder: document.querySelector("#sortOrder"),
  maxOutputCount: document.querySelector("#maxOutputCount"),
  adminEnabled: document.querySelector("#adminEnabled"),
  reset: document.querySelector("#resetModelForm"),
  error: document.querySelector("#modelError"),
  rows: document.querySelector("#modelRows")
};
let models = [];
let isMutating = false;

elements.sync.addEventListener("click", () => void syncModels());
elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveModel();
});
elements.reset.addEventListener("click", resetForm);
void loadModels();

async function loadModels() {
  try {
    const result = await listImageModels();
    models = result.items ?? [];
    renderModels();
  } catch (error) {
    showError(error);
  }
}

async function syncModels() {
  clearError();
  try {
    setMutating(true);
    await syncImageModels();
    await loadModels();
  } catch (error) {
    showError(error);
  } finally {
    setMutating(false);
  }
}

async function saveModel() {
  const modelId = elements.modelId.value;
  if (isMutating || modelId.length === 0) return;

  clearError();
  try {
    setMutating(true);
    await updateImageModel(modelId, {
      display_name: elements.displayName.value.trim(),
      description: elements.description.value.trim(),
      capability: elements.capability.value.trim(),
      admin_enabled: elements.adminEnabled.checked,
      supported_task_types: splitCsv(elements.supportedTaskTypes.value),
      default_task_types: splitCsv(elements.defaultTaskTypes.value),
      sort_order: Number(elements.sortOrder.value || "0"),
      max_output_count: Number(elements.maxOutputCount.value || "1")
    });
    resetForm();
    await loadModels();
  } catch (error) {
    showError(error);
  } finally {
    setMutating(false);
  }
}

function renderModels() {
  elements.rows.replaceChildren();

  if (models.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "admin-empty";
    cell.textContent = "暂无模型配置，请先同步目录。";
    row.append(cell);
    elements.rows.append(row);
    return;
  }

  for (const model of models) {
    const row = document.createElement("tr");
    appendCell(row, `${model.display_name}\n${model.gateway_model_code}`);
    appendCell(row, `${model.capability}\n${model.supported_task_types.join(", ")}`);
    appendCell(
      row,
      model.default_task_types.length === 0 ? "未设置" : model.default_task_types.join(", ")
    );
    appendCell(row, resolveStatusText(model));
    const actions = document.createElement("td");
    const edit = createButton("编辑", () => editModel(model));
    const toggle = createButton(
      model.admin_enabled ? "停用" : "启用",
      () => void toggleModel(model)
    );
    actions.className = "admin-row-actions";
    actions.append(edit, toggle);
    row.append(actions);
    elements.rows.append(row);
  }
}

function editModel(model) {
  elements.modelId.value = model.id;
  elements.modelCode.value = model.gateway_model_code;
  elements.title.textContent = "编辑模型";
  elements.displayName.value = model.display_name;
  elements.capability.value = model.capability;
  elements.description.value = model.description;
  elements.supportedTaskTypes.value = model.supported_task_types.join(",");
  elements.defaultTaskTypes.value = model.default_task_types.join(",");
  elements.sortOrder.value = model.sort_order;
  elements.maxOutputCount.value = model.max_output_count;
  elements.adminEnabled.checked = model.admin_enabled;
  elements.form.scrollIntoView({ behavior: "smooth" });
}

async function toggleModel(model) {
  if (isMutating) return;
  if (model.admin_enabled && !window.confirm(`确认停用 ${model.display_name}？`)) return;

  clearError();
  try {
    setMutating(true);
    await updateImageModel(model.id, { admin_enabled: !model.admin_enabled });
    await loadModels();
  } catch (error) {
    showError(error);
  } finally {
    setMutating(false);
  }
}

function resolveStatusText(model) {
  if (!model.source_available) return "来源已移除";
  if (model.source_status !== "active") return "来源停用";
  return model.admin_enabled ? "启用" : "停用";
}

function splitCsv(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function setMutating(mutating) {
  isMutating = mutating;
  // 保存和同步期间锁住按钮，避免连续切换导致默认模型配置被后一次请求覆盖。
  for (const button of document.querySelectorAll("button")) {
    button.disabled = mutating;
  }
}

function resetForm() {
  elements.form.reset();
  elements.modelId.value = "";
  elements.modelCode.value = "";
  elements.title.textContent = "选择模型";
  clearError();
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
  elements.error.textContent = error instanceof Error ? error.message : "模型管理操作失败。";
  elements.error.hidden = false;
}
