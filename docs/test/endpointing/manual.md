# 三端联调清单（improve-speech-endpointing-and-live-ux 7.5）

- 时间：2026-10-06
- 环境：Python 8000、Spring 18080、Postgres / Redis（docker）；前端 mock 模式 3011（界面）
- 自动化部分由脚本与 Playwright 完成；**真人说话部分需要用户在电脑浏览器和手机上验证**（无法由脚本发声）

## 已验证（自动化）

| # | 项目 | 方式 | 结果 |
|---|---|---|---|
| 1 | 只说"嗯……"不成句、不落库 | `eval.multimodal.e6_chain`，经 Spring 推流 | ✅ partial → hold → discard，0 条记录 |
| 2 | 句中停顿：事件顺序、holdMs 随指标落库 | 同上 | ✅ 两句定稿（"请问。"被判为说完，见报告"仍未解决"），指标含 holdMs |
| 3 | AI 回复让位：撤回、不落库、恢复回应 | 同上，回复开始后发 `interrupt{yield:true}` | ✅ discard[ai] 后该 uid 无事件；3 s 后新 uid 回应；记录中没有撤回的回复 |
| 4 | Spring 处理撤回：广播、移出重建上下文、撤销转写段 | `InterpretStreamTest`（22 项） | ✅ |
| 5 | 会议室无空白气泡 / 孤立光标、分组、新消息胶囊 | mock + Playwright 采样 30 s | ✅ |
| 6 | AI 对话抢答让位（界面）、迟到转写排序、"正在听" | mock + Playwright 采样 45 s | ✅ |
| 7 | 收听：停顿呼吸点、无孤立光标 | mock + Playwright 采样 40 s | ✅ |
| 8 | 移动端 390 px、暗色、减少动效 | Playwright 截图 | ✅ 上下布局，动效降级 |
| 9 | 开播门：说话时推迟、4 s 上限、让位丢弃排队音频 | `queue.test.ts`、`batcher.test.ts`、`speech-activity.test.ts` | ✅ |

## 待用户验证（真人说话）

启动：`cd python-backend && uv run python -m app --port 8000`；`cd springboot-backend && ./mvnw spring-boot:run`；
`cd web && pnpm dev:lan`（手机用打印出的 https 地址，首次在证书警告页选择继续访问）。

| # | 操作 | 期望 | 结果 |
|---|---|---|---|
| A | 同传收听，说"我想问一下……（停 1 秒）……这个怎么退货" | 停顿时气泡末尾变为呼吸点，接着说时文字在同一气泡内增长，最后只出一句译文 | ☐ |
| B | 同传收听，只咳嗽一声或只说"嗯" | 可能短暂出现"正在听"，不出现气泡，不播报 | ☐ |
| C | AI 对话（不戴耳机），说半句后停顿 1 秒左右再接着说 | AI 若已开始"思考"，其气泡淡出；说完后 AI 只回应一次，针对完整的话 | ☐ |
| D | AI 对话戴耳机模式，AI 说话时咳嗽 | AI 不被打断；说"等一下"则被打断 | ☐ |
| E | 双向对话（不戴耳机），上一句译文到达时自己还在说 | 译文等你停下（最多 4 秒）再播，正在说的话没有被截断 | ☐ |
| F | 会议室：手机与电脑两人轮流说话，各自停顿、咳嗽 | 双方界面都没有空白气泡；对方说话未出字时显示"某某正在说话…"；上翻历史时不被拉回底部 | ☐ |
| G | 任一模式下长时间对话后上翻 | 出现"新消息 · n"胶囊，点击平滑回到底部 | ☐ |

如果 A / C 中停顿仍常被切开，可在 `.env` 设置 `ENDPOINT_SMART_TURN=auto`（模型已随 `app.speech.download` 下载）后重启 Python 再试，
并把体验反馈给我，用于决定是否改为缺省开启。
