import asyncio
import json
import os
from pathlib import Path

import psycopg
import pytest

FIXTURES = Path(__file__).parent / "fixtures"
VECTORS = json.loads((FIXTURES / "crypto-vectors.json").read_text(encoding="utf-8"))

# 并行开发（多个 worktree 同时跑测试）时用 PYTEST_DB 隔离测试库
TEST_DB = os.environ.get("PYTEST_DB", "xjl_tl_pytest")
INTERNAL_TOKEN = "test-internal-token"

# 环境变量优先于根目录 .env；必须在导入 app 之前设置
os.environ["POSTGRES_DB"] = TEST_DB
os.environ.setdefault("POSTGRES_HOST", "localhost")
os.environ.setdefault("POSTGRES_PORT", "5432")
os.environ["TL_AI_DB_USER"] = os.environ.get("TEST_TL_AI_DB_USER", "tl_ai")
os.environ["TL_AI_DB_PASSWORD"] = os.environ.get("TEST_TL_AI_DB_PASSWORD", "tl_ai_pwd")
os.environ["MODEL_KEY_SECRET"] = VECTORS["key"]
os.environ["INTERNAL_TOKEN"] = INTERNAL_TOKEN
# 默认不在 app 中启动文档 worker；worker 测试自行构建（独立的 Redis db 与流名前缀）
os.environ["DOC_WORKER_ENABLED"] = "false"
# 单元测试不得下载 embedding 模型：app 注入假 provider，且关闭预热
os.environ["TM_PRELOAD"] = "false"

SUPER_USER = os.environ.get("POSTGRES_SUPERUSER", "postgres")
SUPER_PWD = os.environ.get("POSTGRES_SUPERUSER_PASSWORD", "postgres")
HOST = os.environ["POSTGRES_HOST"]
PORT = os.environ["POSTGRES_PORT"]


def super_conn(dbname: str) -> psycopg.Connection:
    return psycopg.connect(host=HOST, port=PORT, dbname=dbname, user=SUPER_USER, password=SUPER_PWD, autocommit=True)


DDL = """
CREATE SCHEMA IF NOT EXISTS biz;
DROP TABLE IF EXISTS biz.glossary_term;
DROP TABLE IF EXISTS biz.glossary;
DROP TABLE IF EXISTS biz.model_config;
CREATE TABLE biz.model_config (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           varchar(64)  NOT NULL,
  provider       varchar(32)  NOT NULL,
  base_url       varchar(255) NOT NULL,
  model_name     varchar(128) NOT NULL,
  api_key_cipher text         NOT NULL,
  api_key_mask   varchar(32)  NOT NULL,
  params         jsonb        NOT NULL DEFAULT '{}'::jsonb,
  is_default     boolean      NOT NULL DEFAULT false,
  enabled        boolean      NOT NULL DEFAULT true,
  remark         varchar(255),
  deleted        boolean      NOT NULL DEFAULT false,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now(),
  capability     varchar(24)  NOT NULL DEFAULT 'CHAT',
  supports_vision boolean     NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX uk_model_config_default ON biz.model_config (capability) WHERE is_default AND NOT deleted;
GRANT USAGE ON SCHEMA biz TO tl_ai;
GRANT SELECT ON biz.model_config TO tl_ai;

-- 与 Spring Flyway V2 一致的术语库表（design D6，仅保留 Python 用到的列与约束；测试库没有 sys_user，省略外键）
CREATE TABLE biz.glossary (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    bigint       NOT NULL DEFAULT 1,
  name        varchar(64)  NOT NULL,
  description varchar(255),
  source_lang varchar(8)   NOT NULL,
  target_lang varchar(8)   NOT NULL,
  domain      varchar(32),
  scope       varchar(16)  NOT NULL DEFAULT 'PRIVATE' CHECK (scope IN ('PRIVATE','PUBLIC')),
  term_count  int          NOT NULL DEFAULT 0,
  deleted     boolean      NOT NULL DEFAULT false,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE TABLE biz.glossary_term (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  glossary_id    bigint       NOT NULL REFERENCES biz.glossary(id),
  source_term    varchar(200) NOT NULL,
  target_term    varchar(200) NOT NULL,
  note           varchar(255),
  case_sensitive boolean      NOT NULL DEFAULT false,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uk_glossary_term_source ON biz.glossary_term (glossary_id, lower(source_term));
GRANT SELECT ON biz.glossary, biz.glossary_term TO tl_ai;

-- design D9：ai.doc_chunk_result（主库由 Spring Flyway V3 建表）
-- 检查点表由 AsyncPostgresSaver.setup() 以 tl_ai 身份创建
CREATE SCHEMA IF NOT EXISTS ai;
GRANT USAGE, CREATE ON SCHEMA ai TO tl_ai;
DROP TABLE IF EXISTS ai.doc_chunk_result;
CREATE TABLE ai.doc_chunk_result (
  task_id     bigint      NOT NULL,
  chunk_index int         NOT NULL,
  result      jsonb       NOT NULL,
  usage       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, chunk_index)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON ai.doc_chunk_result TO tl_ai;

-- add-session-context-and-memory D5：ai.translation_memory（主库由 Spring Flyway V5 建表，这里按相同结构自建）
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE IF NOT EXISTS ai.translation_memory (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint       NOT NULL,
  source_lang varchar(8)   NOT NULL,
  target_lang varchar(8)   NOT NULL,
  source_text text         NOT NULL,
  target_text text         NOT NULL,
  source_norm text         NOT NULL,
  source_hash char(32)     NOT NULL,
  embedding   vector(384)  NOT NULL,
  origin      varchar(16)  NOT NULL,
  origin_ref  varchar(64),
  hit_count   int          NOT NULL DEFAULT 0,
  last_hit_at timestamptz,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT uk_tm_source UNIQUE (user_id, source_lang, target_lang, source_hash)
);
CREATE INDEX IF NOT EXISTS idx_tm_embedding ON ai.translation_memory USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_tm_source_norm ON ai.translation_memory USING gin (source_norm public.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_tm_user_pair ON ai.translation_memory (user_id, source_lang, target_lang);
GRANT SELECT, INSERT, UPDATE, DELETE ON ai.translation_memory TO tl_ai;
"""


