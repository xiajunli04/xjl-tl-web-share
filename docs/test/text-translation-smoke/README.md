# 冒烟测试记录：add-text-translation-agent

- 日期：2026-10-03
- 环境：Windows 11；docker compose（pgvector/pgvector:pg17、redis:7-alpine）；Spring Boot 4.1.1 / JDK 25（18080）；Python 3.12 FastAPI + LangGraph 1.2.12（8000）；Next.js 16.3.8（3000）
- 测试用 LLM：OpenAI 兼容中转 `gpt-5.6-luna`（默认，model_config id=2）；Anthropic 协议 `gpt-6-luna`（id=3）

## 1. 三端联调（9.1）

### 浏览器端（真实模型，浏览器直连 Spring）

| # | 场景 | 预期 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | 标准路径翻译 360 字符英文 | 译文逐字流式出现；评审完成后显示分数、耗时、token | ✅ 译文长度在 7.1–8.4 s 内连续增长 41→65→93→96→102；16.7 s 完成，评审 94 | 01-real-standard-done-light.png |
| 2 | 翻译进行 4 s 时点击「停止」 | 显示"已停止"，不写入历史，Python 取消任务 | ✅ 记录数不变；Python 日志"客户端已断开，取消翻译任务" | 02-real-stopped.png |
| 3 | 停止 Python 后翻译 | 错误状态显示 C0110 与 traceId，可重试 | ✅ `AI 服务不可用 C0110 traceId: 2ebf…` | 03-real-ai-down-c0110.png |
| 4 | 暗色 + 宽屏 + 选择术语库（3 条术语，GPU 出现两次） | Agent 面板展开；术语全部遵循并高亮 | ✅ 两处 GPU 均译为"图形处理器"，术语遵循 3/3，评审 100，跳过修正 | 04-real-terms-dark.png |
| 5 | 翻译历史 | 列表展示真实记录（语言对、路径、评分、耗时） | ✅ | 05-real-history-trace-dark.png |

### 接口层（curl，经 Spring）

| 场景 | 预期 | 结果 |
|---|---|---|
| en→zh 标准路径 + 术语库（3 条术语） | 完整事件流，final 含 recordId | ✅ 事件流见 `docs/contracts/real-run-via-spring.sse.txt`，术语 3/3，约 15.5 s |
| 选择 API Key 错误的模型 | `error` 事件 C0121 | ✅ |
| 目标语种 `xx` | 建流前返回 HTTP 400 + A0420 | ✅ |
| 日语文本识别 | `ja`，method=lingua | ✅ 置信度 1.0 |
| 中途取消 | 无新增记录 | ✅ |

## 2. UI/UX 验收（9.2）

截图位于 `ui/`（Web 线自查截图的精选；全量 103 张为亮色/暗色两套 + reduced-motion 对比）。

| 页面 | 亮色 | 暗色 | 信息分层（无整页平铺） |
|---|---|---|---|
| 翻译工作台 | light-01、light-06（修正轮次）、light-08（评审标签页） | dark-07（时间线）、dark-11（错误状态） | 左右分栏 + 设置弹层 + 可收起 Agent 面板（三标签页） |
| 术语库 | light-22（三步导入·预览） | dark-20 | 主从布局 + 分步对话框 |
| 翻译历史 | light-32（侧滑详情·对照） | dark-34（轨迹回放） | 列表 + 侧滑详情（三标签页） |
| 用户管理 | light-41 | — | 表格 + 侧滑分区详情 |
| 模型配置 | light-44（测试结果在卡片内） | — | 卡片网格 + 侧滑编辑 |
| 日志 | — | dark-47、dark-48（参数侧滑） | 单页两个标签页 |
| 系统状态 | light-50（AI DOWN） | — | 状态卡片 |
| 个人中心 | light-52 | — | 两个标签页 |

**减少动效（reduced-motion）**：`reduced-no-preference-history-enter-120ms.png` 与 `reduced-reduce-history-enter-120ms.png` 为进场第 120 ms 的对比。逐帧采样显示：默认模式存在 y 8px→0 的位移帧，开启 reduce 后位移帧为 0，只保留透明度过渡。

## 3. 自动化测试（9.3）

| 工程 | 命令 | 结果 |
|---|---|---|
| springboot-backend | `./mvnw verify` | 128 通过 / 0 失败 |
| python-backend | `uv run ruff check . && uv run pytest` | 115 通过 / 0 失败 |
| web | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` | 41 通过；lint/类型检查/构建通过 |
| openspec | `openspec validate add-text-translation-agent --strict` | 通过 |

### 规格场景核对

| 规格 | 覆盖方式 |
|---|---|
| ui-design-system | Web 截图（亮/暗、reduced-motion 对比、各页分层）；令牌检查（组件无硬编码颜色） |
| language-detection | Python `test_lang.py`（中/日/法、短文本兜底、空文本）；Spring 语种清单与 A0420 测试；浏览器自动识别（"自动识别：英语（100%）"） |
| glossary | Spring `module/glossary` 集成测试（可见性、唯一性、计数、CSV 预览/导入/导出/非法文件）；Python `test_glossary.py`（最长匹配、词边界、中文子串、语言对跳过）；Web 三步导入截图 |
| text-translation-agent | Python `test_agent.py`（路径规划、领域判定、评审修正/上限/JSON 损坏、术语遵循、占位符保护、风格差异）；真实模型标准路径 |
| translation-streaming | Spring `TranslateStreamTest`（17 个：事件顺序、换行 JSON、首事件 1 s、心跳、超时、取消、错误事件、限流）；Python `test_translate_stream.py`；Web `sse.ts` 测试（冒号后有无空格、心跳、CRLF、切块） |
| translation-history | Spring 历史接口测试（检索、隔离、收藏、删除、轨迹顺序、失败不入库）；浏览器历史页 |
| model-config（可用模型选项） | Spring 测试（无 baseUrl/apiKeyMask、停用不出现） |
| ai-service-foundation（最小权限） | Spring `TranslationSchemaTest`（tl_ai 可读术语表，不可写，不可读翻译记录/用户表） |

## 4. 联调中发现并修复的问题

1. **停止翻译后 Agent 偶尔仍在后台运行**：断开时生成器停在 yield 处，取消落在 send 上，生成器不会被唤醒，其 finally 不执行。已在响应对象层兜底取消后台任务（`f270de5`）。剩余边界：Spring 优雅关闭连接时，uvicorn 要等下一次写入才感知，因此最多会多跑完一次在途 LLM 调用，后续节点不再执行（已写入 design 风险清单）。
2. **Anthropic SDK 1.11 不接受 temperature**：凡带 temperature 的请求都会失败（① 的连通性测试恰好没带）。已在适配层忽略该参数。
3. **Spring 7 下游取消不会关闭上游连接**：`JdkClientHttpResponse` 对响应体做了 cache，下游取消传不到 JDK。改为每个流使用独立 HttpClient，结束时 `shutdownNow()`。
4. **导入预览样例字段前后端不一致**：前端按 `source/target` 解析，后端返回 `sourceTerm/targetTerm/exists`。已对齐，并在样例中标出"将覆盖"。
5. **error 事件缺少 traceId**：已补充，前端错误状态可直接复制 traceId 排查。
6. **主工作区 `uv sync` 下载 lingua 时 TLS 握手失败**：改用镜像安装缺失包（README 常见问题已说明）。
