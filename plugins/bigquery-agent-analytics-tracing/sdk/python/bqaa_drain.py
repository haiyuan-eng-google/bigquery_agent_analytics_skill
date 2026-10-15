"""Background drainer for the BQAA spool.

The drainer is launched as a detached subprocess by the hook adapter (see
``_ensure_drainer`` in ``bqaa_tracing.py``). Its job is to take BQAA rows that
the hook process spooled to disk and write them to BigQuery without blocking
the host agent.

Design choices:

- Single drainer per spool dir, enforced by an exclusive ``fcntl.flock`` on
  ``.drainer.pid``. New hook fires that try to spawn a drainer no-op out
  immediately if the lock is held.
- Writes use the BigQuery Storage Write API via ``BigQueryWriteAsyncClient``
  + PyArrow batches when both libraries are importable. This matches the
  ADK BQAA plugin and avoids streaming-insert quotas.
- When the Storage Write client or PyArrow are not available, falls back to
  ``bigquery.Client.insert_rows_json``. Same row contents in either path.
- Retries transient failures (``ServiceUnavailable``, ``TooManyRequests``,
  ``InternalServerError``, timeouts) with exponential backoff, matching ADK's
  RetryConfig defaults.
- Every network or auth call (the ADC lookup, table checks, each write
  attempt) runs under a hard ``BQAA_NETWORK_TIMEOUT_SECONDS`` timeout, so a
  hung call can't pin the single drainer and its pidfile lock.
- ``insert_rows_json`` resends are idempotent as far as BigQuery allows:
  every attempt carries the same insertIds (each row's content hash), which
  BigQuery uses for best-effort dedupe. A timed-out insert keeps running on
  its own thread, so it's never resent while it may still land: the backoff
  is spent waiting for its result, and if it's still running after that the
  batch is dead-lettered, though it may yet land.
- The Storage Write API's default stream is at-least-once. An append that
  times out may still have landed, so its retry, or the ``insert_rows_json``
  fallback after it, can write those rows twice.
- Rows that exhaust retries or hit non-retryable errors are moved to
  ``dead-letter/`` so they can be inspected and replayed.
- Drainer exits after ``BQAA_DRAIN_IDLE_SECONDS`` of empty polling; the next
  hook fire spawns a fresh one.
"""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import hashlib
import json
import os
import random
import sys
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

# Storage Write API channels share gRPC state across forks; this matches what
# the ADK plugin does and keeps the channel safe if the host agent forks us.
os.environ.setdefault("GRPC_ENABLE_FORK_SUPPORT", "1")

from bqaa_tracing import (  # noqa: E402  (after env tweak)
    BQAAConfig,
    WRITER_LABEL,
    _call_with_timeout,
    _CallTimedOut,
    _log,
    bq_schema,
)

# The scopes BigQueryWriteAsyncClient asks ADC for by default; they cover
# the insert_rows_json fallback too.
_WRITE_SCOPES = (
    "https://www.googleapis.com/auth/bigquery",
    "https://www.googleapis.com/auth/bigquery.insertdata",
    "https://www.googleapis.com/auth/cloud-platform",
)


@dataclass
class _RetryConfig:
    max_retries: int = 3
    initial_delay: float = 1.0
    multiplier: float = 2.0
    max_delay: float = 10.0


@dataclass
class _Envelope:
    path: Path
    config_dict: dict[str, Any]
    row: dict[str, Any]


@contextlib.contextmanager
def _try_acquire_pidfile(pidfile: Path) -> Iterator[int | None]:
    """Acquire the drainer pidfile non-blockingly. Yields None if held."""
    pidfile.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(pidfile), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield None
            return
        try:
            os.ftruncate(fd, 0)
            os.write(fd, str(os.getpid()).encode())
            os.fsync(fd)
        except OSError:
            pass
        try:
            yield fd
        finally:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except OSError:
                pass
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def _list_pending(spool: Path) -> list[Path]:
    if not spool.exists():
        return []
    return sorted(p for p in spool.glob("event-*.json") if p.is_file())


def _read_envelope(path: Path) -> _Envelope | None:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        # Corrupt spool entry — dead-letter and move on.
        _quarantine(path, reason="corrupt-json")
        return None
    return _Envelope(
        path=path,
        config_dict=data.get("config") or {},
        row=data.get("row") or {},
    )


