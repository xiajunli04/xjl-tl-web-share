import { describe, expect, it } from "vitest";
import { SpeechActivity } from "../speech-activity";

describe("SpeechActivity（本机说话检测，improve-speech-endpointing-and-live-ux 5.2）", () => {
  it("电平持续 120 ms 才算开口，停止后保留 600 ms", () => {
    const a = new SpeechActivity();
    a.update(0.8, 0);
    a.update(0.8, 80);
    expect(a.speaking(80)).toBe(false); // 一声咔哒不算
    a.update(0.8, 120);
    expect(a.speaking(120)).toBe(true);
    a.update(0.1, 160);
    expect(a.speaking(700)).toBe(true);
    expect(a.speaking(800)).toBe(false);
  });

  it("中途掉到阈值以下重新计算起点", () => {
    const a = new SpeechActivity();
    a.update(0.8, 0);
    a.update(0.1, 60);
    a.update(0.8, 100);
    a.update(0.8, 200);
    expect(a.speaking(200)).toBe(false);
    a.update(0.8, 220);
    expect(a.speaking(220)).toBe(true);
  });
});
