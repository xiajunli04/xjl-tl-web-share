/**
 * 文档翻译 mock 的样例数据（仅开发环境）：
 * - K8S_GUIDE：docs/contracts/fixtures/k8s-guide.md 的内容（CRLF 段落按 LF 内嵌）
 * - ZH：逐段的中文译文；首译中故意保留两处"不一致"的译法，供一致性阶段修正
 * - splitMarkdown：简化版的 Markdown 块切分（prefix + source + suffix 可拼回原文），只服务于 mock
 */
import type { DocBlockType, DocSegmentVO, DocTermVO } from "@/lib/api/documents";

export const K8S_GUIDE = `# Kubernetes Deployment Guide

Kubernetes is an open-source platform for automating the deployment, scaling and management of containerized applications. This guide walks you through deploying a stateless web application on a Kubernetes cluster, and explains the core concepts you will meet along the way.

## Core Concepts

A **Pod** is the smallest deployable unit in Kubernetes. Each Pod wraps one or more containers that share storage and network resources. Pods are ephemeral: when a node fails, the Pods running on it are lost, and a controller such as a Deployment creates replacement Pods on healthy nodes.

- A **Node** is a worker machine, either virtual or physical.
  - Every Node runs the \`kubelet\`, which talks to the control plane.
  - The container runtime on the Node pulls images and starts containers.
- A **Deployment** declares the desired state of your Pods.
- A **Service** exposes a set of Pods behind a stable network endpoint.

> Tip: keep your Pods stateless whenever possible. Stateless Pods can be rescheduled freely, which makes scaling and rolling updates much easier.

## Deploying the Application

First, make sure \`kubectl\` is configured to talk to your cluster. Run \`kubectl get nodes\` and check that every Node reports the status \`Ready\`. If you are new to the command line tool, see [the kubectl reference](https://kubernetes.io/docs/reference/kubectl/) for details.

Save the following manifest as \`deployment.yaml\`:

\`\`\`yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web
\`\`\`

Then apply it with \`kubectl apply -f deployment.yaml\`. The Deployment controller creates three Pods and keeps them running. If a Pod crashes, the controller replaces it automatically.

1. Check the rollout status with \`kubectl rollout status deployment/web\`.
2. List the Pods with \`kubectl get pods -l app=web\`.
3. Expose the Deployment through a Service of type \`LoadBalancer\`.

| Resource | Purpose | Scope |
| --- | --- | --- |
| Pod | Runs one or more containers | Namespace |
| Deployment | Manages replicated Pods | Namespace |
| Node | Provides compute capacity | Cluster |

<div class="note">The table above lists only the resources used in this guide.</div>

## Scaling and Updates

To handle more traffic, scale the Deployment to five replicas with \`kubectl scale deployment/web --replicas=5\`. Kubernetes schedules the new Pods on Nodes that have enough CPU and memory. Horizontal scaling works best when every Pod is identical and stateless.

When you release a new version, update the container image in the Deployment. Kubernetes performs a rolling update: it starts new Pods with the new image, waits until they are ready, and only then terminates the old Pods. If the new version fails its readiness checks, the rollout pauses, and you can roll back with \`kubectl rollout undo deployment/web\`.

---

This paragraph uses Windows line endings.
It spans two lines inside the same paragraph.

Hello {name}, your cluster has %d Nodes and the dashboard is available at https://dashboard.example.com.
`;

export const SHORT_NOTE = `Machine translation has come a long way. Early systems relied on hand-written rules, while modern systems learn from large parallel corpora.

Large language models can now translate whole documents. They keep terminology consistent when they are given a glossary and enough context.

However, human review is still important for legal and medical texts, where a single mistranslated term can have serious consequences.
`;

