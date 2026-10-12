"use client";

import { useQuery } from "@tanstack/react-query";
import { translateApi } from "@/lib/api/translate";
import { glossaryApi } from "@/lib/api/glossaries";
import { FALLBACK_LANGUAGES } from "@/lib/languages";

/** 支持语种（接口失败时使用内置清单兜底） */
export function useLanguages() {
  const q = useQuery({
    queryKey: ["translate", "languages"],
    queryFn: translateApi.languages,
    staleTime: Infinity,
    retry: false,
  });
  return q.data?.length ? q.data : FALLBACK_LANGUAGES;
}

/** 可用模型选项（已启用，默认模型在前） */
export function useModelOptions() {
  return useQuery({
    queryKey: ["model-configs", "options"],
    queryFn: translateApi.modelOptions,
    staleTime: 60_000,
    retry: false,
  });
}

/** 可选术语库（自己的 + 公共的） */
export function useGlossaryOptions() {
  return useQuery({
    queryKey: ["glossaries", "options"],
    queryFn: () => glossaryApi.page({ pageNum: 1, pageSize: 100 }),
    staleTime: 30_000,
    retry: false,
    select: (d) => d.records,
  });
}
