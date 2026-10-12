# 冒烟测试记录：add-document-translation-agent

- 日期：2026-10-03
- 环境：Windows 11；docker compose（pgvector/pgvector:pg17、redis:7-alpine）；Spring Boot 4.1.1 / JDK 25（18080）；Python 3.12 + LangGraph 1.2.12 + langgraph-checkpoint-postgres 3.1.2（8000，内置文档 worker，并发 2）；Next.js 16.3.8（3000）
- 测试用 LLM：OpenAI 兼容中转 `gpt-5.6-luna`（默认，model_config id=2）
- 测试文档：`docs/contracts/fixtures/k8s-guide.md`（3104 字符，4 块，含标题/嵌套列表/表格/代码块/HTML/行内代码/链接/占位符/CRLF 段落）、`short-note.txt`

## 1. 三端联调（9.1）

### 1.1 串行 + 人工确认术语 + 中途杀进程（任务 1，经接口驱动）

| 步骤 | 结果 |
|---|---|
| 上传 k8s-guide.md（multipart），serial，confirmTerms，术语库 1 | ✅ PENDING → PARSING → ANALYZING → AWAITING_CONFIRM，抽取 8 个候选 |
| 人工确认：修改 `Service`→保留英文、拒绝 `image`、新增 `rolling update→滚动更新`（origin=user） | ✅ 被拒绝项为 REJECTED，新增项 origin=user |
| 第 1/4 块完成后 **强制杀掉 Python** | 任务停在 TRANSLATING 1/4 |
| 重启 Python | ❌→✅ **发现缺陷并修复**：worker 恢复了未确认的 `resume` 消息，但因任务已越过待确认阶段而将其忽略并 ACK，任务卡死。修复为"resume 已生效但未执行完时从检查点继续"，并补回归测试（`93030dc`） |
| 修复后：取消 → 继续（retry） | ✅ CANCELLING → CANCELLED → PENDING → COMPLETED 4/4；轨迹显示第 1 块"命中分块缓存，未调用 LLM"，`cachedChunks=1` |
| 导出译文 Markdown 与原文对比 | ✅ 行数 60/60、CRLF 3/3、标题 4/4、表格行 5/5、列表项 8/8；代码块逐字相同；`` `kubectl get nodes` ``、链接、`{name}`、`%d`、HTML 块全部保留；确认的术语生效（`Service` 保留英文、"滚动更新"）。样例见 `k8s-guide.zh.md` |

### 1.2 并行 / 混合 + Spring 停机期间积压事件（任务 2、3）

| 步骤 | 结果 |
|---|---|
| 同时创建 parallel、hybrid 两个任务（不确认术语） | ✅ worker 并发 2，同时执行 |
| 两个任务处于 ANALYZING 时 **停掉 Spring 60 秒** | 停机期间 Python 继续执行，`tl:doc-events` 中 spring 组 lag=34，数据库停留在 ANALYZING 0/4 |
| 重启 Spring | ✅ 数秒内补处理全部积压事件（lag→0），两个任务均为 COMPLETED 4/4，数据与不停机一致 |

三种策略的结果（注意：任务 1 的耗时包含卡死与取消重试的时间，不可比较；任务 2、3 同时运行）：

| 任务 | 策略 | 耗时 | prompt / completion tokens | 术语遵循 | 一致性问题 |
|---|---|---|---|---|---|
| 1 | serial | （含中断，不可比） | 12376 / 5359 | 30/30 | 0 |
| 2 | parallel | 93.6 s | 14487 / 6709 | 29/29 | 0 |
| 3 | hybrid | 66.3 s | 12021 / 4884 | 35/35 | 0 |
| Python 线单独运行 | serial + 确认术语 | 147.5 s（不含等待确认） | 15669 / 6672 | 30/30 | 0 |

### 1.3 浏览器端（真实后端）

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| 1 | 任务中心展示真实任务（过期令牌自动续期后加载） | ✅ | 01-real-center.png |
| 2 | 新建对话框：上传 short-note.txt → 翻译设置 → 确认页 | ✅ 识别为纯文本、约 1 块、默认 D4 | 02-real-dialog-step3.png |
| 3 | 创建后跳转工作区，自动进入待确认术语，侧栏切到「术语」 | ✅ | 03-real-awaiting-terms.png |
| 4 | 在浏览器中手动新增术语 `glossary→术语表` 并确认（未填译法时按钮禁用） | ✅ | 04-real-add-term.png |
| 5 | 实时进度推进至完成，译文使用"术语表"，一致性标签页显示全文一致 | ✅ 30 s、3688 tokens | 05-real-completed.png |