/** 首译（含刻意的不一致：工作节点 / 滚动升级） */
export const ZH: Record<string, string> = {
  "Kubernetes Deployment Guide": "Kubernetes 部署指南",
  "Kubernetes Operations Handbook": "Kubernetes 运维手册",
  "Kubernetes is an open-source platform for automating the deployment, scaling and management of containerized applications. This guide walks you through deploying a stateless web application on a Kubernetes cluster, and explains the core concepts you will meet along the way.":
    "Kubernetes 是一个用于自动化部署、扩缩容和管理容器化应用的开源平台。本指南将带你在 Kubernetes 集群上部署一个无状态 Web 应用，并讲解途中会遇到的核心概念。",
  "Core Concepts": "核心概念",
  "A **Pod** is the smallest deployable unit in Kubernetes. Each Pod wraps one or more containers that share storage and network resources. Pods are ephemeral: when a node fails, the Pods running on it are lost, and a controller such as a Deployment creates replacement Pods on healthy nodes.":
    "**Pod** 是 Kubernetes 中最小的可部署单元。每个 Pod 封装一个或多个共享存储与网络资源的容器。Pod 是临时性的：当某个工作节点发生故障时，运行在其上的 Pod 会丢失，Deployment 等控制器会在健康的节点上创建替代的 Pod。",
  "A **Node** is a worker machine, either virtual or physical.": "**节点**是一台工作机器，可以是虚拟机，也可以是物理机。",
  "Every Node runs the `kubelet`, which talks to the control plane.": "每个节点都运行 `kubelet`，由它与控制平面通信。",
  "The container runtime on the Node pulls images and starts containers.": "节点上的容器运行时负责拉取镜像并启动容器。",
  "A **Deployment** declares the desired state of your Pods.": "**Deployment** 声明 Pod 的期望状态。",
  "A **Service** exposes a set of Pods behind a stable network endpoint.": "**Service** 通过一个稳定的网络端点暴露一组 Pod。",
  "Tip: keep your Pods stateless whenever possible. Stateless Pods can be rescheduled freely, which makes scaling and rolling updates much easier.":
    "提示：尽可能让 Pod 保持无状态。无状态的 Pod 可以被自由地重新调度，这会让扩缩容和滚动更新容易得多。",
  "Deploying the Application": "部署应用",
  "First, make sure `kubectl` is configured to talk to your cluster. Run `kubectl get nodes` and check that every Node reports the status `Ready`. If you are new to the command line tool, see [the kubectl reference](https://kubernetes.io/docs/reference/kubectl/) for details.":
    "首先，确认 `kubectl` 已配置为可以访问你的集群。运行 `kubectl get nodes`，检查每个工作节点的状态是否都为 `Ready`。如果你刚接触这个命令行工具，请参阅 [kubectl 参考文档](https://kubernetes.io/docs/reference/kubectl/) 了解详情。",
  "Save the following manifest as `deployment.yaml`:": "将以下清单保存为 `deployment.yaml`：",
  "Then apply it with `kubectl apply -f deployment.yaml`. The Deployment controller creates three Pods and keeps them running. If a Pod crashes, the controller replaces it automatically.":
    "然后使用 `kubectl apply -f deployment.yaml` 应用它。Deployment 控制器会创建三个 Pod 并保持其运行。如果某个 Pod 崩溃，控制器会自动替换它。",
  "Check the rollout status with `kubectl rollout status deployment/web`.": "使用 `kubectl rollout status deployment/web` 查看发布状态。",
  "List the Pods with `kubectl get pods -l app=web`.": "使用 `kubectl get pods -l app=web` 列出 Pod。",
  "Expose the Deployment through a Service of type `LoadBalancer`.": "通过 `LoadBalancer` 类型的 Service 暴露该 Deployment。",
  "Resource | Purpose | Scope": "资源 | 用途 | 作用域",
  "Pod | Runs one or more containers | Namespace": "Pod | 运行一个或多个容器 | 命名空间",
  "Deployment | Manages replicated Pods | Namespace": "Deployment | 管理多副本的 Pod | 命名空间",
  "Node | Provides compute capacity | Cluster": "节点 | 提供计算资源 | 集群",
  "Scaling and Updates": "扩缩容与更新",
  "To handle more traffic, scale the Deployment to five replicas with `kubectl scale deployment/web --replicas=5`. Kubernetes schedules the new Pods on Nodes that have enough CPU and memory. Horizontal scaling works best when every Pod is identical and stateless.":
    "为了承载更多流量，使用 `kubectl scale deployment/web --replicas=5` 将 Deployment 扩容到五个副本。Kubernetes 会把新的 Pod 调度到 CPU 和内存充足的节点上。当每个 Pod 都完全相同且无状态时，水平扩缩容的效果最好。",
  "When you release a new version, update the container image in the Deployment. Kubernetes performs a rolling update: it starts new Pods with the new image, waits until they are ready, and only then terminates the old Pods. If the new version fails its readiness checks, the rollout pauses, and you can roll back with `kubectl rollout undo deployment/web`.":
    "发布新版本时，更新 Deployment 中的容器镜像即可。Kubernetes 会执行滚动升级：先用新镜像启动新的 Pod，等待其就绪后才终止旧的 Pod。如果新版本未通过就绪检查，发布会暂停，你可以使用 `kubectl rollout undo deployment/web` 回滚。",
  "This paragraph uses Windows line endings.\nIt spans two lines inside the same paragraph.": "本段使用 Windows 换行符。\n它在同一段落内跨越两行。",
  "Hello {name}, your cluster has %d Nodes and the dashboard is available at https://dashboard.example.com.":
    "你好 {name}，你的集群共有 %d 个节点，控制台地址为 https://dashboard.example.com。",
  "Machine translation has come a long way. Early systems relied on hand-written rules, while modern systems learn from large parallel corpora.":
    "机器翻译已经走过了很长的路。早期系统依赖人工编写的规则，而现代系统则从大规模平行语料中学习。",
  "Large language models can now translate whole documents. They keep terminology consistent when they are given a glossary and enough context.":
    "如今，大语言模型已经可以翻译整篇文档。只要提供术语表和足够的上下文，它们就能保持术语一致。",
  "However, human review is still important for legal and medical texts, where a single mistranslated term can have serious consequences.":
    "不过，对于法律和医学文本，人工审校依然重要，因为一个术语的误译就可能造成严重后果。",
};

