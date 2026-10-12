# Lumi 首页欢迎语

`lumi-greeting-zh.mp3` 是预生成的静态音频，访客点击后直接播放，不需要登录或运行语音服务。

- 模型：项目已配置的 `qwen3-omni-flash-realtime`。
- 音色：`Cherry`（女声）。
- 风格：年轻、温柔、亲切，自然打招呼；Lumi 读作“露米”。
- 内容：你好，我是 Lumi！我可以实时为你的对话做翻译，也可以陪你用想练习的语言聊天。
- 时长：6.96 秒；MP3，单声道，24 kHz，96 kbps。
- 音量：FFmpeg loudnorm，目标 -18 LUFS、峰值 -2 dBTP。

更新欢迎语时，需要同时更新 `src/lib/landing/fixtures.ts` 中的中文问候及英文说明，并重新生成此音频。音频不包含模型凭据。

## 文学示例朗读

诗性散文和《定风波》示例分别提供原文与译文四段录音。使用项目百炼凭据调用 `qwen3-tts-flash`，音色 `Cherry`；24 kHz 单声道 MP3，96 kbps，按欢迎语相同标准统一音量。

文本、模型、音色与时长记录在 `literary-narration.json`。修改 `src/lib/landing/fixtures.ts` 的文学示例后，须重新生成对应录音，保持文字与音频一致。首页按需加载，不自动播放；播放另一段、切换样例或重播译文演示时会停止当前录音。
