"""3.1 提示词快照用例（测试与快照生成共用）。"""

from app.agent.state import TranslationContext
from app.doc import prompts
from app.doc.memory import ChunkMemory
from app.glossary.matcher import SOFT, TermHit


def snapshot_messages():
    ctx = TranslationContext(
        terms=[TermHit("Pod", "容器组", 0), TermHit("Deployment", "部署", 0, binding=SOFT)],
        domain_hint="计算机",
        style="faithful",
    )
    memory = ChunkMemory(
        summary="本文介绍如何在 Kubernetes 集群上部署无状态应用。",
        names=[("Kubernetes", "Kubernetes"), ("kubelet", "kubelet")],
        prev=[("A **Node** is a worker machine.", "**节点**是一台工作机器。")],
    )
    items = [{"id": 5, "text": "Every Node runs the ⟦0⟧."}]
    return prompts.translate_messages(ctx, memory, items, "en", "zh")


def render(messages) -> str:
    return "\n\n".join(f"===== {m.role} =====\n{m.content}" for m in messages) + "\n"
