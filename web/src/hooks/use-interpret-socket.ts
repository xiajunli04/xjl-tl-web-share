"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { interpretApi, interpretWsUrl, type InterpretEndVO, type InterpretJoinVO } from "@/lib/api/interpret";
import { interpretHistoryApi, type InterpretSegmentVO } from "@/lib/api/interpret-history";
import { ApiError } from "@/lib/http";
import type { EngineInfo } from "@/lib/api/speech";
import { MicrophoneError, type CaptureFrame, type CaptureHandle } from "@/lib/audio/capture";
import { HalfDuplexGate } from "@/lib/audio/half-duplex";
import { openMicrophone } from "@/lib/audio/mic";
import { levelFromRms } from "@/lib/audio/pcm";
import { AudioPlayer } from "@/lib/audio/player";
import { SpeechActivity } from "@/lib/audio/speech-activity";
import { speak, stopSpeaking } from "@/lib/audio/speak";
import { InterpretConnection, type WebSocketLike } from "@/lib/interpret/connection";
import { EventBatcher } from "@/lib/interpret/batcher";
import type { EndedStats, ServerEvent } from "@/lib/interpret/protocol";
import { lastReply, localTurnOpen, summarize } from "@/lib/interpret/reducer";
import { segmentsToEvents, setupFromSession } from "@/lib/interpret/resume";
import {
  CHAT_ENGINE,
  buildCreateRequest,
  halfDuplexEnabled,
  isMeaningfulSpeech,
  shouldAutoInterrupt,
  startGateEnabled,
  supportsAutoConverse,
} from "@/lib/interpret/setup";
import { describeError, toastError } from "@/lib/errors";
import { useInterpretSetup, useInterpretStore, type InterpretSetup } from "@/stores/interpret-store";

/** 预录缓冲上限：3 秒 */
const PREROLL_FRAMES = 75;
const store = () => useInterpretStore.getState();

/** 分页加载已落库的转写（最多 5 页 × 100 句） */
async function loadSegments(sessionId: number): Promise<InterpretSegmentVO[]> {
  const out: InterpretSegmentVO[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await interpretHistoryApi.segments(sessionId, page);
    out.push(...r.records);
    if (out.length >= r.total || !r.records.length) break;
  }
  return out;
}

const isMock = () => process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_MOCK_API === "1";

/** 仅收听的原因说明：非安全上下文（http 局域网地址）下浏览器禁止使用麦克风 */
export function listenOnlyHint(): string {
  return typeof window !== "undefined" && !window.isSecureContext
    ? "当前页面通过 http 打开，浏览器只允许在 HTTPS 或 localhost 下使用麦克风。可以正常看字幕、听译文；要发言请改用 https 地址打开。"
    : "当前浏览器不支持录音，可以正常看字幕、听译文。";
}

/** 采集帧的电平平滑：上升即时，下降按系数衰减 */
const LEVEL_DECAY = 0.82;
/** 回复让位只针对这么近的回复（最近一次更新起） */
const YIELD_WINDOW_MS = 15_000;

/**
 * 同传运行时（模块级单例）：麦克风采集、WebSocket 连接、播放队列、半双工门控与事件分发，
 * 状态写入 interpret-store。React 组件通过 useInterpretSocket() 取得动作。
 */
class InterpretRuntime {
  private conn: InterpretConnection | null = null;
  private capture: CaptureHandle | null = null;
  private player: AudioPlayer | null = null;
  private gate: HalfDuplexGate | null = null;
  private token = 0;
  private browserTts = false;
  private level = 0;
  /** 已打断的 AI 回复：之后迟到的音频不再播放 */
  private interrupted = new Set<string>();
  /** 下行文本事件按帧合并后归并（improve-speech-endpointing-and-live-ux D9） */
  private batcher = new EventBatcher((es) => (es.length === 1 ? store().apply(es[0]) : store().applyMany(es)));
  /** 本机是否正在说话（择机开播，D7） */
  private activity = new SpeechActivity();
  private wasSpeaking = false;

