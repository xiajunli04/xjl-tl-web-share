# add-session-context-and-memory 冒烟记录

> 日期：2026-10-04 · 代码版本：`6e863ad` 起

## 后端（真实 LLM，gpt-5.6-luna 译者 / gpt-6-luna 评审）

| 检查项 | 结果 |
|---|---|
| Flyway V5 迁移 | 启动日志 `Migrating schema "biz" to version "5 - session memory"`，成功 |
| embedding 模型 | `paraphrase-multilingual-MiniLM-L12-v2` 从本地缓存加载 3.6 秒；单句编码约 25 ms；进程常驻内存约 600 MB |
| 会话三轮 | retrieve 节点 `sessionTurns` 依次为 0、1、2；第 2 轮 "They stopped charging yesterday." 译为"它们昨天停止充电了"（指耳机） |
| 迭代修订 | 对第 2 轮提出"更口语一些"：plan `path=revise`，`final.revisionOf=2547`，译文"它们昨天就不充电了"；会话详情中第 2 轮有 2 个版本，新版本为采用版本 |
| 歧义追问 | "Please send it to the bank." 以 `clarify` 结束（"这里的'bank'是指银行，还是河岸？"）；回答"银行"后从断点继续，节点依次为 clarify → retrieve → translate → review → finalize，记录保存问答 |
| 翻译记忆 | 第 1 轮存入记忆后翻译 "I bought the X300 headphones from your shop last month."：命中 85%（语义 0.94），译文沿用"从你们店里购买了"的措辞 |
| 实验 | E1 10 次、E2 120 轮 × 2、E3 60 次请求，全部无失败（见实验报告第 10 节） |

## 前端（mock 模式，`NEXT_PUBLIC_MOCK_API=1 NEXT_PUBLIC_MOCK_STREAM=1`）

| 截图 | 检查点 |
|---|---|
| `01-session-thread.png` | 会话模式：对话线程卡片、v1/v2 版本条、追问问答展开项、修订输入与快捷要求芯片、会话记忆与追问开关 |
| `02-clarify-card.png` | 追问卡片：歧义片段高亮、选项按钮与"其他…"、判断依据；线程中该轮显示"等待你回答追问" |
| `03-clarify-resumed.png` | 回答后卡片收起，恢复执行完成，第 4 轮写入线程，状态栏显示评审分、耗时与 token |
| `04-memory-tab.png` | Agent 面板「记忆」标签页：92% 匹配度徽章、与当前原文不同的 "usually" 高亮、来源 |
| `05-memory-page.png` | `/memory` 主从布局：筛选与检索、列表、详情（命中次数、最近命中、来源定位） |
| `06-doc-segment-memory.png` | 文档工作区每段的「记忆 xx%」徽章，`?seq=9` 定位到第 9 段 |

布局均为分区组织（抽屉、线程、侧板、主从），没有整页平铺。动效统一走 `MotionConfig reducedMotion="user"`，组件内用 `useReducedMotion` 关闭缩放与位移。
