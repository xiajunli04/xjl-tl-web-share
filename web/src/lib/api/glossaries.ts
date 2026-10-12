import { http } from "@/lib/http";
import type { PageQuery, PageResult } from "./types";

// 与 design.md D7 契约一一对应

export type GlossaryScope = "PRIVATE" | "PUBLIC";

export interface GlossaryVO {
  id: number;
  name: string;
  description: string | null;
  sourceLang: string;
  targetLang: string;
  domain: string | null;
  scope: GlossaryScope;
  termCount: number;
  ownerId: number;
  ownerName: string;
  editable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GlossaryQuery extends PageQuery {
  keyword?: string;
  scope?: GlossaryScope;
  sourceLang?: string;
  targetLang?: string;
}

export interface GlossarySaveRequest {
  name: string;
  description?: string;
  sourceLang: string;
  targetLang: string;
  domain?: string;
  scope?: GlossaryScope;
}

export interface TermVO {
  id: number;
  sourceTerm: string;
  targetTerm: string;
  note: string | null;
  caseSensitive: boolean;
  updatedAt: string;
}

export interface TermSaveRequest {
  sourceTerm: string;
  targetTerm: string;
  note?: string;
  caseSensitive?: boolean;
}

/** 预览样例行（与 Spring GlossaryDtos.ImportSample 一致） */
export interface ImportSampleRow {
  line: number;
  sourceTerm: string;
  targetTerm: string;
  note?: string | null;
  /** 是否与已有术语冲突（导入时按策略跳过或覆盖） */
  exists: boolean;
}

export interface ImportPreview {
  total: number;
  valid: number;
  newCount: number;
  updateCount: number;
  errors: { line: number; message: string }[];
  sample: ImportSampleRow[];
}

export type ImportStrategy = "skip" | "overwrite";

export interface ImportResult {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
}

const BASE = "/api/glossaries";

export const glossaryApi = {
  page: (q: GlossaryQuery) => http.get<PageResult<GlossaryVO>>(BASE, { ...q }),
  get: (id: number) => http.get<GlossaryVO>(`${BASE}/${id}`),
  create: (body: GlossarySaveRequest) => http.post<GlossaryVO>(BASE, body),
  update: (id: number, body: GlossarySaveRequest) => http.put<GlossaryVO>(`${BASE}/${id}`, body),
  remove: (id: number) => http.del<null>(`${BASE}/${id}`),

  terms: (id: number, q: PageQuery & { keyword?: string }) =>
    http.get<PageResult<TermVO>>(`${BASE}/${id}/terms`, { ...q }),
  createTerm: (id: number, body: TermSaveRequest) =>
    http.post<TermVO>(`${BASE}/${id}/terms`, body),
  updateTerm: (id: number, termId: number, body: TermSaveRequest) =>
    http.put<TermVO>(`${BASE}/${id}/terms/${termId}`, body),
  removeTerm: (id: number, termId: number) => http.del<null>(`${BASE}/${id}/terms/${termId}`),

  importPreview: (id: number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return http.upload<ImportPreview>(`${BASE}/${id}/terms/import/preview`, form);
  },
  importTerms: (id: number, file: File, strategy: ImportStrategy) => {
    const form = new FormData();
    form.append("file", file);
    form.append("strategy", strategy);
    return http.upload<ImportResult>(`${BASE}/${id}/terms/import`, form);
  },
  exportTerms: (id: number) => http.download(`${BASE}/${id}/terms/export`),
};