  /** 创建会话并开始（准备阶段的"开始"按钮，需在点击事件中调用以解锁音频） */
  start = async (setup: InterpretSetup, engine: EngineInfo | undefined) => {
    const req = buildCreateRequest(setup, engine);
    await this.begin(setup, () => interpretApi.create(req), {
      displayName: setup.displayName.trim() || "我",
      lang: req.languages[0],
      converseAuto: req.converseRouting === "auto",
    });
  };

  /** 通过房间码加入会议室 */
  joinRoom = async (code: string, displayName: string, lang: string, setup: InterpretSetup) => {
    const name = displayName.trim() || "访客";
    await this.begin({ ...setup, mode: "ROOM", roomLang: lang }, () => interpretApi.join(code, { displayName: name, lang }), {
      displayName: name,
      lang,
      converseAuto: false,
    });
  };

  /**
   * 恢复进行中的会话（刷新页面后）：按会话记录还原设置，以创建者身份取新票据重连，
   * 已落库的转写回放到字幕区，计时从会话真实开始时间继续。
   */
  resume = async (session: InterpretEndVO) => {
    const setup = setupFromSession(session, useInterpretSetup.getState());
    useInterpretSetup.getState().patchSetup(setup);
    const opts = session.options ?? {};
    await this.begin(
      setup,
      () => interpretApi.ticket(session.id),
      {
        displayName: typeof opts.displayName === "string" && opts.displayName ? opts.displayName : "我",
        lang: session.languages[0],
        converseAuto: session.mode === "CONVERSE" && setup.converseAuto,
      },
      { startedAt: Date.parse(session.startedAt) || Date.now(), history: () => loadSegments(session.id) },
    );
  };

