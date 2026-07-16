import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

interface RestoreMode {
  mode_code: string;
  display_name: string;
  backend_preset_id: string;
  requires_annotation: boolean;
  defaults: Record<string, unknown>;
}

interface RestoreModesModule {
  imageRestoreModes: RestoreMode[];
  createImageRestoreParameterValues(): Record<string, Record<string, unknown>>;
  validateImageRestoreMode(mode: RestoreMode, hasAnnotations: boolean): {
    valid: boolean;
    message: string;
  };
  composeImageRestorePrompt(
    mode: RestoreMode,
    prompt: string,
    values: Record<string, unknown>
  ): string;
}

const restoreModes = (await import(
  pathToFileURL(resolve("public", "assets", "image-restore-modes.js")).href
)) as RestoreModesModule;

void test("图片修复注册表覆盖八种交互模式并映射后台模板", () => {
  assert.equal(restoreModes.imageRestoreModes.length, 8);
  assert.ok(restoreModes.imageRestoreModes.every((mode) => mode.backend_preset_id.length > 0));
});

void test("局部修复和去除元素必须存在有效标注", () => {
  for (const modeCode of ["local_repair", "remove_object"]) {
    const mode = restoreModes.imageRestoreModes.find((item) => item.mode_code === modeCode);
    assert.ok(mode);
    assert.equal(restoreModes.validateImageRestoreMode(mode, false).valid, false);
    assert.equal(restoreModes.validateImageRestoreMode(mode, true).valid, true);
  }
});

void test("修复提示词包含模式、动态参数和用户补充说明", () => {
  const mode = restoreModes.imageRestoreModes.find((item) => item.mode_code === "smart_restore");
  assert.ok(mode);
  const values = restoreModes.createImageRestoreParameterValues()[mode.mode_code];
  const prompt = restoreModes.composeImageRestorePrompt(mode, "保留墙上的文字", values);

  assert.match(prompt, /修复方式：智能修复/);
  assert.match(prompt, /修复强度：标准/);
  assert.match(prompt, /用户补充说明：保留墙上的文字/);
});
