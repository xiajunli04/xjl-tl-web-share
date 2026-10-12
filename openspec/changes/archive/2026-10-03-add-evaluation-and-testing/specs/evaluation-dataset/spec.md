## ADDED Requirements

### Requirement: 篇章级测试集
评测工程 SHALL 提供从 kubernetes/website 固定 commit 获取 5 篇概念文档英文原文及其官方简体中文译文的脚本，并按统一规则清洗：去除 front matter、去除中文页的全部 HTML 注释、把术语提示类短代码还原为其显示文本、删除容器类短代码的标签并保留内容、删除整行的功能状态和代码示例短代码。中英文 MUST 按相同的二级标题边界截取，单篇英文不超过 8000 字符。清洗结果与来源信息（URL、commit SHA、sha256）SHALL 写入 `evaluation/data/` 并纳入版本控制。

#### Scenario: 清洗短代码
- **WHEN** 原文包含 `{{< glossary_tooltip text="containers" term_id="container" >}}`
- **THEN** 清洗后该处为 `containers`

#### Scenario: 去除英文注释
- **WHEN** 中文页包含 `<!-- _Pods_ are the smallest deployable units ... -->`
- **THEN** 清洗后的中文参考译文中不含该注释及其中的英文

#### Scenario: 可追溯
- **WHEN** 查看 `evaluation/data/manifest.json`
- **THEN** 每个文件都记录了来源 URL、仓库 commit SHA 和清洗后内容的 sha256

### Requirement: 金标术语表
每篇篇章级测试文档 SHALL 附带 10–20 条人工整理的金标条目，每条包含源词、金标译法、变体列表（其他可接受译法或常见误译）、是否区分大小写、类型（术语或专名）。

#### Scenario: 条目格式
- **WHEN** 读取 `data/k8s/terms.json` 中 Pod 文档的条目
- **THEN** 包含 `{source:"Pod", target:"Pod", variants:[...], caseSensitive:true, kind:"term"}` 这样的结构

### Requirement: 句子级与语种识别数据
评测工程 SHALL 从 FLORES-200 压缩包（校验 sha256）中抽取 devtest 的 eng_Latn→zho_Hans 前 100 句平行对，以及 15 种支持语种的语种识别样本：每种语种三档长度（单词、词组、整句）各 100 条，用固定随机种子生成。下载失败时 MUST 报错并提示手动放置文件，MUST NOT 静默降级。

#### Scenario: 可复现抽样
- **WHEN** 两次执行语种识别样本生成
- **THEN** 生成的样本完全相同

#### Scenario: 下载失败
- **WHEN** 压缩包下载失败且本地没有缓存
- **THEN** 脚本以非零状态退出，提示手动放置路径
