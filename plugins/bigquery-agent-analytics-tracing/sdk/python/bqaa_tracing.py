"""BQAA Claude Code / Codex tracing SDK.

Architecture
------------
Hook wrapper (hooks/common.sh, what the agent waits on):
  Queues the event under BQAA_STATE_DIR/queue, starts this module in the
  background and waits at most BQAA_HOOK_WAIT_SECONDS in all, so the host
  agent never waits on Python startup, file locks, auth or BigQuery.

Hook subprocess (hot path, ``--queue``, see process_hook_queue):
  1. Apply the session's queued events oldest first, each as of the time
     its hook ran, so an event whose own run starts late still lands
     before the newer events of its session.
  2. Build the BQAA row (existing logic).
  3. Append a JSONL line to BQAA_SPOOL_DIR (sync, ~1 ms).
  4. Spawn a detached drainer subprocess (idempotent via flock).
  5. Exit. The host agent never blocks on BigQuery.

Every network or auth call (direct writes here, the drainer's writes) runs
under a hard BQAA_NETWORK_TIMEOUT_SECONDS timeout.

Drainer subprocess (background, see bqaa_drain.py):
  - Holds an exclusive flock so only one drainer runs per spool dir.
  - Batches spooled rows and writes them via the BigQuery Storage Write
    async API (BigQueryWriteAsyncClient + AppendRowsRequest with PyArrow).
  - Falls back to the legacy streaming insert API only when the Storage
    Write API or PyArrow are not importable.
  - Retries transient gRPC failures with exponential backoff.
  - Moves permanently-failed rows to BQAA_SPOOL_DIR/dead-letter/.

State store changes:
  - fcntl.flock around every read/modify/write keeps concurrent hook fires
    consistent.
  - Per-tool state lives in its own file (tool_<id>.json) so parallel
    PreToolUse fires don't clobber each other.
  - Stale state files older than BQAA_STATE_TTL_HOURS are purged on
    SessionStart.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import traceback
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, NamedTuple, TypeVar


BQAA_EVENT_TYPES = {
    "LLM_REQUEST",
    "LLM_RESPONSE",
    "TOOL_STARTING",
    "TOOL_COMPLETED",
    "HITL_CREDENTIAL_REQUEST",
    "HITL_CREDENTIAL_REQUEST_COMPLETED",
    "HITL_CONFIRMATION_REQUEST",
    "HITL_CONFIRMATION_REQUEST_COMPLETED",
    "HITL_INPUT_REQUEST",
    "HITL_INPUT_REQUEST_COMPLETED",
    "STATE_DELTA",
}

SENSITIVE_KEYS = {
    "api_key",
    "authorization",
    "client_secret",
    "id_token",
    "password",
    "refresh_token",
    "secret",
    "token",
}

DEFAULT_LOG_FILE = "/tmp/bqaa-agent-tracing.log"
DEFAULT_SPOOL_DIR = "/tmp/bqaa-agent-tracing/spool"
DEFAULT_STATE_DIR = "/tmp/bqaa-agent-tracing"
DEFAULT_TRANSCRIPT_MAX_BYTES = 256 * 1024  # 256 KB streamed cap per stop event.
DEFAULT_STATE_TTL_HOURS = 24
DEFAULT_DRAIN_IDLE_SECONDS = 8.0
DEFAULT_DRAIN_BATCH_SIZE = 50
DEFAULT_DRAIN_POLL_SECONDS = 0.5
DEFAULT_NETWORK_TIMEOUT_SECONDS = 30.0

# Writer identity. Mirrors how the ADK BQAA plugin tags its Storage Write
# requests (`google-adk-bq-logger/<version>`) so adopters can attribute
# writes back to this plugin from BigQuery's side.
#
# Two surfaces use this label:
#   * Every row's `attributes.writer.{plugin,version,label,agent,mode}`
#     block — the queryable surface for self-service adoption analytics.
#     Set on every write path, including the insert_rows_json fallback.
#   * `AppendRowsRequest.trace_id` on Storage Write API batches — recorded
#     server-side by Google for diagnostics. NOT exposed as a column in
#     `INFORMATION_SCHEMA.WRITE_API_TIMELINE_BY_*`, so it can't power
#     adoption queries; it lets Google Cloud support attribute traffic
#     back to this plugin during throughput / quota investigations.
#
# Override per deployment with the BQAA_WRITER_LABEL env var (e.g. when
# running multiple distinct deployments against one dataset).
WRITER_PLUGIN_NAME = "bqaa-coding-agent-plugin"
WRITER_PLUGIN_VERSION = "0.1.0"
WRITER_LABEL = f"{WRITER_PLUGIN_NAME}/{WRITER_PLUGIN_VERSION}"


# While a queued hook event is applied, the time its hook ran (see
# _event_clock), so row timestamps, latencies and the transcript window come
# out the same however late the event is applied.
_EVENT_TIME_NS: int | None = None


def _utc_now() -> datetime:
    if _EVENT_TIME_NS is not None:
        seconds, nanos = divmod(_EVENT_TIME_NS, 1_000_000_000)
        return datetime.fromtimestamp(seconds, timezone.utc).replace(microsecond=nanos // 1000)
    return datetime.now(timezone.utc)


def _timestamp_ms() -> int:
    if _EVENT_TIME_NS is not None:
        return _EVENT_TIME_NS // 1_000_000
    return int(time.time() * 1000)


def _event_time_ms() -> int | None:
    return None if _EVENT_TIME_NS is None else _EVENT_TIME_NS // 1_000_000


@contextlib.contextmanager
def _event_clock(time_ns: int) -> Iterator[None]:
    """Take time_ns as the current time for everything done inside."""
    global _EVENT_TIME_NS
    saved, _EVENT_TIME_NS = _EVENT_TIME_NS, time_ns
    try:
        yield
    finally:
        _EVENT_TIME_NS = saved


def _iso_timestamp(value: datetime | None = None) -> str:
    ts = value or _utc_now()
    return ts.isoformat(timespec="microseconds").replace("+00:00", "Z")


_T = TypeVar("_T")


class _CallTimedOut(TimeoutError):
    """A call outlived its timeout. It keeps running on its own thread, so a
    request it made may still land."""

    def __init__(self, message: str, worker: threading.Thread, outcome: dict[str, Any]):
        super().__init__(message)
        self._worker = worker
        self._outcome = outcome

    def result(self, wait: float) -> Any:
        """Wait up to `wait` more seconds for the call, then return its
        value or raise its error. Raises self if it's still running."""
        self._worker.join(wait)
        if self._worker.is_alive():
            raise self
        if "error" in self._outcome:
            raise self._outcome["error"]
        return self._outcome["value"]


