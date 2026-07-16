import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const outputDirectory = resolve(process.cwd(), "dist");

if (basename(outputDirectory) !== "dist" || dirname(outputDirectory) !== resolve(process.cwd())) {
  throw new Error("编译输出目录校验失败，拒绝清理。");
}

// 每次编译前清理已确认的 dist，避免已删除测试的旧 JavaScript 继续进入验收。
await rm(outputDirectory, { recursive: true, force: true });
