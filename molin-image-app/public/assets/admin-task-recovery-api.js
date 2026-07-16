const apiPath = "/api/admin/image/task-recovery";

export async function listFailedTasks(page = 1, pageSize = 20) {
  const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  return await requestJson(`${apiPath}?${query.toString()}`);
}

export async function replayFailedTask(taskId) {
  return await requestJson(`${apiPath}/${encodeURIComponent(taskId)}/replay`, {
    method: "POST"
  });
}

async function requestJson(path, options = {}) {
  // 管理请求仍通过应用会话和后端管理员白名单校验，浏览器不接触队列或数据库凭据。
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers: { accept: "application/json" }
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "任务恢复请求失败。");
  }

  return payload;
}