def _call_with_timeout(fn: Callable[[], _T], timeout: float, what: str) -> _T:
    """Run fn() on a daemon thread and give up after timeout seconds.

    ADC lookups (metadata-server probes, token refreshes) and BigQuery
    requests can hang well past their own retry deadlines. A daemon thread
    can't be cancelled, but it won't keep the process alive once the caller
    has moved on. On timeout raises _CallTimedOut, which can still collect
    the call's result.
    """
    outcome: dict[str, Any] = {}

    def run() -> None:
        try:
            outcome["value"] = fn()
        except BaseException as exc:  # re-raised in the caller's thread
            outcome["error"] = exc

    worker = threading.Thread(target=run, name=f"bqaa {what}", daemon=True)
    worker.start()
    worker.join(timeout)
    if worker.is_alive():
        raise _CallTimedOut(f"{what} timed out after {timeout:g}s", worker, outcome)
    if "error" in outcome:
        raise outcome["error"]
    return outcome["value"]


def _hex_id(chars: int) -> str:
    return uuid.uuid4().hex[:chars]


def _deterministic_span(seed: str, chars: int = 16) -> str:
    """Stable hex span id derived from a seed (e.g. tool_use_id).

    Used so that a PostToolUse without a matching PreToolUse can still emit a
    span_id that correlates with whatever the (missing) start would have
    produced if it ran with the same seed. Better than _hex_id which yields a
    fresh random id and breaks span correlation.
    """
    if not seed:
        return _hex_id(chars)
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return digest[:chars]


def _to_jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_to_jsonable(v) for v in value]
    if hasattr(value, "model_dump"):
        return _to_jsonable(value.model_dump())
    if hasattr(value, "to_dict"):
        return _to_jsonable(value.to_dict())
    return str(value)


def _truncate(value: Any, max_len: int) -> tuple[Any, bool]:
    value = _to_jsonable(value)
    if max_len == -1:
        return value, False
    if isinstance(value, str):
        if len(value) > max_len:
            return value[:max_len] + "...[TRUNCATED]", True
        return value, False
    if isinstance(value, list):
        out = []
        truncated = False
        for item in value:
            next_item, did_truncate = _truncate(item, max_len)
            out.append(next_item)
            truncated = truncated or did_truncate
        return out, truncated
    if isinstance(value, dict):
        out = {}
        truncated = False
        for key, item in value.items():
            key_lower = str(key).lower()
            if key_lower in SENSITIVE_KEYS or key_lower.startswith("temp:"):
                out[key] = "[REDACTED]"
                continue
            next_item, did_truncate = _truncate(item, max_len)
            out[key] = next_item
            truncated = truncated or did_truncate
        return out, truncated
    return value, False


def _safe_json_loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (ValueError, RecursionError):
        # JSONDecodeError, an integer too long to convert, or deep nesting.
        return default


def _text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        pieces = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                pieces.append(str(item.get("text", "")))
            elif isinstance(item, str):
                pieces.append(item)
        return "\n".join(p for p in pieces if p)
    return ""


def _transcript_time_ms(item: Any) -> int | None:
    """When a transcript line was written, from its "timestamp" field."""
    stamp = item.get("timestamp") if isinstance(item, dict) else None
    if not isinstance(stamp, str):
        return None
    try:
        parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def _read_transcript_since(
    path: str, start_line: int, max_bytes: int, until_ms: int | None = None
) -> tuple[str, str, dict[str, int], bool]:
    """Stream-read the transcript and stop after max_bytes of output text.

    With until_ms, assistant lines stamped after it are left out: applied
    late, a Stop can find the next turn in the transcript already.

    Returns (output_text, model, usage, was_truncated).
    """
    output_parts: list[str] = []
    bytes_collected = 0
    was_truncated = False
    model = ""
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    if not path:
        return "", model, usage, False
    transcript = Path(path).expanduser()
    if not transcript.exists():
        return "", model, usage, False

    with transcript.open("r", encoding="utf-8", errors="replace") as handle:
        for line_no, line in enumerate(handle, start=1):
            if line_no <= start_line or not line.strip():
                continue
            item = _safe_json_loads(line, {})
            if item.get("type") != "assistant":
                continue
            if until_ms is not None and (_transcript_time_ms(item) or 0) > until_ms:
                continue
            message = item.get("message") or {}
            model = message.get("model") or model
            text = _text_from_content(message.get("content"))
            if text:
                if max_bytes > 0:
                    encoded = text.encode("utf-8", "replace")
                    remaining = max_bytes - bytes_collected
                    if remaining <= 0:
                        was_truncated = True
                    elif len(encoded) > remaining:
                        output_parts.append(
                            encoded[:remaining].decode("utf-8", "replace")
                            + "...[TRUNCATED]"
                        )
                        bytes_collected = max_bytes
                        was_truncated = True
                    else:
                        output_parts.append(text)
                        bytes_collected += len(encoded)
                else:
                    output_parts.append(text)
            raw_usage = message.get("usage") or {}
            usage["prompt_tokens"] += int(raw_usage.get("input_tokens") or 0)
            usage["prompt_tokens"] += int(raw_usage.get("cache_read_input_tokens") or 0)
            usage["prompt_tokens"] += int(raw_usage.get("cache_creation_input_tokens") or 0)
            usage["completion_tokens"] += int(raw_usage.get("output_tokens") or 0)
    usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
    return "\n".join(output_parts), model, usage, was_truncated