## 2. UI/UX 验收（9.2）

截图位于 `ui/`（Web 线以 mock 走完整生命周期的精选；全量 43 张为亮色/暗色两套 + reduced-motion 对比）。

| 页面 / 状态 | 截图 | 信息分层 |
|---|---|---|
| 任务中心（有任务 / 空状态） | light-01-center、dark-00-center-empty | 统计卡片 + 分段筛选 + 卡片网格 |
| 新建对话框·实验选项（D2 / D0 预设） | light-05、dark-03 | 三步对话框，实验选项默认折叠 |
| 工作区·待确认术语 / 修改后 | light-09、light-10 | 双栏对照 + 侧栏术语卡片 + 固定确认按钮 |
| 工作区·2000 段翻译中 | dark-06 | 虚拟滚动双栏 + 概览侧栏 |
| 工作区·一致性报告与定位闪烁 | light-15、light-14 | 侧栏标签页 |
| 段落交互（悬停操作 / 重译结果 / 行内编辑） | light-17、light-20、dark-10 | 行内操作 + 弹层 |
| 轨迹 / 失败 / 继续时缓存重放 / 已取消 | light-22、light-25、light-27、dark-12 | 侧栏标签页、状态徽标 |
| reduced-motion 对比 | rm-motion-01、rm-reduced-01 | 减少动效时骨架无微光、脉冲光环隐藏 |

性能自查（Web 线）：2000 段文档连续滚动平均每帧 12 ms（p95 21 ms），可视区域仅约 23 行 DOM。

## 3. 自动化测试（9.3）

| 工程 | 结果 |
|---|---|
| springboot-backend `./mvnw verify` | 173 通过 / 0 失败 |
| python-backend `ruff check` + `pytest` | 215 通过 / 0 失败（含"确认术语后重启"回归测试） |
| web `lint` + `typecheck` + `test` + `build` | 70 通过；其余通过 |
| `openspec validate add-document-translation-agent --strict` | 通过 |

### 规格场景核对

| 规格 | 覆盖方式 |
|---|---|
| document-task | Spring `DocTaskApiTest`（创建四场景、并发 A0213、状态机、取消/继续/删除与 A0431、purge）、`DocExportTest`（结构保持逐字节一致）、`DocSseTest`（中途订阅 snapshot）、`DocStaleTaskDetector` 测试；联调 1.1/1.2 |
| document-agent | Python `test_doc_parse.py`（可逆切分、表格、保护标记、分块不跨章节）、`test_doc_graph.py`（术语库优先、关闭摘要、确认修改与拒绝、前块上下文、漏段补译、关闭评审、混合策略、一致性统一与未解决分支、单段重译）、`test_doc_worker.py`（进程重启续译两条路径、resume 后重启）；真实模型运行 |
| document-pipeline | Spring `DocEventConsumerTest`（样例序列终态、重复投递、停机积压补处理、pending 认领）；Python worker 测试（消费组、取消回报、中断释放并发、排队、purge）；联调 1.2 |
| document-workspace | Web vitest（GET 订阅、重连、状态合成与去重）；mock 全生命周期截图；浏览器真实联调 1.3 |

## 4. 已知局限与后续改进

1. **术语遵循的子串误判（中文）**：确认术语 `Deployment→部署` 时，"a controller such as a Deployment" 被译为"Deployment 等控制器"未使用"部署"，但同段含"最小的可**部署**单元"，子串匹配判定为遵循。后续可改为按术语在原文中的出现次数比对译文中的出现次数，或做分词级匹配
2. **执行中的 token 用量不实时**：浏览器 chunk_done 事件不含累计用量，顶栏用量在完成时才更新（Web 线建议补充累计字段）
3. **task.latencyMs 为墙钟时间**：包含中断、等待重试的时间，⑤ 的耗时统计应使用逐块 trace 的耗时之和
