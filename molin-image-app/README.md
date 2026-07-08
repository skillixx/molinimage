# 墨灵 AI 图片创作应用

这是墨灵 AI 图片创作应用的 Node.js + TypeScript 工程骨架。

## 本地命令

```bash
copy .env.example .env
npm install
npm run dev
npm run dev:worker
npm run build
npm run lint
npm run format:check
npm test
```

## 目录边界

- `src/app`：API 服务入口和 HTTP 边界。
- `src/modules`：业务模块，后续放任务、文件、计费、鉴权等领域逻辑。
- `src/infrastructure`：外部系统适配层，后续放 MySQL、MinIO、Redis、AI 网关等实现。
- `src/workers`：异步任务 worker 入口。
- `test`：自动化测试。
- `migrations`：数据库变更脚本。

## 环境变量

应用启动前会校验 `.env.example` 中列出的关键配置。真实环境变量值必须由本地 `.env`、部署平台或密钥管理系统提供，不能提交到仓库。

## 代码规范

项目使用 TypeScript strict mode、ESLint 和 Prettier。新增代码需要遵守 [开发规范](docs/development-standards.md)，关键业务逻辑必须同步写中文注释。
