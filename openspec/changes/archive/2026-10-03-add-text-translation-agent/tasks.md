## 1. infra：数据库扩展与契约基线

- [x] 1.1 在 `docker/postgres/init/01-roles.sh` 中补充 `CREATE EXTENSION IF NOT EXISTS pg_trgm`；对已有的开发库用超级用户手动执行一次，并在 README 常见问题中说明（验证：`\dx` 能看到 pg_trgm 和 vector）
- [x] 1.2 生成一份共享的 SSE 事件样例 `docs/contracts/translate-stream-sample.txt`（包含 fast 和 standard 两条路径、含 1 轮修正的完整事件序列，遵循 design D5），供三端测试使用（验证：人工核对与 D5 的事件表一致）

## 2. python-backend：语种识别与术语匹配

- [x] 2.1 `uv add langgraph lingua-language-detector`；新增 `app/lang/languages.py`（15 种语种的代码、中文名、本族语名称，以及与 lingua 枚举的映射）（验证：pytest 断言共 15 项且代码唯一）
- [x] 2.2 实现 `app/lang/detector.py`：限定语种的 lingua 单例，启动时预热；低置信度（< 0.5）或少于 4 个字符时调用 LLM 兜底；返回 `{lang, confidence, method, candidates}`（验证：pytest 覆盖中文、日语、法语、"Hi" 走 LLM 兜底（mock LLM）、空文本返回 A0410）
- [x] 2.3 实现 `POST /internal/lang/detect`（验证：带内部令牌请求时返回 00000，并符合契约）
- [x] 2.4 实现 `app/glossary/repository.py`（只读加载术语库和术语，按 id + updated_at 缓存）和 `app/glossary/matcher.py`（最长匹配、词边界与中日韩子串规则、语言对过滤、遵循校验函数）（验证：pytest 覆盖 glossary 规格中"术语匹配"的 4 个场景，以及遵循校验的大小写和边界规则）

## 3. python-backend：Agent 编排与流式接口

- [x] 3.1 实现 `app/agent/state.py`（TranslationState、TranslationContext、TermHit、Review、NodeTrace）和 `app/agent/prompts.py`（翻译、评审、修正、领域判定四套提示词；风格指令；占位符保护规则）（验证：pytest 用快照断言生成的提示词包含术语表、风格指令和保护规则）
- [x] 3.2 实现节点 analyze / plan / retrieve / finalize（不调用 LLM 的部分），以及 plan 的路径规则和 reason 文案（验证：pytest 覆盖 auto 模式下快速和标准两种判定、强制模式、领域判定只在标准路径触发）
- [x] 3.3 实现节点 translate / review / refine：通过 `get_stream_writer()` 推送 delta；评审使用 JSON 模式，解析失败视为通过并记录警告；阈值和最大轮次放在 settings 中（验证：用 mock LLM 覆盖一轮修正后通过、达到上限、评审 JSON 损坏三种情况）
- [x] 3.4 用 `app/agent/graph.py` 组装 StateGraph（条件边：路径选择、评审是否通过），每个节点统一包装事件推送（started/completed/skipped、摘要、耗时、usage）（验证：pytest 断言 fast 和 standard 路径的事件序列与 `translate-stream-sample.txt` 的结构一致）
- [x] 3.5 实现 `POST /internal/translate/stream`：EventSourceResponse、单行 JSON data、15 秒心跳、180 秒总超时（C0141）、客户端断开时取消图任务、异常转为 error 事件（C0140 / C01xx）（验证：pytest 用 httpx 流式读取，覆盖正常结束、超时、断开后任务被取消、LLM 鉴权失败返回 C0121）
- [x] 3.6 用真实测试模型（.env 中的 TEST_LLM_*）手动跑一次 en→zh 的标准路径翻译并保存事件日志（验证：日志中出现 review 事件，final 中 compliance 正确）

## 4. springboot-backend：数据与术语库

