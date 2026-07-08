# 墨灵 AI 图片创作应用文档索引

本目录用于沉淀墨灵 AI 图片创作应用的产品、技术和前端设计文档。

## 阅读顺序

1. `ai-image-product-plan.md`
   - 产品定位、用户画像、功能范围、产品规则、关键指标和阶段规划。
   - 适合产品、设计、前端、后端、测试先读。

2. `ai-image-stage-goals.md`
   - 阶段类型、每阶段任务 Goal、交付物、验收标准、推荐执行顺序、MVP 最小上线集合和 Agent 分配方式。
   - 适合项目管理、研发排期、任务拆分、Agent 派工和验收跟踪阅读。

3. `ai-image-model-preparation.md`
   - AI 网关模型目录需要准备的模型能力、逻辑模型 code、能力标签、分阶段准备清单和验收标准。
   - 适合模型配置、后端联调、前端模型选择器和计费配置阅读。

4. `ai-image-agent-task-assignment.md`
   - Agent 角色、职责边界、阶段 Goal 对应关系、MVP 分工和协作顺序。
   - 适合创建 Agent、分派任务、跨角色协作和阶段验收阅读。

5. `ai-image-platform-design.md`
   - 平台架构、AI 网关协议、MySQL、MinIO、任务、文件、计费、API 和测试策略。
   - 适合后端、前端联调、测试和运维阅读。

6. `molinimage-moling-integration-flow.md`
   - molinimage 接入墨灵平台的流程、平台后台参数、应用 `.env`、SSO、权益、计费和验收清单。
   - 适合平台配置、后端接入、联调和上线前验收阅读。

7. `ai-image-frontend-ui-design.md`
   - 前端页面、布局、组件、状态、响应式和接口依赖设计。
   - 适合 UI 设计、前端开发和验收走查阅读。

8. `agents/pm-agent.md`
   - 产品规划 Agent 的角色定义、职责边界、输出模板和协作规则。
   - 适合创建或唤起 `pm-agent` 时作为提示词参考。

## 已确认关键决策

- 数据库使用 MySQL 8.0+。
- 文件存储第一阶段使用 MinIO，后期可迁移到阿里云 OSS。
- 模型统一走墨灵 AI 网关协议，应用不直连上游模型供应商。
- 前端不直接调用 AI 网关、MinIO 或墨灵内部接口。
- 用户侧按图片任务计费，AI 网关 usage 只做成本核算和审计，避免双扣费。
- MVP 优先交付文生图、图生文、文件上传、作品历史、余额与预计消耗、计费闭环。

## 后续文档建议

- API 详细契约文档。
- MySQL migration 设计。
- 前端开发任务拆分。
- 测试用例与验收清单。
- 管理后台配置设计。
