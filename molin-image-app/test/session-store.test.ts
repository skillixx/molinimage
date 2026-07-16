import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemorySessionStore,
  type SessionIdentity,
  type SessionStore
} from "../src/modules/auth/session-store.js";

const identity: SessionIdentity = {
  user_id: 479,
  app_id: 990008,
  product_id: 990107,
  entitlement_id: 990311
};

void test("内存 SessionStore 实现异步接口并保留身份字段", async () => {
  const store: SessionStore = new InMemorySessionStore();
  const created = await store.createSession(identity, 60);
  const loaded = await store.getSession(created.token);

  assert.ok(loaded);
  assert.equal(loaded.session_id, created.session.session_id);
  assert.equal(loaded.user_id, identity.user_id);
  assert.equal(loaded.app_id, identity.app_id);
  assert.equal(loaded.product_id, identity.product_id);
  assert.equal(loaded.entitlement_id, identity.entitlement_id);
  assert.ok(created.token.length > 0);
});

void test("内存 Session 到期后不可读取并会清理", async () => {
  const store: SessionStore = new InMemorySessionStore();
  const created = await store.createSession(identity, 0);

  assert.equal(await store.getSession(created.token), undefined);
  assert.equal(await store.getSession(created.token), undefined);
});

void test("删除 Session 后立即失效且重复删除安全", async () => {
  const store: SessionStore = new InMemorySessionStore();
  const created = await store.createSession(identity, 60);

  await store.deleteSession(created.token);
  await store.deleteSession(created.token);
  await store.deleteSession(undefined);

  assert.equal(await store.getSession(created.token), undefined);
});