@contextlib.contextmanager
def _file_lock(path: Path, mode: int = fcntl.LOCK_EX) -> Iterator[int]:
    """Open a lockfile exclusively. Blocks until the lock is acquired."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, mode)
        yield fd
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


@dataclass
class BQAAConfig:
    project_id: str
    dataset: str
    table: str = "agent_events"
    agent_name: str = "coding-agent"
    user_id: str = "local-user"
    enabled: bool = True
    dry_run: bool = False
    direct_write: bool = False
    auto_create_table: bool = True
    auto_create_dataset: bool = False
    location: str | None = None
    max_content_length: int = 5000
    log_file: str = DEFAULT_LOG_FILE
    spool_dir: str = DEFAULT_SPOOL_DIR
    state_dir: str = DEFAULT_STATE_DIR
    state_ttl_hours: float = DEFAULT_STATE_TTL_HOURS
    transcript_max_bytes: int = DEFAULT_TRANSCRIPT_MAX_BYTES
    drain_idle_seconds: float = DEFAULT_DRAIN_IDLE_SECONDS
    drain_batch_size: int = DEFAULT_DRAIN_BATCH_SIZE
    drain_poll_seconds: float = DEFAULT_DRAIN_POLL_SECONDS
    writer_label: str = WRITER_LABEL
    network_timeout_seconds: float = DEFAULT_NETWORK_TIMEOUT_SECONDS

    @classmethod
    def from_env(cls) -> "BQAAConfig":
        return cls(
            project_id=os.environ.get("BQAA_PROJECT_ID")
            or os.environ.get("GCP_PROJECT_ID")
            or os.environ.get("GOOGLE_CLOUD_PROJECT")
            or "",
            dataset=os.environ.get("BQAA_DATASET") or os.environ.get("BQ_DATASET") or "",
            table=os.environ.get("BQAA_TABLE") or os.environ.get("BQ_TABLE") or "agent_events",
            agent_name=os.environ.get("BQAA_AGENT_NAME") or "coding-agent",
            user_id=os.environ.get("BQAA_USER_ID") or os.environ.get("USER") or "local-user",
            enabled=os.environ.get("BQAA_TRACE_ENABLED", "true").lower() == "true",
            dry_run=os.environ.get("BQAA_DRY_RUN", "false").lower() == "true",
            direct_write=os.environ.get("BQAA_DIRECT_WRITE", "false").lower() == "true",
            auto_create_table=os.environ.get("BQAA_AUTO_CREATE_TABLE", "true").lower()
            == "true",
            auto_create_dataset=os.environ.get("BQAA_AUTO_CREATE_DATASET", "false").lower()
            == "true",
            location=os.environ.get("BQAA_LOCATION") or None,
            max_content_length=int(os.environ.get("BQAA_MAX_CONTENT_LENGTH", "5000")),
            log_file=os.environ.get("BQAA_LOG_FILE", DEFAULT_LOG_FILE),
            spool_dir=os.environ.get("BQAA_SPOOL_DIR", DEFAULT_SPOOL_DIR),
            state_dir=os.environ.get("BQAA_STATE_DIR", DEFAULT_STATE_DIR),
            state_ttl_hours=float(
                os.environ.get("BQAA_STATE_TTL_HOURS", str(DEFAULT_STATE_TTL_HOURS))
            ),
            transcript_max_bytes=int(
                os.environ.get("BQAA_TRANSCRIPT_MAX_BYTES", str(DEFAULT_TRANSCRIPT_MAX_BYTES))
            ),
            drain_idle_seconds=float(
                os.environ.get("BQAA_DRAIN_IDLE_SECONDS", str(DEFAULT_DRAIN_IDLE_SECONDS))
            ),
            drain_batch_size=int(
                os.environ.get("BQAA_DRAIN_BATCH_SIZE", str(DEFAULT_DRAIN_BATCH_SIZE))
            ),
            drain_poll_seconds=float(
                os.environ.get("BQAA_DRAIN_POLL_SECONDS", str(DEFAULT_DRAIN_POLL_SECONDS))
            ),
            writer_label=os.environ.get("BQAA_WRITER_LABEL") or WRITER_LABEL,
            network_timeout_seconds=float(
                os.environ.get(
                    "BQAA_NETWORK_TIMEOUT_SECONDS", str(DEFAULT_NETWORK_TIMEOUT_SECONDS)
                )
            ),
        )


class BigQueryAgentAnalyticsLogger:
    """Builds rows in the BQAA schema and routes them to spool/dry-run/sync.

    Default emit mode is `spool` (writes a JSONL line and triggers the async
    drainer subprocess). `dry_run=True` writes to BQAA_LOG_FILE only.
    `direct_write=True` falls back to a synchronous insert_rows_json call,
    which is what the hook used to do; kept for debugging and parity tests.
    """

    def __init__(self, config: BQAAConfig | None = None):
        self.config = config or BQAAConfig.from_env()
        self._client = None
        self._table_ready = False

    def log_event(
        self,
        *,
        event_type: str,
        content: dict[str, Any] | None = None,
        attributes: dict[str, Any] | None = None,
        latency_ms: dict[str, Any] | None = None,
        agent: str | None = None,
        session_id: str | None = None,
        invocation_id: str | None = None,
        user_id: str | None = None,
        trace_id: str | None = None,
        span_id: str | None = None,
        parent_span_id: str | None = None,
        status: str = "OK",
        error_message: str | None = None,
        timestamp: datetime | None = None,
        content_parts: list[dict[str, Any]] | None = None,
        is_truncated: bool = False,
    ) -> dict[str, Any]:
        if not self.config.enabled:
            return {}
        if event_type not in BQAA_EVENT_TYPES:
            raise ValueError(f"Unsupported BQAA event_type: {event_type}")

        clipped_content, content_truncated = _truncate(
            content or {}, self.config.max_content_length
        )
        # Stamp writer identity onto every row so adoption/usage queries on
        # the events table itself can group by plugin without depending on
        # the Storage Write API's INFORMATION_SCHEMA views.
        merged_attributes = dict(attributes or {})
        merged_attributes.setdefault(
            "writer",
            {
                "plugin": WRITER_PLUGIN_NAME,
                "version": WRITER_PLUGIN_VERSION,
                "label": self.config.writer_label,
                "agent": agent or self.config.agent_name,
                "mode": "dry_run"
                if self.config.dry_run
                else ("direct" if self.config.direct_write else "spool"),
            },
        )
        clipped_attributes, attr_truncated = _truncate(
            merged_attributes, self.config.max_content_length
        )
        clipped_latency, latency_truncated = _truncate(latency_ms or {}, 1000)
        clipped_parts, parts_truncated = _truncate(
            content_parts or [], self.config.max_content_length
        )

        row = {
            "timestamp": _iso_timestamp(timestamp),
            "event_type": event_type,
            "agent": agent or self.config.agent_name,
            "session_id": session_id,
            "invocation_id": invocation_id,
            "user_id": user_id or self.config.user_id,
            "trace_id": trace_id,
            "span_id": span_id or _hex_id(16),
            "parent_span_id": parent_span_id,
            "content": clipped_content,
            "content_parts": clipped_parts,
            "attributes": clipped_attributes,
            "latency_ms": clipped_latency,
            "status": status,
            "error_message": error_message,
            "is_truncated": bool(
                is_truncated
                or content_truncated
                or attr_truncated
                or latency_truncated
                or parts_truncated
            ),
        }
        self._emit_row(row)
        return row

    def log_llm_request(
        self,
        *,
        prompt: str,
        session_id: str,
        invocation_id: str,
        trace_id: str,
        span_id: str,
        parent_span_id: str | None = None,
        agent: str | None = None,
        user_id: str | None = None,
        system_prompt: str | None = None,
        attributes: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.log_event(
            event_type="LLM_REQUEST",
            agent=agent,
            user_id=user_id,
            session_id=session_id,
            invocation_id=invocation_id,
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
            content={
                "system_prompt": system_prompt or "",
                "prompt": [{"role": "user", "content": prompt}],
            },
            content_parts=[_content_part(prompt, 0)] if prompt else [],
            attributes=attributes,
        )

    def log_llm_response(
        self,
        *,
        response: str,
        session_id: str,
        invocation_id: str,
        trace_id: str,
        span_id: str,
        parent_span_id: str | None = None,
        agent: str | None = None,
        user_id: str | None = None,
        model: str | None = None,
        usage_metadata: dict[str, int] | None = None,
        total_ms: int | None = None,
        status: str = "OK",
        error_message: str | None = None,
        attributes: dict[str, Any] | None = None,
        is_truncated: bool = False,
    ) -> dict[str, Any]:
        usage = usage_metadata or {}
        attrs = {
            "model": model or "",
            "usage_metadata": {
                "prompt_tokens": int(usage.get("prompt_tokens") or 0),
                "completion_tokens": int(usage.get("completion_tokens") or 0),
                "total_tokens": int(usage.get("total_tokens") or 0),
            },
        }
        if attributes:
            attrs.update(attributes)
        return self.log_event(
            event_type="LLM_RESPONSE",
            agent=agent,
            user_id=user_id,
            session_id=session_id,
            invocation_id=invocation_id,
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
            content={"response": response},
            content_parts=[_content_part(response, 0)] if response else [],
            attributes=attrs,
            latency_ms={"total_ms": total_ms} if total_ms is not None else {},
            status=status,
            error_message=error_message,
            is_truncated=is_truncated,
        )

    def log_tool_starting(
        self,
        *,
        tool: str,
        args: dict[str, Any],
        session_id: str,
        invocation_id: str,
        trace_id: str,
        span_id: str,
        parent_span_id: str | None,
        agent: str | None = None,
        tool_origin: str = "LOCAL",
        attributes: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        # No source default — the writer.agent block already identifies
        # the producer, and a hard-coded "claude_code" mislabels Codex /
        # OpenAI / direct-SDK callers. Pass attributes explicitly when
        # you want a richer label.
        return self.log_event(
            event_type="TOOL_STARTING",
            agent=agent,
            session_id=session_id,
            invocation_id=invocation_id,
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
            content={"tool": tool, "args": args, "tool_origin": tool_origin},
            attributes=attributes,
        )

    def log_tool_completed(
        self,
        *,
        tool: str,
        result: Any,
        session_id: str,
        invocation_id: str,
        trace_id: str,
        span_id: str,
        parent_span_id: str | None,
        agent: str | None = None,
        tool_origin: str = "LOCAL",
        total_ms: int | None = None,
        status: str = "OK",
        error_message: str | None = None,
        attributes: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.log_event(
            event_type="TOOL_COMPLETED",
            agent=agent,
            session_id=session_id,
            invocation_id=invocation_id,
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
            content={"tool": tool, "result": result, "tool_origin": tool_origin},
            attributes=attributes,
            latency_ms={"total_ms": total_ms} if total_ms is not None else {},
            status=status,
            error_message=error_message,
        )

    def _emit_row(self, row: dict[str, Any]) -> None:
        bq_row = _serialize_bq_json_fields(row)
        if self.config.dry_run:
            _log(self.config, "DRY_RUN " + json.dumps(bq_row, sort_keys=True, default=str))
            return
        if not self.config.project_id or not self.config.dataset:
            raise ValueError("BQAA_PROJECT_ID/GCP_PROJECT_ID and BQAA_DATASET are required")
        if self.config.direct_write:
            self._direct_insert(bq_row)
            return
        self._spool(bq_row)

    def _spool(self, bq_row: dict[str, Any]) -> None:
        spool = Path(self.config.spool_dir).expanduser()
        spool.mkdir(parents=True, exist_ok=True)
        # Per-event file keeps append atomic on POSIX without needing locks
        # in the hot path. Drainer renames into a working set before reading.
        envelope = {
            "config": {
                "project_id": self.config.project_id,
                "dataset": self.config.dataset,
                "table": self.config.table,
                "location": self.config.location,
                "auto_create_table": self.config.auto_create_table,
                "auto_create_dataset": self.config.auto_create_dataset,
                "writer_label": self.config.writer_label,
            },
            "row": bq_row,
        }
        name = f"event-{time.time_ns()}-{os.getpid()}-{uuid.uuid4().hex[:8]}.json"
        path = spool / name
        # Write to a tmp name + rename for atomicity against the drainer.
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(envelope, sort_keys=True, default=str), encoding="utf-8")
        os.replace(tmp, path)
        _ensure_drainer(self.config)

    def _direct_insert(self, bq_row: dict[str, Any]) -> None:
        timeout = self.config.network_timeout_seconds
        # Creating the client runs the ADC lookup, so it's inside the bound too.
        _call_with_timeout(self._ensure_table, timeout, "BigQuery table check")
        errors = _call_with_timeout(
            lambda: self._client.insert_rows_json(self._table_id, [bq_row], timeout=timeout),
            timeout,
            "BigQuery insert",
        )
        if errors:
            raise RuntimeError(f"BigQuery insert failed: {errors}")

    def _ensure_table(self) -> None:
        if self._table_ready:
            return
        from google.cloud import bigquery
        from google.cloud.exceptions import NotFound

        timeout = self.config.network_timeout_seconds
        self._client = self._client or bigquery.Client(
            project=self.config.project_id, location=self.config.location
        )
        dataset_id = f"{self.config.project_id}.{self.config.dataset}"
        if self.config.auto_create_dataset:
            try:
                self._client.get_dataset(dataset_id, timeout=timeout)
            except NotFound:
                dataset = bigquery.Dataset(dataset_id)
                if self.config.location:
                    dataset.location = self.config.location
                self._client.create_dataset(dataset, timeout=timeout)

        try:
            self._client.get_table(self._table_id, timeout=timeout)
        except NotFound:
            if not self.config.auto_create_table:
                raise
            table = bigquery.Table(self._table_id, schema=bq_schema(bigquery))
            table.time_partitioning = bigquery.TimePartitioning(
                type_=bigquery.TimePartitioningType.DAY,
                field="timestamp",
            )
            table.clustering_fields = ["event_type", "agent", "user_id"]
            table.labels = {"adk_schema_version": "1"}
            self._client.create_table(table, timeout=timeout)
        self._table_ready = True

    @property
    def _table_id(self) -> str:
        return f"{self.config.project_id}.{self.config.dataset}.{self.config.table}"


def _ensure_drainer(config: BQAAConfig) -> None:
    """Spawn the drainer in a detached subprocess if none is running.

    Uses a non-blocking flock on a pidfile to dedupe; a running drainer holds
    the lock for its entire lifetime. If we can't take the lock, a drainer is
    already running and will pick up our spool file.
    """
    spool = Path(config.spool_dir).expanduser()
    spool.mkdir(parents=True, exist_ok=True)
    pidfile = spool / ".drainer.pid"
    fd = os.open(str(pidfile), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return  # Another drainer is running.
        # We hold the lock momentarily; release before spawning so the child
        # can take it for its own lifetime.
        fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)

    drain_script = _drain_script_path()
    python_bin = os.environ.get("BQAA_PYTHON") or sys.executable or "python3"
    try:
        subprocess.Popen(
            [python_bin, str(drain_script)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
            env=os.environ.copy(),
        )
    except OSError as exc:
        _log(config, f"DRAINER_SPAWN_FAIL {exc}")


def _drain_script_path() -> Path:
    """Locate the bqaa_drain.py entry script next to bqaa_hook.py."""
    here = Path(__file__).resolve().parent
    # sdk/python/bqaa_tracing.py -> ../../scripts/bqaa_drain.py
    candidate = here.parent.parent / "scripts" / "bqaa_drain.py"
    return candidate


def _content_part(text: str, index: int) -> dict[str, Any]:
    return {
        "mime_type": "text/plain",
        "uri": None,
        "object_ref": None,
        "text": text,
        "part_index": index,
        "part_attributes": None,
        "storage_mode": "INLINE",
    }


def _serialize_bq_json_fields(row: dict[str, Any]) -> dict[str, Any]:
    bq_row = dict(row)
    for field in ("content", "attributes", "latency_ms"):
        value = bq_row.get(field)
        if value is not None and not isinstance(value, str):
            bq_row[field] = json.dumps(value, sort_keys=True)
    parts = []
    for part in bq_row.get("content_parts") or []:
        next_part = dict(part)
        object_ref = next_part.get("object_ref")
        if isinstance(object_ref, dict):
            details = object_ref.get("details")
            if details is not None and not isinstance(details, str):
                next_object_ref = dict(object_ref)
                next_object_ref["details"] = json.dumps(details, sort_keys=True)
                next_part["object_ref"] = next_object_ref
        parts.append(next_part)
    bq_row["content_parts"] = parts
    return bq_row


def bq_schema(bigquery: Any) -> list[Any]:
    """BigQuery schema matching ADK BQAA agent_events.

    Exposed as a public helper so the drainer can reuse it for table creation
    and Storage Write API setup.
    """
    return [
        bigquery.SchemaField("timestamp", "TIMESTAMP", mode="REQUIRED"),
        bigquery.SchemaField("event_type", "STRING"),
        bigquery.SchemaField("agent", "STRING"),
        bigquery.SchemaField("session_id", "STRING"),
        bigquery.SchemaField("invocation_id", "STRING"),
        bigquery.SchemaField("user_id", "STRING"),
        bigquery.SchemaField("trace_id", "STRING"),
        bigquery.SchemaField("span_id", "STRING"),
        bigquery.SchemaField("parent_span_id", "STRING"),
        bigquery.SchemaField("content", "JSON"),
        bigquery.SchemaField(
            "content_parts",
            "RECORD",
            mode="REPEATED",
            fields=[
                bigquery.SchemaField("mime_type", "STRING"),
                bigquery.SchemaField("uri", "STRING"),
                bigquery.SchemaField(
                    "object_ref",
                    "RECORD",
                    fields=[
                        bigquery.SchemaField("uri", "STRING"),
                        bigquery.SchemaField("version", "STRING"),
                        bigquery.SchemaField("authorizer", "STRING"),
                        bigquery.SchemaField("details", "JSON"),
                    ],
                ),
                bigquery.SchemaField("text", "STRING"),
                bigquery.SchemaField("part_index", "INTEGER"),
                bigquery.SchemaField("part_attributes", "STRING"),
                bigquery.SchemaField("storage_mode", "STRING"),
            ],
        ),
        bigquery.SchemaField("attributes", "JSON"),
        bigquery.SchemaField("latency_ms", "JSON"),
        bigquery.SchemaField("status", "STRING"),
        bigquery.SchemaField("error_message", "STRING"),
        bigquery.SchemaField("is_truncated", "BOOLEAN"),
    ]


# ----------------------------------------------------------------------------
# State store with file locking
# ----------------------------------------------------------------------------


class _LockedJSONStore:
    """Atomic read-modify-write JSON store guarded by fcntl.flock."""

    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    @contextlib.contextmanager
    def transaction(self) -> Iterator[dict[str, Any]]:
        fd = os.open(str(self.path), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                with os.fdopen(fd, "r+", encoding="utf-8", closefd=False) as handle:
                    handle.seek(0)
                    raw = handle.read()
                    state = _safe_json_loads(raw, {}) if raw.strip() else {}
                    yield state
                    handle.seek(0)
                    handle.truncate()
                    handle.write(json.dumps(state, sort_keys=True))
                    handle.flush()
                    os.fsync(fd)
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            try:
                os.close(fd)
            except OSError:
                pass

    def read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        with self.transaction() as state:
            return dict(state)

    def remove(self) -> None:
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


class StateStore:
    """Per-session state with locked RMW + per-tool sub-files.

    Session-scoped fields (`session_id`, `current_*`, `trace_count`, etc) live
    in `state_<session>.json`. Per-tool sub-state lives in
    `tool_<session>_<tool_use_id>.json` so concurrent PreToolUse fires don't
    clobber each other's `start_ms`/`span_id`.
    """

    def __init__(self, key: str, root: str = DEFAULT_STATE_DIR):
        safe_key = "".join(ch for ch in key if ch.isalnum() or ch in "._-") or "default"
        self.key = safe_key
        self.root = Path(root).expanduser()
        self.root.mkdir(parents=True, exist_ok=True)
        self._session_store = _LockedJSONStore(self.root / f"state_{safe_key}.json")
        self._cache: dict[str, Any] = self._session_store.read()

    def get(self, key: str, default: Any = None) -> Any:
        return self._cache.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self.update({key: value})

    def update(self, values: dict[str, Any]) -> None:
        with self._session_store.transaction() as state:
            state.update(values)
            self._cache = dict(state)

    def delete(self, *keys: str) -> None:
        with self._session_store.transaction() as state:
            for key in keys:
                state.pop(key, None)
            self._cache = dict(state)

    def remove(self) -> None:
        self._session_store.remove()
        for path in self.root.glob(f"tool_{self.key}_*.json"):
            try:
                path.unlink()
            except FileNotFoundError:
                pass

    # -- Per-tool sub-state ---------------------------------------------------

    def _tool_path(self, tool_use_id: str) -> Path:
        safe = "".join(ch for ch in tool_use_id if ch.isalnum() or ch in "._-") or "unknown"
        return self.root / f"tool_{self.key}_{safe}.json"

    def set_tool(self, tool_use_id: str, value: dict[str, Any]) -> None:
        store = _LockedJSONStore(self._tool_path(tool_use_id))
        with store.transaction() as state:
            state.clear()
            state.update(value)

    def pop_tool(self, tool_use_id: str) -> dict[str, Any]:
        path = self._tool_path(tool_use_id)
        store = _LockedJSONStore(path)
        with store.transaction() as state:
            value = dict(state)
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return value


def cleanup_stale_state(root: str | Path, ttl_hours: float) -> int:
    """Remove state, per-tool and hook queue files older than ttl_hours.
    Returns count."""
    if ttl_hours <= 0:
        return 0
    base = Path(root).expanduser()
    if not base.exists():
        return 0
    cutoff = time.time() - ttl_hours * 3600
    removed = 0
    paths = [
        path
        for path in base.iterdir()
        if path.name.startswith(("state_", "tool_")) and path.name.endswith(".json")
    ]
    queue = base / "queue"
    if queue.is_dir():
        # Events no adapter run got to, or that a dying hook never finished.
        # Not the lock files, which stay (see QUEUE_LOCKS), nor QUEUE_LAST.
        paths += [p for p in queue.iterdir() if p.name.isdigit()]
    stale = []
    for path in paths:
        if not path.is_file():
            continue
        try:
            mtime = path.stat().st_mtime
        except FileNotFoundError:
            continue
        if mtime < cutoff:
            stale.append(path)
    # Their numbers stay used (see QUEUE_LAST).
    _record_used(queue, [path for path in stale if path.parent == queue])
    for path in stale:
        try:
            path.unlink()
            removed += 1
        except FileNotFoundError:
            pass
    return removed


# ----------------------------------------------------------------------------
# Hook adapter
# ----------------------------------------------------------------------------


class ClaudeHookBQAAAdapter:
    def __init__(self, logger: BigQueryAgentAnalyticsLogger | None = None):
        self.logger = logger or BigQueryAgentAnalyticsLogger()
        self.config = self.logger.config

    def process(self, hook_name: str, payload: dict[str, Any]) -> None:
        state = StateStore(self._state_key(payload), root=self.config.state_dir)
        if hook_name == "SessionStart":
            self._session_start(payload, state)
        elif hook_name == "UserPromptSubmit":
            self._user_prompt_submit(payload, state)
        elif hook_name == "PreToolUse":
            self._pre_tool_use(payload, state)
        elif hook_name == "PostToolUse":
            self._post_tool_use(payload, state)
        elif hook_name == "Stop":
            self._stop(payload, state)
        elif hook_name == "SubagentStop":
            self._subagent_stop(payload, state)
        elif hook_name == "Notification":
            self._notification(payload, state)
        elif hook_name == "PermissionRequest":
            self._permission_request(payload, state)
        elif hook_name == "SessionEnd":
            self._session_end(payload, state)

    def _state_key(self, payload: dict[str, Any]) -> str:
        return (
            str(payload.get("session_id") or "")
            or os.environ.get("CLAUDE_SESSION_KEY", "")
            or str(os.getppid())
        )

    def _ensure_session(self, payload: dict[str, Any], state: StateStore) -> None:
        if state.get("session_id"):
            return
        self._session_start(payload, state)

    def _session_start(self, payload: dict[str, Any], state: StateStore) -> None:
        cwd = payload.get("cwd") or os.getcwd()
        session_id = payload.get("session_id") or _hex_id(32)
        state.update(
            {
                "session_id": session_id,
                "project_name": os.environ.get("BQAA_PROJECT_NAME") or Path(cwd).name,
                "agent": os.environ.get("BQAA_AGENT_NAME") or "claude-code",
                "user_id": os.environ.get("BQAA_USER_ID") or os.environ.get("USER"),
                "trace_count": int(state.get("trace_count", 0)),
                "session_start_ms": _timestamp_ms(),
            }
        )
        try:
            cleanup_stale_state(self.config.state_dir, self.config.state_ttl_hours)
        except OSError:
            pass

    def _user_prompt_submit(self, payload: dict[str, Any], state: StateStore) -> None:
        self._ensure_session(payload, state)
        trace_count = int(state.get("trace_count", 0)) + 1
        trace_id = _hex_id(32)
        span_id = _hex_id(16)
        invocation_id = payload.get("invocation_id") or _hex_id(32)
        prompt = str(payload.get("prompt") or "")
        transcript = str(payload.get("transcript_path") or "")
        state.update(
            {
                "trace_count": trace_count,
                "current_trace_id": trace_id,
                "current_span_id": span_id,
                "current_invocation_id": invocation_id,
                "current_prompt": prompt,
                "current_start_ms": _timestamp_ms(),
                "transcript_path": transcript,
                "transcript_start_line": _line_count(transcript),
            }
        )
        self.logger.log_llm_request(
            prompt=prompt,
            session_id=state.get("session_id"),
            invocation_id=invocation_id,
            trace_id=trace_id,
            span_id=span_id,
            agent=state.get("agent"),
            user_id=state.get("user_id"),
            attributes={
                "session_metadata": {
                    "project_name": state.get("project_name"),
                    "cwd": payload.get("cwd"),
                    "source": "claude_code",
                    "trace_number": trace_count,
                },
                "custom_tags": {"assistant": "claude_code"},
            },
        )

    def _pre_tool_use(self, payload: dict[str, Any], state: StateStore) -> None:
        self._ensure_session(payload, state)
        tool_use_id = str(payload.get("tool_use_id") or _hex_id(16))
        # Deterministic span so a Post without matching Pre still correlates.
        span_id = _deterministic_span(tool_use_id)
        tool_name = str(payload.get("tool_name") or "unknown")
        state.set_tool(
            tool_use_id,
            {
                "start_ms": _timestamp_ms(),
                "span_id": span_id,
                "tool_name": tool_name,
            },
        )
        self.logger.log_tool_starting(
            tool=tool_name,
            args=_to_jsonable(payload.get("tool_input") or {}),
            session_id=state.get("session_id"),
            invocation_id=state.get("current_invocation_id") or _hex_id(32),
            trace_id=state.get("current_trace_id") or _hex_id(32),
            span_id=span_id,
            parent_span_id=state.get("current_span_id"),
            agent=state.get("agent"),
            tool_origin=_tool_origin(tool_name),
            attributes={"source": "claude_code"},
        )

    def _post_tool_use(self, payload: dict[str, Any], state: StateStore) -> None:
        self._ensure_session(payload, state)
        tool_use_id = str(payload.get("tool_use_id") or "")
        tool_state = state.pop_tool(tool_use_id) if tool_use_id else {}
        start_ms = int(tool_state.get("start_ms") or _timestamp_ms())
        tool_name = str(payload.get("tool_name") or tool_state.get("tool_name") or "unknown")
        # If Pre never fired we still want correlation: derive deterministically.
        span_id = tool_state.get("span_id") or _deterministic_span(tool_use_id)
        result = payload.get("tool_response")
        status, error_message = _tool_status(result)
        self.logger.log_tool_completed(
            tool=tool_name,
            result=_to_jsonable(result),
            session_id=state.get("session_id"),
            invocation_id=state.get("current_invocation_id") or _hex_id(32),
            trace_id=state.get("current_trace_id") or _hex_id(32),
            span_id=span_id,
            parent_span_id=state.get("current_span_id"),
            agent=state.get("agent"),
            tool_origin=_tool_origin(tool_name),
            total_ms=max(0, _timestamp_ms() - start_ms),
            status=status,
            error_message=error_message,
            attributes={"source": "claude_code"},
        )

    def _stop(self, payload: dict[str, Any], state: StateStore) -> None:
        if not state.get("current_trace_id"):
            return
        transcript = str(payload.get("transcript_path") or state.get("transcript_path") or "")
        output, model, usage, was_truncated = _read_transcript_since(
            transcript,
            int(state.get("transcript_start_line") or 0),
            self.config.transcript_max_bytes,
            until_ms=_event_time_ms(),
        )
        output = output or str(payload.get("response") or "(No response captured)")
        start_ms = int(state.get("current_start_ms") or _timestamp_ms())
        self.logger.log_llm_response(
            response=output,
            session_id=state.get("session_id"),
            invocation_id=state.get("current_invocation_id"),
            trace_id=state.get("current_trace_id"),
            span_id=state.get("current_span_id"),
            agent=state.get("agent"),
            user_id=state.get("user_id"),
            model=model or str(payload.get("model") or ""),
            usage_metadata=usage,
            total_ms=max(0, _timestamp_ms() - start_ms),
            attributes={
                "session_metadata": {
                    "project_name": state.get("project_name"),
                    "source": "claude_code",
                    "trace_number": state.get("trace_count"),
                },
                "custom_tags": {"assistant": "claude_code"},
            },
            is_truncated=was_truncated,
        )
        state.delete(
            "current_trace_id",
            "current_span_id",
            "current_invocation_id",
            "current_prompt",
            "current_start_ms",
            "transcript_path",
            "transcript_start_line",
        )

    def _subagent_stop(self, payload: dict[str, Any], state: StateStore) -> None:
        if not state.get("current_trace_id"):
            return
        transcript = str(payload.get("agent_transcript_path") or "")
        output, model, usage, was_truncated = _read_transcript_since(
            transcript, 0, self.config.transcript_max_bytes
        )
        agent_name = str(payload.get("agent_type") or payload.get("agent_id") or "subagent")
        self.logger.log_llm_response(
            response=output or str(payload.get("output") or ""),
            session_id=state.get("session_id"),
            invocation_id=state.get("current_invocation_id"),
            trace_id=state.get("current_trace_id"),
            span_id=_hex_id(16),
            parent_span_id=state.get("current_span_id"),
            agent=agent_name,
            user_id=state.get("user_id"),
            model=model,
            usage_metadata=usage,
            attributes={
                "session_metadata": {
                    "project_name": state.get("project_name"),
                    "source": "claude_code_subagent",
                },
                "custom_tags": {
                    "assistant": "claude_code",
                    "subagent_id": payload.get("agent_id"),
                },
            },
            is_truncated=was_truncated,
        )

    def _notification(self, payload: dict[str, Any], state: StateStore) -> None:
        self._ensure_session(payload, state)
        self.logger.log_event(
            event_type="STATE_DELTA",
            agent=state.get("agent"),
            session_id=state.get("session_id"),
            invocation_id=state.get("current_invocation_id"),
            trace_id=state.get("current_trace_id"),
            span_id=_hex_id(16),
            parent_span_id=state.get("current_span_id"),
            content={
                "notification": {
                    "title": payload.get("title"),
                    "message": payload.get("message"),
                    "type": payload.get("notification_type") or "info",
                }
            },
            attributes={
                "state_delta": {
                    "source": "claude_code_notification",
                    "notification_type": payload.get("notification_type") or "info",
                }
            },
        )

    def _permission_request(self, payload: dict[str, Any], state: StateStore) -> None:
        self._ensure_session(payload, state)
        self.logger.log_event(
            event_type="HITL_CONFIRMATION_REQUEST",
            agent=state.get("agent"),
            session_id=state.get("session_id"),
            invocation_id=state.get("current_invocation_id"),
            trace_id=state.get("current_trace_id"),
            span_id=_hex_id(16),
            parent_span_id=state.get("current_span_id"),
            content={
                "permission": payload.get("permission"),
                "tool": payload.get("tool_name"),
                "args": _to_jsonable(payload.get("tool_input") or {}),
            },
            attributes={
                "session_metadata": {"source": "claude_code_permission_request"},
                "custom_tags": {"assistant": "claude_code"},
            },
        )

    def _session_end(self, payload: dict[str, Any], state: StateStore) -> None:
        self._ensure_session(payload, state)
        self.logger.log_event(
            event_type="STATE_DELTA",
            agent=state.get("agent"),
            session_id=state.get("session_id"),
            invocation_id=state.get("current_invocation_id"),
            trace_id=state.get("current_trace_id"),
            span_id=_hex_id(16),
            parent_span_id=state.get("current_span_id"),
            content={"session_end": True},
            attributes={
                "state_delta": {
                    "source": "claude_code_session_end",
                    "trace_count": state.get("trace_count", 0),
                    "duration_ms": max(
                        0, _timestamp_ms() - int(state.get("session_start_ms") or _timestamp_ms())
                    ),
                }
            },
        )
        state.remove()


def _line_count(path: str) -> int:
    """Lines in the transcript as of the current hook.

    Applied late, a UserPromptSubmit can find the reply in the transcript
    already, and Stop reads the reply from this line on. So the count ends
    at the last line stamped no later than the hook ran.
    """
    if not path:
        return 0
    transcript = Path(path).expanduser()
    if not transcript.exists():
        return 0
    hook_ms = _event_time_ms()
    if hook_ms is None:
        with transcript.open("r", encoding="utf-8", errors="replace") as handle:
            return sum(1 for _ in handle)
    total, later, stamped = 0, None, False
    for line in _lines_from_end(transcript):
        if later is None:
            stamp = _transcript_time_ms(_safe_json_loads(line.decode("utf-8", "replace"), None))
            if stamp is not None:
                stamped = True
                if stamp <= hook_ms:
                    later = total
        total += 1
    if later is None:
        return 0 if stamped else total
    return total - later


def _lines_from_end(path: Path, block_size: int = 1 << 20) -> Iterator[bytes]:
    """The file's lines (as iterating over it yields them), last first."""
    with path.open("rb") as handle:
        end = handle.seek(0, os.SEEK_END)
        if end == 0:
            return
        handle.seek(end - 1)
        if handle.read(1) == b"\n":
            end -= 1
        position, head = end, b""
        while position > 0:
            step = min(block_size, position)
            position -= step
            handle.seek(position)
            lines = (handle.read(step) + head).split(b"\n")
            head = lines.pop(0)
            yield from reversed(lines)
        yield head


