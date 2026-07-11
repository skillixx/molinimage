import { listPricingRules, savePricingRule, setPricingRuleActive } from "./admin-pricing-api.js";

const elements = {
  form: document.querySelector("#pricingRuleForm"),
  ruleId: document.querySelector("#ruleId"),
  title: document.querySelector("#ruleFormTitle"),
  taskType: document.querySelector("#ruleTaskType"),
  modelCode: document.querySelector("#ruleModelCode"),
  capability: document.querySelector("#ruleCapability"),
  quality: document.querySelector("#ruleQuality"),
  imageSize: document.querySelector("#ruleImageSize"),
  upscaleFactor: document.querySelector("#ruleUpscaleFactor"),
  points: document.querySelector("#rulePoints"),
  usageType: document.querySelector("#ruleUsageType"),
  active: document.querySelector("#ruleActive"),
  reset: document.querySelector("#resetRuleForm"),
  error: document.querySelector("#adminError"),
  rows: document.querySelector("#pricingRuleRows")
};
let rules = [];
let isMutating = false;

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveRule();
});
elements.reset.addEventListener("click", resetForm);
elements.taskType.addEventListener("change", fillDefaultUsageType);
void loadRules();

async function loadRules() {
  try {
    const result = await listPricingRules();
    rules = result.items ?? [];
    renderRules();
  } catch (error) {
    showError(error);
  }
}

async function saveRule() {
  if (isMutating) return;

  clearError();
  const ruleId = elements.ruleId.value;
  const body = {
    task_type: elements.taskType.value,
    gateway_model_code: emptyToNull(elements.modelCode.value),
    gateway_capability: emptyToNull(elements.capability.value),
    quality: emptyToNull(elements.quality.value),
    image_size: emptyToNull(elements.imageSize.value),
    upscale_factor:
      elements.upscaleFactor.value === "" ? null : Number(elements.upscaleFactor.value),
    usage_type: elements.usageType.value.trim(),
    points_per_unit: elements.points.value.trim(),
    active: elements.active.checked
  };
  try {
    setMutating(true);
    await savePricingRule(ruleId, body);
    resetForm();
    await loadRules();
  } catch (error) {
    showError(error);
  } finally {
    setMutating(false);
  }
}

function renderRules() {
  elements.rows.replaceChildren();
  if (rules.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "admin-empty";
    cell.textContent = "暂无数据库价格规则，当前使用环境默认规则。";
    row.append(cell);
    elements.rows.append(row);
    return;
  }
  for (const rule of rules) {
    const row = document.createElement("tr");
    appendCell(row, rule.task_type);
    appendCell(row, summarizeDimensions(rule));
    appendCell(row, `${rule.points_per_unit} ${rule.unit}`);
    appendCell(row, rule.active ? "启用" : "停用");
    const actions = document.createElement("td");
    const edit = createButton("编辑", () => editRule(rule));
    const toggle = createButton(rule.active ? "停用" : "启用", () => void toggleRule(rule));
    actions.className = "admin-row-actions";
    actions.append(edit, toggle);
    row.append(actions);
    elements.rows.append(row);
  }
}

function editRule(rule) {
  elements.ruleId.value = rule.id;
  elements.title.textContent = "编辑规则";
  elements.taskType.value = rule.task_type;
  elements.modelCode.value = rule.gateway_model_code ?? "";
  elements.capability.value = rule.gateway_capability ?? "";
  elements.quality.value = rule.quality ?? "";
  elements.imageSize.value = rule.image_size ?? "";
  elements.upscaleFactor.value = rule.upscale_factor ?? "";
  elements.points.value = rule.points_per_unit;
  elements.usageType.value = rule.usage_type;
  elements.active.checked = rule.active;
  elements.form.scrollIntoView({ behavior: "smooth" });
}

async function toggleRule(rule) {
  if (isMutating) return;
  if (rule.active && !window.confirm(`确认停用 ${rule.task_type} 价格规则？`)) return;

  clearError();
  try {
    setMutating(true);
    await setPricingRuleActive(rule.id, !rule.active);
    await loadRules();
  } catch (error) {
    showError(error);
  } finally {
    setMutating(false);
  }
}

function setMutating(mutating) {
  isMutating = mutating;
  // 提交期间锁定所有操作按钮，避免重复保存或连续切换同一条价格规则。
  for (const button of document.querySelectorAll("button")) {
    button.disabled = mutating;
  }
}

function resetForm() {
  elements.form.reset();
  elements.ruleId.value = "";
  elements.title.textContent = "新建规则";
  elements.active.checked = true;
  fillDefaultUsageType();
  clearError();
}
function fillDefaultUsageType() {
  if (elements.ruleId.value === "") elements.usageType.value = `image_${elements.taskType.value}`;
}
function emptyToNull(value) {
  const text = value.trim();
  return text === "" ? null : text;
}
function summarizeDimensions(rule) {
  return (
    [
      rule.gateway_model_code,
      rule.gateway_capability,
      rule.quality,
      rule.image_size,
      rule.upscale_factor === null ? null : `${rule.upscale_factor}x`
    ]
      .filter(Boolean)
      .join(" / ") || "默认规则"
  );
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
  elements.error.textContent = error instanceof Error ? error.message : "价格规则操作失败。";
  elements.error.hidden = false;
}
