import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  assertDeploymentApiUrl,
  assertDeploymentGate,
  assertDeploymentReadiness,
  assertProductionModes,
  checkHealthEndpoint
} from "../scripts/validate-g09-deployment.js";

void test("部署验收地址强制外部 HTTPS 且仅允许回环 HTTP", () => {
  assert.doesNotThrow(() => assertDeploymentApiUrl("https://molin-image.example.com"));
  assert.doesNotThrow(() => assertDeploymentApiUrl("http://127.0.0.1:5199"));
  assert.doesNotThrow(() => assertDeploymentApiUrl("http://localhost:5199"));
  assert.throws(() => assertDeploymentApiUrl("http://8.130.9.163:5199"), /必须使用 HTTPS/u);
  assert.throws(
    () => assertDeploymentApiUrl("https://user:password@molin-image.example.com"),
    /必须使用 HTTPS/u
  );
});

void test("部署健康检查拒绝跟随重定向", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(302, { location: "/forged-ready" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    await assert.rejects(
      checkHealthEndpoint(
        new URL(`http://127.0.0.1:${String(address.port)}/api/health/ready`),
        true
      ),
      /部署健康接口暂不可访问/u
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      })
    );
  }
});

void test("生产部署只允许 Redis Session 和 BullMQ 队列模式", () => {
  assert.doesNotThrow(() => {
    assertProductionModes({ sessionStore: "redis", imageTaskExecutionMode: "queue" });
  });
  assert.throws(() => {
    assertProductionModes({ sessionStore: "memory", imageTaskExecutionMode: "queue" });
  }, /生产部署必须使用 Redis Session/u);
  assert.throws(() => {
    assertProductionModes({ sessionStore: "redis", imageTaskExecutionMode: "inline" });
  }, /生产部署必须使用 BullMQ 队列/u);
});

void test("部署 readiness 必须确认四项依赖和 Worker 全部在线", () => {
  assert.doesNotThrow(() => {
    assertDeploymentReadiness(createReadyResponse());
  });

  assert.throws(() => {
    assertDeploymentReadiness({
      ...createReadyResponse(),
      dependencies: { ...createReadyResponse().dependencies, redis: "error" }
    });
  }, /依赖未就绪/u);
  assert.throws(() => {
    assertDeploymentReadiness({
      ...createReadyResponse(),
      status: "error",
      worker: { status: "offline" }
    });
  }, /readiness 未达到可发布状态/u);
  assert.throws(() => {
    assertDeploymentReadiness({
      ...createReadyResponse(),
      runtime: { session_store: "memory", image_task_execution_mode: "inline" }
    });
  }, /远端实例未使用 Redis Session/u);
  assert.throws(() => {
    assertDeploymentReadiness({
      ...createReadyResponse(),
      queue: { ...createReadyResponse().queue, active: 1 }
    });
  }, /尚未排空/u);
  assert.throws(() => {
    assertDeploymentReadiness({
      ...createReadyResponse(),
      queue: { ...createReadyResponse().queue, delayed: 1 }
    });
  }, /尚未排空/u);
});

void test("内部部署门禁校验失败 Job 摘要和计费异常", () => {
  const readyGate = {
    failed_jobs: { count: 0, fingerprint: "none", overflow: false },
    billing: { pending_count: 0, orphan_reserve_count: 0 }
  };
  assert.doesNotThrow(() => {
    assertDeploymentGate(readyGate);
  });
  assert.doesNotThrow(() => {
    assertDeploymentGate(
      {
        ...readyGate,
        failed_jobs: { count: 1, fingerprint: "reviewed-fingerprint", overflow: false }
      },
      "reviewed-fingerprint"
    );
  });
  assert.throws(() => {
    assertDeploymentGate({
      ...readyGate,
      failed_jobs: { count: 1, fingerprint: "unreviewed-fingerprint", overflow: false }
    });
  }, /尚未确认的失败 Job/u);
  assert.throws(() => {
    assertDeploymentGate({
      ...readyGate,
      billing: { pending_count: 0, orphan_reserve_count: 1 }
    });
  }, /等待对账/u);
});

void test("部署 readiness 响应格式异常时返回稳定中文错误", () => {
  assert.throws(() => {
    assertDeploymentReadiness(null);
  }, /响应格式无效/u);
  assert.throws(() => {
    assertDeploymentReadiness({ status: "ok", dependencies: {} });
  }, /远端实例未使用 Redis Session/u);
});

function createReadyResponse() {
  return {
    status: "ok",
    service: "molin-image-app",
    runtime: {
      session_store: "redis",
      image_task_execution_mode: "queue"
    },
    dependencies: {
      mysql: "ok",
      redis: "ok",
      minio: "ok",
      queue: "ok"
    },
    worker: { status: "ok" },
    queue: {
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      oldest_wait_ms: 0
    },
    outbox: { backlog: 0, dead_letter: 0, oldest_wait_ms: 0 },
    alerts: []
  };
}
