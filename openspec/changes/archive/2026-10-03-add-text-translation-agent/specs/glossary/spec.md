## ADDED Requirements

### Requirement: 术语库管理
系统 SHALL 允许已登录用户创建、编辑、删除（逻辑删除）自己的术语库。术语库包含名称、描述、源语言、目标语言、领域和可见范围（`PRIVATE` 或 `PUBLIC`）。只有 ADMIN 可以创建或修改 `PUBLIC` 术语库。用户 MUST 只能看到自己的术语库和全部公共术语库，只能修改自己的术语库。

#### Scenario: 创建个人术语库
- **WHEN** 普通用户创建一个 en→zh、领域为"计算机"的术语库
- **THEN** 术语库以 PRIVATE 范围创建，`termCount=0`，只有该用户可见

#### Scenario: 普通用户不能创建公共库
- **WHEN** 普通用户创建术语库时传入 `scope=PUBLIC`
- **THEN** 系统返回 HTTP 403、code `A0301`

#### Scenario: 访问他人的私有库
- **WHEN** 用户 A 请求用户 B 的私有术语库的术语列表
- **THEN** 系统返回 HTTP 404、code `A0404`（不暴露资源是否存在）

#### Scenario: 公共库只读
- **WHEN** 普通用户尝试向公共术语库添加术语
- **THEN** 系统返回 HTTP 403、code `A0301`；列表中该库的 `editable=false`

### Requirement: 术语管理
系统 SHALL 允许术语库的拥有者增删改查术语（源术语、目标术语、备注、是否区分大小写）。同一术语库内的源术语 MUST 不区分大小写地唯一。增删术语时 MUST 同步更新术语库的 `termCount`。

#### Scenario: 添加重复术语
- **WHEN** 术语库中已有 "GPU"，用户再添加 "gpu"
- **THEN** 系统返回 HTTP 409、code `A0112`

#### Scenario: 计数同步
- **WHEN** 用户向空术语库添加 3 条术语后删除 1 条
- **THEN** 术语库的 `termCount` 为 2

### Requirement: CSV 导入与导出
系统 SHALL 支持以 UTF-8 CSV（列：`source,target,note`，首行为表头，可带 BOM）导入术语：先预览，返回总数、有效数、新增数、将覆盖数、逐行错误和样例；确认导入时按策略 `skip`（跳过已存在）或 `overwrite`（覆盖已存在）执行，并返回统计结果。单次导入 MUST 不超过 5000 行。系统 SHALL 支持把术语库导出为同样格式的 CSV。

#### Scenario: 预览导入
- **WHEN** 用户上传一个 10 行的 CSV，其中 2 行缺少目标术语、3 行与已有术语重复
- **THEN** 预览返回 `total=10, valid=8, newCount=5, updateCount=3`，errors 中列出 2 行及其行号

#### Scenario: 覆盖策略
- **WHEN** 用户选择 `overwrite` 确认导入上述文件
- **THEN** 返回 `inserted=5, updated=3, skipped=0, failed=2`

#### Scenario: 非法文件
- **WHEN** 用户上传的文件缺少 `source` 表头，或不是 UTF-8 文本
- **THEN** 系统返回 HTTP 400、code `A0421`

#### Scenario: 导出
- **WHEN** 用户导出一个有 3 条术语的术语库
- **THEN** 下载的 CSV 包含表头和 3 行数据，可以原样重新导入

### Requirement: 术语匹配
AI 服务 SHALL 在翻译时从所选术语库中匹配原文出现的术语：按源术语长度降序做最长匹配，已匹配的区间不重复匹配；拉丁和西里尔文字默认不区分大小写并要求词边界，中日韩和泰文按子串匹配。语言对与本次翻译不一致的术语库 MUST 被跳过，并在结果中注明。

#### Scenario: 最长匹配优先
- **WHEN** 术语库同时包含 "machine learning" 和 "learning"，原文为 "Machine learning is fun"
- **THEN** 只命中 "machine learning"，不单独命中 "learning"

#### Scenario: 词边界
- **WHEN** 术语库包含 "GPU"，原文为 "GPUs and eGPU"
- **THEN** "eGPU" 中的 GPU 不被命中

#### Scenario: 中文子串
- **WHEN** 术语库包含 "神经网络"，原文为 "卷积神经网络很强大"
- **THEN** 命中 "神经网络"

#### Scenario: 语言对不符
- **WHEN** 翻译方向为 en→ja，而所选术语库是 en→zh
- **THEN** 该术语库被跳过，`terms` 事件的 `skippedGlossaries` 中包含它的 id

### Requirement: 术语库页面交互
术语库页面 SHALL 采用主从布局：左侧按"我的 / 公共"分组列出术语库卡片，右侧显示所选术语库的术语表（搜索、行内编辑）。导入 SHALL 使用三步对话框（上传 → 预览与冲突 → 选择策略并确认）。

#### Scenario: 分步导入
- **WHEN** 用户点击「导入」并上传文件
- **THEN** 对话框进入第二步显示预览统计和错误行；确认后进入第三步并以动画展示导入结果