  private async begin(
    setup: InterpretSetup,
    open: () => Promise<InterpretJoinVO>,
    me: { displayName: string; lang: string; converseAuto: boolean },
    restore?: { startedAt: number; history: () => Promise<InterpretSegmentVO[]> },
  ) {
    const token = ++this.token;
    this.teardown();
    // 必须在用户手势内同步创建 AudioContext
    const player = new AudioPlayer();
    player.setGender(setup.gender);
    void player.unlock();
    this.player = player;
    this.browserTts = setup.ttsEngine === "browser";
    store().patch({
      phase: "starting",
      micError: null,
      tts: setup.tts,
      headphone: setup.headphone,
      muted: false,
      pttSide: null,
      converseAuto: me.converseAuto,
      summary: null,
      listenOnly: false,
    });

    // 1) 先取得麦克风权限，避免创建了会话却无法收音
    let simulatedLevel: (() => number) | undefined;
    if (isMock()) simulatedLevel = (await import("@/lib/mock/interpret")).mockMicLevel;
    let listenOnly = false;
    try {
      this.capture = await openMicrophone((f) => this.onFrame(f), simulatedLevel);
    } catch (e) {
      if (token !== this.token) return;
      const kind = e instanceof MicrophoneError ? e.kind : "unsupported";
      if (setup.mode === "ROOM" && kind === "unsupported") {
        // 多语会议室：当前环境无法录音（如手机用 http 局域网地址打开）时以仅收听方式加入，仍可看字幕、听译文
        this.capture = null;
        listenOnly = true;
      } else {
        this.teardown();
        store().patch({ phase: "setup", micError: kind });
        return;
      }
    }
    if (token !== this.token) {
      void this.capture?.stop();
      return;
    }

    // 2) 创建 / 加入会话
    let join: InterpretJoinVO;
    try {
      join = await open();
    } catch (e) {
      if (token !== this.token) return;
      this.teardown();
      if (e instanceof ApiError && e.code === "A0214") {
        // 已有进行中的会话（如刷新前未结束）：交给准备页的恢复卡片处理，不只是报错
        store().patch({ phase: "setup", conflictAt: Date.now() });
        return;
      }
      if (e instanceof ApiError && e.code === "A0452" && restore) {
        store().patch({ phase: "setup", conflictAt: Date.now() });
        toast.info("这场同传已经结束", { description: "转写已保存到翻译历史，可以重新开始一场" });
        return;
      }
      store().patch({ phase: "setup" });
      toastError(e);
      return;
    }
    if (token !== this.token) return;

    const mode = join.mode;
    const gate = new HalfDuplexGate(halfDuplexEnabled(mode, setup.headphone), (closed) => store().patch({ gated: closed }));
    this.gate = gate;
    player.setEnabled(setup.tts);
    // 择机开播（D7）：半双工的收听 / 对话与 AI 对话中，本机用户正在说话或本句尚未定稿时推迟下一句开播（最多 4 秒）
    if (startGateEnabled(mode, setup.headphone)) player.queue.setStartGate(() => !this.localTurnOpen());
    player.queue.onPlayingChange((playing) => {
      this.livePlaying = playing;
      store().patch({ playing });
      gate.setPlaying(playing || this.replaying);
      // 播报开始而本机仍有等待续说的语句：半双工下用户已无法接着说，让服务端立即定稿
      if (playing && gate.isClosed && this.localHolding()) this.conn?.send({ type: "flush" });
    });
    player.queue.onCurrentChange((speakingId) => store().patch({ speakingId }));

    store().patch({
      phase: "live",
      join,
      me: { displayName: me.displayName, lang: me.lang },
      startedAt: restore?.startedAt ?? Date.now(),
      conflictAt: null,
      simulatedMic: !!this.capture?.simulated,
      converseAuto: mode === "CONVERSE" ? me.converseAuto : false,
      listenOnly,
    });
    if (listenOnly) toast.info("已以仅收听方式加入", { description: listenOnlyHint(), duration: 8000 });

    // 恢复：先回放已落库的转写，再连接实时通道（失败不影响继续同传）
    if (restore) {
      try {
        const segments = await restore.history();
        if (token !== this.token) return;
        for (const e of segmentsToEvents(segments)) store().apply(e);
      } catch {
        toast.warning("之前的字幕加载失败", { description: "同传会继续，完整转写可在翻译历史中查看" });
      }
    }

    // 3) 连接实时通道
    const createSocket = await this.socketFactory();
    if (token !== this.token) return;
    const conn = new InterpretConnection({
      createSocket,
      buildUrl: (ticket) => interpretWsUrl(ticket, join.wsUrl || "/ws/interpret"),
      renewTicket: async () => {
        const vo = join.isHost
          ? await interpretApi.ticket(join.sessionId)
          : await interpretApi.join(join.roomCode ?? "", { displayName: me.displayName, lang: me.lang, participantId: join.participantId });
        return vo.wsTicket;
      },
      onEvent: (e) => this.onEvent(e),
      onStatus: (status, info) => {
        store().patch({ connection: status, reconnectAttempt: info.attempt });
        if (status === "reconnecting" && info.attempt === 1) toast.warning("连接中断，正在重连…");
        if (status === "failed") {
          toast.error("连接已断开", { description: info.error ? describeError(info.error) : "多次重连失败，请稍后重新开始" });
          this.finish("error", null);
        }
      },
    });
    this.conn = conn;
    conn.connect(join.wsTicket);
  }

