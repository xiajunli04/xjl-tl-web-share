# 文档任务 Redis Stream 消息样例（契约基准）

对应 `openspec/changes/add-document-translation-agent/design.md` 的 D2。

**线上格式约定**：下面每个代码块中的每一行都是一条 Stream 消息的全部字段，以 JSON 对象展示以便阅读。实际写入 Redis 时，**所有字段值都是字符串**：`taskId`、`eventSeq` 是数字字符串；`payload`、`data` 是对应对象的**单行 JSON 字符串**（`ensure_ascii=False`，无缩进）。

示例文档（`payload.text`），共 4 段、按二级标题切成 2 块，满足 `拼接(prefix + source + suffix) == 原文`：

```text
# GPU Basics

A GPU accelerates training.

## Usage

Use the GPU for each epoch.
```

## 1. 任务流 `tl:doc-tasks`（Spring → Python，消费组 `ai-worker`）

```jsonl
{"cmd": "start", "taskId": "42", "traceId": "doc-42-a", "payload": {"userId": 1, "title": "GPU Basics", "format": "md", "text": "# GPU Basics\n\nA GPU accelerates training.\n\n## Usage\n\nUse the GPU for each epoch.\n", "sourceLang": "auto", "targetLang": "zh", "style": "faithful", "domain": null, "glossaryIds": [1], "modelConfigId": null, "strategy": "serial", "confirmTerms": true, "options": {"contextWindow": true, "globalSummary": true, "termExtraction": true, "review": true}}}
{"cmd": "resume", "taskId": "42", "traceId": "doc-42-b", "data": {"terms": [{"source": "GPU", "target": "图形处理器"}, {"source": "epoch", "target": "训练轮次"}]}}
{"cmd": "retry", "taskId": "42", "traceId": "doc-42-c", "payload": {"userId": 1, "title": "GPU Basics", "format": "md", "text": "# GPU Basics\n\nA GPU accelerates training.\n\n## Usage\n\nUse the GPU for each epoch.\n", "sourceLang": "auto", "targetLang": "zh", "style": "faithful", "domain": null, "glossaryIds": [1], "modelConfigId": null, "strategy": "serial", "confirmTerms": true, "options": {"contextWindow": true, "globalSummary": true, "termExtraction": true, "review": true}}}
{"cmd": "cancel", "taskId": "42"}
```

## 2. 事件流 `tl:doc-events`（Python → Spring，消费组 `spring`）

### 2.1 开启术语确认的完整执行（start → awaiting_confirm → resume → completed）

第 9 条 `awaiting_confirm` 之后，worker 释放并发槽；Spring 收到用户确认后写入 `resume` 命令，执行从第 10 条继续。第 2 块的段 3 首译时未遵循术语，一致性阶段把它统一为任务术语表的译法。

