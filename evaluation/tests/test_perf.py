"""压测工具：mock 模型配置的切换与恢复（含异常退出）、locust 统计解析与汇总合并。"""

import json

import pytest

from eval.perf import mock_model, run
from eval.perf.mock_model import MOCK_BASE_URL, MOCK_NAME, MockModelSwitch


class FakeAdmin:
    def __init__(self, configs):
        self.configs = configs
        self.calls = []

    def model_configs(self):
        return [dict(c) for c in self.configs]

    def default_model_config(self):
        return next((dict(c) for c in self.configs if c["isDefault"]), None)

    def create_model_config(self, body):
        c = {"id": 99, "name": body["name"], "baseUrl": body["baseUrl"], "isDefault": False, "enabled": True}
        self.configs.append(c)
        self.calls.append(("create", 99))
        return dict(c)

    def set_default_model(self, cid):
        self.calls.append(("default", cid))
        for c in self.configs:
            c["isDefault"] = c["id"] == cid

    def set_model_enabled(self, cid, enabled):
        self.calls.append(("enabled", cid, enabled))
        for c in self.configs:
            if c["id"] == cid:
                c["enabled"] = enabled
                if not enabled:
                    c["isDefault"] = False


def _configs():
    return [{"id": 2, "name": "real", "baseUrl": "https://x/v1", "isDefault": True, "enabled": True}]


def test_switch_registers_mock_and_restores_on_exception(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_model.atexit, "register", lambda f: None)
    admin = FakeAdmin(_configs())
    restore_file = tmp_path / ".restore.json"
    switch = MockModelSwitch(admin, restore_file)
    with pytest.raises(RuntimeError), switch:
        assert admin.default_model_config()["id"] == 99
        assert json.loads(restore_file.read_text())["originalId"] == 2
        raise RuntimeError("压测中途失败")
    assert admin.default_model_config()["id"] == 2
    mock = next(c for c in admin.configs if c["id"] == 99)
    assert mock["enabled"] is False
    assert switch.restored_state == {"defaultId": 2, "mockId": 99, "mockEnabled": False}
    assert not restore_file.exists()
    # 恢复只执行一次（atexit 再次调用时不重复请求）
    n = len(admin.calls)
    switch.restore()
    assert len(admin.calls) == n


def test_switch_reuses_disabled_mock_config(tmp_path, monkeypatch):
    monkeypatch.setattr(mock_model.atexit, "register", lambda f: None)
    configs = _configs() + [
        {"id": 4, "name": MOCK_NAME, "baseUrl": MOCK_BASE_URL, "isDefault": False, "enabled": False}
    ]
    admin = FakeAdmin(configs)
    with MockModelSwitch(admin, tmp_path / "r.json"):
        assert admin.default_model_config()["id"] == 4
    assert ("create", 99) not in admin.calls
    assert admin.default_model_config()["id"] == 2


def test_switch_recovers_original_after_previous_crash(tmp_path, monkeypatch):
    """上次异常退出导致 mock 仍是默认：从恢复文件读取真正的原默认模型。"""
    monkeypatch.setattr(mock_model.atexit, "register", lambda f: None)
    configs = [
        {"id": 2, "name": "real", "baseUrl": "https://x/v1", "isDefault": False, "enabled": True},
        {"id": 4, "name": MOCK_NAME, "baseUrl": MOCK_BASE_URL, "isDefault": True, "enabled": True},
    ]
    restore_file = tmp_path / "r.json"
    restore_file.write_text(json.dumps({"originalId": 2, "mockId": 4}))
    admin = FakeAdmin(configs)
    with MockModelSwitch(admin, restore_file):
        pass
    assert admin.default_model_config()["id"] == 2


def test_restore_from_file(tmp_path):
    configs = [
        {"id": 2, "name": "real", "baseUrl": "https://x/v1", "isDefault": False, "enabled": True},
        {"id": 4, "name": MOCK_NAME, "baseUrl": MOCK_BASE_URL, "isDefault": True, "enabled": True},
    ]
    f = tmp_path / "r.json"
    f.write_text(json.dumps({"originalId": 2}))
    state = mock_model.restore_from_file(FakeAdmin(configs), f)
    assert state == {"defaultId": 2, "mockId": 4, "mockEnabled": False}


HEADER = (
    "Type,Name,Request Count,Failure Count,Median Response Time,Average Response Time,Min Response Time,"
    "Max Response Time,Average Content Size,Requests/s,Failures/s,50%,66%,75%,80%,90%,95%,98%,99%,99.9%,99.99%,100%"
)
STATS = (
    HEADER
    + """
GET,GET /api/glossaries,48,2,25,27.4,10,56.3,100,4.0,0.1,25,30,33,35,40,46,50,56,56,56,56
SSE,translate TTFE,50,0,140,163.1,90,310.5,0,3.63,0,140,150,160,170,200,300,310,310,310,310,310
POST,/api/auth/login,10,0,330,322.5,300,345.7,0,0.83,0,330,330,340,340,350,350,350,350,350,350,350
,Aggregated,108,2,30,50.8,10,345.7,0,7.0,0.1,30,40,50,60,140,300,330,330,350,350,350
"""
)


def test_parse_stats_and_merge_summary(tmp_path):
    p = tmp_path / "s.csv"
    p.write_text(STATS, encoding="utf-8")
    rows = run.parse_stats(p, "rest", 10, 15)
    names = [r["name"] for r in rows]
    assert names == ["GET /api/glossaries", "SSE translate TTFE", "POST /api/auth/login", "Aggregated"]
    g = rows[0]
    assert g["error_rate"] == round(2 / 48, 4) and g["p95_ms"] == 46 and g["p99_ms"] == 56 and g["rps"] == 4.0

    summary = tmp_path / "summary.csv"
    run.write_summary(rows, summary)
    run.write_summary(run.parse_stats(p, "stream", 10, 15), summary)
    run.write_summary(rows[:1], summary)  # 同一 (rest, 10) 被替换
    text = summary.read_text(encoding="utf-8").splitlines()
    assert sum(1 for line in text if line.startswith("rest,")) == 1
    assert sum(1 for line in text if line.startswith("stream,")) == 4


def test_doc_percentile():
    from eval.perf.doc_throughput import _percentile

    assert _percentile([], 0.5) is None
    assert _percentile([1, 2, 3, 4], 0.5) == 2.5
