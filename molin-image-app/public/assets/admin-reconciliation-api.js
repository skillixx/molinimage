const apiPath = "/api/admin/image/billing-reconciliation";

export async function listPendingReconciliationTasks(page = 1, pageSize = 20) {
  const query = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize)
  });

  return await requestJson(`${apiPath}?${query.toString()}`);
}

export async function retrySettleTask(taskId) {
  return await requestJson(`${apiPath}/${encodeURIComponent(taskId)}/retry-settle`, {
    method: "POST"
  });
}

export async function retryReleaseTask(taskId) {
  return await requestJson(`${apiPath}/${encodeURIComponent(taskId)}/retry-release`, {
    method: "POST"
  });
}

async function requestJson(path, options = {}) {
  // 对账操作只访问应用后端，由后端校验墨灵会话、管理员白名单和任务真实状态。
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: {
      accept: "application/json"
    }
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "对账请求失败。");
  }

  return payload;
}
