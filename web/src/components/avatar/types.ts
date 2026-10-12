/**
 * 数字人逐帧读取的信号（以函数形式提供，不触发 React 重渲染）。
 * 同传由运行时提供（麦克风电平、播放器分析节点）；首页演示由脚本提供。
 */
export interface AvatarSignals {
  /** 麦克风电平 0–1 */
  micLevel?: () => number;
  /** 播放输出的频谱分析节点（口型） */
  analyser?: () => AnalyserNode | null;
  /** 正在用浏览器朗读（无音频数据，改用伪口型） */
  pseudoSpeaking?: () => boolean;
}