def _group_envelopes(envelopes: list[_Envelope]) -> dict[tuple, list[_Envelope]]:
    """Group by destination table + writer label + auto-create policy.

    The writer label is part of the key so a single drainer process can serve
    envelopes from differently-labeled deployments without bleeding their
    AppendRowsRequest.trace_id values together. The auto-create flags are
    part of the key so the fallback path honors each producer's policy
    instead of clobbering it with hard-coded defaults.
    """
    grouped: dict[tuple, list[_Envelope]] = {}
    for env in envelopes:
        cfg = env.config_dict
        # Defaults match BQAAConfig defaults in bqaa_tracing.py.
        auto_create_table = cfg.get("auto_create_table")
        auto_create_dataset = cfg.get("auto_create_dataset")
        key = (
            cfg.get("project_id"),
            cfg.get("dataset"),
            cfg.get("table"),
            cfg.get("location"),
            cfg.get("writer_label") or WRITER_LABEL,
            True if auto_create_table is None else bool(auto_create_table),
            False if auto_create_dataset is None else bool(auto_create_dataset),
        )
        grouped.setdefault(key, []).append(env)
    return grouped


def _quarantine(path: Path, reason: str) -> None:
    dead = path.parent / "dead-letter"
    dead.mkdir(parents=True, exist_ok=True)
    target = dead / f"{path.stem}.{reason}.json"
    try:
        os.replace(path, target)
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _default_credentials(timeout: float) -> Any:
    """Look up Application Default Credentials under a hard timeout.

    Left to themselves, both clients do this lookup in their constructors
    with no deadline, and it can probe the GCE metadata server or refresh a
    token over the network.
    """
    import google.auth

    credentials, _ = _call_with_timeout(
        lambda: google.auth.default(default_scopes=_WRITE_SCOPES),
        timeout,
        "ADC lookup",
    )
    return credentials


# ---------------------------------------------------------------------------
# Storage Write API path
# ---------------------------------------------------------------------------


def _storage_write_available() -> bool:
    try:
        import pyarrow  # noqa: F401
        from google.cloud.bigquery_storage_v1.services.big_query_write.async_client import (  # noqa: F401
            BigQueryWriteAsyncClient,
        )
        from google.cloud.bigquery_storage_v1 import types as _types  # noqa: F401
    except Exception:
        return False
    return True


def _arrow_schema():
    import pyarrow as pa

    object_ref_type = pa.struct(
        [
            pa.field("uri", pa.string()),
            pa.field("version", pa.string()),
            pa.field("authorizer", pa.string()),
            pa.field("details", pa.string()),  # JSON serialized as string for Arrow.
        ]
    )
    content_part_type = pa.struct(
        [
            pa.field("mime_type", pa.string()),
            pa.field("uri", pa.string()),
            pa.field("object_ref", object_ref_type),
            pa.field("text", pa.string()),
            pa.field("part_index", pa.int64()),
            pa.field("part_attributes", pa.string()),
            pa.field("storage_mode", pa.string()),
        ]
    )
    return pa.schema(
        [
            pa.field("timestamp", pa.timestamp("us", tz="UTC"), nullable=False),
            pa.field("event_type", pa.string()),
            pa.field("agent", pa.string()),
            pa.field("session_id", pa.string()),
            pa.field("invocation_id", pa.string()),
            pa.field("user_id", pa.string()),
            pa.field("trace_id", pa.string()),
            pa.field("span_id", pa.string()),
            pa.field("parent_span_id", pa.string()),
            pa.field("content", pa.string()),  # JSON in Storage Write payload.
            pa.field("content_parts", pa.list_(content_part_type)),
            pa.field("attributes", pa.string()),
            pa.field("latency_ms", pa.string()),
            pa.field("status", pa.string()),
            pa.field("error_message", pa.string()),
            pa.field("is_truncated", pa.bool_()),
        ]
    )