def _tool_origin(tool_name: Any) -> str:
    name = str(tool_name or "")
    if name.lower().startswith("mcp__"):
        return "MCP"
    if name in {"Task", "Subagent"}:
        return "SUB_AGENT"
    return "LOCAL"


def _tool_status(result: Any) -> tuple[str, str | None]:
    if isinstance(result, dict):
        if result.get("is_error") or result.get("error"):
            return "ERROR", str(result.get("error") or result.get("message") or "tool error")
    text = str(result or "")
    if text.lower().startswith("error:"):
        return "ERROR", text[:1000]
    return "OK", None


def _log(config: BQAAConfig, message: str) -> None:
    _append_log(config.log_file, message)


def _append_log(log_file: str, message: str) -> None:
    if not log_file:
        return
    try:
        with open(log_file, "a", encoding="utf-8") as handle:
            handle.write(f"[{_iso_timestamp(datetime.now(timezone.utc))}] {message}\n")
    except OSError:
        pass


def run_claude_hook(hook_name: str, payload: dict[str, Any] | None = None) -> None:
    adapter = ClaudeHookBQAAAdapter()
    adapter.process(hook_name, payload or {})


# ----------------------------------------------------------------------------
# Hook queue (filled by hooks/common.sh)
# ----------------------------------------------------------------------------

