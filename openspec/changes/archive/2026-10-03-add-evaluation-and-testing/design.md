## Context

- 平台功能已全部就绪（①②③ 已归档，主规格 15 个能力）。③ 的文档任务支持 `options{contextWindow, globalSummary, termExtraction, review}` 与 `strategy`，并通过 doc_task_trace 记录逐块耗时与 token
- 测试用 LLM 为 OpenAI 兼容中转站（译者默认 `gpt-5.6-luna`，同站还提供 `gpt-6-luna` 等），延迟 3–60 秒且偶发 TLS 失败
- 网络：raw.githubusercontent.com、dl.fbaipublicfiles.com 可访问；huggingface.co 不可访问
- 开发机内存紧张；Docker Hub 不可访问
- 已知局限（③ 测试记录）：术语遵循按子串匹配存在中文误判；task.latencyMs 为墙钟时间

## Goals / Non-Goals

**Goals:**

- 用可复现的数据回答三个问题：① 各项 Agent 能力（上下文、摘要、术语、评审）分别带来多少质量提升？代价（token、耗时）是多少？② 三种分块策略的质量与速度如何取舍？③ 平台在本地单机上的性能上限是多少？
- 评测代码独立、可断点续跑、结果可追溯（记录模型、配置、时间、git commit）
- 产出可以直接放进论文的表格与图

**Non-Goals:**

- 见 proposal「非目标」

## Decisions

### D1. 评测工程与黑盒原则

```
evaluation/
├─ pyproject.toml / uv.lock
├─ eval/
│  ├─ config.py          # 读取根目录 .env 与 evaluation/config.toml（平台地址、账号、评审模型、并发）
│  ├─ client.py          # 平台客户端：登录与刷新、创建文档任务、轮询、取段落与轨迹、短文本 SSE 翻译
│  ├─ dataset/           # 测试集获取与清洗（k8s、flores、lid）
│  ├─ metrics/           # chrf_bleu.py、mqm_judge.py、terminology.py、cost.py
│  ├─ ablation/          # runner.py（篇章 D0–D5 与句子级）、aggregate.py、plots.py
│  ├─ lid/               # benchmark.py
│  └─ perf/              # locustfile.py、run.py、report.py
├─ mock_llm/server.py    # OpenAI 兼容 mock（性能测试用）
├─ data/                 # 清洗后的测试集（入库）+ manifest.json（来源 URL、commit、sha256）
├─ results/              # 原始结果 JSONL（入库，便于复核）
└─ tests/                # 指标与清洗逻辑的单元测试
```

- **决策**：篇章与句子级实验一律通过 Spring 对外接口执行（登录 → 创建任务 → 轮询 → 取结果），与真实用户路径一致。**备选**：直接 import python-backend 的图。**理由**：黑盒评测验证的是"平台"而不是"某个函数"，结果更可信；评测工程不依赖业务代码的内部结构
- 语种识别实验是离线的库对比，不经过平台

### D2. 篇章级测试集（Kubernetes 文档）

- **选文**：5 篇概念文档，英文原文 2k–8k 字符，内容覆盖概念说明、列表、表格、代码块：`concepts/workloads/pods/_index.md`、`concepts/workloads/controllers/deployment.md`（截取前若干节，控制在 8k 以内）、`concepts/services-networking/service.md`（截取）、`concepts/configuration/configmap.md`、`concepts/storage/volumes.md`（截取）。同时固定 kubernetes/website 的 commit SHA，写入 manifest
- **清洗规则**（中英文分别处理，然后人工抽查）：
  1. 去掉 YAML front matter
  2. 中文页：删除全部 `<!-- ... -->` 注释（其中是英文原文和审阅元数据）
  3. Hugo 短代码：`{{< glossary_tooltip text="X" ... >}}` → `X`；`{{< note >}}` / `{{< /note >}}` 等容器类短代码删除标签、保留内容；`{{< feature-state ... >}}`、`{{% code_sample ... %}}` 等整行删除
  4. 截取时中英文按相同的二级标题边界截断，保证内容对应
- **金标术语表**（`data/k8s/terms.json`）：每篇 10–20 条，取自 Kubernetes 中文本地化术语表与参考译文中的实际用法，格式 `{source, target, variants:[其他可接受或常见的错误译法], caseSensitive, kind:"term"|"proper_noun"}`。例如 `Pod → Pod`（变体：豆荚、容器组）、`Deployment → Deployment`（变体：部署）、`node → 节点`
- **决策**：参考译文只用于 d-chrF / d-BLEU（文档级），不做段落对齐。**理由**：官方中文译文是本地化改写，与原文并非逐段对应；文档级指标对这种差异更稳健。段落级质量交给无参考的 LLM 评审

### D3. 句子级与语种识别数据（FLORES-200）

