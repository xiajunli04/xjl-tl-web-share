import { describe, expect, it } from "vitest";
import {
  createSmoother,
  dominantViseme,
  NOISE_GATE,
  pseudoVisemes,
  visemesFromSpectrum,
  zeroVisemes,
} from "../lipsync";
import { persistUi } from "@/stores/ui";
import { approach, deriveAvatarState, LISTEN_THRESHOLD } from "../state";
import { avatarRender, createFpsMonitor, fallbackReason, normalizeStyle } from "../support";
import { CHARACTER_IDS, characterForLang } from "../characters";
import { createRigAnimator, MOUTH_FRAMES, mouthFrame } from "../rig-weights";
import { backgroundFor, viewRect } from "../view";

const SR = 48000;
const BINS = 512; // fftSize 1024

/** 只在 [lo, hi) Hz 内放入能量 level（0–255）的频谱 */
function spectrum(lo: number, hi: number, level = 200): Uint8Array {
  const bins = new Uint8Array(BINS);
  const binHz = SR / 2 / BINS;
  for (let i = 0; i < BINS; i++) {
    const f = i * binHz;
    if (f >= lo && f < hi) bins[i] = level;
  }
  return bins;
}

describe("deriveAvatarState（ai-avatar：数字人组件与状态机）", () => {
  it("按优先级判定", () => {
    expect(deriveAvatarState({ error: true, playing: true })).toBe("error");
    expect(deriveAvatarState({ playing: true, micLevel: 0.9 })).toBe("speaking");
    expect(deriveAvatarState({ awaitingReply: true, micLevel: 0.9 })).toBe("thinking");
    expect(deriveAvatarState({ micLevel: LISTEN_THRESHOLD + 0.1 })).toBe("listening");
    expect(deriveAvatarState({ micLevel: 0.1 })).toBe("idle");
    expect(deriveAvatarState({})).toBe("idle");
  });

  it("静音或门控时不进入倾听", () => {
    expect(deriveAvatarState({ micLevel: 0.9, muted: true })).toBe("idle");
    expect(deriveAvatarState({ micLevel: 0.9, gated: true })).toBe("idle");
  });

  it("approach 在 250 ms 内完成约 95% 的过渡", () => {
    let v = 0;
    for (let i = 0; i < 15; i++) v = approach(v, 1, 1 / 60);
    expect(v).toBeGreaterThan(0.94);
    expect(approach(0.3, 0.3, 0.016)).toBeCloseTo(0.3);
  });
});

describe("visemesFromSpectrum（ai-avatar：口型与倾听反馈）", () => {
  it("静音时闭嘴", () => {
    expect(visemesFromSpectrum(new Uint8Array(BINS), SR)).toEqual(zeroVisemes());
    const faint = spectrum(200, 5000, Math.floor(NOISE_GATE * 255 * 0.5));
    expect(dominantViseme(visemesFromSpectrum(faint, SR))).toBeNull();
  });

  it("低 / 中 / 高频分别偏向 oh / aa / ee", () => {
    expect(dominantViseme(visemesFromSpectrum(spectrum(200, 800), SR))).toBe("oh");
    expect(dominantViseme(visemesFromSpectrum(spectrum(800, 2500), SR))).toBe("aa");
    expect(dominantViseme(visemesFromSpectrum(spectrum(2500, 5000), SR))).toBe("ee");
  });

  it("能量越大开口越大，且有上限", () => {
    const soft = visemesFromSpectrum(spectrum(800, 2500, 60), SR).aa;
    const loud = visemesFromSpectrum(spectrum(800, 2500, 255), SR).aa;
    expect(loud).toBeGreaterThan(soft);
    expect(loud).toBeLessThanOrEqual(0.9);
  });
});

describe("createSmoother", () => {
  it("张嘴快、闭嘴慢", () => {
    const s = createSmoother();
    const open = { ...zeroVisemes(), aa: 0.8 };
    const afterAttack = s.next(open, 0.06).aa;
    expect(afterAttack).toBeGreaterThan(0.45);
    s.next(open, 1);
    const afterRelease = s.next(zeroVisemes(), 0.06).aa;
    // release 时间常数是 attack 的两倍：60 ms 后仍保留超过一半
    expect(afterRelease).toBeGreaterThan(0.4);
    for (let i = 0; i < 60; i++) s.next(zeroVisemes(), 1 / 60);
    expect(s.next(zeroVisemes(), 1 / 60).aa).toBe(0);
  });
});