def _row_to_arrow_dict(row: dict[str, Any]) -> dict[str, Any]:
    """Adapt a spooled row to the Arrow column shape."""
    from datetime import datetime, timezone

    ts_raw = row.get("timestamp")
    if isinstance(ts_raw, str):
        try:
            ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
        except ValueError:
            ts = datetime.now(timezone.utc)
    elif isinstance(ts_raw, datetime):
        ts = ts_raw
    else:
        ts = datetime.now(timezone.utc)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)

    parts = []
    for part in row.get("content_parts") or []:
        ref = part.get("object_ref")
        if isinstance(ref, dict):
            details = ref.get("details")
            if details is not None and not isinstance(details, str):
                ref = dict(ref)
                ref["details"] = json.dumps(details, sort_keys=True)
        parts.append(
            {
                "mime_type": part.get("mime_type"),
                "uri": part.get("uri"),
                "object_ref": ref,
                "text": part.get("text"),
                "part_index": part.get("part_index"),
                "part_attributes": part.get("part_attributes"),
                "storage_mode": part.get("storage_mode"),
            }
        )

    def _as_json(value: Any) -> str | None:
        if value is None:
            return None
        if isinstance(value, str):
            return value
        return json.dumps(value, sort_keys=True, default=str)

    return {
        "timestamp": ts,
        "event_type": row.get("event_type"),
        "agent": row.get("agent"),
        "session_id": row.get("session_id"),
        "invocation_id": row.get("invocation_id"),
        "user_id": row.get("user_id"),
        "trace_id": row.get("trace_id"),
        "span_id": row.get("span_id"),
        "parent_span_id": row.get("parent_span_id"),
        "content": _as_json(row.get("content")),
        "content_parts": parts,
        "attributes": _as_json(row.get("attributes")),
        "latency_ms": _as_json(row.get("latency_ms")),
        "status": row.get("status"),
        "error_message": row.get("error_message"),
        "is_truncated": bool(row.get("is_truncated")),
    }


async def _write_batch_storage_api(
    *,
    project: str,
    dataset: str,
    table: str,
    location: str | None,
    rows: list[dict[str, Any]],
    retry: _RetryConfig,
    config: BQAAConfig,
    writer_label: str,
    credentials: Any = None,
) -> bool:
    """Write a batch via the Storage Write API. Returns True on success."""
    import pyarrow as pa
    from google.api_core.exceptions import (
        InternalServerError,
        ServiceUnavailable,
        TooManyRequests,
    )
    from google.cloud.bigquery_storage_v1 import types as bq_storage_types
    from google.cloud.bigquery_storage_v1.services.big_query_write.async_client import (
        BigQueryWriteAsyncClient,
    )

    schema = _arrow_schema()
    arrow_rows = [_row_to_arrow_dict(r) for r in rows]
    try:
        record_batch = pa.RecordBatch.from_pylist(arrow_rows, schema=schema)
    except Exception as exc:
        _log(config, f"DRAINER arrow_serialize_failed: {exc}")
        return False

    serialized_schema = schema.serialize().to_pybytes()
    serialized_batch = record_batch.serialize().to_pybytes()
    write_stream = (
        f"projects/{project}/datasets/{dataset}/tables/{table}/_default"
    )

    timeout = config.network_timeout_seconds
    client = BigQueryWriteAsyncClient(credentials=credentials)
    try:
        req = bq_storage_types.AppendRowsRequest(
            write_stream=write_stream,
            # Writer attribution. Recorded server-side for Google support
            # diagnostics; not surfaced as a column in
            # `INFORMATION_SCHEMA.WRITE_API_TIMELINE_BY_*`. Adoption
            # analytics use the row-level `attributes.writer` block
            # instead — see WRITER_LABEL in bqaa_tracing.py.
            trace_id=writer_label,
        )
        req.arrow_rows.writer_schema.serialized_schema = serialized_schema
        req.arrow_rows.rows.serialized_record_batch = serialized_batch

        attempt = 0
        delay = retry.initial_delay
        while True:
            try:

                async def _requests_iter():
                    yield req

                async def _perform():
                    responses = await client.append_rows(_requests_iter())
                    async for response in responses:
                        error = getattr(response, "error", None)
                        error_code = getattr(error, "code", None)
                        if error_code and error_code != 0:
                            error_message = getattr(error, "message", "Unknown error")
                            # gRPC codes: 4=DEADLINE_EXCEEDED, 13=INTERNAL, 14=UNAVAILABLE
                            if error_code in (4, 13, 14):
                                raise ServiceUnavailable(error_message)
                            raise RuntimeError(
                                f"non_retryable_storage_error: {error_message}"
                            )

                await asyncio.wait_for(_perform(), timeout=timeout)
                return True

            except (
                ServiceUnavailable,
                TooManyRequests,
                InternalServerError,
                asyncio.TimeoutError,
            ) as exc:
                attempt += 1
                if attempt > retry.max_retries:
                    _log(
                        config,
                        f"DRAINER batch_dropped_after_{retry.max_retries + 1}: {exc}",
                    )
                    return False
                sleep_for = min(delay * (1 + random.random()), retry.max_delay)
                _log(
                    config,
                    f"DRAINER retry attempt={attempt} sleep={sleep_for:.2f} err={exc}",
                )
                await asyncio.sleep(sleep_for)
                delay *= retry.multiplier
            except Exception as exc:
                _log(config, f"DRAINER unexpected_error: {exc}\n{traceback.format_exc()}")
                return False
    finally:
        # Close the gRPC channel cleanly; ignore errors during shutdown.
        try:
            transport = getattr(client, "transport", None)
            close = getattr(transport, "close", None) if transport else None
            if close is not None:
                result = close()
                if asyncio.iscoroutine(result):
                    await asyncio.wait_for(result, timeout=timeout)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# insert_rows_json fallback