# Each event is a file named by its 12-digit sequence number in
# BQAA_STATE_DIR/queue: the hook name, a newline, the payload, then a line
# with QUEUE_END and the hook's token, written last.
QUEUE_END = b"#bqaa-end"
# A number is never handed out twice. Before a run removes an event it
# raises the number in this file to the event's (see _record_used), and a
# hook numbers its event above every queued one and keeps the number only
# if it's above this one once the hook holds the file. Were a number freed
# for reuse (another session's run removed the event under it), a run that
# had already read past it could later find a newer event of its own
# session there, such as a Stop, having missed the older UserPromptSubmit
# that went to a lower number in between. The numbers start over only if
# the queue dir is removed; the token then still tells the hook's own run
# its event apart from a newer one with the same number.
QUEUE_LAST = "last"
# Runs lock one of QUEUE_LOCKS files in the queue dir, picked by session.
# They are never removed: a run could lock one just as it was unlinked, and
# the next run would then lock a new file at the same path, so both would
# apply the session's events at once. A fixed set keeps them few; sessions
# that share one only wait for each other.
QUEUE_LOCKS = 64


class _QueuedEvent(NamedTuple):
    path: Path
    hook_name: str
    payload: Any  # None if it can't be parsed, and then error says why
    # Whose event it is: the payload's top-level session_id, as the
    # adapter's state key reads it. None to apply it on its own.
    session: str | None
    error: str | None
    token: str
    time_ns: int  # when the hook wrote it