- [x] 4.1 编写 Flyway `V2__translation.sql`：glossary、glossary_term、translation_record、agent_trace 四张表，索引（含 pg_trgm GIN，扩展用 IF NOT EXISTS），以及对 `${ai_role}` 授予两张术语表的 SELECT；Testcontainers 的初始化脚本同步创建 pg_trgm（验证：迁移测试通过；以 tl_ai 身份读 glossary_term 成功、读 translation_record 被拒绝）
- [x] 4.2 在 ErrorCode 中新增 A0112、A0212、A0420、A0421、C0140、C0141，并新增语种常量与 `GET /api/translate/languages`（验证：单元测试覆盖新错误码的 HTTP 映射；接口返回 15 项）
- [x] 4.3 实现 `GET /api/model-configs/options`（验证：集成测试覆盖 model-config 规格中"可用模型选项"的两个场景，并断言响应里没有 baseUrl 和 apiKeyMask）
- [x] 4.4 实现术语库 CRUD 与可见性规则（个人/公共、editable 计算、他人私有库返回 404、公共库只有 ADMIN 能写）（验证：集成测试覆盖 glossary 规格中"术语库管理"的 4 个场景）
- [x] 4.5 实现术语 CRUD 与 termCount 维护、源术语不区分大小写唯一（A0112）（验证：集成测试覆盖"术语管理"的两个场景）
- [x] 4.6 实现 CSV 导入预览、确认导入（skip / overwrite）、导出；支持 BOM，限制 5000 行，表头或编码非法时返回 A0421（验证：集成测试覆盖"CSV 导入与导出"的 4 个场景，导出结果能原样重新导入）

## 5. springboot-backend：翻译流与历史

- [x] 5.1 引入 `spring-webflux`（不引入 starter-webflux），新增基于 WebClient 的 `AiStreamClient`：附加内部令牌和 traceId，把上游 SSE 解析为 `ServerSentEvent<String>`（验证：用 JDK HttpServer 模拟上游 SSE 的测试中，事件原样解析，含换行的 JSON 不被破坏；确认应用仍运行在 Tomcat 上）
- [x] 5.2 实现 `POST /api/translate/detect`：参数校验、每分钟 120 次限流、转发到 Python（验证：集成测试覆盖空文本返回 A0410、正常转发、限流）
- [x] 5.3 实现 `POST /api/translate/stream`：参数校验（长度、语种 A0420、源语言与目标语言相同）、术语库访问权限校验、每分钟 20 次限流（A0212，在建立流之前返回）、转发事件、合并 15 秒心跳、设置 `X-Accel-Buffering: no` 和 `Cache-Control: no-cache`、上游不可达时发出 error 事件（C0110）（验证：集成测试覆盖 translation-streaming 规格中的"错误事件"和"翻译调用限流"场景，以及首个事件在 1 秒内到达）
- [x] 5.4 收到 final 时写入 translation_record 和 agent_trace（在同一事务中），并把 recordId 补进 final；收到 error 或被取消时不落库；取消时断开上游连接（验证：集成测试覆盖成功后有记录、error 后无记录、客户端取消后上游连接被关闭且无记录）
- [x] 5.5 实现历史接口：分页检索（关键词、语言、收藏、时间范围）、详情（含按 seq 排序的轨迹）、收藏、逻辑删除，并做用户隔离（验证：集成测试覆盖 translation-history 规格中"历史检索"和"收藏与删除"的场景）

## 6. web：设计系统与外壳

- [x] 6.1 安装 motion、next-themes；在 `globals.css` 中用 `@theme` 定义设计令牌（中性色、品牌渐变、语义色、圆角、三级阴影、字体）以及亮色/暗色两套变量（验证：`pnpm build` 通过；用 grep 检查组件中没有硬编码颜色）
- [x] 6.2 实现 `src/components/motion/`：PageTransition（`template.tsx`）、StaggerList/StaggerItem、NumberTicker、FadeIn，以及基于 useReducedMotion 的降级（验证：分别开启和关闭 Playwright 的 reducedMotion 截图对比，开启后没有位移动画）
- [x] 6.3 实现 `src/components/feedback/`：EmptyState、ErrorState（traceId 可复制、带重试）、Skeleton 系列、ConfirmDialog；以及侧滑面板 Sheet 组件（spring 动画）（验证：用一个临时演示路由截图核对，核对后删除该路由）
- [x] 6.4 重做应用外壳：可折叠图标侧边栏（状态持久化、指示条位移动画、折叠时显示悬停提示）、面包屑、主题切换（亮/暗/跟随系统，首屏不闪烁）、用户菜单；导航按角色显示（验证：亮/暗两种主题、展开/折叠两种状态的截图；刷新后不闪白）

