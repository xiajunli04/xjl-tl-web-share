import logging
import uuid
from contextvars import ContextVar

trace_id_var: ContextVar[str] = ContextVar("trace_id", default="-")

TRACE_HEADER = "X-Trace-Id"


def new_trace_id() -> str:
    return uuid.uuid4().hex[:16]


def get_trace_id() -> str:
    return trace_id_var.get()


class TraceIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.trace_id = trace_id_var.get()
        return True


def setup_logging(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler()
    handler.addFilter(TraceIdFilter())
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [%(trace_id)s] %(name)s - %(message)s"))
    root = logging.getLogger("app")
    root.handlers[:] = [handler]
    root.setLevel(level)
    root.propagate = False