```jsonl
{"taskId": "42", "eventSeq": "1", "type": "phase", "traceId": "doc-42-a", "data": {"phase": "parsing"}}
{"taskId": "42", "eventSeq": "2", "type": "parsed", "traceId": "doc-42-a", "data": {"segments": [{"seq": 0, "blockType": "heading", "prefix": "# ", "source": "GPU Basics", "suffix": "\n\n", "translatable": true, "level": 1}, {"seq": 1, "blockType": "paragraph", "prefix": "", "source": "A GPU accelerates training.", "suffix": "\n\n", "translatable": true}, {"seq": 2, "blockType": "heading", "prefix": "## ", "source": "Usage", "suffix": "\n\n", "translatable": true, "level": 2}, {"seq": 3, "blockType": "paragraph", "prefix": "", "source": "Use the GPU for each epoch.", "suffix": "\n", "translatable": true}], "chunks": [{"index": 0, "segSeqs": [0, 1], "group": 0}, {"index": 1, "segSeqs": [2, 3], "group": 1}], "detectedLang": "en", "confidence": 0.98}}
{"taskId": "42", "eventSeq": "3", "type": "trace", "traceId": "doc-42-a", "data": {"seq": 1, "node": "parse", "status": "completed", "summary": "解析 4 段，切分为 2 块，识别为英语（98%）", "latencyMs": 42}}
{"taskId": "42", "eventSeq": "4", "type": "phase", "traceId": "doc-42-a", "data": {"phase": "analyzing"}}
{"taskId": "42", "eventSeq": "5", "type": "analysis", "traceId": "doc-42-a", "data": {"summary": "本文简要介绍 GPU 在模型训练中的作用及其使用方式。", "domain": "计算机", "genre": "技术文档", "candidates": [{"source": "GPU", "target": "图形处理器", "origin": "glossary", "frequency": 3}, {"source": "epoch", "target": "轮次", "origin": "extracted", "frequency": 1}, {"source": "training", "target": "训练", "origin": "extracted", "frequency": 1}]}}
{"taskId": "42", "eventSeq": "6", "type": "trace", "traceId": "doc-42-a", "data": {"seq": 2, "node": "analyze", "status": "completed", "summary": "生成全文摘要；领域：计算机；抽取 2 个候选术语", "latencyMs": 3120, "usage": {"promptTokens": 310, "completionTokens": 96}}}
{"taskId": "42", "eventSeq": "7", "type": "trace", "traceId": "doc-42-a", "data": {"seq": 3, "node": "align_terms", "status": "completed", "summary": "术语库命中 1 条，抽取 2 条，合并后 3 条候选", "latencyMs": 3}}
{"taskId": "42", "eventSeq": "8", "type": "phase", "traceId": "doc-42-a", "data": {"phase": "awaiting_confirm"}}
{"taskId": "42", "eventSeq": "9", "type": "awaiting_confirm", "traceId": "doc-42-a", "data": {"candidates": [{"source": "GPU", "target": "图形处理器", "origin": "glossary", "frequency": 3}, {"source": "epoch", "target": "轮次", "origin": "extracted", "frequency": 1}, {"source": "training", "target": "训练", "origin": "extracted", "frequency": 1}]}}
{"taskId": "42", "eventSeq": "10", "type": "phase", "traceId": "doc-42-a", "data": {"phase": "translating"}}
{"taskId": "42", "eventSeq": "11", "type": "trace", "traceId": "doc-42-a", "data": {"seq": 4, "node": "confirm_terms", "status": "completed", "summary": "用户确认 2 条术语，拒绝 1 条", "latencyMs": 0}}
{"taskId": "42", "eventSeq": "12", "type": "chunk_done", "traceId": "doc-42-a", "data": {"chunk": 0, "segments": [{"seq": 0, "target": "图形处理器基础", "reviewScore": 95, "reviewRounds": 0, "compliance": [{"source": "GPU", "target": "图形处理器", "compliant": true}]}, {"seq": 1, "target": "图形处理器可加速训练。", "reviewScore": 95, "reviewRounds": 0, "compliance": [{"source": "GPU", "target": "图形处理器", "compliant": true}]}], "usage": {"promptTokens": 520, "completionTokens": 48}, "latencyMs": 4210, "cached": false}}
{"taskId": "42", "eventSeq": "13", "type": "trace", "traceId": "doc-42-a", "data": {"seq": 5, "node": "translate_chunk", "status": "completed", "chunk": 0, "summary": "第 1/2 块：翻译 2 段，评审 95 分", "latencyMs": 4210, "usage": {"promptTokens": 520, "completionTokens": 48}}}
{"taskId": "42", "eventSeq": "14", "type": "chunk_done", "traceId": "doc-42-a", "data": {"chunk": 1, "segments": [{"seq": 2, "target": "用法", "reviewScore": 88, "reviewRounds": 1, "compliance": []}, {"seq": 3, "target": "每个训练轮次都使用 GPU。", "reviewScore": 88, "reviewRounds": 1, "compliance": [{"source": "GPU", "target": "图形处理器", "compliant": false}, {"source": "epoch", "target": "训练轮次", "compliant": true}]}], "usage": {"promptTokens": 980, "completionTokens": 90}, "latencyMs": 8030, "cached": false}}
{"taskId": "42", "eventSeq": "15", "type": "trace", "traceId": "doc-42-a", "data": {"seq": 6, "node": "translate_chunk", "status": "completed", "chunk": 1, "summary": "第 2/2 块：翻译 2 段，评审 72→88 分（修正 1 轮）", "latencyMs": 8030, "usage": {"promptTokens": 980, "completionTokens": 90}}}
{"taskId": "42", "eventSeq": "16", "type": "phase", "traceId": "doc-42-a", "data": {"phase": "consistency"}}
{"taskId": "42", "eventSeq": "17", "type": "consistency", "traceId": "doc-42-a", "data": {"issues": [{"term": "GPU", "variants": [{"text": "图形处理器", "count": 2}, {"text": "GPU", "count": 1}], "chosen": "图形处理器", "fixedSegs": [3], "unresolvedSegs": []}], "segments": [{"seq": 3, "target": "每个训练轮次都使用图形处理器。"}]}}
{"taskId": "42", "eventSeq": "18", "type": "trace", "traceId": "doc-42-a", "data": {"seq": 7, "node": "consistency", "status": "completed", "summary": "发现 1 处不一致，已修正 1 段", "latencyMs": 2400, "usage": {"promptTokens": 150, "completionTokens": 20}}}
{"taskId": "42", "eventSeq": "19", "type": "phase", "traceId": "doc-42-a", "data": {"phase": "assembling"}}
{"taskId": "42", "eventSeq": "20", "type": "completed", "traceId": "doc-42-a", "data": {"usage": {"promptTokens": 1960, "completionTokens": 254}, "latencyMs": 21500, "stats": {"chunks": 2, "cachedChunks": 0, "refined": 1, "compliance": {"ok": 3, "total": 3}}}}
```