- 下载 `flores200_dataset.tar.gz`（dl.fbaipublicfiles.com），校验 sha256 后解压到临时目录（不入库），抽取：
  - 句子级：devtest 中 `eng_Latn` / `zho_Hans` 的前 100 句平行对 → `data/flores/en-zh.100.jsonl`
  - 语种识别：15 种语种（zho_Hans、eng_Latn、jpn_Jpan、kor_Hang、fra_Latn、deu_Latn、spa_Latn、rus_Cyrl、por_Latn、ita_Latn、arb_Arab、tha_Thai、vie_Latn、ind_Latn、tur_Latn）的 devtest 句子，每种语种按固定随机种子生成三档样本各 100 条：单词（≥5 字符；中日泰无空格语言取 2–4 字）、词组（2–3 个词；中日泰取 5–10 字）、整句 → `data/lid/samples.jsonl`
- 下载失败时报错并提示手动放置压缩包，不静默降级

### D4. 翻译质量指标

| 指标 | 定义 | 实现 |
|---|---|---|
| d-chrF | 整篇译文与整篇参考的 chrF（char n-gram=6，word n-gram=0） | sacrebleu `CHRF` |
| d-BLEU | 整篇 BLEU，`tokenize="zh"` | sacrebleu `BLEU` |
| MQM 分 | 逐块把（原文段落、译文段落）交给评审模型，按 GEMBA-MQM 提示词输出错误 `{category: accuracy/fluency/terminology/style/locale, severity: critical/major/minor, span}`；罚分为 critical 25、major 5、minor 1；报告每千源词罚分，越低越好 | `metrics/mqm_judge.py`，评审模型默认 `gpt-6-luna`（与译者不同），temperature 0，JSON 输出加容错；评审结果按（文档、配置、块、译文 hash）缓存 |
| 术语准确率 | 对金标表中每条术语在原文段落中的每次出现（按词边界与大小写规则匹配，跳过行内代码），检查**对应译文段落**中出现金标译法的次数，按出现次数计算比例：`min(译文中金标译法次数, 原文出现次数) / 原文出现次数` 的加权平均 | `metrics/terminology.py` |
| 术语一致率 | 对每条术语，在所有出现该术语的段落中，统计译文使用的译法（金标 + 变体）；一致率 = 最常用译法的次数 / 识别出的译法总次数；按术语取平均 | 同上 |
| 专名一致率 | 同术语一致率，只统计 `kind=proper_noun` 的条目 | 同上 |
| 成本 | prompt / completion token（任务汇总）；**逐块耗时之和**（来自 trace，排除排队与等待）；墙钟时间 | `metrics/cost.py` |

- **决策**：术语准确率按出现次数比对，而不是像平台的遵循校验那样只判断"是否出现"。**理由**：修正 ③ 中记录的子串误判，例如同段含"可部署单元"导致 Deployment→部署 被误判为遵循。评测指标必须比被测系统更严格
- 所有指标函数都有单元测试，用手工构造的小样本校验数值

### D5. 消融实验执行器

```
for doc in 5 篇:
    for group in [D0, D1, D2, D3, D4, D5] (+ D4 重复 1 次):
        task = POST /api/doc-tasks {text, targetLang:"zh", strategy, confirmTerms:false, options, modelConfigId, glossaryIds:[]}
        poll GET /api/doc-tasks/{id} 直到 COMPLETED/FAILED（FAILED 时调用 retry，最多 2 次）
        segments = GET .../segments；traces = GET .../traces
        写 results/doc/{doc}__{group}__{run}.json（任务配置、段落、trace、用量、时间戳、git commit、模型名）
指标计算与运行解耦：aggregate.py 读取全部结果文件，计算指标，输出 results/doc_metrics.csv
```

| 组 | contextWindow | globalSummary | termExtraction | review | strategy |
|---|---|---|---|---|---|
| D0 | ✗ | ✗ | ✗ | ✗ | parallel |
| D1 | ✓ | ✗ | ✗ | ✗ | serial |
| D2 | ✓ | ✓ | ✗ | ✗ | serial |
| D3 | ✓ | ✓ | ✓ | ✗ | serial |
| D4 | ✓ | ✓ | ✓ | ✓ | serial |
| D5 | ✓ | ✓ | ✓ | ✓ | parallel |
| D6（附加） | ✓ | ✓ | ✓ | ✓ | hybrid |

- **不使用术语库**（glossaryIds 为空），这样术语指标反映的是 Agent 自身抽取和一致性机制的效果，而不是人工术语库
- **并发**：同时最多 2 个任务（与平台的用户并发上限一致）；已存在结果文件的组合跳过（断点续跑）
- **句子级**：FLORES 100 句分别以 `mode=fast` 和 `mode=standard` 调用 `/api/translate/stream`，计算语料级 chrF / BLEU，并统计评审修正触发率与 token 成本
- **可复现性**：所有调用记录模型名与 git commit；LLM 输出存在随机性，用 D4 的重复运行估计波动，并在报告中给出两次运行之差

