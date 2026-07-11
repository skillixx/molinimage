const taskStatusLabels = {
  pending: "等待处理",
  billing_reserved: "积分已预占",
  queued: "排队中",
  running: "处理中",
  succeeded: "已成功",
  failed: "已失败",
  billing_pending: "等待计费对账",
  cancelled: "已取消"
};

const failureMessages = {
  AI_GATEWAY_FAILED: "AI 模型服务调用失败，请稍后重试。",
  FILE_STORAGE_FAILED: "结果文件保存失败，请稍后重试。",
  BILLING_SETTLE_PENDING: "图片已生成，积分结算等待对账。",
  BILLING_RELEASE_PENDING: "任务失败，积分释放等待对账。",
  INPUT_IMAGE_REQUIRED: "任务缺少输入图片，请重新上传后重试。",
  PROMPT_REQUIRED: "任务缺少提示词，请填写后重试。"
};

export function formatTaskStatus(status) {
  return taskStatusLabels[status] ?? "未知状态";
}

export function resolveTaskFailureMessage(task) {
  const mappedMessage = failureMessages[task.error_code];

  if (mappedMessage !== undefined) {
    return mappedMessage;
  }

  const message = typeof task.error_message === "string" ? task.error_message.trim() : "";

  // 历史数据可能保存 Provider 英文原文；只展示包含中文的公开原因，避免用户看到内部异常。
  return /[\u3400-\u9fff]/u.test(message) ? message : "任务执行失败，请稍后重试。";
}

export function formatTaskPoints(task) {
  if (task.cost_points === null) {
    return "未产生积分记录";
  }

  // 根据任务与计费错误状态区分已结算、待对账、已释放和仍处于预占中的积分。
  if (task.status === "succeeded") {
    return `${task.cost_points} 积分`;
  }

  if (task.status === "billing_pending" || task.error_code === "BILLING_SETTLE_PENDING") {
    return `${task.cost_points} 积分（结算待对账）`;
  }

  if (task.status === "failed" || task.status === "cancelled") {
    return task.error_code === "BILLING_RELEASE_PENDING"
      ? `${task.cost_points} 积分（释放待对账）`
      : `${task.cost_points} 积分（已释放）`;
  }

  return `${task.cost_points} 积分（已预占）`;
}