def process_hook_queue(queue_dir: str | Path, entry: str, token: str) -> int:
    """Apply the queued hook events of entry's session, oldest first.
    Returns how many.

    Each hook queues its event (entry, with the hook's token) before it
    returns and then starts an adapter run, which can start late (on macOS
    a hung syspolicyd holds up interpreter launches for minutes). Whichever
    run of a session gets the lock first applies everything queued for the
    session, so a late event still lands before the newer events that
    depend on it (UserPromptSubmit before its Stop, PreToolUse before its
    PostToolUse). Each is applied as of the time its hook ran.

    An event's session is the top-level session_id of its whole payload, so
    every queued payload is read in full. One without a session_id, or that
    can't be parsed, is applied on its own; the latter is dropped with a log
    line, and runs of other sessions just pass it by. Only the session's own
    events are applied, since sessions can run with different settings.
    """
    if not (len(entry) == 12 and entry.isdigit()):
        raise ValueError(f"bad queue entry {entry!r}")
    queue = Path(queue_dir)
    own = _read_queued_event(queue / entry)
    if own is None or own.token != token:
        # Applied already, after everything queued for its session before it.
        return 0
    session = own.session
    with _file_lock(_queue_lock(queue, session or entry)):
        # Another run of the session may have applied it in the meantime.
        own = _read_queued_event(own.path)
        if own is None or own.token != token:
            return 0
        events = [own] if session is None else _queued_events(queue, session)
        # Before any of them is removed (see QUEUE_LAST).
        _record_used(queue, [event.path for event in events])
        try:
            adapter = ClaudeHookBQAAAdapter()
        except Exception:
            # Nothing can be written with a config that doesn't parse. Drop
            # the events, as a direct run would, rather than let them pile up.
            for event in events:
                event.path.unlink(missing_ok=True)
            raise
        for event in events:
            try:
                if event.error:
                    # Most likely cut off when the hook stopped waiting for
                    # stdin, or nested too deeply or holding too long a
                    # number for json. Applying it as {} would only make up
                    # an event.
                    raise ValueError(event.error)
                with _event_clock(event.time_ns):
                    adapter.process(event.hook_name, event.payload)
            except Exception as exc:
                _log(adapter.config, f"ERROR hook={event.hook_name}: {exc}\n{traceback.format_exc()}")
            finally:
                event.path.unlink(missing_ok=True)
        return len(events)