describe("pseudoVisemes", () => {
  it("一秒内有开有合，幅度在 0–0.9", () => {
    const samples = Array.from({ length: 60 }, (_, i) => pseudoVisemes(i / 60).aa);
    expect(Math.max(...samples)).toBeGreaterThan(0.3);
    expect(Math.min(...samples)).toBeLessThan(0.05);
    expect(samples.every((v) => v >= 0 && v <= 0.9)).toBe(true);
  });
});

describe("avatarRender（ai-avatar：懒加载与降级）", () => {
  const base = { style: "live" as const, reducedMotion: false, webgl: true };
  it("条件满足时渲染动态立绘，任一降级条件改为静态立绘", () => {
    expect(avatarRender(base)).toBe("live");
    expect(avatarRender({ ...base, style: "static" })).toBe("static");
    expect(avatarRender({ ...base, reducedMotion: true })).toBe("static");
    expect(avatarRender({ ...base, webgl: false })).toBe("static");
    expect(avatarRender({ ...base, loadFailed: true })).toBe("static");
    expect(avatarRender({ ...base, lowFps: true })).toBe("static");
  });

  it("降级原因：用户主动选择静态时不提示", () => {
    expect(fallbackReason(base)).toBeNull();
    expect(fallbackReason({ ...base, style: "static", webgl: false })).toBeNull();
    expect(fallbackReason({ ...base, webgl: false })).toContain("WebGL");
    expect(fallbackReason({ ...base, lowFps: true })).toContain("性能");
  });

  it("旧版偏好值兼容映射", () => {
    expect(normalizeStyle("3d")).toBe("live");
    expect(normalizeStyle("simple")).toBe("static");
    expect(normalizeStyle("static")).toBe("static");
    expect(normalizeStyle(undefined)).toBe("live");
  });

  it("帧率监测：预热 3 秒后，2 秒窗口平均低于 24 fps 时触发并保持", () => {
    const fast = createFpsMonitor();
    for (let i = 0; i < 600; i++) expect(fast.tick(1 / 60)).toBe(false);
    const slow = createFpsMonitor();
    let tripped = false;
    for (let i = 0; i < 40; i++) expect(slow.tick(1 / 15)).toBe(false);
    for (let i = 0; i < 40; i++) tripped = slow.tick(1 / 15);
    expect(tripped).toBe(true);
    expect(slow.tick(1 / 60)).toBe(true);
  });
});

describe("persistUi（ai-avatar：数字人偏好）", () => {
  it("持久化数字人开关与形态", () => {
    const saved = persistUi({
      sidebarCollapsed: false,
      agentPanelOpen: true,
      avatarEnabled: false,
      avatarStyle: "static",
    } as Parameters<typeof persistUi>[0]);
    expect(saved).toEqual({ sidebarCollapsed: false, agentPanelOpen: true, avatarEnabled: false, avatarStyle: "static" });
  });
});

describe("characterForLang（ai-avatar：语言形象）", () => {
  it("中英日韩有专属形象，粤语归中文，其他语言回退中文", () => {
    expect(characterForLang("en")).toBe("en");
    expect(characterForLang("ja")).toBe("ja");
    expect(characterForLang("ko")).toBe("ko");
    expect(characterForLang("yue")).toBe("zh");
    expect(characterForLang("fr")).toBe("zh");
    expect(characterForLang(null)).toBe("zh");
    expect(CHARACTER_IDS).toEqual(["zh", "en", "ja", "ko"]);
  });
});

