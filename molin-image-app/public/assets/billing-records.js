import { getBillingBalance, getBillingRecords, getCurrentUser } from "./api-client.js";

const state = {
  page: 1,
  pageSize: 20,
  total: 0
};

const elements = {
  sessionSummary: document.querySelector("#billingSessionSummary"),
  refreshButton: document.querySelector("#billingRefreshButton"),
  error: document.querySelector("#billingError"),
  balancePoints: document.querySelector("#balancePoints"),
  reservedPoints: document.querySelector("#reservedPoints"),
  releasedPoints: document.querySelector("#releasedPoints"),
  pendingPoints: document.querySelector("#pendingPoints"),
  totalText: document.querySelector("#billingTotalText"),
  recordList: document.querySelector("#billingRecordList"),
  prevButton: document.querySelector("#billingPrevButton"),
  nextButton: document.querySelector("#billingNextButton"),
  pageText: document.querySelector("#billingPageText")
};

elements.refreshButton.addEventListener("click", () => {
  void loadBillingRecords();
});
elements.prevButton.addEventListener("click", () => {
  if (state.page <= 1) {
    return;
  }

  state.page -= 1;
  void loadBillingRecords();
});
elements.nextButton.addEventListener("click", () => {
  if (state.page * state.pageSize >= state.total) {
    return;
  }

  state.page += 1;
  void loadBillingRecords();
});

void bootstrapBillingPage();

async function bootstrapBillingPage() {
  clearError();

  try {
    const [user, balance] = await Promise.all([getCurrentUser(), getBillingBalance()]);
    elements.sessionSummary.textContent = `用户 ${String(user.user_id)} · 应用 ${String(user.app_id)}`;
    renderBalance(balance);
    await loadBillingRecords();
  } catch (error) {
    elements.sessionSummary.textContent = "未建立应用会话";
    showError(error instanceof Error ? error.message : "消耗记录加载失败。");
  }
}

async function loadBillingRecords() {
  clearError();
  elements.recordList.replaceChildren(createLoadingItem());

  try {
    const result = await getBillingRecords(state.page, state.pageSize);
    state.total = result.total ?? 0;
    renderSummary(result.summary);
    renderRecords(result.items ?? []);
    renderPagination(result);
  } catch (error) {
    elements.recordList.replaceChildren();
    showError(error instanceof Error ? error.message : "消耗记录加载失败。");
  }
}

function renderSummary(summary) {
  elements.reservedPoints.textContent = `${summary?.reserved_points ?? "0"} 积分`;
  elements.releasedPoints.textContent = `${summary?.released_points ?? "0"} 积分`;
  elements.pendingPoints.textContent = `${summary?.pending_points ?? "0"} 积分`;
  elements.totalText.textContent = `共 ${String(summary?.record_count ?? 0)} 条`;
}

function renderBalance(balance) {
  elements.balancePoints.textContent = `${balance?.balance_points ?? "0"} 积分`;
}

function renderRecords(items) {
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "billing-empty";
    empty.textContent = "暂无积分消耗记录";
    elements.recordList.replaceChildren(empty);
    return;
  }

  elements.recordList.replaceChildren(...items.map(createRecordItem));
}

function createRecordItem(record) {
  const item = document.createElement("article");
  item.className = `billing-record is-${record.billing_stage}`;

  const main = document.createElement("div");
  main.className = "billing-record-main";

  const title = document.createElement("a");
  title.href = record.task_detail_url;
  title.textContent = `${record.event_type_label} · ${formatTaskType(record.task_type)}`;

  const meta = document.createElement("small");
  meta.textContent = `${record.created_at} · 任务 ${record.task_id}`;

  const status = document.createElement("span");
  status.className = "billing-status";
  status.textContent = record.status_label;

  const amount = document.createElement("strong");
  amount.className = "billing-amount";
  amount.textContent = `${record.display_amount_points} 积分`;

  main.append(title, meta);
  item.append(main, status, amount);

  if (record.error_message !== null) {
    const error = document.createElement("p");
    error.className = "billing-record-error";
    error.textContent = record.error_message;
    item.append(error);
  }

  return item;
}

function renderPagination(result) {
  const page = result.page ?? state.page;
  const pageSize = result.page_size ?? state.pageSize;
  const total = result.total ?? 0;

  state.page = page;
  state.pageSize = pageSize;
  state.total = total;
  elements.pageText.textContent = `第 ${String(page)} 页`;
  elements.prevButton.disabled = page <= 1;
  elements.nextButton.disabled = page * pageSize >= total;
}

function createLoadingItem() {
  const item = document.createElement("div");
  item.className = "billing-empty";
  item.textContent = "正在加载消耗记录";

  return item;
}

function formatTaskType(taskType) {
  const labels = {
    text_to_image: "文生图",
    image_to_text: "图生文",
    image_to_image: "图生图",
    image_restore: "图片修复",
    upscale: "高清放大"
  };

  return labels[taskType] ?? "未知任务";
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
}

function clearError() {
  elements.error.textContent = "";
  elements.error.hidden = true;
}
