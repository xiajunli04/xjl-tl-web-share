import type { ModelConfigVO } from "@/lib/api/types";
import type { ModelOption } from "@/lib/api/translate";

/** 评审模型相关的纯函数（模型配置页提示条、新建任务对话框、工作区概览共用） */

export const SAME_AS_TRANSLATOR = "与译者相同";
export const SAME_AS_TRANSLATOR_UNSET = "与译者相同（管理员未设置评审模型）";

type ConfigLike = Pick<ModelConfigVO, "id" | "name" | "isDefault" | "enabled"> & { isReviewDefault?: boolean };

export type ReviewNotice =
  /** 没有启用的评审模型：评审将使用译者模型 */
  | { kind: "unset"; key: string }
  /** 评审模型与默认模型是同一配置：等同于译者自评 */
  | { kind: "same"; key: string; name: string };

/**
 * 模型配置页顶部提示条的判定。
 * - 没有任何配置时返回 null（页面已有空状态与"未设置默认模型"的提示）；
 * - 没有启用的评审模型 → unset；
 * - 评审模型同时是默认模型 → same；
 * - 其余情况返回 null。
 * key 随情形变化，关闭提示后情形改变时会重新出现。
 */
export function reviewNoticeOf(configs: readonly ConfigLike[] | null | undefined): ReviewNotice | null {
  if (!configs?.length) return null;
  const review = configs.find((m) => m.isReviewDefault && m.enabled);
  if (!review) return { kind: "unset", key: "unset" };
  if (review.isDefault) return { kind: "same", key: `same:${review.id}`, name: review.name };
  return null;
}

/** 当前的评审模型选项（选项列表中 isReviewDefault=true 的那项） */
export function reviewOptionOf(options: readonly ModelOption[] | null | undefined): ModelOption | undefined {
  return options?.find((m) => m.isReviewDefault);
}

/**
 * 任务详情中的评审模型文案：
 * - 未开启评审 → null（不显示）；
 * - reviewModelConfigId 为空 → "与译者相同"；
 * - 在选项中找到 → 名称；找不到（已停用或删除） → "模型 #id"。
 */
export function taskReviewLabel(
  review: boolean,
  reviewModelConfigId: number | null | undefined,
  options: readonly ModelOption[] | null | undefined,
): string | null {
  if (!review) return null;
  if (reviewModelConfigId === null || reviewModelConfigId === undefined) return SAME_AS_TRANSLATOR;
  return options?.find((m) => m.id === reviewModelConfigId)?.name ?? `模型 #${reviewModelConfigId}`;
}
