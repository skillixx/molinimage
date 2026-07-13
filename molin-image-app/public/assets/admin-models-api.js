const apiPath = "/api/admin/image/models";

export async function listImageModels() {
  return await requestJson(apiPath);
}

export async function syncImageModels() {
  return await requestJson(`${apiPath}/sync`, { method: "POST" });
}

export async function updateImageModel(modelId, input) {
  return await requestJson(`${apiPath}/${encodeURIComponent(modelId)}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

async function requestJson(path, options = {}) {
  // 管理端只调用应用后端 API，由后端基于墨灵会话和管理员白名单做权限判断。
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
    throw new Error(payload?.error?.message ?? "模型管理请求失败。");
  }

  return payload;
}