# ---------------------------------------------------------------------------


def _ensure_table_exists(
    *,
    project: str,
    dataset: str,
    table: str,
    location: str | None,
    auto_create_table: bool,
    auto_create_dataset: bool,
    credentials: Any = None,
    timeout: float | None = None,
) -> Any:
    """Make sure the table exists; returns the client for the insert."""
    from google.cloud import bigquery
    from google.cloud.exceptions import NotFound

    client = bigquery.Client(project=project, location=location, credentials=credentials)
    dataset_id = f"{project}.{dataset}"
    if auto_create_dataset:
        try:
            client.get_dataset(dataset_id, timeout=timeout)
        except NotFound:
            ds = bigquery.Dataset(dataset_id)
            if location:
                ds.location = location
            client.create_dataset(ds, timeout=timeout)
    table_id = f"{project}.{dataset}.{table}"
    try:
        client.get_table(table_id, timeout=timeout)
        return client
    except NotFound:
        if not auto_create_table:
            raise
    bq_table = bigquery.Table(table_id, schema=bq_schema(bigquery))
    bq_table.time_partitioning = bigquery.TimePartitioning(
        type_=bigquery.TimePartitioningType.DAY,
        field="timestamp",
    )
    bq_table.clustering_fields = ["event_type", "agent", "user_id"]
    bq_table.labels = {"adk_schema_version": "1"}
    client.create_table(bq_table, timeout=timeout)
    return client


