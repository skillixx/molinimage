import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js"]
        },
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // 配置层要求 Promise 必须被显式处理，避免后续计费、队列和存储流程出现静默失败。
      "@typescript-eslint/no-floating-promises": "error",
      // 类型推断足够清晰时允许省略显式返回类型，保持业务代码简洁。
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-magic-numbers": "off"
    }
  }
]);