### 2.2 失败后 retry：已完成的块以缓存上报

同一任务的 eventSeq 在 retry 后继续递增（不会回退）；`cached=true` 的块没有调用 LLM，用量为 0。Spring 照常按 eventSeq 去重。

```jsonl
{"taskId": "42", "eventSeq": "30", "type": "phase", "traceId": "doc-42-c", "data": {"phase": "translating"}}
{"taskId": "42", "eventSeq": "31", "type": "chunk_done", "traceId": "doc-42-c", "data": {"chunk": 0, "segments": [{"seq": 0, "target": "图形处理器基础", "reviewScore": 95, "reviewRounds": 0, "compliance": [{"source": "GPU", "target": "图形处理器", "compliant": true}]}, {"seq": 1, "target": "图形处理器可加速训练。", "reviewScore": 95, "reviewRounds": 0, "compliance": [{"source": "GPU", "target": "图形处理器", "compliant": true}]}], "usage": {"promptTokens": 0, "completionTokens": 0}, "latencyMs": 0, "cached": true}}
```

### 2.3 失败与取消

```jsonl
{"taskId": "43", "eventSeq": "9", "type": "failed", "traceId": "doc-43-a", "data": {"code": "C0122", "message": "LLM 调用超时", "retryable": true}}
{"taskId": "44", "eventSeq": "5", "type": "cancelled", "traceId": "doc-44-a", "data": {}}
```

## 附：improve-agent-from-experiments（⑥）新增字段

以上样例保持 ③ 时的原貌（测试以"样例字段 + 下列新增字段"比对）。⑥ 新增的字段均为可选，旧消费方忽略即可：