/** 一致性阶段的统一规则：错误译法 → 选定译法 */
export const CONSISTENCY_FIXES: { term: string; wrong: string; chosen: string }[] = [
  { term: "Node", wrong: "工作节点", chosen: "节点" },
  { term: "rolling update", wrong: "滚动升级", chosen: "滚动更新" },
];

export const K8S_TERMS: Omit<DocTermVO, "id">[] = [
  { source: "Pod", target: "Pod", origin: "extracted", frequency: 14, status: "PENDING" },
  { source: "Node", target: "节点", origin: "glossary", frequency: 9, status: "PENDING" },
  { source: "Deployment", target: "Deployment", origin: "extracted", frequency: 8, status: "PENDING" },
  { source: "cluster", target: "集群", origin: "glossary", frequency: 3, status: "PENDING" },
  { source: "Service", target: "Service", origin: "extracted", frequency: 3, status: "PENDING" },
  { source: "rolling update", target: "滚动更新", origin: "glossary", frequency: 2, status: "PENDING" },
  { source: "replicas", target: "副本", origin: "extracted", frequency: 2, status: "PENDING" },
  { source: "control plane", target: "控制面", origin: "extracted", frequency: 2, status: "PENDING" },
  { source: "container runtime", target: "容器运行时", origin: "extracted", frequency: 2, status: "PENDING" },
  { source: "readiness checks", target: "就绪检查", origin: "extracted", frequency: 2, status: "PENDING" },
];

export interface MockSeg {
  blockType: DocBlockType;
  level: number | null;
  prefix: string;
  source: string;
  suffix: string;
  translatable: boolean;
}

/** 简化版块切分：空行并入上一块的 suffix；保证 prefix + source + suffix 逐段拼回原文 */
export function splitMarkdown(text: string, format: "md" | "txt" = "md"): MockSeg[] {
  const src = text.replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  // 以换行结尾时 split 会多出一个空串，它不代表空行
  const endsWithNl = lines.length > 1 && lines[lines.length - 1] === "";
  if (endsWithNl) lines.pop();
  const out: MockSeg[] = [];
  const push = (s: MockSeg) => out.push(s);
  const trailBlank = () => {
    // 把紧随其后的空行并入上一块 suffix
    while (i < lines.length && lines[i] === "" && out.length) {
      out[out.length - 1].suffix += "\n";
      i++;
    }
  };
  let i = 0;
  // 开头的空行
  let lead = "";
  while (i < lines.length && lines[i] === "") {
    lead += "\n";
    i++;
  }
  if (lead) push({ blockType: "blank", level: null, prefix: "", source: lead, suffix: "", translatable: false });
  while (i < lines.length) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    const nl = isLast && !endsWithNl ? "" : "\n";
    if (line === "") {
      i++;
      continue;
    }
    if (format === "txt") {
      const buf: string[] = [];
      while (i < lines.length && lines[i] !== "") buf.push(lines[i++]);
      push({ blockType: "paragraph", level: null, prefix: "", source: buf.join("\n"), suffix: i < lines.length || endsWithNl ? "\n" : "", translatable: true });
      trailBlank();
      continue;
    }
    let m: RegExpMatchArray | null;
    if (/^```/.test(line)) {
      const buf = [line];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      if (i < lines.length) buf.push(lines[i++]);
      push({ blockType: "code", level: null, prefix: "", source: buf.join("\n"), suffix: i < lines.length || endsWithNl ? "\n" : "", translatable: false });
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      push({ blockType: "heading", level: m[1].length, prefix: `${m[1]} `, source: m[2], suffix: nl, translatable: true });
      i++;
    } else if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      push({ blockType: "hr", level: null, prefix: "", source: line, suffix: nl, translatable: false });
      i++;
    } else if (/^\|/.test(line)) {
      if (/^\|[\s:|-]+\|\s*$/.test(line)) {
        push({ blockType: "table_row", level: null, prefix: "", source: line, suffix: nl, translatable: false });
      } else {
        const inner = line.replace(/^\|\s?/, "").replace(/\s?\|\s*$/, "");
        const head = line.match(/^\|\s?/)![0];
        const tail = line.slice(head.length + inner.length);
        push({ blockType: "table_row", level: null, prefix: head, source: inner, suffix: tail + nl, translatable: true });
      }
      i++;
    } else if (/^<\w/.test(line)) {
      push({ blockType: "html", level: null, prefix: "", source: line, suffix: nl, translatable: false });
      i++;
    } else if ((m = line.match(/^>\s?/))) {
      push({ blockType: "blockquote", level: null, prefix: m[0], source: line.slice(m[0].length), suffix: nl, translatable: true });
      i++;
    } else if ((m = line.match(/^(\s*)([-*+]|\d+\.)\s+/))) {
      push({
        blockType: "list_item",
        level: Math.floor(m[1].length / 2) + 1,
        prefix: m[0],
        source: line.slice(m[0].length),
        suffix: nl,
        translatable: true,
      });
      i++;
    } else {
      const buf: string[] = [];
      while (
        i < lines.length &&
        lines[i] !== "" &&
        !/^(#{1,6}\s|```|>|\||<\w|\s*([-*+]|\d+\.)\s)/.test(lines[i])
      ) {
        buf.push(lines[i++]);
      }
      push({ blockType: "paragraph", level: null, prefix: "", source: buf.join("\n"), suffix: i < lines.length || endsWithNl ? "\n" : "", translatable: true });
    }
    trailBlank();
  }
  return out;
}

