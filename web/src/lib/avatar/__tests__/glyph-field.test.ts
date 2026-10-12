import { describe, expect, it } from "vitest";
import { createGlyphField, DOT, FIELD_FX, GLYPH_COUNT, STRIDE, type FieldInput } from "../glyph-field";
import { MOODS, settledFrame, type MascotFrame } from "../mascot";

const W = 600;
const H = 720;
const input = (frame: MascotFrame, over: Partial<FieldInput> = {}): FieldInput => ({
  frame,
  dt: 1 / 60,
  energy: 0,
  mic: 0,
  dark: true,
  width: W,
  height: H,
  pointer: null,
  ...over,
});
const particles = (out: Float32Array, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const o = i * STRIDE;
    return { x: out[o], y: out[o + 1], size: out[o + 2], glyph: out[o + 3], a: out[o + 7] };
  });
const bbox = (ps: { x: number; y: number }[]) => ({
  minY: Math.min(...ps.map((p) => p.y)),
  maxY: Math.max(...ps.map((p) => p.y)),
});

describe("字形粒子场（glyph-field）", () => {
  it("七种情绪都有粒子场参数", () => {
    for (const m of MOODS) expect(FIELD_FX[m]).toBeTruthy();
  });

  it("舞台构图有几千个粒子；输出都是有限值，字形索引合法", () => {
    const field = createGlyphField({ framing: "stage", intro: false });
    expect(field.capacity).toBeGreaterThan(2000);
    const n = field.update(input(settledFrame("idle")));
    expect(n).toBeGreaterThan(1500);
    for (const p of particles(field.out, n)) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.size).toBeGreaterThanOrEqual(1);
      expect(p.glyph).toBeGreaterThanOrEqual(0);
      expect(p.glyph).toBeLessThan(GLYPH_COUNT);
      expect(p.a).toBeGreaterThan(0);
      expect(p.a).toBeLessThanOrEqual(1);
    }
  });

  it("身体落在画布内（不含字符雨）", () => {
    const field = createGlyphField({ framing: "stage", intro: false });
    const n = field.update(input(settledFrame("idle")));
    const body = particles(field.out, n).filter((p) => p.glyph === DOT);
    const b = bbox(body);
    expect(b.minY).toBeGreaterThan(0);
    expect(b.maxY).toBeLessThan(H);
  });

  it("降低密度时粒子数随之减少（低性能降级，画风不变）", () => {
    const full = createGlyphField({ framing: "stage", quality: 1, intro: false }).capacity;
    const low = createGlyphField({ framing: "stage", quality: 0.35, intro: false }).capacity;
    expect(low).toBeLessThan(full * 0.5);
    expect(low).toBeGreaterThan(400);
  });

  it("小图标构图没有字符雨 / 字符环，粒子少而大", () => {
    const icon = createGlyphField({ framing: "icon-face", quality: 0.12, intro: false });
    expect(icon.capacity).toBeLessThan(300);
    const n = icon.update(input(settledFrame("happy"), { dt: 0, width: 40, height: 40 }));
    expect(n).toBeGreaterThan(100);
  });

  it("入场：粒子先在上方，随后聚拢成形", () => {
    const field = createGlyphField({ framing: "stage", seed: 1 });
    expect(field.settled).toBe(false);
    const f = settledFrame("idle");
    const n0 = field.update(input(f, { dt: 0.25 }));
    const early = particles(field.out, n0);
    for (let i = 0; i < 120; i++) field.update(input(f));
    expect(field.settled).toBe(true);
    const n1 = field.update(input(f));
    const late = particles(field.out, n1);
    // 早期可见的粒子大多还在画面上半部分（下落中）；成形后可见粒子明显更多
    expect(early.filter((p) => p.y < H * 0.35).length).toBeGreaterThan(early.length * 0.4);
    expect(n1).toBeGreaterThan(n0 * 1.5);
    expect(late.length).toBe(n1);
  });

  it("表情不同，五官粒子位置不同（开心 ^ 与圆眼）", () => {
    const eyes = (mood: "idle" | "happy") => {
      const field = createGlyphField({ framing: "badge", intro: false, seed: 2 });
      const n = field.update(input(settledFrame(mood), { dt: 0 }));
      return particles(field.out, n).filter((p) => p.glyph === DOT);
    };
    const a = bbox(eyes("idle"));
    const b = bbox(eyes("happy"));
    expect(Math.abs(a.minY - b.minY) + Math.abs(a.maxY - b.maxY)).toBeGreaterThan(1);
  });

  it("问候：迸发星星，身体粒子向外炸开", () => {
    const field = createGlyphField({ framing: "stage", intro: false, seed: 4 });
    const f = settledFrame("idle");
    const n0 = field.update(input(f, { dt: 0 }));
    const spread0 = particles(field.out, n0).reduce((s, p) => s + Math.abs(p.x - W / 2), 0) / n0;
    field.update(input({ ...f, sparkles: 12 }));
    let n = 0;
    for (let i = 0; i < 10; i++) n = field.update(input(f));
    const ps = particles(field.out, n);
    const spread = ps.reduce((s, p) => s + Math.abs(p.x - W / 2), 0) / n;
    expect(spread).toBeGreaterThan(spread0);
    expect(n).toBeGreaterThan(n0);
  });

  it("指针悬停时附近粒子被拨开", () => {
    const f = settledFrame("idle");
    const a = createGlyphField({ framing: "stage", intro: false, seed: 5 });
    const b = createGlyphField({ framing: "stage", intro: false, seed: 5 });
    const na = a.update(input(f, { dt: 0 }));
    const nb = b.update(input(f, { dt: 0, pointer: { x: W / 2, y: H * 0.45 } }));
    expect(na).toBe(nb);
    let moved = 0;
    for (let i = 0; i < na * STRIDE; i += STRIDE) if (Math.abs(a.out[i] - b.out[i]) > 0.5) moved++;
    expect(moved).toBeGreaterThan(30);
  });

  it("同一种子可复现", () => {
    const f = settledFrame("thinking");
    const a = createGlyphField({ framing: "stage", intro: false, seed: 9 });
    const b = createGlyphField({ framing: "stage", intro: false, seed: 9 });
    const n = a.update(input(f, { dt: 0 }));
    b.update(input(f, { dt: 0 }));
    expect(Array.from(a.out.subarray(0, n * STRIDE))).toEqual(Array.from(b.out.subarray(0, n * STRIDE)));
  });
});
