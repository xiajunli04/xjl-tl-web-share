"""术语指标：translation-metrics 规格场景与匹配规则。"""

import pytest

from eval.metrics.terminology import TermEntry, TermMatcher, detect_lockin, evaluate_terms


def test_not_misled_by_substring():
    """规格场景"不被子串误导"：译文中"可部署"里的"部署"不计入 Deployment→部署。"""
    entry = TermEntry("Deployment", "部署", case_sensitive=True)
    src = "a Deployment creates Pods; the smallest deployable unit"
    tgt = "Deployment 会创建 Pod；最小的可部署单元"
    report = evaluate_terms([(src, tgt)], [entry])
    assert report.occurrences == 1
    assert report.accuracy == 0


def test_accuracy_counts_occurrences_not_presence():
    """原文出现 3 次、译文金标只出现 1 次 → 1/3，而不是"出现即遵循"。"""
    entry = TermEntry("node", "节点")
    src = "A node runs Pods. Each node has a kubelet. The node reports status."
    tgt = "节点运行 Pod。每个结点都有 kubelet。该机器上报状态。"
    report = evaluate_terms([(src, tgt)], [entry])
    assert report.occurrences == 3
    assert report.accuracy == pytest.approx(1 / 3)


def test_accuracy_caps_extra_target_occurrences():
    entry = TermEntry("node", "节点")
    report = evaluate_terms([("one node", "节点、节点、节点")], [entry])
    assert report.accuracy == 1.0


def test_consistency_scenario():
    """规格场景"一致率"：node 在 4 个段落中译为 节点、节点、节点、结点 → 0.75。"""
    entry = TermEntry("node", "节点", variants=("结点",))
    pairs = [("the node", "节点"), ("a node", "节点"), ("node pool", "节点池"), ("each node", "每个结点")]
    report = evaluate_terms(pairs, [entry])
    assert report.consistency == pytest.approx(0.75)
    assert report.terms[0].renderings == {"节点": 3, "结点": 1}


def test_cross_segment_accuracy_weighted_by_occurrence():
    a = TermEntry("Pod", "Pod", case_sensitive=True)
    b = TermEntry("cluster", "集群")
    pairs = [
        ("Pods run in a cluster. A Pod is small.", "Pod 运行在集群中。Pod 很小。"),  # Pod 2/2, cluster 1/1
        ("The cluster scales.", "群集会扩缩。"),  # cluster 0/1
        ("Not translated Pod.", None),  # Pod 0/1
    ]
    report = evaluate_terms(pairs, [a, b])
    assert report.occurrences == 5
    assert report.accuracy == pytest.approx(3 / 5)
    stats = {t.source: t for t in report.terms}
    assert stats["Pod"].accuracy == pytest.approx(2 / 3)
    assert stats["cluster"].accuracy == pytest.approx(1 / 2)


def test_word_boundary_and_plural_on_source():
    m = TermMatcher([e := TermEntry("Pod", "Pod", case_sensitive=True)])
    assert m.count_source(e, "Pods and a Pod, but not Podman or pod-template-hash") == 2


def test_case_sensitivity():
    cs = TermEntry("Service", "Service", case_sensitive=True)
    ci = TermEntry("node", "节点", case_sensitive=False)
    m = TermMatcher([cs, ci])
    assert m.count_source(cs, "A Service is not a network service") == 1
    assert m.count_source(ci, "Node and node and NODES") == 3


def test_inline_code_and_link_targets_are_skipped():
    e = TermEntry("Pod", "Pod", case_sensitive=True)
    m = TermMatcher([e])
    text = "Run `kubectl get Pod` and see [the docs](/docs/concepts/Pod/) for a Pod."
    assert m.count_source(e, text) == 1
    assert m.count_rendering("Pod", "运行 `kubectl get Pod`，参阅[文档](/docs/Pod/)了解 Pod。") == 1


def test_longer_source_term_masks_shorter():
    pod = TermEntry("Pod", "Pod", case_sensitive=True)
    tpl = TermEntry("Pod template", "Pod 模板", case_sensitive=True)
    m = TermMatcher([pod, tpl])
    assert m.count_source(pod, "The Pod template defines a Pod.") == 1
    assert m.count_rendering("Pod", "Pod 模板定义了一个 Pod。") == 1
    assert m.count_rendering("Pod 模板", "Pod模板定义了一个 Pod。") == 1  # 空白可有可无


def test_longer_gold_of_other_entry_masks_shorter_rendering():
    """统计"部署"时屏蔽其他条目中更长的"金丝雀部署"。"""
    dep = TermEntry("Deployment", "部署", case_sensitive=True)
    canary = TermEntry("canary deployment", "金丝雀部署")
    m = TermMatcher([dep, canary])
    assert m.count_rendering("部署", "金丝雀部署使用部署") == 1


def test_blockers_mask_ordinary_words():
    dep = TermEntry("Deployment", "部署", case_sensitive=True, blockers=("部署单元",))
    m = TermMatcher([dep])
    assert m.count_rendering("部署", "最小部署单元；创建部署") == 1
    # 自动规则："可" + 译法
    assert m.count_rendering("部署", "可部署的应用") == 0


def test_latin_rendering_boundaries_in_chinese_text():
    e = TermEntry("Deployment", "Deployment", variants=("部署",), case_sensitive=True)
    m = TermMatcher([e])
    assert m.count_rendering("Deployment", "创建Deployment后，DeploymentSpec 不算，deployments 算") == 2


def test_proper_noun_consistency_only_counts_proper_nouns():
    k8s = TermEntry("Kubernetes", "Kubernetes", variants=("K8s",), case_sensitive=True, kind="proper_noun")
    node = TermEntry("node", "节点", variants=("结点",))
    pairs = [("Kubernetes node", "Kubernetes 节点"), ("Kubernetes node", "K8s 结点")]
    report = evaluate_terms(pairs, [k8s, node])
    assert report.proper_noun_consistency == pytest.approx(0.5)
    assert report.consistency == pytest.approx(0.5)


def test_no_occurrence_gives_none():
    report = evaluate_terms([("nothing here", "无")], [TermEntry("node", "节点")])
    assert report.accuracy is None and report.consistency is None


def test_detect_lockin_scenario():
    """规格场景"识别锁定运行"：Deployment 出现 10 次，只有 1 段保留 → 锁定。"""
    entries = [TermEntry("Deployment", "Deployment", case_sensitive=True), TermEntry("Pod", "Pod")]
    pairs = [("A Deployment runs.", "部署运行。")] * 9 + [("A Deployment runs.", "Deployment 运行。")]
    pairs += [("A Pod.", "一个 Pod。")] * 4
    locked = detect_lockin(pairs, entries)
    assert [(t.source, t.kept, t.occurrences) for t in locked] == [("Deployment", 1, 10)]


def test_detect_lockin_ignores_rare_lowercase_and_translated_gold():
    entries = [
        TermEntry("Service", "Service"),  # 金标未标区分大小写，锁定判定仍区分大小写
        TermEntry("Deployment", "Deployment"),
        TermEntry("namespace", "名字空间"),  # 金标本身是译法：不参与锁定判定
    ]
    pairs = [("the service is up", "服务已启动")] * 5  # 小写普通词不计
    pairs += [("A Deployment.", "部署。")] * 2  # 不足 3 次
    pairs += [("a namespace", "命名空间")] * 5
    assert detect_lockin(pairs, entries) == []
    assert detect_lockin([], [TermEntry("namespace", "名字空间")]) == []
