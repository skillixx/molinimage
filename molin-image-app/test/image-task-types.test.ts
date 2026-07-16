import assert from "node:assert/strict";
import test from "node:test";

import {
  isSupportedImageRestoreType,
  isSupportedImageTaskType,
  supportsStylePreset
} from "../src/modules/image-tasks/image-task-types.js";

void test("图片任务类型注册表统一判断任务和模板支持范围", () => {
  assert.equal(isSupportedImageTaskType("text_to_image"), true);
  assert.equal(isSupportedImageTaskType("image_to_image"), true);
  assert.equal(isSupportedImageTaskType("unknown_mode"), false);

  assert.equal(supportsStylePreset("text_to_image"), true);
  assert.equal(supportsStylePreset("image_to_image"), true);
  assert.equal(supportsStylePreset("upscale"), false);
});

void test("图片修复类型注册表保留内置修复模式兜底", () => {
  assert.equal(isSupportedImageRestoreType("old_photo"), true);
  assert.equal(isSupportedImageRestoreType("denoise"), true);
  assert.equal(isSupportedImageRestoreType("remove_object"), false);
});