/** D4 的 token 估算：中日韩字符按 1，其余每 4 个字符 1 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[぀-ヿ㐀-鿿가-힯]/.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

/** 分块：按 token 累积到目标值时切块，不跨一、二级标题 */
export function chunkSegs(segs: MockSeg[], target: number): number[] {
  const chunkOf: number[] = [];
  let chunk = 0;
  let acc = 0;
  segs.forEach((s, i) => {
    const t = estimateTokens(s.source);
    const boundary = s.blockType === "heading" && (s.level ?? 9) <= 2 && i > 0 && acc > 0;
    if (boundary || (acc > 0 && acc + t > target)) {
      chunk++;
      acc = 0;
    }
    chunkOf.push(chunk);
    acc += t;
  });
  return chunkOf;
}

/** 生成约 n 段的长文档（用于虚拟列表性能自查） */
export function buildLongDoc(n = 2000): string {
  const base = splitMarkdown(K8S_GUIDE).filter((s) => s.blockType !== "blank" && s.blockType !== "heading");
  const titles = ["Core Concepts", "Deploying the Application", "Scaling and Updates"];
  const parts: string[] = ["# Kubernetes Operations Handbook\n\n"];
  let count = 1;
  let section = 1;
  while (count < n) {
    parts.push(`## ${section}. ${titles[(section - 1) % titles.length]}\n\n`);
    count++;
    for (const s of base) {
      if (count >= n) break;
      parts.push(s.prefix + s.source + s.suffix);
      count++;
    }
    parts.push("\n");
    section++;
  }
  return parts.join("");
}

const NUM_PREFIX = /^(\d+(?:\.\d+)*\.?\s+)([\s\S]*)$/;

/** mock 译文：优先查表，其次处理"编号 + 标题"，否则返回带标记的伪译文 */
export function mockTranslate(source: string, targetLang: string): string {
  const key = source.replace(/\r\n?/g, "\n");
  if (targetLang === "zh") {
    if (ZH[key]) return ZH[key];
    const m = key.match(NUM_PREFIX);
    if (m && ZH[m[2]]) return m[1] + ZH[m[2]];
    return `〔译〕${key}`;
  }
  return `[${targetLang}] ${key}`;
}

/** 由段落生成 DocSegmentVO（未翻译） */
export function toSegments(segs: MockSeg[], chunkTarget: number): DocSegmentVO[] {
  const chunkOf = chunkSegs(segs, chunkTarget);
  return segs.map((s, i) => ({
    seq: i,
    blockType: s.blockType,
    level: s.level,
    prefix: s.prefix,
    source: s.source,
    suffix: s.suffix,
    translatable: s.translatable,
    chunkIndex: chunkOf[i],
    target: null,
    status: s.translatable ? "PENDING" : "SKIPPED",
    reviewScore: null,
    reviewRounds: null,
    compliance: null,
    edited: false,
  }));
}
