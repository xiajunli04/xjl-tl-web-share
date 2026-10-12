from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# python-backend/app/core/config.py -> 仓库根目录
ROOT_ENV_FILE = Path(__file__).resolve().parents[3] / ".env"
# python-backend/.cache/models：embedding 模型缓存目录（已加入 .gitignore）
MODEL_CACHE_DIR = Path(__file__).resolve().parents[2] / ".cache" / "models"
# python-backend/.cache/speech：本地语音模型（SenseVoice、silero VAD）
SPEECH_MODEL_DIR = Path(__file__).resolve().parents[2] / ".cache" / "speech"

APP_VERSION = "0.1.0"


class Settings(BaseSettings):
    """环境变量优先，其次读取仓库根目录 .env（与 Spring、docker compose 共用）。"""

    model_config = SettingsConfigDict(env_file=ROOT_ENV_FILE, env_file_encoding="utf-8", extra="ignore")

    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_db: str = "xjl_tl"
    tl_ai_db_user: str = "tl_ai"
    tl_ai_db_password: str = "tl_ai_pwd"

    model_key_secret: str = ""
    internal_token: str = ""

    db_pool_min_size: int = 1
    db_pool_max_size: int = 5
    db_connect_timeout: float = 3.0

    # ---- 语种识别（design D3）----
    lang_detect_min_confidence: float = 0.5  # lingua 最高置信度低于该值时调用 LLM 兜底
    lang_detect_min_chars: int = 4  # 文本少于该字符数时调用 LLM 兜底
    lang_detect_low_accuracy: bool = False  # 内存紧张时可切换为 lingua 低精度模式
    lang_detect_preload: bool = True  # 启动时预热检测器

    # ---- 翻译 Agent（design D1 / D5）----
    translate_max_text_length: int = 5000
    agent_review_min_score: int = 75  # 评审兜底分：低于该分即使没有 major 问题也修正（design D5）
    agent_max_refine_rounds: int = 2  # 最大修正轮次
    agent_fast_path_max_chars: int = 80  # auto 模式下快速路径的文本长度上限
    agent_review_max_tokens: int = 512
    agent_translate_max_tokens: int = 4096  # 模型配置未设置 maxTokens 时的翻译输出上限
    translate_total_timeout_seconds: float = 180.0  # 整次翻译上限，超时返回 C0141
    sse_heartbeat_seconds: float = 15.0  # SSE 注释心跳间隔

    # ---- Redis（文档任务的任务流与事件流，design D1）----
    redis_host: str = "localhost"
    redis_port: int = 6379
    redis_password: str = ""
    redis_db: int = 0

    # ---- 文档翻译（design D1 / D4 / D5 / D6 / D7）----
    doc_worker_enabled: bool = True  # 是否在 FastAPI 进程内启动文档 worker（测试时关闭）
    doc_stream_prefix: str = "tl:"  # 流与计数键的前缀：tl:doc-tasks / tl:doc-events / tl:doc-seq:{taskId}
    doc_consumer_group: str = "ai-worker"  # Python 在任务流上的消费组
    doc_event_group: str = "spring"  # Spring 在事件流上的消费组（双方都幂等创建）
    doc_consumer_name: str = "ai-worker-1"  # 固定名称：重启后可以直接重读自己未确认的消息
    doc_worker_concurrency: int = 2  # 全局任务并发；待确认术语的任务不占槽位
    doc_chunk_concurrency: int = 3  # 单个任务内组间并发（parallel / hybrid）
    doc_chunk_target_tokens: int = 1800
    doc_chunk_max_tokens: int = 3000
    doc_max_refine_rounds: int = 1  # 分块评审不达标时的修正轮次
    doc_claim_idle_ms: int = 60000  # 启动时 XAUTOCLAIM 认领闲置超过该时长的消息
    doc_read_block_ms: int = 2000  # XREADGROUP 阻塞时长
    doc_summary_single_max_tokens: int = 12000  # 正文不超过该值时一次调用完成分析，否则分章摘要再汇总
    doc_summary_section_tokens: int = 6000  # 分章摘要时每次调用的正文上限
    doc_summary_concurrency: int = 3
    doc_translate_max_tokens: int = 8192  # 分块翻译、评审修正的输出上限
    doc_llm_timeout_seconds: float = 180.0  # 文档相关 LLM 调用的单次超时
    doc_prompt_max_names: int = 40  # 滚动专名表在提示词中的最大条数
    doc_prompt_max_terms: int = 60  # 任务术语表超过该条数时只放入本块出现的术语
    doc_fix_batch_size: int = 8  # 一致性定向修正每次最多处理的段数
    doc_max_text_length: int = 50000
    doc_done_ttl_seconds: int = 7 * 24 * 3600  # 完成后 eventSeq 计数键与完成标记的保留时长

    # ---- 翻译记忆（add-session-context-and-memory D5 / D6 / D7）----
    tm_enabled: bool = True  # 关闭后检索恒为空、写入返回 C0160
    tm_embedding_model: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    tm_model_cache_dir: str = str(MODEL_CACHE_DIR)
    tm_preload: bool = True  # 启动时后台预热（首次会下载模型，约 220 MB）
    tm_embed_threads: int = 2  # ONNX Runtime 推理线程数
    tm_retry_seconds: float = 600.0  # 模型加载失败后，间隔多久允许再次尝试
    tm_write_wait_seconds: float = 120.0  # 写入时等待模型加载完成的最长时间
    hf_endpoint: str = ""  # HuggingFace 镜像（如 https://hf-mirror.com），为空时使用官方地址
    tm_recall_limit: int = 20  # 向量路与字面路各自的召回条数
    tm_trgm_min: float = 0.3  # 字面路三元组相似度下限
    tm_fuzzy_min: float = 0.6  # 短文本入选阈值：fuzzy 或 semantic 达到其一即可
    tm_semantic_min: float = 0.65  # paraphrase-multilingual-MiniLM 的同义改写实测约 0.66（0.85 几乎不可达）
    tm_top_k: int = 3
    tm_doc_fuzzy_min: float = 0.7  # 文档按段检索的入选阈值
    tm_doc_semantic_min: float = 0.75  # 文档注入更保守
    tm_doc_max_hits: int = 8  # 每块最多放入提示词的记忆条数

    # ---- 会话上下文、歧义追问与会话记忆（D2 / D4）----
    session_window_turns: int = 8  # 兜底上限：Spring 下发尚未并入摘要的最近 6–8 轮（D6）
    session_turn_max_chars: int = 500
    session_ctx_max_chars: int = 4000
    clarify_max_chars: int = 500  # 原文超过该长度不做歧义检查
    clarify_max_tokens: int = 512
    memorize_max_tokens: int = 1024
    memorize_timeout_seconds: float = 60.0
    memorize_summary_max_chars: int = 300
    memorize_max_entities: int = 30
    turn_thread_ttl_hours: float = 24.0  # 未回答的追问检查点保留时长
    turn_cleanup_interval_seconds: float = 3600.0

    # ---- 语音能力（add-speech-and-image-translation D4 / D5）----
    speech_model_dir: str = str(SPEECH_MODEL_DIR)
    speech_model_mirror: str = ""  # 模型下载镜像前缀（替换 https://github.com），为空时直连 GitHub
    speech_asr_threads: int = 2  # SenseVoice 推理线程数
    speech_preload: bool = False  # 启动时预加载本地识别模型（首次约 2 s）
    speech_vad_min_silence_ms: int = 500
    speech_vad_max_speech_s: float = 10.0
    speech_partial_interval_ms: int = 700  # 进行中识别（partial）的间隔
    speech_transcribe_max_seconds: float = 60.0  # 听写接口的音频上限
    speech_tts_max_chars: int = 2000
    speech_tts_cache_size: int = 64
    speech_engine_probe_ttl_seconds: float = 600.0  # 引擎可用性探测结果缓存
    edge_tts_timeout_seconds: float = 15.0
    edge_tts_max_concurrency: int = 4  # 进程级 Edge 并发合成上限（预取 + 会议室多语种，防 Edge 限流）

    # ---- 同传（D3 / D6）----
    interpret_max_streams: int = 20  # 全局并发发言流上限
    # 同传提示词与上下文（improve-prompts-and-context-memory D1 / D2）
    interpret_ctx_sentences: int = 6  # 级联翻译携带的最近句数（发言流级，含双向对话的双方）
    interpret_ctx_max_chars: int = 1500  # 上下文字符上限，超出时从最早的一句丢弃
    interpret_mt_temperature: float | None = 0.3  # 级联翻译与对话字幕的温度；为空时沿用模型参数
    interpret_mt_max_tokens: int = 300
    # AI 对话记忆（improve-prompts-and-context-memory D4）
    chat_window_turns: int = 12  # 短期窗口（轮）
    chat_memory_batch_turns: int = 4  # 每次并入摘要的轮数
    chat_memory_max_chars: int = 6000  # 未压缩消息的字符上限，超出时提前压缩
    chat_memory_hard_turns: int = 24  # 压缩持续失败时保留的最多轮数
    chat_memory_summary_max_chars: int = 400
    chat_memory_timeout_seconds: float = 30.0
    interpret_upstream_retries: int = 2  # S2S 上游建连失败重试次数
    interpret_qwen_default_voice: str = "Tina"  # 百炼 3.8 默认音色 Chelsie 不可用，必须显式指定
    # 分段合成与响应速度档位（improve-speech-playback-latency D4 / D6）：balanced 为缺省档，fast 为极速档
    interpret_tts_concurrency: int = 2  # 一句话内同时合成的段数
    interpret_seg_min_chars: int = 12  # 非首段的最小长度（中日韩每字 1、其他语言每词 3）
    interpret_seg_first_min: int = 8
    interpret_seg_first_min_fast: int = 4
    speech_vad_min_silence_ms_fast: int = 300
    speech_partial_interval_ms_fast: int = 500
    # 识别让路（D4.1）：最近 quiet_ms 的输入 RMS 都低于阈值（约 −40 dBFS）时不再发起 partial，句末定稿独占 CPU
    speech_partial_quiet_rms: float = 0.01
    speech_partial_quiet_ms: int = 200
    # 两段式断句（improve-speech-endpointing-and-live-ux D1 / D2）：判为未说完时的续说等待；0 = 不等待（旧行为）
    endpoint_hold_ms: int = 700  # 同传·均衡
    endpoint_hold_ms_fast: int = 400  # 同传·极速
    endpoint_hold_ms_chat: int = 1500  # AI 对话·均衡
    endpoint_hold_ms_chat_fast: int = 1000  # AI 对话·极速
    endpoint_merge_max_s: float = 12.0  # 一句话合并语音的上限（同传·均衡）
    endpoint_merge_max_s_fast: float = 8.0
    endpoint_merge_max_s_chat: float = 20.0
    # 声学句末模型：auto（模型存在即用）| on | off。E6 停顿鲁棒性评测（合成语音）未达缺省开启的标准
    # （碎句率下降 ≥ 50% 且完整句延迟增加 ≤ 150 ms），缺省 off、只用文本规则；见 docs/test/endpointing/report.md
    endpoint_smart_turn: str = "off"
    endpoint_smart_turn_threshold: float = 0.5
    endpoint_smart_turn_confident: float = 0.99  # 以弱延续词（如"的"）结尾时，模型须达到的完成概率
    speech_hf_mirror: str = ""  # HuggingFace 下载镜像（如 https://hf-mirror.com），为空时直连
    # AI 对话回复让位（D6）：让位后多久没有新的用户句定稿就恢复回应原句
    chat_yield_resume_seconds: float = 3.0
    # 实时语音对话的上游断句（D8）
    realtime_chat_silence_ms: int = 800
    realtime_chat_openai_eagerness: str = "low"

    # ---- 图片翻译（D10）----
    image_max_side: int = 2048  # 送入视觉模型前的长边上限
    image_ocr_max_tokens: int = 4096
    image_translate_max_tokens: int = 4096
    image_llm_timeout_seconds: float = 120.0

    # ---- 解读（D11）----
    insights_max_chars: int = 2000
    insights_max_tokens: int = 1500

    @property
    def doc_task_stream(self) -> str:
        return f"{self.doc_stream_prefix}doc-tasks"

    @property
    def doc_event_stream(self) -> str:
        return f"{self.doc_stream_prefix}doc-events"

    @property
    def db_conninfo(self) -> str:
        return (
            f"host={self.postgres_host} port={self.postgres_port} dbname={self.postgres_db} "
            f"user={self.tl_ai_db_user} password={self.tl_ai_db_password} "
            f"connect_timeout={int(self.db_connect_timeout)}"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