## 7. web：现有页面改造

- [x] 7.1 个人中心改为「基本资料 / 安全设置」两个标签页（验证：截图中同一时刻只有一个表单）
- [x] 7.2 用户管理改为表格 + 侧滑详情（基本信息 / 角色 / 安全操作三个分区），列表有进场动画和骨架屏（验证：截图核对布局；禁用等操作后状态徽标有过渡）
- [x] 7.3 模型配置改为卡片网格（提供方图标、状态灯、默认标记）+ 侧滑编辑表单 + 连通性测试结果动画（验证：截图，并录制测试连通性的过程）
- [x] 7.4 日志合并为一个页面的两个标签页（登录 / 操作），筛选放进工具条弹层，参数详情在侧滑面板中查看（验证：截图中没有整页平铺）
- [x] 7.5 系统状态改为状态卡片（呼吸灯）+ 自动刷新倒计时（验证：停掉 Python 后，卡片以过渡动画变为 DOWN）

## 8. web：翻译工作台、术语库、历史

- [x] 8.1 实现 `src/lib/sse.ts`（fetch + ReadableStream 的 SSE 解析器，支持 AbortSignal，整合令牌刷新）和 `src/lib/api/{translate,glossaries,history}.ts`，类型与 design D7 一致（验证：对解析器做单元测试，或用一个 tsx 脚本跑 `translate-stream-sample.txt`，断言事件和 JSON 解析正确）
- [x] 8.2 实现 `useTranslationRun()`（事件归约为运行状态：nodes / detect / terms / plan / rounds / final / error，支持停止）（验证：用样例事件流驱动，断言最终状态正确）
- [x] 8.3 实现工作台布局：工具条（语种选择与互换、自动识别结果、模式）、「翻译设置」弹层（风格分段控件、领域、术语库多选、模型）、左右分栏编辑区（字数统计、Ctrl+Enter）、设为默认首页（验证：亮/暗两种主题的截图）
- [x] 8.4 实现 Agent 面板：时间线（节点脉冲光环、连接线填充、跳过的节点置灰）、评审标签页（分数滚动、问题按维度分组）、术语标签页（命中与遵循情况）；可以收起和展开（验证：用真实模型跑一次标准路径并录屏，核对每个节点都点亮）
- [x] 8.5 实现译文区：流式光标、修正轮次切换动画、术语高亮与悬停提示、未遵循标红、复制、收藏、评分徽标、停止按钮、错误状态与重试（验证：录屏覆盖完成、停止、出错三种情况）
- [x] 8.6 实现术语库页面：主从布局（左侧卡片分组、右侧术语表与行内编辑）、新建/编辑术语库的侧滑面板、三步导入对话框、导出、空状态（验证：截图，并用一个含错误行的 CSV 走完导入流程）
- [x] 8.7 实现历史页面：列表、筛选弹层、收藏和删除的动画、侧滑详情（对照 / Agent 轨迹回放 / 术语三个标签页）、「在工作台中打开」（验证：截图，并录屏轨迹回放）

## 9. 联调与交付

- [x] 9.1 三端联调：用真实测试模型完成 fast 和 standard 两条路径；故意配置一个错误的 Key 验证 C0121 error 事件；停掉 Python 验证 C0110；翻译过程中停止，确认数据库没有新增记录（验证：结果写入 `docs/test/text-translation-smoke/README.md`）
- [x] 9.2 UI/UX 验收：对工作台、术语库、历史和全部管理页，分别截取亮色和暗色截图；再开启 reducedMotion 截图对比；逐页核对没有整页平铺（验证：截图存档到 `docs/test/text-translation-smoke/`）
- [x] 9.3 三端自动化测试全部通过（mvnw verify、pytest + ruff、pnpm lint/typecheck/build），并执行 `openspec validate add-text-translation-agent --strict`，逐条核对每个规格场景都有对应的测试或手动验证记录（验证：命令全部通过，核对清单附在冒烟测试记录中）
