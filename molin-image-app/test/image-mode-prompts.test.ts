import assert from "node:assert/strict";
import test from "node:test";

import {
  buildImageEditPromptWithTemplate,
  buildImageRestorePromptWithTemplate,
  buildTextToImagePromptWithTemplate,
  buildUpscalePrompt,
  buildVisionTextPrompt,
  resolveUpscaleTargetDimension
} from "../src/workers/image-mode-prompts.js";
import { FileServiceError } from "../src/modules/files/file-service.js";

void test("文生图提示词支持模板和用户要求组合", () => {
  const prompt = buildTextToImagePromptWithTemplate("蓝色科技海报", "商业摄影风格");

  assert.match(prompt, /商业摄影风格/);
  assert.match(prompt, /用户创作要求：蓝色科技海报/);
});

void test("图生图提示词按编辑模式兜底，也允许模板覆盖", () => {
  const fallbackPrompt = buildImageEditPromptWithTemplate(
    "换成雪山背景",
    "change_background",
    null
  );
  const templatePrompt = buildImageEditPromptWithTemplate(
    "保留人物",
    "change_background",
    "证件照模板"
  );

  assert.match(fallbackPrompt, /替换或重绘背景环境/);
  assert.match(fallbackPrompt, /用户编辑要求：换成雪山背景/);
  assert.match(templatePrompt, /证件照模板/);
  assert.doesNotMatch(templatePrompt, /替换或重绘背景环境/);
});

void test("图片修复和高清放大提示词保持独立构造", () => {
  const restorePrompt = buildImageRestorePromptWithTemplate("尽量自然", "deblur", null);
  const upscalePrompt = buildUpscalePrompt(2, 2048, 1024);

  assert.match(restorePrompt, /变清晰/);
  assert.match(restorePrompt, /用户补充要求：尽量自然/);
  assert.match(upscalePrompt, /高清放大 2 倍/);
  assert.match(upscalePrompt, /2048x1024/);
});

void test("图生文默认提示词和放大尺寸校验保持 worker 可复用", () => {
  assert.match(buildVisionTextPrompt(null), /标题/);
  assert.equal(resolveUpscaleTargetDimension(512, 4), 2048);
  assert.throws(
    () => resolveUpscaleTargetDimension(20_000, 2),
    (error: unknown) =>
      error instanceof FileServiceError && error.code === "UPSCALE_TARGET_TOO_LARGE"
  );
});
