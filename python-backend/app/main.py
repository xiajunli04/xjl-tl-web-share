import asyncio
import logging
import sys
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Any

import redis.asyncio as aioredis
from fastapi import FastAPI, Request
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

from app.agent.hitl import TurnCheckpoints
from app.api.internal import doc, health, image, insights, lang, llm, tm, translate
from app.api.internal import interpret as interpret_api
from app.api.internal import speech as speech_api
from app.core.config import APP_VERSION, Settings, get_settings
from app.core.db import Database
from app.core.errors import ErrorCode, error_response, register_exception_handlers
from app.core.logging import TRACE_HEADER, new_trace_id, setup_logging, trace_id_var
from app.doc.graph import compile_doc_graph
from app.doc.store import PgChunkStore, make_checkpoint_pool
from app.glossary.repository import GlossaryRepository
from app.lang.detector import LanguageDetector
from app.llm.registry import LLMRegistry
from app.memory.embedding import EmbeddingProvider, LocalEmbedding
from app.memory.tm import TranslationMemory
from app.repositories.model_config import ModelConfigRepository
from app.worker.doc_worker import DocWorker

log = logging.getLogger("app.main")


def make_redis(settings: Settings) -> aioredis.Redis:
    return aioredis.Redis(
        host=settings.redis_host,
        port=settings.redis_port,
        db=settings.redis_db,
        password=settings.redis_password or None,
        decode_responses=True,
        health_check_interval=30,
    )


async def start_doc_worker(app: FastAPI, settings: Settings, database: Database) -> tuple:
    """文档 worker（design D1）：Redis 客户端、检查点连接池（ai schema）与 worker 协程。"""
    redis = make_redis(settings)
    pool = make_checkpoint_pool(settings)
    await pool.open(wait=False)
    saver = AsyncPostgresSaver(conn=pool)
    worker = DocWorker(
        settings=settings,
        redis=redis,
        graph=compile_doc_graph(saver),
        checkpointer=saver,
        store=PgChunkStore(database),
        registry=app.state.registry,
        detector=app.state.detector,
        glossary_repo=app.state.glossary_repo,
        tm=app.state.tm,
    )
    await worker.start()
    app.state.doc_worker = worker
    return worker, redis, pool


async def stop_doc_worker(app: FastAPI, resources: tuple) -> None:
    worker, redis, pool = resources
    await worker.stop()
    app.state.doc_worker = None
    await redis.aclose()
    await pool.close()


def create_app(
    settings: Settings | None = None,
    db: Database | None = None,
    llm_http_client_factory: Callable[[], Any] | None = None,
    embedding: EmbeddingProvider | None = None,
) -> FastAPI:
    """llm_http_client_factory：返回 httpx2.AsyncClient 的工厂，仅测试时注入（openai/anthropic SDK 基于 httpx2）。
    embedding：翻译记忆的 embedding 提供方，测试时注入假实现；缺省为本地 fastembed 模型（后台预热）。"""
    settings = settings or get_settings()
    setup_logging()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if sys.platform == "win32" and isinstance(asyncio.get_running_loop(), asyncio.ProactorEventLoop):
            log.warning(
                "当前为 ProactorEventLoop，psycopg 异步连接不可用（db 将为 DOWN）。"
                "请使用 `python -m app` 或 `uvicorn ... --loop app.core.event_loop:selector_event_loop` 启动"
            )
        database = db or Database(settings)
        await database.open()
        app.state.db = database
        app.state.registry = LLMRegistry(
            ModelConfigRepository(database), settings.model_key_secret, llm_http_client_factory
        )
        app.state.glossary_repo = GlossaryRepository(database)
        app.state.detector = LanguageDetector(settings)
        if settings.lang_detect_preload:
            # lingua 检测器为进程内单例，首次构建需要加载语言模型，放到线程中避免阻塞事件循环
            await asyncio.to_thread(app.state.detector.warmup)
        # 翻译记忆：模型后台预热，失败时降级（检索为空、写入 C0160），不影响服务启动
        provider = embedding or LocalEmbedding(settings)
        app.state.embedding = provider
        app.state.tm = TranslationMemory(database, provider, settings)
        if settings.tm_preload and isinstance(provider, LocalEmbedding):
            provider.start_warmup()
        # 歧义追问的检查点（ai schema），并定期清理过期的 turn:* thread
        hitl = TurnCheckpoints(settings)
        await hitl.open()
        hitl.start_cleanup()
        app.state.hitl = hitl
        app.state.doc_worker = None
        doc_resources = None
        if settings.doc_worker_enabled:
            doc_resources = await start_doc_worker(app, settings, database)
        try:
            yield
        finally:
            if doc_resources is not None:
                await stop_doc_worker(app, doc_resources)
            await hitl.close()
            if isinstance(provider, LocalEmbedding):
                await provider.close()
            await app.state.registry.close()
            await database.close()

    app = FastAPI(title="LinguaBridge AI Service", version=APP_VERSION, lifespan=lifespan)
    app.state.settings = settings

    @app.middleware("http")
    async def trace_id_middleware(request: Request, call_next):
        trace_id = request.headers.get(TRACE_HEADER) or new_trace_id()
        token = trace_id_var.set(trace_id)
        try:
            response = await call_next(request)
        except Exception:
            # 未预期异常：在 traceId 上下文内记录日志并返回 B0001，不泄露堆栈
            log.exception("未预期异常 %s %s", request.method, request.url.path)
            response = error_response(ErrorCode.SYSTEM_ERROR)
        finally:
            trace_id_var.reset(token)
        response.headers[TRACE_HEADER] = trace_id
        return response

    register_exception_handlers(app)
    app.include_router(health.router)
    app.include_router(llm.router)
    app.include_router(lang.router)
    app.include_router(translate.router)
    app.include_router(doc.router)
    app.include_router(tm.router)
    app.include_router(image.router)
    app.include_router(insights.router)
    app.include_router(speech_api.router)
    app.include_router(interpret_api.router)
    return app


app = create_app()
