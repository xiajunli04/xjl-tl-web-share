import { describe, expect, it } from "vitest";
import { createMascotAnimator, EYES, HAND_POSE, hexToRgb, MOOD_STYLE, MOODS, moodOf, MOUTHS, SLEEP_AFTER, type MascotInput } from "../mascot";
import { HUMAN_AVATAR_ENABLED } from "../feature";

const idle: MascotInput = { mood: "idle", energy: 0, mic: 0, pointer: null, hover: false };
const run = (anim: ReturnType<typeof createMascotAnimator>, seconds: number, input: MascotInput) => {
  let f = anim.step(0, input);
  for (let t = 0; t < seconds; t += 1 / 60) f = anim.step(1 / 60, input);
  return f;
};

describe("吉祥物配置（mascot：状态、语气与配色）", () => {
  it("七种情绪各有完整配置，眼型 / 嘴型 / 手势都可用", () => {
    expect(MOODS).toHaveLength(7);
    for (const m of MOODS) {
      const st = MOOD_STYLE[m];
      expect(EYES).toContain(st.eye);
      expect(MOUTHS).toContain(st.mouth);
      expect(HAND_POSE[st.hands]).toBeTruthy();
      expect(st.top).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(new Set(MOODS.map((m) => MOOD_STYLE[m].top)).size).toBe(7);
  });
  it("外部情绪覆盖优先于数字人状态；颜色解析", () => {
    expect(moodOf("speaking")).toBe("speaking");
    expect(moodOf("idle", "happy")).toBe("happy");
    expect(hexToRgb("#ff8000")).toEqual([1, 128 / 255, 0]);
  });
  it("真人形象默认隐藏", () => {
    expect(HUMAN_AVATAR_ENABLED).toBe(false);
  });
});

describe("吉祥物动画器", () => {
  it("切换情绪时颜色平滑过渡到目标色，眼型与手势随之变化", () => {
    const anim = createMascotAnimator(() => 0.99);
    const first = run(anim, 0.05, { ...idle, mood: "thinking" });
    const target = hexToRgb(MOOD_STYLE.thinking.top);
    expect(Math.abs(first.top[0] - target[0])).toBeGreaterThan(0.01);
    const f = run(anim, 1.5, { ...idle, mood: "thinking" });
    expect(f.top[0]).toBeCloseTo(target[0], 2);
    expect(f.ring).toBeGreaterThan(0.95);
    expect(f.hands.right[1]).toBeCloseTo(HAND_POSE.chin.right[1], 1);
    const e = run(createMascotAnimator(), 1, { ...idle, mood: "error" });
    expect(e.eyes.cross).toBeGreaterThan(0.95);
    expect(e.eyes.round).toBeLessThan(0.05);
  });

  it("idle 会眨眼，思考时不眨眼", () => {
    const anim = createMascotAnimator(() => 0);
    let minOpen = 1;
    for (let t = 0; t < 4; t += 1 / 60) minOpen = Math.min(minOpen, anim.step(1 / 60, idle).eyeOpen);
    expect(minOpen).toBeLessThan(0.1);
    const think = createMascotAnimator(() => 0);
    let thinkMin = 1;
    run(think, 0.5, { ...idle, mood: "thinking" });
    for (let t = 0; t < 6; t += 1 / 60) thinkMin = Math.min(thinkMin, think.step(1 / 60, { ...idle, mood: "thinking" }).eyeOpen);
    expect(thinkMin).toBeGreaterThan(0.8);
  });

  it("说话时嘴巴随能量张开，静音时合上", () => {
    const anim = createMascotAnimator();
    expect(run(anim, 0.3, { ...idle, mood: "speaking", energy: 0.7 }).mouthOpen).toBeGreaterThan(0.8);
    expect(run(anim, 0.4, { ...idle, mood: "speaking", energy: 0 }).mouthOpen).toBeLessThan(0.05);
    expect(run(anim, 0.4, { ...idle, mood: "speaking", energy: 0.7 }).waves).toBeGreaterThan(0.5);
  });

  it("问候：约 1 秒的开心表情，迸发星星，结束后回到原情绪", () => {
    const anim = createMascotAnimator();
    anim.greet();
    const f = anim.step(1 / 60, idle);
    expect(f.mood).toBe("happy");
    expect(f.sparkles).toBe(12);
    expect(anim.step(1 / 60, idle).sparkles).toBe(0);
    expect(run(anim, 1.3, idle).mood).toBe("idle");
  });

  it("idle 无交互超过阈值后打瞌睡，有交互立即醒来", () => {
    const anim = createMascotAnimator();
    expect(run(anim, SLEEP_AFTER + 1, idle).mood).toBe("sleepy");
    expect(anim.step(1 / 60, idle).zzz).toBe(true);
    anim.poke();
    expect(anim.step(1 / 60, idle).mood).toBe("idle");
    expect(run(createMascotAnimator(), SLEEP_AFTER + 1, { ...idle, pointer: { x: 0.2, y: 0 } }).mood).toBe("idle");
  });

  it("拖拽产生惯性旋转，停手 3 秒后回到正面", () => {
    const anim = createMascotAnimator();
    anim.drag(1.2, 0.1);
    const spun = run(anim, 0.5, idle);
    expect(Math.abs(spun.yaw)).toBeGreaterThan(1);
    const back = run(anim, 6, idle);
    const rem = ((back.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    expect(Math.min(rem, 2 * Math.PI - rem)).toBeLessThan(0.05);
  });
});
