# 朗读与同传体验 UI 验收（improve-speech-playback-latency 7.4 / 8.7）

验收环境：2026-10-06，Next 开发服务器 `localhost:3001`，真实后端（Spring 18080 + Python 8000），1440×900 与 390×844。

| 截图 | 验收点 | 结论 |
|---|---|---|
| 01-workbench-idle.png | 会话模式空状态；输入框旁的朗读按钮带“设置”小三角 | 通过 |
| 02-workbench-translating.png | 单次模式翻译进行中：译文区右下角朗读按钮可见、半透明禁用（悬停提示“译文完成后可朗读”） | 通过 |
| 03-workbench-done.png | 翻译完成后朗读按钮变为可用；布局为左右分栏 + Agent 面板，不是整页平铺 | 通过 |
| 04-workbench-playing.png | 点击朗读后进入播放态（品牌色声波条），请求 `POST /api/speech/tts` 返回 200 | 通过 |
| 05-voice-settings.png | 朗读设置弹层：音色（女声 / 男声）与语速（0.8× / 1.0× / 1.2×）分段控件 | 通过 |
| 06-session-mobile.png | 390 px 宽度会话模式：历史第 1 轮的朗读按钮无需悬停即可见，其余操作仍按悬停显示 | 通过 |
| 07-settings-autoread-dark.png | 暗色模式「翻译设置」底部新增“朗读”分区与“完成后自动朗读”开关 | 通过 |
| 08-session-playing-reduced-motion-dark.png | prefers-reduced-motion + 暗色：播放态为静态声波条，不做循环动画 | 通过 |

| 09-chat-engine-cards-unavailable.png | AI 对话“对话引擎”双卡片；后端（未重启的旧 Spring）没有 chat 类别时回退：实时语音模型卡片置灰并给出“请管理员在模型配置中添加 REALTIME_CHAT”（暗色） | 通过 |
| 10-chat-realtime-selected.png | 引擎列表含可用的实时语音模型（请求拦截注入 chat 类别）：选中后指示器滑到右侧卡片，摘要显示“实时语音模型 · 已配置” | 通过 |
| 11-advanced-realtime-disabled.png | 选中实时语音模型时，高级分区的术语库、回复模型、响应速度置灰并提示“实时语音模型不支持”，音色 / 播报 / 耳机模式仍可用 | 通过 |
| 12-cascade-latency-fast.png | 平台级联 + 响应速度“极速”：分段控件生效，说明切换为极速档提示，高级分区计数徽章 +1（亮色） | 通过 |
| 13-chat-live-speaking.png | 级联 AI 对话进行中：主从两栏（左数字人舞台、右对话流），开场白与中文字幕；延迟 8.6 s 含首次加载识别模型 | 通过 |
| 14-chat-replay.png | 悬停 AI 气泡点击“重播”：气泡下方出现声波条与“停止重播”，底部状态显示“说话时暂停收音”（重播期间半双工门控关闭收音） | 通过 |

说明：
- 3001 上的开发服务器连接的是尚未重启的 Spring（旧代码，朗读整段返回），流式分块已在 `SpeechApiTest.ttsIsStreamedChunkByChunkOverRealHttp`（真实端口）中验证。
- 发现并修复一处回归：朗读按钮变宽后，1440 宽度下元信息中的 token 用量被截断，改为仅在 ≥1500 px 显示。
- 09–14 使用假麦克风（注入静音 MediaStream）与级联 AI 对话真实链路（Spring 18080 旧代码 + Python 8000 新代码）。
- 已知小遗留：重播期间数字人吉祥物不跟随口型（口型只读实时播报通道的电平），不影响功能。