def _queue_lock(queue: Path, key: str) -> Path:
    """The lock file for the events of key (a session, or a lone entry)."""
    digest = hashlib.sha256(key.encode("utf-8", "surrogatepass")).digest()
    return queue / f".lock-{int.from_bytes(digest[:4], 'big') % QUEUE_LOCKS:02d}"


def _record_used(queue: Path, paths: list[Path]) -> None:
    """Raise the number in QUEUE_LAST to the highest of paths' numbers.
    Call it before removing them, so no hook hands those numbers out again."""
    if not paths:
        return
    top = max(int(path.name) for path in paths)
    last = queue / QUEUE_LAST
    with _file_lock(queue / ".last.lock"):
        try:
            if int(last.read_text(encoding="ascii")) >= top:
                return
        except (OSError, ValueError):
            pass
        # Hooks read the file without a lock: replace it whole.
        new = queue / ".last.new"
        new.write_text(f"{top:012d}\n", encoding="ascii")
        os.replace(new, last)


def _queued_events(queue: Path, session: str) -> list[_QueuedEvent]:
    """The session's complete queue entries, oldest first.

    An entry without its last line is still being written by a hook that
    hasn't returned, so nothing queued after it depends on it; its own run
    picks it up. (One a dying hook left unfinished is purged by
    cleanup_stale_state.)
    """
    try:
        names = sorted((p.name for p in queue.iterdir() if p.name.isdigit()), key=int)
    except FileNotFoundError:
        return []
    events = []
    for name in names:
        event = _read_queued_event(queue / name)
        if event is not None and event.session == session:
            events.append(event)
    return events


