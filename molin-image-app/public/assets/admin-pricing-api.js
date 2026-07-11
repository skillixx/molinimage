const apiPath = "/api/admin/image/pricing-rules";

export async function listPricingRules() {
  return await requestJson(apiPath);
}

export async function savePricingRule(ruleId, input) {
  return await requestJson(ruleId === "" ? apiPath : `${apiPath}/${encodeURIComponent(ruleId)}`, {
    method: ruleId === "" ? "POST" : "PATCH",
    body: JSON.stringify(input)
  });
}

export async function setPricingRuleActive(ruleId, active) {
  return await requestJson(`${apiPath}/${encodeURIComponent(ruleId)}`, {
    method: "PATCH",
    body: JSON.stringify({ active })
  });
}

async function requestJson(path, options = {}) {
  // 管理页面同样只访问应用后端，由应用会话完成管理员身份校验。
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
    throw new Error(payload?.error?.message ?? "请求失败。");
  }

  return payload;
}
