"""biz.model_config 只读访问（tl_ai 只有 SELECT 权限）。"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from app.core.db import Database

_COLUMNS = (
    "id, name, provider, base_url, model_name, api_key_cipher, params, is_default, enabled, updated_at, "
    "capability, supports_vision"
)

CHAT = "CHAT"
ASR = "ASR"
TTS = "TTS"
REALTIME_TRANSLATE = "REALTIME_TRANSLATE"
REALTIME_CHAT = "REALTIME_CHAT"  # 实时语音对话（improve-speech-playback-latency D7）
IMAGE_TRANSLATE = "IMAGE_TRANSLATE"


@dataclass
class ModelConfig:
    id: int
    name: str
    provider: str
    base_url: str
    model_name: str
    api_key_cipher: str
    is_default: bool
    enabled: bool
    updated_at: datetime
    params: dict[str, Any] = field(default_factory=dict)  # camelCase：temperature / maxTokens / timeoutSeconds / extra
    capability: str = CHAT  # CHAT / ASR / TTS / REALTIME_TRANSLATE / REALTIME_CHAT / IMAGE_TRANSLATE
    supports_vision: bool = False

    @property
    def extra(self) -> dict[str, str]:
        """引擎相关的非敏感参数（voice、appId、reasoningEffort 等）。"""
        return dict(self.params.get("extra") or {})


class ModelConfigRepository:
    def __init__(self, db: Database):
        self._db = db

    @staticmethod
    def _to_entity(row: dict | None) -> ModelConfig | None:
        if row is None:
            return None
        row = dict(row)
        row["params"] = row.get("params") or {}
        return ModelConfig(**row)

    async def find_active_by_id(self, config_id: int) -> ModelConfig | None:
        row = await self._db.fetch_one(
            f"select {_COLUMNS} from biz.model_config where id = %s and enabled and not deleted",
            (config_id,),
        )
        return self._to_entity(row)

    async def find_default(self, capability: str = CHAT) -> ModelConfig | None:
        """某能力的默认配置；未指定时取 CHAT（翻译、解读、图片翻译的"默认模型"都只指对话模型）。"""
        row = await self._db.fetch_one(
            f"select {_COLUMNS} from biz.model_config "
            "where is_default and enabled and not deleted and capability = %s limit 1",
            (capability,),
        )
        return self._to_entity(row)

    async def find_enabled(self, capability: str) -> list[ModelConfig]:
        """某能力下全部启用的配置，默认配置在前。"""
        rows = await self._db.fetch_all(
            f"select {_COLUMNS} from biz.model_config where enabled and not deleted and capability = %s "
            "order by is_default desc, id",
            (capability,),
        )
        return [e for e in (self._to_entity(r) for r in rows) if e is not None]