| 位置 | 字段 | 说明 |
|---|---|---|
| start / retry 命令 `payload` | `reviewModelConfigId` | 评审模型配置 id；Spring 创建任务时按"显式指定 → 管理员评审模型 → null"解析并持久化，`null` 表示评审使用译者模型 |
| `chunk_done.data` | `reviewIssues` | 最后一次评审的问题按严重度计数 `{"critical": n, "major": n, "minor": n}`；未评审或评审无法解析时为 `null` |
| 任务术语（执行端状态） | `binding` | `hard`（术语库命中、人工确认）/ `soft`（未确认时自动采用的抽取术语）；缺失时按 `hard` 处理 |
| 轨迹 | 节点 `review_model` | 评审模型不可用、退回译者模型时记录一条警告轨迹 |
| 短文本 `POST /internal/translate/stream` 请求体 | `reviewModelConfigId` | 同上，Spring 每次请求时解析 |
| 短文本 `event:review` | `reviewer`、`fallback` | 实际执行评审的模型显示名；是否因评审模型不可用而退回译者模型 |

示例（短文本评审事件，2026-10-03 实测）：

```
event:review
data:{"round":0,"score":100,"passed":true,"issues":[],"reviewer":"GPT-6 Luna（Anthropic协议）","fallback":false}
```

## 附：add-session-context-and-memory（④）新增事件与接口

完整字段定义见 `openspec/changes/archive/*-add-session-context-and-memory/design.md` D9。以下为 2026-10-04 真实后端实测的样例。

**短文本 / 会话事件流**

```
event:node
data:{"seq":6,"node":"retrieve","status":"completed","summary":"上下文包：0 条术语，领域=电商，风格=忠实；命中 1 条翻译记忆（最高 85%）","latencyMs":398,"detail":{"tmHits":[{"id":1,"source":"I bought the X200 headphones from your store last week.","target":"我上周从你们店里购买了X200耳机。","fuzzy":0.8545,"semantic":0.9401,"origin":"workbench","originRef":"2546"}],"sessionTurns":0}}

event:clarify
data:{"threadId":"turn:25402c2d10cd46d2","question":"这里的“bank”是指银行，还是河岸？","options":["银行","河岸"],"span":"the bank","reason":"多义词"}
```

- `clarify` 是终止事件：其后不再有 `final`，连接关闭，不产生翻译记录；Spring 把追问写入会话的 pending
- 恢复：`POST /api/translate/sessions/{id}/clarify` `{"threadId":"turn:25402c2d10cd46d2","answer":"银行"}` → 新的事件流（以 start 开始，从 clarify 节点之后继续），最终 `final.clarification = {"question","options","span","answer"}`
- `memory`（仅压缩会话记忆时出现，位于 final 之前）：`{"summary":"...","entities":[{"source","target","note"}],"memorizedUntil":3}`
- 修订：`POST /api/translate/sessions/{id}/revise` `{"recordId":2547,"instruction":"更口语一些"}` → plan 事件 `path=revise`，`final.revisionOf=2547`

**Spring → Python 内部接口**

| 接口 | 说明 |
|---|---|
| `POST /internal/translate/stream` | 请求体新增 `session`（recentTurns / summary / entities / toMemorize / clarifyEnabled / memorizedUntil / turnSeq）与 `revise`（recordId / baseSource / baseTarget / instruction），`mode` 新增 `revise` |
| `POST /internal/translate/resume` | `{threadId, answer, userId}`，返回 SSE；thread 不存在返回 error `A0440` |
| `DELETE /internal/translate/threads/{threadId}` | 放弃追问，仅接受 `turn:` 前缀 |
| `POST /internal/tm/entries` / `GET` / `DELETE /{id}` / `POST /internal/tm/search` | 翻译记忆写入、列表、删除与检索；模型不可用时写入返回 `C0160` |

**文档**：start/retry 的 `options.translationMemory`（缺省 true）；`chunk_done.data.segments[i].tmHits`（该段命中，0–1 条），Spring 存入 `doc_segment.tm_hits`。
