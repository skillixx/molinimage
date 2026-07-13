import {
  listPendingReconciliationTasks,
  retryReleaseTask,
  retrySettleTask
} from "./admin-reconciliation-api.js";

const elements = {
  rows: document.querySelector("#reconciliationRows"),
  error: document.querySelector("#reconciliationError"),
  prev: document.querySelector("#reconciliationPrev"),
  next: document.querySelector("#reconciliationNext"),
  pageInfo: document.querySelector("#reconciliationPageInfo")
};
let tasks = [];
let isMutating = false;
let page = 1;
let totalTasks = 0;
const pageSize = 20;

elements.prev.addEventListener("click", () => {
  if (page <= 1 || isMutating) return;
  page -= 1;
  void loadTasks();
});
elements.next.addEventListener("click", () => {
  if (isMutating) return;
  page += 1;
  void loadTasks();
});
void loadTasks();

async function loadTasks() {
  clearError();
  try {
    const result = await listPendingReconciliationTasks(page, pageSize);
    tasks = result.items ?? [];
    totalTasks = result.total ?? 0;
    if (tasks.length === 0 && page > 1) {
      page -= 1;
      await loadTasks();
      return;
    }
    renderTasks();
    renderPager(totalTasks);
  } catch (error) {
    showError(error);
  }
}

function renderPager(total) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  elements.pageInfo.textContent = `第 ${String(page)} / ${String(totalPages)} 页，共 ${String(total)} 条`;
  elements.prev.disabled = isMutating || page <= 1;
  elements.next.disabled = isMutating || page >= totalPages;
}

function renderTasks() {
  elements.rows.replaceChildren();

  if (tasks.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "admin-empty";
    cell.textContent = "暂无待对账任务。";
    row.append(cell);
    elements.rows.append(row);
    return;
  }

  for (const task of tasks) {
    const row = document.createElement("tr");
    appendCell(row, `${task.id}\n${task.task_type}\n用户 ${String(task.owner_user_id)}`);
    appendCell(row, task.status);
    appendCell(row, task.cost_points ?? "-");
    appendCell(row, formatFailure(task));
    appendCell(row, formatLatestAttempt(task));
    row.append(createActionCell(task));
    elements.rows.append(row);
  }
}

function createActionCell(task) {
  const cell = document.createElement("td");
  cell.className = "admin-row-actions";
  const button =
    task.status === "billing_pending"
      ? createButton("重试结算", () => void retrySettle(task))
      : createButton("重试释放", () => void retryRelease(task));
  cell.append(button);
  return cell;
}

async function retrySettle(task) {
  if (isMutating) return;
  if (!window.confirm(`确认重试结算任务 ${task.id}？`)) return;

  await mutate(async () => {
    await retrySettleTask(task.id);
  });
}

async function retryRelease(task) {
  if (isMutating) return;
  if (!window.confirm(`确认重试释放任务 ${task.id}？`)) return;

  await mutate(async () => {
    await retryReleaseTask(task.id);
  });
}

async function mutate(action) {
  clearError();
  try {
    setMutating(true);
    await action();
    await loadTasks();
  } catch (error) {
    showError(error);
  } finally {
    setMutating(false);
  }
}

function setMutating(mutating) {
  isMutating = mutating;
  // 对账动作会触达墨灵计费接口，执行期间锁定按钮，避免同一任务被连续点击。
  for (const button of document.querySelectorAll("button")) {
    button.disabled = mutating;
  }
  renderPager(totalTasks);
}

function formatFailure(task) {
  return [task.error_code, task.error_message, task.latest_billing_event_error_message]
    .filter((item) => typeof item === "string" && item.length > 0)
    .join("\n");
}

function formatLatestAttempt(task) {
  return [
    task.latest_reconciliation_result,
    task.latest_reconciliation_error_code,
    task.latest_reconciliation_error_message,
    task.latest_reconciliation_created_at
  ]
    .filter((item) => typeof item === "string" && item.length > 0)
    .join("\n");
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
  elements.error.textContent = error instanceof Error ? error.message : "对账操作失败。";
  elements.error.hidden = false;
}
