## Why

① 已经打通"浏览器 → Spring → Python → LLM"这条链路，但平台还不能翻译。本 change 交付题目的核心闭环：多语言识别、术语辅助、Agent 任务编排、翻译记录与历史，让用户输入一段文本就能**实时看到 Agent 逐步执行**（分析 → 规划 → 检索术语 → 翻译 → 评审 → 修正），并得到遵循术语的译文。

同时，第一版前端是 shadcn 默认样式，没有动效，部分页面整页平铺，达不到"主流、高级、优雅"的标准（见 docs/总体设计.md 8.1）。本 change 先建立设计系统和动效基础，改造现有页面，再在新的设计系统上构建翻译工作台。

## What Changes

- **设计系统与动效（web）**：设计令牌（颜色、圆角、阴影、间距、字体）、暗色模式、motion 动效组件（页面切换、列表进出场、骨架屏、数字滚动、状态切换），以及空状态、错误状态组件；重做应用外壳（可折叠图标侧边栏、面包屑、主题切换）
- **现有页面改造（web）**：用户管理、模型配置、日志、系统状态、个人中心按新设计系统重做，消除整页平铺（采用主从布局、侧滑详情、标签页）
- **语种识别**：Python 基于 lingua 识别 15 种支持语种，置信度低时由 LLM 兜底；Spring 对外提供识别接口；工作台输入时自动识别
- **术语库**：个人术语库和公共术语库（管理员维护）；术语增删改查、CSV 导入（带预览和冲突报告）与导出；Python 只读匹配术语（最长匹配优先、区分中日韩与拉丁文字的边界规则）
- **短文本翻译 Agent**：LangGraph 状态图包含 analyze / plan / retrieve / translate / review / refine / finalize 七个节点，有快速和标准两条路径；评审节点按 MQM 维度打分，不达标时最多修正 2 轮；finalize 节点做规则化的术语遵循校验
- **流式执行与可观测**：Python → Spring → 浏览器两跳 SSE，推送节点事件、译文增量、评审结果和最终结果；浏览器断开时逐级取消上游调用；Spring 在结束时写入翻译记录和 Agent 执行轨迹
- **翻译工作台（web）**：左右分栏编辑器、语种选择与自动识别、风格/领域/术语库/模型设置弹层、可收起的 Agent 面板（执行时间线、评审意见、术语命中三个标签页）、译文中高亮术语
- **翻译历史（web + Spring）**：分页检索、收藏、删除；侧滑详情展示原文译文对照、执行轨迹回放和术语命中
- **调用限流**：每个用户的翻译请求按分钟限流

## Capabilities

### New Capabilities

- `ui-design-system`：设计令牌、暗色模式、动效规范与组件、应用外壳、空状态/加载/错误状态、信息分层（禁止整页平铺）
- `language-detection`：支持语种清单、文本语种识别（lingua + LLM 兜底）、识别接口
- `glossary`：术语库与术语管理、可见性（个人/公共）、CSV 导入导出、术语匹配
- `text-translation-agent`：短文本翻译 Agent 编排（节点、路径规划、评审修正、术语遵循校验）、翻译参数、TranslationContext
- `translation-streaming`：SSE 事件协议、两跳转发、心跳、取消、错误事件、调用限流
- `translation-history`：翻译记录与 Agent 轨迹持久化、历史检索、收藏、删除、详情回放

### Modified Capabilities

- `ai-service-foundation`：修改「数据库最小权限」，`tl_ai` 的只读授权范围扩大到术语表 `biz.glossary`、`biz.glossary_term`
- `model-config`：新增需求「可用模型选项」，已登录用户可以查询已启用模型的选项列表（只含 id、名称、提供方、是否默认），用于工作台选择模型

## 非目标

- 不做长文档翻译、文件上传、异步任务、断点续译（属于 ③）
- 不做会话上下文、歧义追问（interrupt）、翻译记忆与向量检索（属于 ④）
- 不引入 LangGraph checkpointer（短文本一次执行即完成，没有恢复需求，留到 ③）
- 不做消融实验和指标评测脚本（属于 ⑤）；本次只采集评测需要的原始数据（每个节点的耗时、token、评审分）
- 不做多人协作术语库、术语审批流程
- 不做 fastText 识别器（放到 ⑤ 作为对比实验）

## 依赖关系（对照 docs/总体设计.md 路线图）

- 依赖 ①（已归档）：认证与 RBAC、`Result<T>` 与错误码、模型配置与 LLM 适配层（含重试）、AI 服务客户端、traceId
- 为 ③ 提供：设计系统、Agent 节点（translate / review / refine 可复用到逐块翻译）、术语匹配、SSE 协议、翻译记录模型
- 为 ④ 提供：TranslationContext 的 terms / domain_hint / style 字段，以及工作台的交互框架
- 为 ⑤ 提供：agent_trace 中的节点耗时、token 和评审分数据

## Impact

- **web**：新增依赖 motion、next-themes；`src/styles` 设计令牌；`src/components/{motion,layout,feedback}`；重做 `(main)` 下全部页面；新增 `translate`、`glossaries`、`history` 路由
- **springboot-backend**：新增依赖 spring-webflux（只用 WebClient 消费上游 SSE）；Flyway V2（glossary、glossary_term、translation_record、agent_trace 四张表及授权）；新增 `module/{translate,glossary,history}`
- **python-backend**：新增依赖 langgraph、lingua-language-detector；新增 `app/agent/`（状态、节点、图、提示词）、`app/lang/`、`app/glossary/`、`app/api/internal/{lang,translate}.py`
- **对外 API**：`/api/translate/*`、`/api/glossaries/*`、`/api/translations/*`、`/api/model-configs/options`
- **内部 API**：`/internal/lang/detect`、`/internal/translate/stream`
