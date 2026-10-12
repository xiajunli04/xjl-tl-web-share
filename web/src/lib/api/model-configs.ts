import { http } from "@/lib/http";
import type {
  ModelConfigSaveRequest,
  ModelConfigVO,
  ModelTestResult,
  PageQuery,
  PageResult,
} from "./types";

const BASE = "/api/admin/model-configs";

export const modelConfigApi = {
  page: (q: PageQuery & { keyword?: string }) =>
    http.get<PageResult<ModelConfigVO>>(BASE, { ...q }),
  get: (id: number) => http.get<ModelConfigVO>(`${BASE}/${id}`),
  create: (body: ModelConfigSaveRequest) => http.post<ModelConfigVO>(BASE, body),
  update: (id: number, body: ModelConfigSaveRequest) =>
    http.put<ModelConfigVO>(`${BASE}/${id}`, body),
  remove: (id: number) => http.del<null>(`${BASE}/${id}`),
  setDefault: (id: number) => http.put<null>(`${BASE}/${id}/default`),
  /** 设为评审模型（自动取消原评审模型）；不存在 A0404，已停用 C0130 */
  setReviewDefault: (id: number) => http.put<null>(`${BASE}/${id}/review-default`),
  /** 取消评审模型标记（幂等） */
  clearReviewDefault: (id: number) => http.del<null>(`${BASE}/${id}/review-default`),
  setEnabled: (id: number, enabled: boolean) =>
    http.put<null>(`${BASE}/${id}/enabled`, { enabled }),
  test: (id: number) => http.post<ModelTestResult>(`${BASE}/${id}/test`),
};
