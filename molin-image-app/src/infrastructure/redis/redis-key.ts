export function createRedisKey(prefix: string, ...segments: string[]): string {
  assertKeyPrefix(prefix);

  if (segments.length === 0) {
    throw new Error("Redis Key 至少需要一个业务段");
  }

  for (const segment of segments) {
    assertKeyPart(segment, "Redis Key 业务段");
  }

  // 所有模块必须通过同一入口拼接 Key，避免遗漏环境前缀后污染其他部署环境。
  return [prefix, ...segments].join(":");
}

function assertKeyPrefix(prefix: string): void {
  const parts = prefix.split(":");

  if (parts.some((part) => part.trim().length === 0)) {
    throw new Error("Redis Key 前缀不能为空或包含空命名段");
  }
}

function assertKeyPart(value: string, label: string): void {
  if (value.trim().length === 0 || value.includes(":")) {
    throw new Error(`${label}不能为空且不能包含冒号`);
  }
}
