"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ChatScenario, InterpretJoinVO, InterpretMode, LatencyMode, VoiceGender } from "@/lib/api/interpret";
import type { MicErrorKind } from "@/lib/audio/capture";
import type { ConnectionStatus } from "@/lib/interpret/connection";
import type { ServerEvent } from "@/lib/interpret/protocol";
import { initialLiveState, reduceLive, type LiveState, type SessionSummary } from "@/lib/interpret/reducer";

/* ---------------- 准备阶段设置（持久化，下次进入沿用） ---------------- */

export interface InterpretSetup {
  mode: InterpretMode;
  engine: string;
  /** LISTEN 目标语言 */
  listenTarget: string;
  /** CONVERSE 两种语言：A 为下半区（本机持有者），B 为上半区（对面） */
  converseA: string;
  converseB: string;
  /** ROOM 我的语言 */
  roomLang: string;
  /** CHAT 我的语言 / 对话语言 / 场景 */
  chatMyLang: string;
  chatAiLang: string;
  chatScenario: ChatScenario;
  displayName: string;
  glossaryIds: number[];
  domainHint: string;
  gender: VoiceGender;
  tts: boolean;
  headphone: boolean;
  /** CONVERSE 自动方向（仅级联引擎） */
  converseAuto: boolean;
  /** 播报引擎；null 表示由服务端按默认选择 */
  ttsEngine: string | null;
  /** 级联引擎的翻译模型（对话模型配置 id）；null 表示平台默认模型 */
  mtModelConfigId: number | null;
  /** 响应速度（仅平台级联）：均衡 / 极速 */
  latencyMode: LatencyMode;
}

export const DEFAULT_SETUP: InterpretSetup = {
  mode: "LISTEN",
  engine: "cascade",
  listenTarget: "zh",
  converseA: "zh",
  converseB: "en",
  roomLang: "zh",
  chatMyLang: "zh",
  chatAiLang: "en",
  chatScenario: "restaurant",
  displayName: "",
  glossaryIds: [],
  domainHint: "",
  gender: "female",
  tts: true,
  headphone: false,
  converseAuto: true,
  ttsEngine: null,
  mtModelConfigId: null,
  latencyMode: "balanced",
};

interface SetupState extends InterpretSetup {
  patchSetup: (p: Partial<InterpretSetup>) => void;
}

export const useInterpretSetup = create<SetupState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETUP,
      patchSetup: (p) => set(p),
    }),
    {
      name: "tl-interpret-setup",
      partialize: (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== "patchSetup")) as InterpretSetup,
    },
  ),
);

/* ---------------- 运行时状态 ---------------- */

export type InterpretPhase = "setup" | "starting" | "live" | "summary";

export interface InterpretRuntimeState {
  phase: InterpretPhase;
  /** 创建时遇到"已有进行中的会话"（A0214）的时间戳，恢复卡片据此刷新并提示 */
  conflictAt: number | null;
  join: InterpretJoinVO | null;
  /** 本次会话的显示名与语言（会议室成员） */
  me: { displayName: string; lang: string } | null;
  live: LiveState;
  connection: ConnectionStatus;
  reconnectAttempt: number;
  /** 0–1 视觉电平 */
  level: number;
  /** 正在播报 */
  playing: boolean;
  /** 正在实时播报的句子 id（气泡上显示声波） */
  speakingId: string | null;
  /** 半双工门控关闭（播报中暂停收音） */
  gated: boolean;
  muted: boolean;
  tts: boolean;
  headphone: boolean;
  converseAuto: boolean;
  pttSide: "A" | "B" | null;
  micError: MicErrorKind | null;
  /** 是否为模拟采集（mock） */
  simulatedMic: boolean;
  /** 无法录音时以仅收听方式加入会议室（如手机用 http 局域网地址打开） */
  listenOnly: boolean;
  startedAt: number | null;
  summary: (SessionSummary & { reason: string; canViewHistory: boolean }) | null;
}

interface InterpretActions {
  patch: (p: Partial<InterpretRuntimeState>) => void;
  apply: (e: ServerEvent) => void;
  /** 批量归并（按帧合并的文本事件，一次 set） */
  applyMany: (es: ServerEvent[]) => void;
  /** 回到准备阶段并清空本次会话 */
  reset: () => void;
}

export const initialRuntime = (): InterpretRuntimeState => ({
  phase: "setup",
  conflictAt: null,
  join: null,
  me: null,
  live: initialLiveState(),
  connection: "idle",
  reconnectAttempt: 0,
  level: 0,
  playing: false,
  speakingId: null,
  gated: false,
  muted: false,
  tts: true,
  headphone: false,
  converseAuto: true,
  pttSide: null,
  micError: null,
  simulatedMic: false,
  listenOnly: false,
  startedAt: null,
  summary: null,
});

export const useInterpretStore = create<InterpretRuntimeState & InterpretActions>()((set) => ({
  ...initialRuntime(),
  patch: (p) => set(p),
  apply: (e) => set((s) => ({ live: reduceLive(s.live, e) })),
  applyMany: (es) =>
    set((s) => {
      const now = Date.now();
      return { live: es.reduce((live, e) => reduceLive(live, e, now), s.live) };
    }),
  reset: () => set(initialRuntime()),
}));
