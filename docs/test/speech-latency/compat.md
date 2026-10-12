# 流式播放浏览器兼容抽查（improve-speech-playback-latency 9.2）

- 测量时间：2026-10-06；工作台“朗读原文”（Edge TTS，MP3）；前端 `localhost:3001`，后端 Spring 18080（旧代码，朗读整段返回）+ Python 8000（新代码）
- 状态时间取自朗读按钮的 `data-speak-phase` 变化（相对点击时刻）

| 浏览器 / 路径 | MediaSource(`audio/mpeg`) | loading → playing | playing → idle | 浏览器朗读兜底 | 结论 |
|---|---|---|---|---|---|
| Chromium 147（Playwright）· MSE 渐进播放 | 支持 | 2781 ms（未命中缓存，含 Edge 合成与旧 Spring 整段缓冲） | 5069 ms（约等于音频时长） | 无 | 通过 |
| Chromium 147 · 模拟不支持 MediaSource（页面加载前删除全局对象）→ 按段整解码降级 | 不支持 | 177 ms（同文命中服务端缓存） | 5075 ms | 无 | 通过 |
| Microsoft Edge | 与 Chromium 同内核，MSE 支持 `audio/mpeg` | — | — | — | 未单独实测（同内核，预期同上） |
| Firefox / Safari | Firefox 支持 MSE `audio/mpeg`；Safari 17.1+ 为 ManagedMediaSource | — | — | — | **未实测**（本机自动化环境仅有 Chromium），答辩前需手工抽查 |

说明：
- 降级开关 `NEXT_PUBLIC_AUDIO_MSE=false` 与“浏览器不支持 MediaSource”走同一条按段整解码路径（`SegmentStream`），本次以删除全局对象的方式在运行时验证，避免重启共用的开发服务器。
- 同传通道的分段协议（seg / segLast / 终止包）由 Python、Spring 与前端队列的单元 / 集成测试覆盖（`test_interpret_*`、`queue.test.ts`、`streaming.test.ts`）。
- 首声时间受旧 Spring 整段缓冲影响；Spring 新代码的逐块透传已由 `SpeechApiTest.ttsIsStreamedChunkByChunkOverRealHttp`（真实端口，首块先于第二块到达）验证，Python 侧直连实测首包约 0.9 s（见 baseline.md）。
