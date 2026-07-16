import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createAppRequestHandler } from "../src/app/create-app.js";
import type { AppConfig } from "../src/config/app-config.js";
import type { SessionStore } from "../src/modules/auth/session-store.js";

void test("liveness 不依赖 Session，readiness 失败返回 503 和稳定响应", async () => {
  const sessionStore = new ThrowingSessionStore();
  const server = createServer(
    createAppRequestHandler(
      {
        appBaseUrl: "http://127.0.0.1",
        sessionCookieName: "molinimage_session"
      } as AppConfig,
      {
        launchTicketVerifier: { verifyLaunchTicket: () => Promise.reject(new Error("unused")) },
        sessionStore,
        healthService: {
          getLiveness: () => ({ status: "ok", service: "molin-image-app" }),
          getReadiness: () =>
            Promise.resolve({
              status: "error",
              service: "molin-image-app",
              dependencies: { mysql: "ok", redis: "error", minio: "ok", queue: "error" },
              worker: { status: "offline" },
              queue: { waiting: 0, active: 0, delayed: 0, failed: 0, oldest_wait_ms: 0 },
              outbox: { backlog: 0, dead_letter: 0, oldest_wait_ms: 0 },
              alerts: []
            })
        }
      }
    )
  );
  const baseUrl = await listen(server);

  try {
    const live = await fetch(`${baseUrl}/api/health/live`);
    const ready = await fetch(`${baseUrl}/api/health/ready`);

    assert.equal(live.status, 200);
    assert.equal(ready.status, 503);
    assert.equal(sessionStore.readCount, 0);
    assert.equal(ready.headers.get("x-request-id")?.length !== 0, true);
    assert.doesNotMatch(await ready.text(), /redis:\/\/|stack|secret/iu);
  } finally {
    await close(server);
  }
});

void test("未装配健康服务时 readiness 明确返回 503", async () => {
  const sessionStore = new ThrowingSessionStore();
  const server = createServer(
    createAppRequestHandler(
      {
        appBaseUrl: "http://127.0.0.1",
        sessionCookieName: "molinimage_session"
      } as AppConfig,
      {
        launchTicketVerifier: { verifyLaunchTicket: () => Promise.reject(new Error("unused")) },
        sessionStore
      }
    )
  );
  const baseUrl = await listen(server);

  try {
    const response = await fetch(`${baseUrl}/api/health/ready`);
    assert.equal(response.status, 503);
    assert.equal(sessionStore.readCount, 0);
  } finally {
    await close(server);
  }
});

class ThrowingSessionStore implements SessionStore {
  readCount = 0;

  createSession(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  getSession(): Promise<never> {
    this.readCount += 1;
    return Promise.reject(new Error("session secret"));
  }

  deleteSession(): Promise<void> {
    return Promise.resolve();
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }

      reject(error);
    });
  });
}
