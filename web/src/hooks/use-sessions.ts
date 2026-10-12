"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SESSIONS_QUERY_KEY,
  sessionDetailKey,
  sessionsApi,
  type SessionDetailVO,
  type SessionSaveRequest,
} from "@/lib/api/sessions";
import type { PageResult } from "@/lib/api/types";
import type { SessionSummaryVO } from "@/lib/api/sessions";

/** 会话列表（按更新时间倒序，前 50 个；标题关键词检索） */
export function useSessionList(keyword: string, enabled = true) {
  return useQuery({
    queryKey: [...SESSIONS_QUERY_KEY, "list", keyword],
    queryFn: () => sessionsApi.page({ pageNum: 1, pageSize: 50, keyword: keyword || undefined }),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** 会话详情（轮次、版本链、pending、会话记忆） */
export function useSessionDetail(id: number | null) {
  return useQuery({
    queryKey: sessionDetailKey(id),
    queryFn: () => sessionsApi.get(id!),
    enabled: id !== null,
    retry: false,
  });
}

/** 局部更新列表缓存中的某个会话（重命名等） */
function patchLists(qc: ReturnType<typeof useQueryClient>, id: number, patch: Partial<SessionSummaryVO> | null) {
  qc.setQueriesData<PageResult<SessionSummaryVO>>({ queryKey: [...SESSIONS_QUERY_KEY, "list"] }, (old) => {
    if (!old) return old;
    if (patch === null) return { ...old, total: old.total - 1, records: old.records.filter((r) => r.id !== id) };
    return { ...old, records: old.records.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
  });
}

export function useSessionMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });

  const create = useMutation({
    mutationFn: sessionsApi.create,
    onSuccess: () => void invalidate(),
  });

  const update = useMutation({
    mutationFn: (p: { id: number; body: SessionSaveRequest }) => sessionsApi.update(p.id, p.body),
    onMutate: (p) => {
      if (p.body.title !== undefined) patchLists(qc, p.id, { title: p.body.title });
      qc.setQueryData<SessionDetailVO>(sessionDetailKey(p.id), (old) =>
        old ? ({ ...old, ...Object.fromEntries(Object.entries(p.body).filter(([, v]) => v !== undefined)) } as SessionDetailVO) : old,
      );
    },
    onSettled: () => void invalidate(),
  });

  const remove = useMutation({
    mutationFn: (id: number) => sessionsApi.remove(id),
    onSuccess: (_d, id) => {
      patchLists(qc, id, null);
      qc.removeQueries({ queryKey: sessionDetailKey(id) });
      setTimeout(() => void invalidate(), 400);
    },
  });

  const adopt = useMutation({
    mutationFn: (p: { id: number; recordId: number; seq: number }) => sessionsApi.adopt(p.id, p.recordId),
    onSuccess: (detail, p) => {
      if (detail && Array.isArray(detail.turns)) qc.setQueryData(sessionDetailKey(p.id), detail);
      else void qc.invalidateQueries({ queryKey: sessionDetailKey(p.id) });
    },
  });

  return { create, update, remove, adopt };
}
