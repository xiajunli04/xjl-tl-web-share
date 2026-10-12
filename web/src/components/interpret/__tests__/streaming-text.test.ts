import { describe, expect, it } from "vitest";
import { nearBottom } from "@/hooks/use-stick-to-bottom";
import { stablePrefix } from "../streaming-text";

describe("stablePrefix（partial 稳定前缀，improve-speech-endpointing-and-live-ux 6.1）", () => {
  it("中文按字取最长公共前缀", () => {
    expect(stablePrefix("大家好今天", "大家好，今天我们")).toBe(3);
    expect(stablePrefix("", "你好")).toBe(0);
    expect(stablePrefix("你好", "你好")).toBe(2);
  });

  it("拉丁文字落在单词中间时回退到词首，避免半个词闪烁", () => {
    expect(stablePrefix("Let's move on to the quart", "Let's move on to the quarterly")).toBe(21);
    expect(stablePrefix("I want to go", "I want two")).toBe(7);
    expect(stablePrefix("Hello world", "Hello there")).toBe(6);
  });
});

describe("nearBottom（跟随滚动）", () => {
  it("距底部 96 px 以内视为在底部", () => {
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 320 })).toBe(true);
    expect(nearBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 320 })).toBe(false);
  });
});
