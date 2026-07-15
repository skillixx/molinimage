export async function getCurrentUser() {
  return await requestJson("/api/me");
}

export async function getImageModels() {
  return await requestJson("/api/image/models");
}

export async function getStylePresets(taskType = "") {
  const query = taskType.length > 0 ? `?task_type=${encodeURIComponent(taskType)}` : "";

  return await requestJson(`/api/image/style-presets${query}`);
}

export async function estimateBilling(input) {
  return await requestJson("/api/billing/estimate", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function optimizePrompt(input) {
  return await requestJson("/api/image/prompts/optimize", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function getBillingBalance() {
  return await requestJson("/api/billing/balance");
}

export async function getBillingRecords(page = 1, pageSize = 20) {
  const query = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize)
  });

  return await requestJson(`/api/billing/records?${query.toString()}`);
}

export async function createImageTask(input) {
  return await requestJson("/api/image/tasks", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function getImageTask(taskId) {
  return await requestJson(`/api/image/tasks/${encodeURIComponent(taskId)}`);
}

export async function retryImageTask(taskId) {
  return await requestJson(`/api/image/tasks/${encodeURIComponent(taskId)}/retry`, {
    method: "POST"
  });
}

export async function uploadImageFile(input) {
  return await requestJson("/api/files", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export async function getImageHistory(taskType = "") {
  const query = taskType.length > 0 ? `?task_type=${encodeURIComponent(taskType)}` : "";

  return await requestJson(`/api/image/history${query}`);
}

export async function favoriteHistoryItem(taskId) {
  return await requestJson(`/api/image/history/${encodeURIComponent(taskId)}/favorite`, {
    method: "POST"
  });
}

export async function deleteHistoryItem(taskId) {
  return await requestJson(`/api/image/history/${encodeURIComponent(taskId)}`, {
    method: "DELETE"
  });
}

async function requestJson(path, options = {}) {
  // 前端统一只访问应用后端 API，禁止绕过后端直接调用外部服务或内部接口。
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" })
    },
    body: options.body
  });
  const payload = await response.json();

  if (!response.ok) {
    const message = payload?.error?.message ?? "请求失败，请稍后重试。";
    const error = new Error(message);

    // 保留后端公开错误码，工作台可据此执行重新估价等安全恢复动作。
    error.code = payload?.error?.code ?? "REQUEST_FAILED";
    throw error;
  }

  return payload;
}
