import "dotenv/config";

import { pathToFileURL } from "node:url";

import { loadAppConfig, type AppConfig } from "../src/config/app-config.js";

type ProductionModes = Pick<AppConfig, "sessionStore" | "imageTaskExecutionMode">;

export function assertProductionModes(config: ProductionModes): void {
  if (config.sessionStore !== "redis") {
    throw new Error("生产部署必须使用 Redis Session。");
  }

  if (config.imageTaskExecutionMode !== "queue") {
    throw new Error("生产部署必须使用 BullMQ 队列。");
  }
}

export function assertDeploymentApiUrl(value: string): URL {
  const url = new URL(value);
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const isSecure = url.protocol === "https:";
  const isLoopbackHttp = url.protocol === "http:" && loopbackHosts.has(url.hostname);

  // Bearer 门禁令牌和门禁结论都必须防止被窃取或篡改；仅本机回环调试允许明文 HTTP。
  if ((!isSecure && !isLoopbackHttp) || url.username.length > 0 || url.password.length > 0) {
    throw new Error("DEPLOYMENT_API_BASE_URL 必须使用 HTTPS；仅本机回环地址允许 HTTP。");
  }

  return url;
}

export function assertDeploymentReadiness(payload: unknown): void {
  if (!isRecord(payload)) {
    throw new Error("部署 readiness 响应格式无效。");
  }

  const dependencies = isRecord(payload.dependencies) ? payload.dependencies : {};
  const runtime = isRecord(payload.runtime) ? payload.runtime : {};
  const requiredDependencies = ["mysql", "redis", "minio", "queue"];

  if (runtime.session_store !== "redis" || runtime.image_task_execution_mode !== "queue") {
    throw new Error("远端实例未使用 Redis Session 与 BullMQ 队列模式。");
  }

  if (requiredDependencies.some((name) => dependencies[name] !== "ok")) {
    throw new Error("部署 readiness 依赖未就绪。");
  }

  const worker = isRecord(payload.worker) ? payload.worker : {};
  if (payload.status !== "ok" || worker.status !== "ok") {
    throw new Error("部署 readiness 未达到可发布状态。");
  }

  const queue = isRecord(payload.queue) ? payload.queue : {};
  const outbox = isRecord(payload.outbox) ? payload.outbox : {};
  if (
    queue.waiting !== 0 ||
    queue.active !== 0 ||
    queue.delayed !== 0 ||
    outbox.backlog !== 0 ||
    outbox.dead_letter !== 0
  ) {
    throw new Error("队列或 Outbox 尚未排空，不能执行发布或回滚切换。");
  }
}

export function assertDeploymentGate(
  payload: unknown,
  acknowledgedFailedJobFingerprint?: string
): void {
  if (!isRecord(payload)) {
    throw new Error("内部部署门禁响应格式无效。");
  }

  const failedJobs = isRecord(payload.failed_jobs) ? payload.failed_jobs : {};
  const billing = isRecord(payload.billing) ? payload.billing : {};
  const expectedFingerprint =
    acknowledgedFailedJobFingerprint === undefined ||
    acknowledgedFailedJobFingerprint.trim().length === 0
      ? "none"
      : acknowledgedFailedJobFingerprint.trim();

  if (failedJobs.overflow === true || failedJobs.fingerprint !== expectedFingerprint) {
    throw new Error("存在尚未确认的失败 Job，请先审核失败记录。");
  }

  if (billing.pending_count !== 0 || billing.orphan_reserve_count !== 0) {
    throw new Error("仍有计费事件等待对账，不能执行发布或回滚切换。");
  }
}

async function main(): Promise<void> {
  // 强制按生产模式重新解析环境变量，禁止灰度遗留的 memory/inline 配置进入正式发布。
  const config = loadAppConfig({ ...process.env, APP_ENV: "production" });
  assertProductionModes(config);
  const apiBaseUrl = process.env.DEPLOYMENT_API_BASE_URL?.trim();
  const deploymentGateToken = process.env.DEPLOYMENT_GATE_TOKEN?.trim();

  if (apiBaseUrl === undefined || apiBaseUrl.length === 0) {
    throw new Error("缺少 DEPLOYMENT_API_BASE_URL，无法执行部署后验收。");
  }

  if (deploymentGateToken === undefined || deploymentGateToken.length === 0) {
    throw new Error("缺少 DEPLOYMENT_GATE_TOKEN，无法读取只读部署门禁。");
  }

  const deploymentApiUrl = assertDeploymentApiUrl(apiBaseUrl);
  await checkHealthEndpoint(new URL("/api/health/live", deploymentApiUrl), false);
  const readiness = await checkHealthEndpoint(new URL("/api/health/ready", deploymentApiUrl), true);
  assertDeploymentReadiness(readiness);
  const deploymentGate = await checkHealthEndpoint(
    new URL("/api/internal/deployment/gate", deploymentApiUrl),
    true,
    // 远程验收只发送独立只读令牌，不能复用具备计费写权限的 INTERNAL_API_TOKEN。
    { authorization: `Bearer ${deploymentGateToken}` }
  );
  assertDeploymentGate(deploymentGate, process.env.DEPLOYMENT_ACKNOWLEDGED_FAILED_JOB_FINGERPRINT);
  // 输出只包含验收结论，不回显部署 URL、连接串或任何环境变量值。
  console.log("G09 部署基础设施门禁通过；完整业务验收以 npm run acceptance 结果为准。");
}

export async function checkHealthEndpoint(
  url: URL,
  parseJson: boolean,
  headers?: Record<string, string>
): Promise<unknown> {
  const response = await fetch(url, {
    headers,
    // 固定健康检查和内部门禁路径不允许重定向，防止验收结论来自未经校验的其他源。
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  }).catch(() => {
    throw new Error("部署健康接口暂不可访问。");
  });

  if (!response.ok) {
    throw new Error("部署健康接口返回失败状态。");
  }

  return parseJson ? await response.json().catch(() => undefined) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "G09 部署验收失败。");
    process.exitCode = 1;
  });
}
