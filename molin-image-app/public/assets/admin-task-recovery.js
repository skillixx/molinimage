import { listFailedTasks, replayFailedTask } from "./admin-task-recovery-api.js";

const pageSize = 20;
let currentPage = 1;
let total = 0;

const rows = document.querySelector("#failureRows");
const summary = document.querySelector("#failureSummary");
const errorBanner = document.querySelector("#failureError");
const pageInfo = document.querySelector("#failurePageInfo");
const previousButton = document.querySelector("#failurePrev");
const nextButton = document.querySelector("#failureNext");

document.querySelector("#refreshFailures")?.addEventListener("click", () => void loadPage());
previousButton?.addEventListener("click", () => {
  if (currentPage > 1) {
    currentPage -= 1;
    void loadPage();
  }
});
nextButton?.addEventListener("click", () => {
  if (currentPage * pageSize < total) {
    currentPage += 1;
    void loadPage();
  }
});

void loadPage();

async function loadPage() {
  setError("");
  summary.textContent = "正在读取失败任务...";

  try {
    const result = await listFailedTasks(currentPage, pageSize);
    total = result.total;
    renderRows(result.items);
    summary.textContent = `共 ${String(total)} 个最终失败任务`;
    pageInfo.textContent = `第 ${String(currentPage)} 页`;
    previousButton.disabled = currentPage <= 1;
    nextButton.disabled = currentPage * pageSize >= total;
  } catch (error) {
    rows.replaceChildren();
    summary.textContent = "读取失败";
    setError(error instanceof Error ? error.message : "任务列表加载失败。");
  }
}

function renderRows(items) {
  rows.replaceChildren();

  if (items.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "recovery-empty";
    cell.textContent = "暂无最终失败任务";
    row.append(cell);
    rows.append(row);
    return;
  }

  for (const item of items) {
    const row = document.createElement("tr");
    row.append(
      createTaskCell(item),
      createCell(String(item.owner_user_id)),
      createErrorCell(item),
      createCell(`${String(item.worker_attempt_count)} 次`),
      createStatusCell(item.billing_status),
      createCell(formatTime(item.updated_at)),
      createActionCell(item)
    );
    rows.append(row);
  }
}

function createTaskCell(item) {
  const cell = document.createElement("td");
  const type = document.createElement("strong");
  const id = document.createElement("code");
  type.textContent = item.task_type;
  id.textContent = item.id;
  cell.append(type, id);
  return cell;
}

function createErrorCell(item) {
  const cell = document.createElement("td");
  const code = document.createElement("code");
  const message = document.createElement("span");
  code.textContent = item.error_code ?? "UNKNOWN";
  message.textContent = item.error_message ?? "未记录公开错误说明";
  cell.append(code, message);
  return cell;
}

function createStatusCell(status) {
  const cell = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = `recovery-status ${status === "released" ? "released" : "pending"}`;
  badge.textContent = status ?? "未知";
  cell.append(badge);
  return cell;
}

function createActionCell(item) {
  const cell = document.createElement("td");
  const button = document.createElement("button");
  cell.className = "action-column";
  button.className = "recovery-button primary";
  button.type = "button";
  button.textContent = "重新投递";

  if (item.error_code === "BILLING_RELEASE_PENDING") {
    button.disabled = true;
    button.textContent = "待计费对账";
    cell.append(button);
    return cell;
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "投递中...";

    try {
      await replayFailedTask(item.id);
      button.textContent = "已投递";
    } catch (error) {
      button.disabled = false;
      button.textContent = "重新投递";
      setError(error instanceof Error ? error.message : "重新投递失败。");
    }
  });
  cell.append(button);
  return cell;
}

function createCell(value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  return cell;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function setError(message) {
  errorBanner.textContent = message;
  errorBanner.hidden = message.length === 0;
}