### D6. 语种识别对比

- 识别器：lingua（高精度、低精度两种模式，限定 15 种语种）、fastText `lid.176.ftz`（下载并校验，映射到 15 种语种，不在范围内的预测视为错误）、langdetect（固定种子）、LLM（每次批量识别 25 条，返回 JSON，每档每语种抽 10 条以控制成本）
- 指标：按三档长度与语种统计准确率，输出混淆最多的语种对；吞吐（条/秒，LLM 单独报告平均延迟）
- 结果：`results/lid_metrics.csv`、热力图与分档柱状图

### D7. 性能测试

- **mock LLM**（`mock_llm/server.py`，FastAPI）：实现 `/v1/chat/completions`（流式与非流式）。根据请求判断返回形态：`response_format=json_object` 时，按系统提示词关键词返回评审 JSON（`{"score":95,"issues":[]}`）、分块翻译 JSON（解析用户消息中的 segments，逐段返回"【译】原文"）、术语抽取 JSON（空列表）；其他情况返回纯文本。延迟参数：首 token 延迟、每 token 间隔，可通过环境变量配置（默认 200 ms + 20 ms）
- **压测对象**：在模型配置中新增指向 mock 的配置（`OPENAI_COMPATIBLE`，`http://127.0.0.1:9100/v1`），压测时把它设为默认；压测结束后恢复
- **场景**（Locust，headless）：
  1. REST：登录后循环请求历史分页、术语库列表、任务列表
  2. 短文本流式：`/api/translate/stream`，`mode=fast`，记录首事件时间（TTFE）与完成时间
  3. 文档任务吞吐：批量提交 20 个 short-note 任务（mock 下几秒一个），测量全部完成的时间与 tasks/min
- **档位**：并发 10 / 50 / 100 用户各 60 秒（文档场景单独执行）；记录 RPS、p50/p95/p99、错误率；限流（每用户每分钟 20 次翻译）会影响短文本场景，压测账号数 ≥ 并发数，脚本预先批量注册压测账号
- **结果**：`results/perf/*.csv`（Locust 原始 stats）与汇总表

### D8. 覆盖率与测试报告

- Spring：jacoco-maven-plugin 在 `verify` 阶段生成 `target/site/jacoco/jacoco.csv`
- Python：`pytest --cov=app --cov-report=xml`
- Web：`vitest run --coverage`（v8），只统计 `src/lib` 与 `src/hooks`（UI 组件靠截图与走查验证，在报告中说明）
- `evaluation/eval/report_tests.py` 解析三端的测试结果与覆盖率，生成 `docs/test/测试报告.md`：测试环境、各工程测试数与通过率、按模块的行覆盖率、规格能力与测试的对照表（链接到各阶段冒烟测试记录）、已知局限

### D9. 实验报告

- `docs/experiments/实验报告.md` 由主控根据结果撰写：实验目的、设置（模型、测试集、指标、配置表）、结果表（每组 × 每指标的均值与每篇明细）、图（消融柱状图、质量-成本散点图、策略对比、LID 分档准确率与热力图、压测曲线）、分析（每项能力的贡献、代价与收益、异常与失败案例）、局限（LLM 评审的偏差、单次运行的随机性、测试集规模、参考译文的本地化差异）
- 图表用 matplotlib 生成 PNG，中文字体使用 Microsoft YaHei（找不到时回退到 SimHei 或 Noto Sans CJK），统一配色

## Risks / Trade-offs

- [LLM 调用量大、耗时长] → 估算：5 篇 × 7 组（含重复）× 平均 4–8 块 ≈ 35 个任务，单任务 1–3 分钟，并发 2 约 40–60 分钟；MQM 评审约 200 次调用。执行器支持断点续跑，评审有缓存
- [LLM 评审有偏差（偏好某种译法、对长文本打分不稳）] → 评审模型与译者不同；temperature 0；报告中把 MQM 作为参考指标，与 chrF 和术语指标相互印证
- [参考译文是本地化改写] → chrF 绝对值偏低属正常，关注组间相对差异
- [网络抖动导致个别任务失败] → 执行器自动 retry（利用 ③ 的断点续译）；最终仍失败的组合在报告中列出
- [压测受限流影响] → 每个虚拟用户使用独立账号；REST 场景不受翻译限流影响
- [fastText 模型下载失败] → 报错并提示手动放置；lid 实验允许跳过该识别器，并在报告中注明

## Migration Plan

- 只新增工程与开发依赖，不改变平台行为；mock 模型配置在压测脚本结束时自动停用

## Open Questions

- 评审模型使用 `gpt-6-luna`；如果中转站不支持该模型的 OpenAI 兼容调用，改用 Anthropic 协议或换用同站其他模型，并在报告中注明
