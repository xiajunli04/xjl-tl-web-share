"use client";

import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { docApi } from "@/lib/api/documents";
import { createDocTaskStore, type DocTaskStore } from "@/lib/doc-task";

export type DocTaskStoreApi = ReturnType<typeof createDocTaskStore>;

/**
 * useDocTask(id)：创建并订阅一个文档任务的状态 store。
 * - 合成 snapshot、段落（收到 parsed 后重新拉取）与增量事件（见 lib/doc-task.ts）
 * - 挂载时开始订阅，卸载时停止；任务进入终结状态后自动停止
 * 返回 store 本身，组件用 useDocTaskSelector 订阅局部状态，避免 2000 段的列表随任意字段变化重渲染。
 */
export function useDocTask(id: number): DocTaskStoreApi {
  const [store] = useState(() =>
    createDocTaskStore(id, { subscribe: docApi.subscribe, segments: docApi.segments, terms: docApi.terms }),
  );
  useEffect(() => {
    store.getState().start();
    return () => store.getState().stop();
  }, [store]);
  return store;
}

export function useDocTaskSelector<T>(store: DocTaskStoreApi, selector: (s: DocTaskStore) => T): T {
  return useStore(store, selector);
}
