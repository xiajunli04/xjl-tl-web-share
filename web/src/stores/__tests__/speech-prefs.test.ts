import { describe, expect, it } from "vitest";
import { persistSpeechPrefs, sanitizeSpeechPrefs, useSpeechPrefs } from "../speech-prefs";

describe("useSpeechPrefs 朗读偏好", () => {
  it("缺省女声、1.0×、不自动朗读；只持久化偏好字段", () => {
    const s = useSpeechPrefs.getState();
    expect([s.gender, s.rate, s.autoRead]).toEqual(["female", 1, false]);
    s.setGender("male");
    s.setRate(1.2);
    s.setAutoRead(true);
    expect(persistSpeechPrefs(useSpeechPrefs.getState())).toEqual({ gender: "male", rate: 1.2, autoRead: true });
  });

  it("恢复本地数据时校正非法值", () => {
    expect(sanitizeSpeechPrefs({ gender: "robot", rate: 3, autoRead: "yes" })).toEqual({
      gender: "female",
      rate: 1,
      autoRead: false,
    });
    expect(sanitizeSpeechPrefs({ gender: "male", rate: 0.8, autoRead: true })).toEqual({
      gender: "male",
      rate: 0.8,
      autoRead: true,
    });
    expect(sanitizeSpeechPrefs(null)).toEqual({ gender: "female", rate: 1, autoRead: false });
  });
});
