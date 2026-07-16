import assert from "node:assert/strict";
import test from "node:test";

import { createRedisKey } from "../src/infrastructure/redis/redis-key.js";

void test("Redis Key 统一包含应用与环境前缀", () => {
  const developmentKey = createRedisKey("molinimage:development", "session", "token_hash");
  const productionKey = createRedisKey("molinimage:production", "session", "token_hash");

  assert.equal(developmentKey, "molinimage:development:session:token_hash");
  assert.equal(productionKey, "molinimage:production:session:token_hash");
  assert.notEqual(developmentKey, productionKey);
});

void test("Redis Key 拒绝空业务段和额外分隔符", () => {
  assert.throws(() => createRedisKey("molinimage:test", ""), /业务段不能为空/);
  assert.throws(() => createRedisKey("molinimage:test", "session:token"), /不能包含冒号/);
  assert.throws(() => createRedisKey("molinimage::test", "session"), /空命名段/);
});