def pytest_asyncio_loop_factories(config, item):
    # psycopg 异步模式不支持 Windows 默认的 ProactorEventLoop
    return {"selector": asyncio.SelectorEventLoop}


@pytest.fixture(scope="session", autouse=True)
def test_database():
    with super_conn("postgres") as c:
        if not c.execute("select 1 from pg_database where datname = %s", (TEST_DB,)).fetchone():
            c.execute(f'CREATE DATABASE "{TEST_DB}"')
    with super_conn(TEST_DB) as c:
        c.execute(DDL)
    yield TEST_DB


@pytest.fixture
def db_admin():
    """超级用户连接测试库，用于插入/修改测试数据。"""
    with super_conn(TEST_DB) as c:
        c.execute("TRUNCATE biz.model_config, biz.glossary_term, biz.glossary RESTART IDENTITY")
        yield c


@pytest.fixture
def insert_config(db_admin):
    from app.core.crypto import encrypt

    def _insert(
        *,
        provider: str = "OPENAI_COMPATIBLE",
        base_url: str = "https://llm.test/v1",
        model_name: str = "deepseek-chat",
        api_key: str = "sk-test-1234567890abcdef",
        params: dict | None = None,
        is_default: bool = False,
        enabled: bool = True,
        deleted: bool = False,
        capability: str = "CHAT",
        supports_vision: bool = False,
    ) -> int:
        row = db_admin.execute(
            """insert into biz.model_config
               (name, provider, base_url, model_name, api_key_cipher, api_key_mask, params,
                is_default, enabled, deleted, capability, supports_vision)
               values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id""",
            (
                f"{provider}-{model_name}",
                provider,
                base_url,
                model_name,
                encrypt(api_key, VECTORS["key"]),
                "sk-****cdef",
                json.dumps(params or {"temperature": 0.3, "maxTokens": 256, "timeoutSeconds": 5}),
                is_default,
                enabled,
                deleted,
                capability,
                supports_vision,
            ),
        ).fetchone()
        return row[0]

    return _insert


@pytest.fixture
def fake_embedding():
    from tests.fakes import FakeEmbedding

    return FakeEmbedding()


@pytest.fixture
def tm_admin():
    """超级用户连接测试库，清空翻译记忆表。"""
    with super_conn(TEST_DB) as c:
        c.execute("TRUNCATE ai.translation_memory RESTART IDENTITY")
        yield c


@pytest.fixture
async def app(fake_embedding):
    from app.core.config import get_settings
    from app.main import create_app
    from tests.respx_bridge import make_http_client

    application = create_app(get_settings(), llm_http_client_factory=make_http_client, embedding=fake_embedding)
    async with application.router.lifespan_context(application):
        yield application


@pytest.fixture
async def client(app):
    import httpx

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://test", headers={"X-Internal-Token": INTERNAL_TOKEN}
    ) as c:
        yield c


@pytest.fixture
def insert_glossary(db_admin):
    """插入术语库及术语；terms 为 (source, target) 或 (source, target, case_sensitive)。"""

    def _insert(
        *,
        source_lang: str = "en",
        target_lang: str = "zh",
        terms: list[tuple] = (),
        name: str = "测试术语库",
        deleted: bool = False,
    ) -> int:
        gid = db_admin.execute(
            """insert into biz.glossary (name, source_lang, target_lang, term_count, deleted)
               values (%s,%s,%s,%s,%s) returning id""",
            (name, source_lang, target_lang, len(terms), deleted),
        ).fetchone()[0]
        for t in terms:
            db_admin.execute(
                "insert into biz.glossary_term (glossary_id, source_term, target_term, case_sensitive) "
                "values (%s,%s,%s,%s)",
                (gid, t[0], t[1], t[2] if len(t) > 2 else False),
            )
        return gid

    return _insert
