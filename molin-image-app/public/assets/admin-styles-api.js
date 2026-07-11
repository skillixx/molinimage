const apiPath = "/api/admin/image/style-presets";

export async function listStylePresets() {
  return await requestJson(apiPath);
}

export async function saveStylePreset(presetId, input) {
  return await requestJson(
    presetId === "" ? apiPath : `${apiPath}/${encodeURIComponent(presetId)}`,
    {
      method: presetId === "" ? "POST" : "PATCH",
      body: JSON.stringify(input)
    }
  );
}

export async function setStylePresetEnabled(presetId, enabled) {
  return await requestJson(`${apiPath}/${encodeURIComponent(presetId)}`, {
    method: "PATCH",
    body: JSON.stringify({ enabled })
  });
}

async function requestJson(path, options = {}) {
  // 风格模板管理只访问应用后端，由后端统一校验墨灵会话和管理员白名单。
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
    throw new Error(payload?.error?.message ?? "风格模板请求失败。");
  }

  return payload;
}