describe("mouthFrame 与立绘权重（ai-avatar：口型与倾听反馈）", () => {
  const v = (p: Partial<ReturnType<typeof zeroVisemes>>) => ({ ...zeroVisemes(), ...p });
  it("按开口度与主导口型选择嘴型帧", () => {
    expect(mouthFrame(zeroVisemes())).toBe("closed");
    expect(mouthFrame(v({ aa: 0.2 }))).toBe("mouth-small");
    expect(mouthFrame(v({ aa: 0.7 }))).toBe("mouth-aa");
    expect(mouthFrame(v({ oh: 0.5, ou: 0.3, aa: 0.2 }))).toBe("mouth-oh");
    expect(mouthFrame(v({ ee: 0.5, ih: 0.3, aa: 0.2 }))).toBe("mouth-ee");
  });

  const run = (anim: ReturnType<typeof createRigAnimator>, seconds: number, input: Parameters<ReturnType<typeof createRigAnimator>["step"]>[1]) => {
    let f = anim.step(0, input);
    for (let t = 0; t < seconds; t += 1 / 60) f = anim.step(1 / 60, input);
    return f;
  };
  const idle = { state: "idle" as const, visemes: zeroVisemes(), mic: 0, pointer: null };

  it("说话时目标嘴型帧趋近 1、其余趋近 0；静音后嘴巴闭合", () => {
    const anim = createRigAnimator(() => 0.99);
    let f = run(anim, 0.3, { ...idle, state: "speaking", visemes: v({ aa: 0.8 }) });
    expect(f.weights["mouth-aa"]).toBeGreaterThan(0.95);
    expect(f.weights["mouth-oh"]).toBeLessThan(0.05);
    f = run(anim, 0.3, { ...idle, state: "speaking" });
    expect(Math.max(...MOUTH_FRAMES.map((m) => f.weights[m]))).toBeLessThan(0.05);
  });

  it("idle 时会眨眼；思考时抬眼且不眨眼", () => {
    const anim = createRigAnimator(() => 0);
    let maxBlink = 0;
    for (let t = 0; t < 4; t += 1 / 60) maxBlink = Math.max(maxBlink, anim.step(1 / 60, idle).weights["eyes-closed"]);
    expect(maxBlink).toBeGreaterThan(0.9);
    const think = createRigAnimator(() => 0);
    let blinkWhileThinking = 0;
    let f = think.step(0, { ...idle, state: "thinking" });
    for (let t = 0; t < 6; t += 1 / 60) {
      f = think.step(1 / 60, { ...idle, state: "thinking" });
      blinkWhileThinking = Math.max(blinkWhileThinking, f.weights["eyes-closed"]);
    }
    expect(f.weights["eyes-up"]).toBeGreaterThan(0.95);
    expect(blinkWhileThinking).toBe(0);
  });

  it("问候时开心表情约 1.2 s 后回落；倾听时前倾放大；出错时降低饱和度", () => {
    const anim = createRigAnimator(() => 0.99);
    anim.greet();
    expect(run(anim, 0.5, idle).weights.happy).toBeGreaterThan(0.9);
    expect(run(anim, 1.5, idle).weights.happy).toBeLessThan(0.05);
    expect(run(createRigAnimator(), 1, { ...idle, state: "listening", mic: 1 }).scale).toBeGreaterThan(1.01);
    expect(run(createRigAnimator(), 2, { ...idle, state: "error" }).saturation).toBeLessThan(0.5);
  });

  it("指针视差：指针在右上方时偏移为正", () => {
    const f = run(createRigAnimator(), 1, { ...idle, pointer: { x: 1, y: 1 } });
    expect(f.offset[0]).toBeGreaterThan(0.005);
    expect(f.offset[1]).toBeGreaterThan(0.004);
  });
});

describe("viewRect 构图", () => {
  const face: [number, number, number, number] = [0.36, 0.23, 0.33, 0.16];
  it("半身：比例接近时显示整幅", () => {
    const r = viewRect("bust", 0.75, 0.75, face);
    expect(r[2]).toBeCloseTo(1);
    expect(r[3]).toBeCloseTo(1);
  });
  it("容器更宽时裁掉下方、保住脸", () => {
    const [, y, w, h] = viewRect("bust", 0.75, 1.5, face);
    expect(w).toBeCloseTo(1);
    expect(h).toBeCloseTo(0.5);
    expect(y).toBe(0); // 从下方裁，头顶完整
  });
  it("头肩：以脸为中心的正方形子区域，背景定位换算", () => {
    const r = viewRect("portrait", 0.75, 1, face);
    expect(r[3]).toBeCloseTo(face[3] * 2.2);
    expect(r[0]).toBeLessThan(face[0] + face[2] / 2);
    expect(r[0] + r[2]).toBeGreaterThan(face[0] + face[2] / 2);
    const bg = backgroundFor(r);
    expect(bg.size).toMatch(/%/);
    expect(viewRect("face", 0.75, 1, face)[3]).toBeLessThan(r[3]);
    expect(backgroundFor([0, 0, 1, 1])).toEqual({ size: "100.000% 100.000%", position: "0.000% 0.000%" });
  });
});