def _insert_id(row: dict[str, Any]) -> str:
    """The row's insertId: its content hash, so a resend carries the same one."""
    canonical = json.dumps(row, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _write_batch_insert_rows_json(
    *,
    project: str,
    dataset: str,
    table: str,
    location: str | None,
    rows: list[dict[str, Any]],
    retry: _RetryConfig,
    config: BQAAConfig,
    auto_create_table: bool,
    auto_create_dataset: bool,
    credentials: Any = None,
) -> bool:
    from google.api_core.exceptions import (
        InternalServerError,
        ServiceUnavailable,
        TooManyRequests,
    )

    timeout = config.network_timeout_seconds
    try:
        client = _call_with_timeout(
            lambda: _ensure_table_exists(
                project=project,
                dataset=dataset,
                table=table,
                location=location,
                auto_create_table=auto_create_table,
                auto_create_dataset=auto_create_dataset,
                credentials=credentials,
                timeout=timeout,
            ),
            timeout,
            "BigQuery table check",
        )
    except Exception as exc:
        _log(config, f"DRAINER ensure_table_failed: {exc}")
        return False

    table_id = f"{project}.{dataset}.{table}"
    # Left to itself the client makes up new insertIds on every call, so a
    # resend of a row that did land would write it again.
    row_ids = [_insert_id(row) for row in rows]
    attempt = 0
    delay = retry.initial_delay
    while True:
        sleep_for = min(delay * (1 + random.random()), retry.max_delay)
        try:
            try:
                errors = _call_with_timeout(
                    lambda: client.insert_rows_json(
                        table_id, rows, row_ids=row_ids, timeout=timeout
                    ),
                    timeout,
                    "BigQuery insert",
                )
            except _CallTimedOut as timed_out:
                if attempt >= retry.max_retries:
                    raise
                # The request may still land. Rather than send another copy
                # while it's in flight, spend the backoff waiting for its
                # result; if that's a failure, the retry goes out right away.
                backoff, sleep_for = sleep_for, 0.0
                errors = timed_out.result(backoff)
        except _CallTimedOut as exc:
            _log(config, f"DRAINER {exc}, not resending while it may still land")
            return False
        except (
            ServiceUnavailable,
            TooManyRequests,
            InternalServerError,
            TimeoutError,
        ) as exc:
            attempt += 1
            if attempt > retry.max_retries:
                _log(
                    config,
                    f"DRAINER batch_dropped_after_{retry.max_retries + 1}: {exc}",
                )
                return False
            time.sleep(sleep_for)
            delay *= retry.multiplier
            continue
        except Exception as exc:
            _log(config, f"DRAINER unexpected_error: {exc}\n{traceback.format_exc()}")
            return False
        if errors:
            _log(config, f"DRAINER insert_rows_json errors: {errors}")
            return False
        return True


# ---------------------------------------------------------------------------
# Drain loop
# ---------------------------------------------------------------------------


async def _drain_group_async(
    *,
    key: tuple,
    envelopes: list[_Envelope],
    retry: _RetryConfig,
    config: BQAAConfig,
    use_storage_api: bool,
) -> None:
    (
        project,
        dataset,
        table,
        location,
        writer_label,
        auto_create_table,
        auto_create_dataset,
    ) = key
    if not project or not dataset or not table:
        for env in envelopes:
            _quarantine(env.path, reason="missing-config")
        return

    rows = [env.row for env in envelopes]
    success = False
    try:
        credentials = await asyncio.to_thread(
            _default_credentials, config.network_timeout_seconds
        )
    except Exception as exc:
        _log(config, f"DRAINER auth_failed: {exc}")
    else:
        if use_storage_api:
            success = await _write_batch_storage_api(
                project=project,
                dataset=dataset,
                table=table,
                location=location,
                rows=rows,
                retry=retry,
                config=config,
                writer_label=writer_label or WRITER_LABEL,
                credentials=credentials,
            )
            if not success:
                _log(config, "DRAINER storage_api_failed, falling back to insert_rows_json")

        if not success:
            # Fallback / second attempt path. Run in a thread so the event
            # loop isn't blocked by the synchronous BQ client. Use the
            # per-envelope auto-create policy that the producer recorded in
            # the spool, not a hard-coded default that would silently
            # override their settings.
            success = await asyncio.to_thread(
                _write_batch_insert_rows_json,
                project=project,
                dataset=dataset,
                table=table,
                location=location,
                rows=rows,
                retry=retry,
                config=config,
                auto_create_table=auto_create_table,
                auto_create_dataset=auto_create_dataset,
                credentials=credentials,
            )

    if success:
        for env in envelopes:
            try:
                env.path.unlink()
            except FileNotFoundError:
                pass
    else:
        for env in envelopes:
            _quarantine(env.path, reason="write-failed")


async def _drain_once(config: BQAAConfig, use_storage_api: bool) -> int:
    spool = Path(config.spool_dir).expanduser()
    pending = _list_pending(spool)
    if not pending:
        return 0
    envelopes: list[_Envelope] = []
    for path in pending[: max(1, config.drain_batch_size)]:
        env = _read_envelope(path)
        if env is not None:
            envelopes.append(env)
    if not envelopes:
        return 0
    grouped = _group_envelopes(envelopes)
    retry = _RetryConfig()
    await asyncio.gather(
        *(
            _drain_group_async(
                key=key,
                envelopes=batch,
                retry=retry,
                config=config,
                use_storage_api=use_storage_api,
            )
            for key, batch in grouped.items()
        )
    )
    return len(envelopes)


async def _run(config: BQAAConfig) -> None:
    spool = Path(config.spool_dir).expanduser()
    spool.mkdir(parents=True, exist_ok=True)
    pidfile = spool / ".drainer.pid"
    use_storage_api = _storage_write_available()
    with _try_acquire_pidfile(pidfile) as fd:
        if fd is None:
            return
        idle = 0.0
        while idle < config.drain_idle_seconds:
            wrote = await _drain_once(config, use_storage_api=use_storage_api)
            if wrote == 0:
                await asyncio.sleep(config.drain_poll_seconds)
                idle += config.drain_poll_seconds
            else:
                idle = 0.0


def main(argv: list[str] | None = None) -> int:
    config = BQAAConfig.from_env()
    if config.dry_run:
        return 0
    try:
        asyncio.run(_run(config))
    except Exception as exc:
        _log(config, f"DRAINER fatal: {exc}\n{traceback.format_exc()}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