def _read_queued_event(path: Path) -> _QueuedEvent | None:
    """The queue entry at path; None if it's gone, can't be read or is still
    being written.

    Every run reads every entry, so this doesn't raise: one bad payload
    must not stop the runs of every session.
    """
    try:
        with path.open("rb") as handle:
            data = handle.read()
            time_ns = os.fstat(handle.fileno()).st_mtime_ns
    except (OSError, MemoryError):
        return None
    body, end, token = data.rpartition(b"\n" + QUEUE_END + b" ")
    if not end or not token.endswith(b"\n") or b"\n" in token[:-1]:
        return None
    header, _, raw = body.partition(b"\n")
    hook_name = header.decode("utf-8", "replace")
    payload: Any = {}
    session = error = None
    try:
        text = raw.decode("utf-8", "replace")
        if text.strip():
            payload = json.loads(text)
        if isinstance(payload, dict):
            session = str(payload.get("session_id") or "") or None
    except Exception as exc:
        # Not only JSONDecodeError: deep nesting raises RecursionError, an
        # integer too long to convert ValueError.
        payload, session, error = None, None, f"{hook_name} payload can't be parsed: {exc!r}"
    return _QueuedEvent(
        path, hook_name, payload, session, error, token[:-1].decode("utf-8", "replace"), time_ns
    )


def main(argv: list[str] | None = None) -> int:
    argv = argv or sys.argv[1:]
    if not argv:
        print(
            "usage: bqaa_tracing.py <ClaudeHookName> | --queue <queue-dir> <entry> <token> | --cleanup <state-dir>",
            file=sys.stderr,
        )
        return 2
    hook_name = argv[0]
    log_file = os.environ.get("BQAA_LOG_FILE", DEFAULT_LOG_FILE)
    # Hooks should never break the calling agent, so even a malformed config
    # or payload only ends up in the log.
    try:
        if hook_name == "--queue":
            # From hooks/common.sh: the event is in the queue, not on stdin.
            _, queue_dir, entry, token = argv
            process_hook_queue(queue_dir, entry, token)
        elif hook_name == "--cleanup":
            # From hooks/common.sh, when the queue is full: prune expired
            # state so queueing can resume.
            _, state_dir = argv
            config = BQAAConfig.from_env()
            cleanup_stale_state(state_dir, config.state_ttl_hours)
        else:
            raw = sys.stdin.read()
            payload = _safe_json_loads(raw, {}) if raw.strip() else {}
            config = BQAAConfig.from_env()
            ClaudeHookBQAAAdapter(BigQueryAgentAnalyticsLogger(config)).process(
                hook_name, payload
            )
    except Exception as exc:
        _append_log(log_file, f"ERROR hook={hook_name}: {exc}\n{traceback.format_exc()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