  private async socketFactory(): Promise<(url: string) => WebSocketLike> {
    if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_MOCK_API === "1") {
      const { MockInterpretSocket } = await import("@/lib/mock/interpret");
      return (url) => new MockInterpretSocket(url);
    }
    return (url) => new WebSocket(url) as unknown as WebSocketLike;
  }

  /** 当前是否允许上行音频 */
  private canUplink() {
    const s = store();
    if (!this.conn?.isOpen || s.muted || s.gated) return false;
    if (s.join?.mode === "CONVERSE" && !s.converseAuto && s.pttSide === null) return false;
    return true;
  }

  /** 连接就绪前的预录缓冲（40 ms 一帧，最多 PREROLL_FRAMES 帧） */
  private preroll: Int16Array[] = [];

  /** 本机正在说话，或本人有尚未定稿的语句 */
  private localTurnOpen() {
    const now = Date.now();
    if (this.activity.speaking(now)) return true;
    const s = store();
    this.batcher.flush();
    return localTurnOpen(s.live, s.join?.participantId, now);
  }

  /** 本人最近一句处于续说等待 */
  private localHolding() {
    const s = store();
    const mine = s.join?.participantId;
    const last = [...s.live.utterances].reverse().find((u) => u.role === "user" && u.id.startsWith(`${mine}:`));
    return !!last && !last.sourceFinal && last.hold;
  }

  private onFrame(f: CaptureFrame) {
    const lv = levelFromRms(f.rms);
    this.level = Math.max(lv, this.level * LEVEL_DECAY);
    const s = store();
    const now = Date.now();
    this.activity.update(s.muted || s.gated ? 0 : lv, now);
    const speaking = this.activity.speaking(now);
    if (this.wasSpeaking && !speaking) this.player?.queue.recheck(); // 停下说话：推迟的播报立即开始
    this.wasSpeaking = speaking;
    const shown = s.muted ? 0 : this.level;
    if (Math.abs(shown - s.level) > 0.01) s.patch({ level: shown });
    if (this.canUplink()) {
      // 连接建立（或重连）前采集到的音频先补发，避免开口第一句被截掉
      if (this.preroll.length) {
        for (const p of this.preroll) this.conn!.sendAudio(p);
        this.preroll = [];
      }
      this.conn!.sendAudio(f.pcm);
    } else if (!this.conn?.isOpen && !s.muted) {
      this.preroll.push(f.pcm);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
    }
  }

  /** 该语种的播报是否属于本机（LISTEN：目标语；ROOM：我的语言；CONVERSE：两侧都播；CHAT：AI 的对话语言） */
  private playsLang(lang: string) {
    const s = store();
    const mode = s.join?.mode;
    if (mode === "CONVERSE") return true;
    if (mode === "ROOM") return lang === s.me?.lang;
    if (mode === "CHAT") return lang === s.join?.languages[1];
    return lang === s.join?.languages[0];
  }

  private onEvent(e: ServerEvent) {
    const s = store();
    if (e.type === "audio") {
      if (this.interrupted.has(String(e.utteranceId))) return;
      if (s.tts && !this.browserTts && this.playsLang(e.lang)) {
        this.player?.enqueue({ ...e, utteranceId: String(e.utteranceId) });
      }
      return;
    }
    if (e.type === "pong") return;
    this.batcher.push(e);
    switch (e.type) {
      case "transcript.partial":
        // 耳机模式（全双工）下 AI 正在说话时用户开口：自动打断（插话）；咳嗽、语气词不算
        if (shouldAutoInterrupt({ mode: s.join?.mode, role: e.role, headphone: s.headphone, playing: s.playing, text: e.text })) this.interrupt();
        else this.maybeYield(e);
        break;
      case "transcript.discard":
        this.player?.queue.drop(String(e.utteranceId));
        this.player?.queue.recheck();
        break;
      case "transcript.final":
        // AI 回复的服务端合成不可用：浏览器朗读原文
        if (e.role === "assistant" && s.tts && (e.ttsFallback || this.browserTts) && this.playsLang(e.lang)) {
          this.player?.speakFallback(String(e.utteranceId), e.text, e.lang);
        }
        break;
      case "reply.interrupted":
        // 服务端发起的打断（实时语音模型检测到插话后自动取消回复）：立即停止已缓冲的回复音频
        if (!this.interrupted.has(String(e.utteranceId))) {
          this.interrupted.add(String(e.utteranceId));
          this.player?.stop();
        }
        break;
      case "translation.final":
        if (s.tts && (e.ttsFallback || this.browserTts) && this.playsLang(e.lang)) {
          this.player?.speakFallback(String(e.utteranceId), e.text, e.lang);
        }
        break;
      case "error":
        if (e.fatal) {
          toast.error(e.message || "同传出错", { description: e.code });
          this.finish("error", null);
        } else if (e.code !== "C0172") {
          // C0172（语音合成失败）由浏览器朗读兜底，不打扰用户
          toast.warning(e.message, { description: e.code });
        }
        break;
      case "ended":
        if (e.reason === "host_left") toast.info("主持人已结束会议");
        else if (e.reason === "idle") toast.info("长时间无人连接，会话已自动结束");
        this.finish(e.reason, e.stats ?? null);
        break;
    }
  }

  /** 按键说话：按下传 side，松开传 null 并强制断句 */
  ptt = (side: "A" | "B" | null) => {
    const s = store();
    if (s.pttSide === side) return;
    s.patch({ pttSide: side });
    this.conn?.send({ type: "ptt", side });
    if (side === null) this.conn?.send({ type: "flush" });
  };

  /**
   * AI 对话回复让位（D6）：用户又开口（有效语音）而最近一条 AI 回复还没开始播放——丢弃其排队音频、本地移除，
   * 通知服务端撤回；用户说完后 AI 对前后两段话一并回应。已开始播放的回复不让位（走打断）。
   */
  private maybeYield(e: Extract<ServerEvent, { type: "transcript.partial" }>) {
    const s = store();
    if (s.join?.mode !== "CHAT" || e.role === "assistant" || !s.tts || s.playing || !isMeaningfulSpeech(e.text)) return;
    this.batcher.flush();
    const live = store().live;
    const reply = lastReply(live);
    if (!reply || this.interrupted.has(reply.id) || this.player?.queue.hasStarted(reply.id)) return;
    // 只针对正在回应的那条：回复之后还没有用户句定稿，且不是很久以前的回复（如合成失败从未开播）
    const at = live.utterances.indexOf(reply);
    if (live.utterances.slice(at + 1).some((u) => u.role === "user" && u.sourceFinal)) return;
    if (Date.now() - reply.updatedAt > YIELD_WINDOW_MS) return;
    this.interrupted.add(reply.id);
    this.player?.queue.drop(reply.id);
    store().apply({ type: "transcript.discard", utteranceId: reply.id, role: "assistant" });
    this.conn?.send({ type: "interrupt", yield: true });
  }

  /** AI 对话：打断 AI 当前的回复（立即停止本地播放，并通知服务端取消生成与合成） */
  interrupt = () => {
    this.batcher.flush();
    const s = store();
    if (s.join?.mode !== "CHAT") return;
    const last = [...s.live.utterances].reverse().find((u) => u.role === "assistant");
    if (last && !last.interrupted) {
      this.interrupted.add(last.id);
      s.apply({ type: "reply.interrupted", utteranceId: last.id, role: "assistant", text: last.source });
    }
    this.player?.stop();
    this.conn?.send({ type: "interrupt" });
  };

  private replaying = false;
  private livePlaying = false;

  /**
   * 重播一句字幕（improve-speech-playback-latency 8.4）：暂停实时播报队列（新到的译音排队），重播结束后继续；
   * 半双工下重播期间同样暂停收音，避免把重播的声音识别成新的发言。
   */
  replay = (utteranceId: string, text: string, lang: string) => {
    this.player?.pause();
    this.replaying = true;
    this.gate?.setPlaying(true);
    const gender = useInterpretSetup.getState().gender;
    void speak({ id: replayId(utteranceId), text, lang, gender }, () => {
      this.replaying = false;
      this.player?.resume();
      this.gate?.setPlaying(this.livePlaying);
    });
  };

  /** 数字人口型：播放输出的频谱分析节点 */
  outputAnalyser = (): AnalyserNode | null => this.player?.getOutputAnalyser() ?? null;

  /** 数字人口型：是否正在用浏览器朗读（拿不到音频数据） */
  speakingWithBrowser = (): boolean => !!this.player?.speakingWithBrowser;

  /** 数字人倾听：当前麦克风电平 0–1 */
  micLevel = (): number => store().level;

  setMuted = (muted: boolean) => {
    store().patch({ muted, level: muted ? 0 : store().level });
    this.conn?.send({ type: "mute", muted });
  };

  setTts = (on: boolean) => {
    store().patch({ tts: on });
    this.player?.setEnabled(on);
  };

  setHeadphone = (on: boolean) => {
    const s = store();
    s.patch({ headphone: on });
    this.gate?.setEnabled(halfDuplexEnabled(s.join?.mode ?? "LISTEN", on));
  };

  setConverseAuto = (on: boolean, engine: EngineInfo | undefined) => {
    if (on && !supportsAutoConverse(engine)) return;
    store().patch({ converseAuto: on, pttSide: null });
    // 恢复自动时强制断句，使服务端回到按语种自动路由
    if (on) this.conn?.send({ type: "flush" });
  };

  /** 用户结束：通知服务端、主持人调用结束接口，进入摘要 */
  end = async () => {
    const s = store();
    if (s.phase !== "live") return;
    const join = s.join;
    this.conn?.send({ type: "end" });
    let server: EndedStats | null = null;
    if (join?.isHost) {
      try {
        const vo = await interpretApi.end(join.sessionId);
        server = {
          durationMs: vo.durationMs ?? undefined,
          utterances: vo.stats?.utterances,
          avgE2eMs: vo.stats?.avgE2eMs ?? undefined,
        };
      } catch {
        // 结束接口失败不阻塞本地收尾（服务端 60 s 无连接后自动结束）
      }
    }
    this.finish("user_end", server);
  };

  private finish(reason: string, stats: EndedStats | null) {
    this.batcher.flush();
    const s = store();
    if (s.phase !== "live" && s.phase !== "starting") return;
    this.token++;
    this.teardown();
    const now = Date.now();
    const sum = summarize(s.live, s.startedAt ?? now, now, stats);
    store().patch({
      phase: "summary",
      playing: false,
      gated: false,
      level: 0,
      pttSide: null,
      summary: { ...sum, reason, canViewHistory: !!s.join?.isHost },
    });
  }

  /** 离开页面：结束会话并清理 */
  abandon = () => {
    const s = store();
    const join = s.join;
    const wasLive = s.phase === "live" || s.phase === "starting";
    this.token++;
    if (wasLive) {
      this.conn?.send({ type: "end" });
      if (join?.isHost) void interpretApi.end(join.sessionId).catch(() => undefined);
    }
    this.teardown();
    if (s.phase !== "setup") s.reset();
  };

  /** 回到准备阶段 */
  restart = () => {
    this.teardown();
    store().reset();
  };

  /** 实时语音模型不可用：改回平台级联后回到准备阶段（AI 对话） */
  restartWithCascade = () => {
    useInterpretSetup.getState().patchSetup({ engine: CHAT_ENGINE });
    this.restart();
  };

  private teardown() {
    if (this.replaying) stopSpeaking();
    this.replaying = false;
    this.conn?.close();
    this.conn = null;
    void this.capture?.stop();
    this.capture = null;
    this.preroll = [];
    this.gate?.dispose();
    this.gate = null;
    void this.player?.close();
    this.player = null;
    this.level = 0;
    this.interrupted.clear();
    this.batcher.dispose();
    this.activity.reset();
    this.wasSpeaking = false;
  }
}

export const interpretRuntime = new InterpretRuntime();

/** 重播条目的朗读 id（与工作台朗读共用全局朗读状态） */
export function replayId(utteranceId: string) {
  return `replay:${utteranceId}`;
}

/** 同传页面入口：返回运行时动作，页面卸载时自动结束会话并清理 */
export function useInterpretSocket() {
  useEffect(() => () => interpretRuntime.abandon(), []);
  // 进行中刷新或关闭页面时先提示（会话在服务端保留约 60 秒，回到本页可继续）
  const live = useInterpretStore((s) => s.phase === "live" || s.phase === "starting");
  useEffect(() => {
    if (!live) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [live]);
  return interpretRuntime;
}
