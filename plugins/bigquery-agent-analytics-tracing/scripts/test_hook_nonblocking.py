#!/usr/bin/env python3
"""Latency and fail-open tests for the agent hook bridge.

The agent waits for PreToolUse before it runs a tool and for PostToolUse
before it returns the result, so a slow hook stalls the agent. These tests
run the real hooks/*.sh scripts the way the agent does (JSON payload on
stdin, then wait for exit and EOF on stdout/stderr) and run the drainer
in-process. Google client libraries are replaced by a small fake package
written to a temp dir, so no network or GCP credentials are needed.
Subprocesses that could import google run it with site disabled (see
_isolated_python), so no site customization can restore the real one, and
the fake package records each import's origin so tests can assert where
google actually came from.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import fcntl
import hashlib
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SDK_PATH = PLUGIN_ROOT / "sdk" / "python"
sys.path.insert(0, str(SDK_PATH))

import bqaa_drain  # noqa: E402
import bqaa_tracing  # noqa: E402

# The hook waits at most 1 s (BQAA_HOOK_WAIT_SECONDS); the rest is slack for
# bash and process startup on a loaded machine.
HOOK_DEADLINE_SECONDS = 3.0
# How long a stuck interpreter, ADC lookup or BigQuery request blocks.
STALL_SECONDS = 10

SESSION_ID = "session-nonblocking"
TOOL_USE_ID = "toolu_nonblocking_1"
PRE_PAYLOAD = {
    "session_id": SESSION_ID,
    "transcript_path": "",
    "cwd": "/tmp",
    "hook_event_name": "PreToolUse",
    "tool_name": "Bash",
    "tool_input": {"command": "ls -la", "description": "List files"},
    "tool_use_id": TOOL_USE_ID,
}
POST_PAYLOAD = dict(
    PRE_PAYLOAD,
    hook_event_name="PostToolUse",
    tool_response={"stdout": "ok", "stderr": "", "interrupted": False},
)
BQ_COLUMNS = {
    "timestamp",
    "event_type",
    "agent",
    "session_id",
    "invocation_id",
    "user_id",
    "trace_id",
    "span_id",
    "parent_span_id",
    "content",
    "content_parts",
    "attributes",
    "latency_ms",
    "status",
    "error_message",
    "is_truncated",
}
_CONFIG_PREFIXES = ("BQAA_", "GCP_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "BQ_DATASET", "BQ_TABLE")

# Stand-ins for the parts of google-auth / google-cloud-bigquery the plugin
# calls. Delays come from env vars so the same package works in-process and
# inside the hook subprocess (via PYTHONPATH).
FAKE_GOOGLE = {
    "google/__init__.py": '''
import os

# So tests can prove hook/drainer subprocesses imported google from here
# (the fake root) and not from a restored real installation.
_origin_log = os.environ.get("FAKE_GOOGLE_ORIGIN_LOG")
if _origin_log:
    with open(_origin_log, "a", encoding="utf-8") as _handle:
        _handle.write(__file__ + "\\n")
''',
    "google/auth/__init__.py": '''
import os
import time

CALLS = []


class _Credentials:
    def __repr__(self):
        return "<fake ADC credentials>"


CREDENTIALS = _Credentials()


def default(scopes=None, request=None, quota_project_id=None, default_scopes=None):
    CALLS.append({"scopes": scopes, "default_scopes": default_scopes})
    time.sleep(float(os.environ.get("FAKE_GOOGLE_ADC_DELAY", "0")))
    return CREDENTIALS, "adc-project"
''',
    "google/api_core/__init__.py": "",
    "google/api_core/exceptions.py": '''
class GoogleAPICallError(Exception):
    pass


class ServiceUnavailable(GoogleAPICallError):
    pass


class TooManyRequests(GoogleAPICallError):
    pass


class InternalServerError(GoogleAPICallError):
    pass
''',
    "google/cloud/__init__.py": "",
    "google/cloud/exceptions.py": '''
class NotFound(Exception):
    pass
''',
    "google/cloud/bigquery.py": '''
import json
import os
import threading
import time
import uuid

import google.auth

CALLS = []
# What the table holds. Like BigQuery, a row whose insertId was already
# seen is dropped.
TABLE = []
_SEEN_IDS = set()
_LOCK = threading.Lock()
_GENERATE_UUID = object()


def _insert_step(index):
    plan = json.loads(os.environ.get("FAKE_BIGQUERY_INSERT_PLAN") or "[]")
    if index < len(plan):
        return plan[index]
    return {"delay": float(os.environ.get("FAKE_BIGQUERY_INSERT_DELAY", "0"))}


class SchemaField:
    def __init__(self, name, field_type, mode="NULLABLE", fields=()):
        self.name, self.field_type, self.mode, self.fields = name, field_type, mode, fields


class Dataset:
    def __init__(self, dataset_ref):
        self.dataset_id, self.location = dataset_ref, None


class Table:
    def __init__(self, table_ref, schema=None):
        self.table_id, self.schema = table_ref, schema


class TimePartitioningType:
    DAY = "DAY"


class TimePartitioning:
    def __init__(self, type_=None, field=None):
        self.type_, self.field = type_, field


class Client:
    def __init__(self, project=None, credentials=None, location=None, **kwargs):
        if credentials is None:
            # The real client resolves Application Default Credentials here.
            credentials, _ = google.auth.default(
                scopes=("https://www.googleapis.com/auth/cloud-platform",)
            )
        self.project, self.credentials, self.location = project, credentials, location

    def get_dataset(self, dataset_ref, retry=None, timeout=None):
        CALLS.append(("get_dataset", dataset_ref, timeout))
        return Dataset(dataset_ref)

    def create_dataset(self, dataset, exists_ok=False, retry=None, timeout=None):
        CALLS.append(("create_dataset", dataset.dataset_id, timeout))
        return dataset

    def get_table(self, table, retry=None, timeout=None):
        CALLS.append(("get_table", table, timeout))
        return Table(table)

    def create_table(self, table, exists_ok=False, retry=None, timeout=None):
        CALLS.append(("create_table", table.table_id, timeout))
        return table

    def insert_rows_json(self, table, json_rows, row_ids=_GENERATE_UUID, skip_invalid_rows=None,
                         ignore_unknown_values=None, template_suffix=None, retry=None,
                         timeout=None):
        rows = list(json_rows)
        if row_ids is _GENERATE_UUID:
            # The real client's default: a fresh insertId per row on every call.
            row_ids = [uuid.uuid4().hex for _ in rows]
        row_ids = list(row_ids)
        with _LOCK:
            step = _insert_step(sum(1 for call in CALLS if call[0] == "insert_rows_json"))
            CALLS.append(("insert_rows_json", table, timeout, rows, row_ids))
        time.sleep(step.get("delay", 0))
        with _LOCK:
            for row_id, row in zip(row_ids, rows):
                if row_id is None or row_id not in _SEEN_IDS:
                    TABLE.append(row)
                    _SEEN_IDS.add(row_id)
        if step.get("error"):
            # The rows landed but the response didn't make it back.
            from google.api_core import exceptions
            raise getattr(exceptions, step["error"])("fake: committed, then the response failed")
        return []
''',
}


# ---------------------------------------------------------------------------
# Test utilities
# ---------------------------------------------------------------------------


@contextlib.contextmanager
def _tmpdir() -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="bqaa-hook-test-") as raw:
        yield Path(raw)


def _base_env(tmp: Path, **overrides: str | None) -> dict[str, str]:
    """Process env with the developer's BQAA config scrubbed and all plugin
    files (log, state, spool) under tmp. A None override unsets the var."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(_CONFIG_PREFIXES)}
    env.update(
        {
            "BQAA_PYTHON": sys.executable,
            "BQAA_PROJECT_ID": "test-project",
            "BQAA_DATASET": "test_dataset",
            "BQAA_USER_ID": "test-user",
            "BQAA_LOG_FILE": str(tmp / "bqaa.log"),
            "BQAA_STATE_DIR": str(tmp / "state"),
            "BQAA_SPOOL_DIR": str(tmp / "spool"),
        }
    )
    for key, value in overrides.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    return env


@contextlib.contextmanager
def _environ(env: dict[str, str]) -> Iterator[None]:
    saved = dict(os.environ)
    os.environ.clear()
    os.environ.update(env)
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(saved)


@contextlib.contextmanager
def _stdin(text: str) -> Iterator[None]:
    saved = sys.stdin
    sys.stdin = io.StringIO(text)
    try:
        yield
    finally:
        sys.stdin = saved


def _run_hook(script: str, payload: object, env: dict[str, str]) -> tuple[float, subprocess.CompletedProcess]:
    """Run hooks/<script> like the agent: payload on stdin (a str is sent
    as is), then wait for the process to exit and for EOF on stdout and
    stderr."""
    start = time.monotonic()
    proc = subprocess.run(
        ["bash", str(PLUGIN_ROOT / "hooks" / script)],
        input=payload if isinstance(payload, str) else json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    return time.monotonic() - start, proc


def _run_hook_holding_stdin(
    script: str, payload: object, env: dict[str, str], hold: float = STALL_SECONDS
) -> tuple[float, int | None, bytes, bytes]:
    """Like _run_hook, but the sender writes the payload (a str is sent as
    is) and then keeps stdin open for `hold` seconds. Returns (elapsed,
    returncode, stdout, stderr); returncode is None if the hook was still
    running."""
    proc = subprocess.Popen(
        ["bash", str(PLUGIN_ROOT / "hooks" / script)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
    )
    output: dict[str, bytes] = {}

    def drain(name: str, stream) -> None:
        output[name] = stream.read()

    readers = [
        threading.Thread(target=drain, args=(name, stream), daemon=True)
        for name, stream in (("stdout", proc.stdout), ("stderr", proc.stderr))
    ]
    start = time.monotonic()
    try:
        proc.stdin.write((payload if isinstance(payload, str) else json.dumps(payload)).encode())
        proc.stdin.flush()
        for reader in readers:
            reader.start()
        try:
            proc.wait(timeout=hold)
        except subprocess.TimeoutExpired:
            return time.monotonic() - start, None, b"", b""
        for reader in readers:
            reader.join(max(0.0, start + hold - time.monotonic()))
        return time.monotonic() - start, proc.returncode, output.get("stdout", b""), output.get("stderr", b"")
    finally:
        proc.stdin.close()
        if proc.poll() is None:
            proc.kill()
        proc.wait()


def _write_stub(path: Path, body: str) -> Path:
    """An executable to use as BQAA_PYTHON in place of the real interpreter."""
    path.write_text("#!/bin/bash\n" + body + "\n", encoding="utf-8")
    path.chmod(0o755)
    return path


@contextlib.contextmanager
def _reaping(pidfile: Path) -> Iterator[Path]:
    """Kill every pid a stub recorded in pidfile once the test is done."""
    try:
        yield pidfile
    finally:
        if pidfile.exists():
            for raw in pidfile.read_text().split():
                with contextlib.suppress(ProcessLookupError, ValueError):
                    os.kill(int(raw), signal.SIGKILL)


def _wait_for_exit(pidfile: Path, timeout: float) -> None:
    """Wait until every pid a stub recorded in pidfile has exited."""
    deadline = time.monotonic() + timeout
    pids = [int(raw) for raw in pidfile.read_text().split()] if pidfile.exists() else []
    for pid in pids:
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            raise AssertionError(f"pid {pid} still running after {timeout}s")


@contextlib.contextmanager
def _drainer_lock_held(spool: Path) -> Iterator[None]:
    """Hold the drainer pidfile lock so nothing spawns a real drainer (which
    would try to reach BigQuery) while the test inspects the spool."""
    spool.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(spool / ".drainer.pid"), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def _write_fake_google(root: Path) -> Path:
    for rel, source in FAKE_GOOGLE.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source.lstrip("\n"), encoding="utf-8")
    return root


def _isolated_python(tmp: Path) -> Path:
    """A BQAA_PYTHON that runs the interpreter with -S: site never runs, so
    no .pth files, sitecustomize or usercustomize execute and site-packages
    never lands on sys.path. Purging a preloaded google is not enough — an
    installed package's legacy *-nspkg.pth preloads the real one during site
    initialization, and a usercustomize or site.addsitedir call can restore
    it after any purge. With -S and the fake root on PYTHONPATH, the fake
    root is the only place hook/drainer subprocesses can import google from.
    """
    return _write_stub(tmp / "isolated-python", f'exec "{sys.executable}" -S "$@"')


def _assert_google_imports_from(origin_log: Path, fake_root: Path, timeout: float = 10) -> None:
    """Fail loudly unless hook/drainer subprocesses imported google from the
    fake root. The fake package logs its own __file__ there on import."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and not origin_log.exists():
        time.sleep(0.05)
    origins = origin_log.read_text(encoding="utf-8").splitlines() if origin_log.exists() else []
    assert origins, f"no subprocess imported google: {origin_log} missing or empty"
    expected = (fake_root / "google" / "__init__.py").resolve()
    for origin in origins:
        got = Path(origin).resolve()
        assert got == expected, f"a subprocess imported google from {got}, not the fake root's {expected}"


@contextlib.contextmanager
def _fake_google_importable(root: Path) -> Iterator[None]:
    def is_google(name: str) -> bool:
        return name == "google" or name.startswith("google.")

    saved_path = list(sys.path)
    saved_modules = {k: v for k, v in sys.modules.items() if is_google(k)}
    for name in saved_modules:
        del sys.modules[name]
    sys.path.insert(0, str(_write_fake_google(root)))
    try:
        yield
    finally:
        sys.path[:] = saved_path
        for name in [k for k in sys.modules if is_google(k)]:
            del sys.modules[name]
        sys.modules.update(saved_modules)


def _spool_files(spool: Path) -> list[Path]:
    return sorted(spool.glob("event-*.json")) if spool.exists() else []


def _wait_for_spool_files(spool: Path, count: int, timeout: float) -> list[Path]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        files = _spool_files(spool)
        if len(files) >= count:
            return files
        time.sleep(0.1)
    return _spool_files(spool)


def _assert_tool_starting_envelope(path: Path) -> None:
    envelope = json.loads(path.read_text(encoding="utf-8"))
    assert envelope["config"] == {
        "project_id": "test-project",
        "dataset": "test_dataset",
        "table": "agent_events",
        "location": None,
        "auto_create_table": True,
        "auto_create_dataset": False,
        "writer_label": "bqaa-coding-agent-plugin/0.1.0",
    }, envelope["config"]
    row = envelope["row"]
    assert set(row) == BQ_COLUMNS, sorted(row)
    assert row["event_type"] == "TOOL_STARTING"
    assert row["agent"] == "claude-code"
    assert row["session_id"] == SESSION_ID
    assert row["user_id"] == "test-user"
    assert row["span_id"] == hashlib.sha256(TOOL_USE_ID.encode()).hexdigest()[:16]
    assert row["status"] == "OK"
    assert row["is_truncated"] is False
    assert json.loads(row["content"]) == {
        "args": {"command": "ls -la", "description": "List files"},
        "tool": "Bash",
        "tool_origin": "LOCAL",
    }
    assert json.loads(row["attributes"]) == {
        "source": "claude_code",
        "writer": {
            "agent": "claude-code",
            "label": "bqaa-coding-agent-plugin/0.1.0",
            "mode": "spool",
            "plugin": "bqaa-coding-agent-plugin",
            "version": "0.1.0",
        },
    }


def _spool_tool_event(config: bqaa_tracing.BQAAConfig) -> Path:
    """Spool one TOOL_STARTING row the way the hook does, without a drainer."""
    with _drainer_lock_held(Path(config.spool_dir)):
        bqaa_tracing.BigQueryAgentAnalyticsLogger(config).log_tool_starting(
            tool="Bash",
            args={"command": "ls -la"},
            session_id=SESSION_ID,
            invocation_id="i" * 32,
            trace_id="t" * 32,
            span_id="s" * 16,
            parent_span_id=None,
        )
    (path,) = _spool_files(Path(config.spool_dir))
    return path


def _dead_letters(config: bqaa_tracing.BQAAConfig) -> list[Path]:
    dead = Path(config.spool_dir) / "dead-letter"
    return sorted(dead.glob("*.json")) if dead.exists() else []


def _spooled_rows(spool: Path) -> list[dict]:
    return [json.loads(path.read_text(encoding="utf-8"))["row"] for path in _spool_files(spool)]


def _queued_entries(state_dir: Path) -> list[Path]:
    queue = state_dir / "queue"
    return sorted(p for p in queue.iterdir() if p.name.isdigit()) if queue.exists() else []


def _recording_stub(tmp: Path) -> tuple[Path, Path]:
    """A BQAA_PYTHON that only writes down the run each hook starts. Returns
    (stub, record); see _recorded_runs."""
    record = tmp / "runs"
    return _write_stub(tmp / "recording-python", f"IFS=$'\\t'\nprintf '%s\\n' \"$*\" >> \"{record}\""), record


def _recorded_runs(record: Path) -> list[tuple[str, ...]]:
    """process_hook_queue's arguments for each run, in the order the hooks
    started them."""
    runs = []
    for line in record.read_text(encoding="utf-8").splitlines():
        _, flag, *args = line.split("\t")
        assert flag == "--queue", line
        runs.append(tuple(args))
    return runs


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _append_transcript(path: Path, *items: dict) -> None:
    with path.open("a", encoding="utf-8") as handle:
        for item in items:
            handle.write(json.dumps(item) + "\n")


def _insert_once(config: bqaa_tracing.BQAAConfig, retry: bqaa_drain._RetryConfig) -> tuple[Path, float]:
    """Spool one row and send it down the insert_rows_json path."""
    path = _spool_tool_event(config)
    ((key, batch),) = bqaa_drain._group_envelopes([bqaa_drain._read_envelope(path)]).items()
    start = time.monotonic()
    asyncio.run(
        bqaa_drain._drain_group_async(
            key=key, envelopes=batch, retry=retry, config=config, use_storage_api=False
        )
    )
    return path, time.monotonic() - start


def _insert_calls(bigquery) -> list[tuple]:
    return [call for call in bigquery.CALLS if call[0] == "insert_rows_json"]


# ---------------------------------------------------------------------------
# Hook latency: the agent must never wait on Python, auth or BigQuery
# ---------------------------------------------------------------------------


def test_hook_returns_fast_when_python_cannot_start() -> None:
    # 2026-10-11: macOS syspolicyd hung, so every launch of the python.org
    # interpreter blocked until launchd replaced the daemon (up to ~20 min),
    # and the agent waited on PreToolUse/PostToolUse the whole time. A stub
    # that never gets going stands in for the blocked interpreter.
    with _tmpdir() as tmp, _reaping(tmp / "pids") as pids:
        stub = _write_stub(tmp / "stalled-python", f'echo $$ >> "{pids}"\nexec sleep {STALL_SECONDS}')
        for script, payload in (("pre_tool_use.sh", PRE_PAYLOAD), ("post_tool_use.sh", POST_PAYLOAD)):
            elapsed, proc = _run_hook(script, payload, _base_env(tmp, BQAA_PYTHON=str(stub)))
            assert elapsed < HOOK_DEADLINE_SECONDS, f"{script} held the agent for {elapsed:.1f}s"
            assert proc.returncode == 0, proc
            assert proc.stdout == "" and proc.stderr == "", proc


def test_hook_returns_fast_when_bigquery_auth_hangs() -> None:
    # With BQAA_DIRECT_WRITE=true the hook process itself talks to BigQuery;
    # building the client runs an ADC lookup that can hang (metadata server
    # probe, token refresh) and had no timeout.
    with _tmpdir() as tmp:
        fake = _write_fake_google(tmp / "fake")
        env = _base_env(
            tmp,
            BQAA_PYTHON=str(_isolated_python(tmp)),
            BQAA_DIRECT_WRITE="true",
            BQAA_NETWORK_TIMEOUT_SECONDS="1",
            FAKE_GOOGLE_ADC_DELAY=str(STALL_SECONDS),
            FAKE_GOOGLE_ORIGIN_LOG=str(tmp / "origins.log"),
            PYTHONPATH=str(fake),
        )
        elapsed, proc = _run_hook("pre_tool_use.sh", PRE_PAYLOAD, env)
        assert elapsed < HOOK_DEADLINE_SECONDS, f"hook held the agent for {elapsed:.1f}s"
        assert proc.returncode == 0, proc
        assert proc.stdout == "" and proc.stderr == "", proc
        _assert_google_imports_from(tmp / "origins.log", fake)


def test_hook_returns_when_agent_keeps_stdin_open() -> None:
    # 2026-10-11 review: the hook read stdin to EOF before its bounded wait
    # began, so a sender that wrote the payload but never closed the pipe
    # held the hook until the host's timeout killed it. Reading the payload
    # counts against the same deadline, and what was sent still gets queued.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"):
        elapsed, returncode, stdout, stderr = _run_hook_holding_stdin("pre_tool_use.sh", PRE_PAYLOAD, _base_env(tmp))
        assert returncode is not None and elapsed < HOOK_DEADLINE_SECONDS, f"hook held the agent for {elapsed:.1f}s"
        assert returncode == 0 and stdout == b"" and stderr == b"", (returncode, stdout, stderr)
        files = _wait_for_spool_files(tmp / "spool", count=1, timeout=10)
        assert len(files) == 1, files
        _assert_tool_starting_envelope(files[0])


def test_cut_off_payload_is_dropped_not_made_up() -> None:
    # A sender that stops partway and never closes stdin leaves the hook
    # with half a payload at the deadline. That's logged and dropped rather
    # than applied as an empty payload, which would invent an event.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"):
        partial = json.dumps(PRE_PAYLOAD)[:80]
        elapsed, returncode, stdout, stderr = _run_hook_holding_stdin("pre_tool_use.sh", partial, _base_env(tmp))
        assert returncode is not None and elapsed < HOOK_DEADLINE_SECONDS, f"hook held the agent for {elapsed:.1f}s"
        assert returncode == 0 and stdout == b"" and stderr == b"", (returncode, stdout, stderr)
        log = tmp / "bqaa.log"

        def logged() -> str:
            return log.read_text(encoding="utf-8") if log.exists() else ""

        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and "payload can't be parsed" not in logged():
            time.sleep(0.1)
        assert "PreToolUse payload can't be parsed: JSONDecodeError" in logged(), logged()
        assert _spool_files(tmp / "spool") == []
        assert _queued_entries(tmp / "state") == []


def test_direct_write_gives_up_on_hung_auth() -> None:
    # Bounding the hook isn't enough on its own: the Python process must not
    # sit on a hung auth call either, or stuck writers pile up.
    with _tmpdir() as tmp, _fake_google_importable(tmp / "fake"):
        env = _base_env(
            tmp,
            BQAA_DIRECT_WRITE="true",
            BQAA_NETWORK_TIMEOUT_SECONDS="0.5",
            FAKE_GOOGLE_ADC_DELAY=str(STALL_SECONDS),
        )
        with _environ(env), _stdin(json.dumps(PRE_PAYLOAD)):
            start = time.monotonic()
            rc = bqaa_tracing.main(["PreToolUse"])
            elapsed = time.monotonic() - start
        assert rc == 0
        assert elapsed < 3.0, f"direct write waited {elapsed:.1f}s on a hung ADC lookup"
        assert "timed out" in (tmp / "bqaa.log").read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Fail-open: errors never reach the agent
# ---------------------------------------------------------------------------


def test_hook_fails_open_when_python_fails() -> None:
    # A PreToolUse hook that exits 2 makes the agent block the tool call,
    # and any other non-zero exit or stderr output surfaces as a hook error.
    with _tmpdir() as tmp:
        cases = {
            "crash with exit 2": str(_write_stub(tmp / "crashing-python", 'echo "Traceback: boom" >&2\nexit 2')),
            "interpreter missing": str(tmp / "no-such-python"),
        }
        for label, python_bin in cases.items():
            elapsed, proc = _run_hook("pre_tool_use.sh", PRE_PAYLOAD, _base_env(tmp, BQAA_PYTHON=python_bin))
            assert proc.returncode == 0, (label, proc)
            assert proc.stdout == "" and proc.stderr == "", (label, proc)
            assert elapsed < HOOK_DEADLINE_SECONDS, (label, elapsed)


def test_main_fails_open_on_bad_input() -> None:
    cases = {
        # int("lots") used to raise from BQAAConfig.from_env(), outside
        # main()'s try block, so the hook died with a traceback.
        "malformed numeric env var": ({"BQAA_MAX_CONTENT_LENGTH": "lots"}, PRE_PAYLOAD),
        "payload is not an object": ({}, ["not", "a", "dict"]),
    }
    for label, (overrides, payload) in cases.items():
        with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"):
            with _environ(_base_env(tmp, **overrides)), _stdin(json.dumps(payload)):
                try:
                    rc = bqaa_tracing.main(["PreToolUse"])
                except Exception as exc:  # noqa: BLE001 - the point of the test
                    raise AssertionError(f"{label}: main() raised {exc!r}") from exc
            assert rc == 0, label
            assert "ERROR hook=PreToolUse" in (tmp / "bqaa.log").read_text(encoding="utf-8"), label


# ---------------------------------------------------------------------------
# Events still get enqueued and sent, unchanged
# ---------------------------------------------------------------------------


def test_hook_enqueues_tool_event_before_returning() -> None:
    # When Python is healthy the hook waits for it, so PreToolUse state is
    # in place before the tool runs and PostToolUse can pair with it.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"):
        _, proc = _run_hook("pre_tool_use.sh", PRE_PAYLOAD, _base_env(tmp, BQAA_HOOK_WAIT_SECONDS="5"))
        assert proc.returncode == 0, proc
        files = _spool_files(tmp / "spool")
        assert len(files) == 1, files
        _assert_tool_starting_envelope(files[0])


def test_healthy_hook_does_not_sit_out_the_wait_and_drainer_sends() -> None:
    # The drainer outlives the hook; if it (or anything else) held the
    # hook's pipe open, every tool call would pay the full wait.
    with _tmpdir() as tmp:
        fake = _write_fake_google(tmp / "fake")
        env = _base_env(
            tmp,
            BQAA_PYTHON=str(_isolated_python(tmp)),
            PYTHONPATH=str(fake),
            FAKE_GOOGLE_ORIGIN_LOG=str(tmp / "origins.log"),
            BQAA_DRAIN_IDLE_SECONDS="1",
        )
        elapsed, proc = _run_hook("pre_tool_use.sh", PRE_PAYLOAD, env)
        assert proc.returncode == 0, proc
        assert elapsed < 0.9, f"healthy hook took {elapsed:.2f}s"
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and _spool_files(tmp / "spool"):
            time.sleep(0.1)
        assert _spool_files(tmp / "spool") == [], "drainer never sent the spooled event"
        assert not (tmp / "spool" / "dead-letter").exists()
        _assert_google_imports_from(tmp / "origins.log", fake)


def test_usercustomize_cannot_restore_a_real_google() -> None:
    # 2026-10-12 review: the fake root used to rely on a sitecustomize purge
    # of the google an nspkg .pth preloads, but usercustomize runs after
    # sitecustomize, and reprocessing the .pth files (site.addsitedir) puts
    # the real google back in sys.modules ahead of the fake on PYTHONPATH —
    # hook/drainer subprocesses then called the real BigQuery. They now run
    # with -S, so none of that executes. This usercustomize plants an
    # imposter google the same way the restore would: if site ever runs in
    # those subprocesses again, the origin assertion names the imposter, and
    # its clientless bigquery module dead-letters the event.
    with _tmpdir() as tmp:
        fake = _write_fake_google(tmp / "fake")
        (fake / "usercustomize.py").write_text(
            "import os\n"
            "import sys\n"
            "from types import ModuleType\n"
            "\n"
            "def _imposter(name):\n"
            "    module = ModuleType(name)\n"
            "    module.__file__ = '/imposter-google/' + name.replace('.', '/') + '.py'\n"
            "    log = os.environ.get('FAKE_GOOGLE_ORIGIN_LOG')\n"
            "    if log and name == 'google':\n"
            "        with open(log, 'a', encoding='utf-8') as handle:\n"
            "            handle.write(module.__file__ + '\\n')\n"
            "    return module\n"
            "\n"
            "for _name in ('google', 'google.auth', 'google.api_core', 'google.api_core.exceptions',\n"
            "              'google.cloud', 'google.cloud.bigquery', 'google.cloud.exceptions'):\n"
            "    sys.modules[_name] = _imposter(_name)\n",
            encoding="utf-8",
        )
        env = _base_env(
            tmp,
            BQAA_PYTHON=str(_isolated_python(tmp)),
            PYTHONPATH=str(fake),
            FAKE_GOOGLE_ORIGIN_LOG=str(tmp / "origins.log"),
            BQAA_DRAIN_IDLE_SECONDS="1",
        )
        elapsed, proc = _run_hook("pre_tool_use.sh", PRE_PAYLOAD, env)
        assert proc.returncode == 0, proc
        assert elapsed < 0.9, f"healthy hook took {elapsed:.2f}s"
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and _spool_files(tmp / "spool"):
            time.sleep(0.1)
        assert _spool_files(tmp / "spool") == [], "drainer never sent the spooled event"
        assert not (tmp / "spool" / "dead-letter").exists()
        _assert_google_imports_from(tmp / "origins.log", fake)


def test_stalled_hook_still_enqueues_event_after_returning() -> None:
    # When Python starts late the hook returns without it; the event must
    # still land once the interpreter gets going.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"):
        slow = _write_stub(tmp / "slow-python", f'sleep 5\nexec "{sys.executable}" "$@"')
        elapsed, proc = _run_hook("pre_tool_use.sh", PRE_PAYLOAD, _base_env(tmp, BQAA_PYTHON=str(slow)))
        assert elapsed < HOOK_DEADLINE_SECONDS, f"hook held the agent for {elapsed:.1f}s"
        assert proc.returncode == 0, proc
        files = _wait_for_spool_files(tmp / "spool", count=1, timeout=20)
        assert len(files) == 1, files
        _assert_tool_starting_envelope(files[0])


def test_unconfigured_hook_does_not_start_python() -> None:
    # Without a project and dataset nothing can be written (dry-run aside),
    # yet every hook still launched Python and logged a traceback.
    cases = [
        ("no project, no dataset", {"BQAA_PROJECT_ID": None, "BQAA_DATASET": None}, False),
        ("dataset only", {"BQAA_PROJECT_ID": None}, False),
        ("project only", {"BQAA_DATASET": None}, False),
        (
            "alias vars",
            {"BQAA_PROJECT_ID": None, "BQAA_DATASET": None, "GOOGLE_CLOUD_PROJECT": "p", "BQ_DATASET": "d"},
            True,
        ),
        ("dry run needs no project", {"BQAA_PROJECT_ID": None, "BQAA_DATASET": None, "BQAA_DRY_RUN": "True"}, True),
    ]
    for label, overrides, expect_python in cases:
        with _tmpdir() as tmp:
            marker = tmp / "python-started"
            stub = _write_stub(tmp / "marker-python", f'touch "{marker}"')
            _, proc = _run_hook("post_tool_use.sh", POST_PAYLOAD, _base_env(tmp, BQAA_PYTHON=str(stub), **overrides))
            assert proc.returncode == 0, (label, proc)
            deadline = time.monotonic() + (5 if expect_python else 0.5)
            while time.monotonic() < deadline and not marker.exists():
                time.sleep(0.05)
            assert marker.exists() == expect_python, label


# ---------------------------------------------------------------------------
# Order: an event whose Python starts late still lands before newer ones
# ---------------------------------------------------------------------------


def test_late_hooks_still_apply_in_order() -> None:
    # 2026-10-11 review: each hook's own Python applied its event, so when
    # UserPromptSubmit's started late, Stop's ran first, found no open trace
    # and dropped the reply; a late PreToolUse likewise landed after its
    # PostToolUse. Here the first two hooks' interpreters stall for 4 s
    # while the last two start at once.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"), _reaping(tmp / "pids") as pids:
        slow = _write_stub(tmp / "slow-python", f'echo $$ >> "{pids}"\nsleep 4\nexec "{sys.executable}" "$@"')
        slow_env, fast_env = _base_env(tmp, BQAA_PYTHON=str(slow)), _base_env(tmp)
        transcript = tmp / "transcript.jsonl"
        turn = {"session_id": SESSION_ID, "transcript_path": str(transcript), "cwd": "/tmp"}
        _append_transcript(
            transcript, {"type": "user", "message": {"role": "user", "content": "list files"}, "timestamp": _iso_now()}
        )
        _run_hook("user_prompt_submit.sh", dict(turn, hook_event_name="UserPromptSubmit", prompt="list files"), slow_env)
        # The reply is in the transcript before the prompt's event is applied.
        time.sleep(0.1)
        _append_transcript(
            transcript,
            {
                "type": "assistant",
                "message": {
                    "model": "claude-test",
                    "content": [{"type": "text", "text": "Listing the files."}],
                    "usage": {"input_tokens": 7, "output_tokens": 3},
                },
                "timestamp": _iso_now(),
            },
            {"type": "last-prompt", "lastPrompt": "list files"},  # Claude Code writes some lines unstamped
        )
        _run_hook("pre_tool_use.sh", PRE_PAYLOAD, slow_env)
        time.sleep(1.0)  # the tool runs
        _run_hook("post_tool_use.sh", POST_PAYLOAD, fast_env)
        _run_hook("stop.sh", dict(turn, hook_event_name="Stop", stop_hook_active=False), fast_env)
        # The stalled interpreters get going too; they must not add or redo anything.
        _wait_for_exit(pids, timeout=20)

        rows = {row["event_type"]: row for row in _spooled_rows(tmp / "spool")}
        assert len(_spool_files(tmp / "spool")) == 4, sorted(rows)
        assert sorted(rows) == ["LLM_REQUEST", "LLM_RESPONSE", "TOOL_COMPLETED", "TOOL_STARTING"], sorted(rows)
        request, started, completed, response = (
            rows[name] for name in ("LLM_REQUEST", "TOOL_STARTING", "TOOL_COMPLETED", "LLM_RESPONSE")
        )
        # Stamped when each hook ran, not when its event was applied.
        assert request["timestamp"] < started["timestamp"] < completed["timestamp"] < response["timestamp"], rows
        assert {row["trace_id"] for row in rows.values()} == {request["trace_id"]}, rows
        assert started["parent_span_id"] == completed["parent_span_id"] == request["span_id"] == response["span_id"]
        assert started["span_id"] == completed["span_id"]
        assert json.loads(response["content"]) == {"response": "Listing the files."}, response["content"]
        assert json.loads(response["attributes"])["model"] == "claude-test"
        assert json.loads(completed["latency_ms"])["total_ms"] >= 900, completed["latency_ms"]
        assert list((tmp / "state").glob("tool_*.json")) == []
        assert _queued_entries(tmp / "state") == []


def test_late_turns_keep_their_own_replies() -> None:
    # Two whole turns go by before any interpreter gets going. Each Stop is
    # applied after the next turn's reply is in the transcript too, yet
    # reports only its own.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"), _reaping(tmp / "pids") as pids:
        slow = _write_stub(tmp / "slow-python", f'echo $$ >> "{pids}"\nsleep 4\nexec "{sys.executable}" "$@"')
        slow_env = _base_env(tmp, BQAA_PYTHON=str(slow), BQAA_HOOK_WAIT_SECONDS="0")
        transcript = tmp / "transcript.jsonl"
        turn = {"session_id": SESSION_ID, "transcript_path": str(transcript), "cwd": "/tmp"}
        for n, env in ((1, slow_env), (2, _base_env(tmp))):
            _append_transcript(
                transcript, {"type": "user", "message": {"role": "user", "content": f"q{n}"}, "timestamp": _iso_now()}
            )
            _run_hook("user_prompt_submit.sh", dict(turn, hook_event_name="UserPromptSubmit", prompt=f"q{n}"), slow_env)
            time.sleep(0.05)
            _append_transcript(
                transcript,
                {
                    "type": "assistant",
                    "message": {"model": "claude-test", "content": [{"type": "text", "text": f"reply {n}"}]},
                    "timestamp": _iso_now(),
                },
            )
            time.sleep(0.05)
            # Turn 1's Stop stalls too; turn 2's runs at once and applies everything.
            _run_hook("stop.sh", dict(turn, hook_event_name="Stop", stop_hook_active=False), env)
        _wait_for_exit(pids, timeout=20)

        rows = sorted(_spooled_rows(tmp / "spool"), key=lambda row: row["timestamp"])
        assert [row["event_type"] for row in rows] == ["LLM_REQUEST", "LLM_RESPONSE"] * 2, rows
        assert [json.loads(row["content"]) for row in rows[1::2]] == [{"response": "reply 1"}, {"response": "reply 2"}]
        assert rows[0]["trace_id"] == rows[1]["trace_id"] != rows[2]["trace_id"] == rows[3]["trace_id"]


def test_late_hooks_group_by_top_level_session_id() -> None:
    # 2026-10-12 review: the hook took the session from the first 1,024
    # characters of the payload. A long prompt ahead of session_id filed the
    # prompt's event on its own, so when its interpreter stalled, Stop's run
    # didn't apply it first and the reply was dropped. A session_id inside
    # tool_input, ahead of the top-level one, misfiled a PreToolUse the same
    # way. Here both put the top-level session_id last.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"), _reaping(tmp / "pids") as pids:
        slow = _write_stub(tmp / "slow-python", f'echo $$ >> "{pids}"\nsleep 4\nexec "{sys.executable}" "$@"')
        slow_env, fast_env = _base_env(tmp, BQAA_PYTHON=str(slow)), _base_env(tmp)
        transcript = tmp / "transcript.jsonl"
        prompt = "list the files, " + "and then some more of them, " * 100
        assert len(prompt) > 2048
        _append_transcript(
            transcript, {"type": "user", "message": {"role": "user", "content": prompt}, "timestamp": _iso_now()}
        )
        _run_hook(
            "user_prompt_submit.sh",
            {
                "prompt": prompt,
                "hook_event_name": "UserPromptSubmit",
                "cwd": "/tmp",
                "transcript_path": str(transcript),
                "session_id": SESSION_ID,
            },
            slow_env,
        )
        time.sleep(0.1)
        _append_transcript(
            transcript,
            {
                "type": "assistant",
                "message": {"model": "claude-test", "content": [{"type": "text", "text": "Listing the files."}]},
                "timestamp": _iso_now(),
            },
        )
        tool_input = {"session_id": "another-session", "command": "ls -la", "description": "List files"}
        pre = {key: PRE_PAYLOAD[key] for key in reversed(PRE_PAYLOAD)}  # session_id last
        _run_hook("pre_tool_use.sh", dict(pre, tool_input=tool_input), slow_env)
        time.sleep(1.0)  # the tool runs
        _run_hook("post_tool_use.sh", dict(POST_PAYLOAD, tool_input=tool_input), fast_env)
        _run_hook(
            "stop.sh",
            {"session_id": SESSION_ID, "transcript_path": str(transcript), "hook_event_name": "Stop"},
            fast_env,
        )
        _wait_for_exit(pids, timeout=20)

        rows = {row["event_type"]: row for row in _spooled_rows(tmp / "spool")}
        assert len(_spool_files(tmp / "spool")) == 4, sorted(rows)
        assert sorted(rows) == ["LLM_REQUEST", "LLM_RESPONSE", "TOOL_COMPLETED", "TOOL_STARTING"], sorted(rows)
        request, started, completed, response = (
            rows[name] for name in ("LLM_REQUEST", "TOOL_STARTING", "TOOL_COMPLETED", "LLM_RESPONSE")
        )
        assert request["timestamp"] < started["timestamp"] < completed["timestamp"] < response["timestamp"], rows
        assert {row["session_id"] for row in rows.values()} == {SESSION_ID}, rows
        assert {row["trace_id"] for row in rows.values()} == {request["trace_id"]}, rows
        assert json.loads(request["content"])["prompt"] == [{"role": "user", "content": prompt}]
        assert json.loads(response["content"]) == {"response": "Listing the files."}, response["content"]
        assert json.loads(started["content"])["args"] == tool_input, started["content"]
        assert json.loads(completed["latency_ms"])["total_ms"] >= 900, completed["latency_ms"]
        assert list((tmp / "state").glob("tool_*.json")) == []
        assert _queued_entries(tmp / "state") == []


def test_numbers_freed_during_a_run_do_not_reorder_its_session() -> None:
    # 2026-10-12 review: a run lists the queue, then reads the entries one
    # by one. When another session's run removed its events in between, the
    # next hooks got their numbers again: session a's UserPromptSubmit one
    # the run had already passed, its Stop one the run hadn't reached yet.
    # The run applied Stop with no open trace, which dropped the reply, and
    # UserPromptSubmit was applied after it. Here the hooks only queue their
    # events, and the runs go in-process so they interleave just that way.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"):
        stub, record = _recording_stub(tmp)
        hook_env = _base_env(tmp, BQAA_PYTHON=str(stub))
        queue = tmp / "state" / "queue"
        # So one run can go while the other holds its session's lock.
        assert bqaa_tracing._queue_lock(queue, "session-a") != bqaa_tracing._queue_lock(queue, "session-b")
        transcript = tmp / "transcript.jsonl"
        turn = {"session_id": "session-a", "transcript_path": str(transcript), "cwd": "/tmp"}
        _run_hook("session_start.sh", dict(turn, hook_event_name="SessionStart", source="startup"), hook_env)
        _run_hook("pre_tool_use.sh", dict(PRE_PAYLOAD, session_id="session-b"), hook_env)
        _run_hook("post_tool_use.sh", dict(POST_PAYLOAD, session_id="session-b"), hook_env)
        start_run, b_run, _ = _recorded_runs(record)
        read = bqaa_tracing._read_queued_event
        interleaved = []

        def read_then_interleave(path: Path):
            event = read(path)
            if path.name == b_run[1] and not interleaved:
                interleaved.append(path.name)
                # Session b's run applies its events and removes them...
                assert bqaa_tracing.process_hook_queue(*b_run) == 2
                # ...and session a's next turn goes by.
                _append_transcript(
                    transcript,
                    {"type": "user", "message": {"role": "user", "content": "list files"}, "timestamp": _iso_now()},
                )
                _run_hook(
                    "user_prompt_submit.sh", dict(turn, hook_event_name="UserPromptSubmit", prompt="list files"), hook_env
                )
                time.sleep(0.05)
                _append_transcript(
                    transcript,
                    {
                        "type": "assistant",
                        "message": {"model": "claude-test", "content": [{"type": "text", "text": "Listing the files."}]},
                        "timestamp": _iso_now(),
                    },
                )
                time.sleep(0.05)
                _run_hook("stop.sh", dict(turn, hook_event_name="Stop", stop_hook_active=False), hook_env)
            return event

        with _environ(_base_env(tmp)):
            # SessionStart's run has listed the queue and just read session
            # b's first event when all that happens.
            bqaa_tracing._read_queued_event = read_then_interleave
            try:
                bqaa_tracing.process_hook_queue(*start_run)
            finally:
                bqaa_tracing._read_queued_event = read
            assert interleaved, "the run never read session b's event"
            for run in _recorded_runs(record):
                bqaa_tracing.process_hook_queue(*run)

        rows = sorted(_spooled_rows(tmp / "spool"), key=lambda row: row["timestamp"])
        rows_a = [row for row in rows if row["session_id"] == "session-a"]
        types_a = [row["event_type"] for row in rows_a]
        assert types_a == ["LLM_REQUEST", "LLM_RESPONSE"], types_a
        assert rows_a[0]["trace_id"] == rows_a[1]["trace_id"], rows_a
        assert json.loads(rows_a[1]["content"]) == {"response": "Listing the files."}, rows_a[1]["content"]
        rows_b = [row["event_type"] for row in rows if row["session_id"] == "session-b"]
        assert rows_b == ["TOOL_STARTING", "TOOL_COMPLETED"], rows_b
        assert _queued_entries(tmp / "state") == []


def test_parallel_hooks_each_queue_their_event() -> None:
    # Parallel tool calls fire their PreToolUse hooks at the same time; each
    # event needs its own place in the queue.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"):
        env = _base_env(tmp, BQAA_HOOK_WAIT_SECONDS="5")
        tool_use_ids = [f"toolu_parallel_{n}" for n in range(8)]
        with concurrent.futures.ThreadPoolExecutor(len(tool_use_ids)) as pool:
            runs = list(
                pool.map(
                    lambda tool_use_id: _run_hook("pre_tool_use.sh", dict(PRE_PAYLOAD, tool_use_id=tool_use_id), env),
                    tool_use_ids,
                )
            )
        assert all(proc.returncode == 0 and proc.stdout == proc.stderr == "" for _, proc in runs), runs
        _wait_for_spool_files(tmp / "spool", count=len(tool_use_ids), timeout=10)
        spans = sorted(row["span_id"] for row in _spooled_rows(tmp / "spool"))
        assert spans == sorted(hashlib.sha256(t.encode()).hexdigest()[:16] for t in tool_use_ids), spans
        assert _queued_entries(tmp / "state") == []


def test_hook_does_not_take_a_number_used_up_since_its_listing() -> None:
    # Between a hook's listing of the queue and its taking the next number,
    # a hook that started later can queue an event under that number, and a
    # run apply and remove it. The number is in queue/last by then, and the
    # first hook mustn't take it again. A FIFO in place of queue/last plays
    # that out: the hook's first read finds no number used, the one after it
    # has taken number 1 finds 1.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"):
        stub, record = _recording_stub(tmp)
        queue = tmp / "state" / "queue"
        queue.mkdir(mode=0o700, parents=True)
        last = queue / "last"
        os.mkfifo(last)

        def serve() -> None:
            for value in ("", "000000000001", "000000000001"):
                with last.open("w", encoding="ascii") as fifo:  # once the hook opens it
                    fifo.write(value + "\n")

        server = threading.Thread(target=serve, daemon=True)
        server.start()
        try:
            _, proc = _run_hook("pre_tool_use.sh", PRE_PAYLOAD, _base_env(tmp, BQAA_PYTHON=str(stub)))
        finally:
            # Unblock the server if the hook read the FIFO fewer times.
            while server.is_alive():
                fd = os.open(last, os.O_RDONLY | os.O_NONBLOCK)
                server.join(0.2)
                os.close(fd)
        assert proc.returncode == 0, proc
        ((_, entry, _),) = _recorded_runs(record)
        assert entry == "000000000002", entry
        assert [path.name for path in _queued_entries(tmp / "state")] == [entry]


def test_queue_applies_only_its_own_sessions_events() -> None:
    # Sessions can run with different settings (dataset, agent name, ...),
    # so an adapter run applies only its own session's events.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"):
        stub, record = _recording_stub(tmp)
        env = _base_env(tmp, BQAA_PYTHON=str(stub))
        for session_id in ("session-a", "session-b"):
            _run_hook("pre_tool_use.sh", dict(PRE_PAYLOAD, session_id=session_id), env)
        assert len(_queued_entries(tmp / "state")) == 2
        run_a, run_b = _recorded_runs(record)
        with _environ(_base_env(tmp)):
            assert bqaa_tracing.process_hook_queue(*run_a) == 1
            assert [row["session_id"] for row in _spooled_rows(tmp / "spool")] == ["session-a"]
            assert len(_queued_entries(tmp / "state")) == 1
            assert bqaa_tracing.process_hook_queue(*run_b) == 1
        assert sorted(row["session_id"] for row in _spooled_rows(tmp / "spool")) == ["session-a", "session-b"]
        assert _queued_entries(tmp / "state") == []


def test_queue_numbers_are_never_handed_out_twice() -> None:
    # Runs read the queue in number order, so a number whose event is gone
    # (applied, or purged by cleanup) stays used: the next hook gets a
    # higher one. Numbers start over only if the queue dir is removed; the
    # token on an event's last line then tells a late run that the newer
    # event under its number isn't its own.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"):
        stub, record = _recording_stub(tmp)
        env = _base_env(tmp, BQAA_PYTHON=str(stub))
        state = tmp / "state"

        def queue_event(session_id: str) -> tuple[str, ...]:
            _run_hook("pre_tool_use.sh", dict(PRE_PAYLOAD, session_id=session_id), env)
            return _recorded_runs(record)[-1]

        with _environ(_base_env(tmp)):
            late_run = queue_event("session-a")
            assert bqaa_tracing.process_hook_queue(*late_run) == 1  # as another run of session-a would
            purged_run = queue_event("session-b")
            long_ago = time.time() - 48 * 3600
            os.utime(state / "queue" / purged_run[1], (long_ago, long_ago))
            assert bqaa_tracing.cleanup_stale_state(state, 24) == 1
            newer_run = queue_event("session-c")
            numbers = [run[1] for run in (late_run, purged_run, newer_run)]
            assert numbers == ["000000000001", "000000000002", "000000000003"], numbers
            assert bqaa_tracing.process_hook_queue(*late_run) == 0

            shutil.rmtree(state / "queue")
            restarted_run = queue_event("session-d")
            assert restarted_run[1] == late_run[1] and restarted_run[2] != late_run[2], (late_run, restarted_run)
            assert bqaa_tracing.process_hook_queue(*late_run) == 0
        assert [row["session_id"] for row in _spooled_rows(tmp / "spool")] == ["session-a"]
        assert [path.name for path in _queued_entries(state)] == [restarted_run[1]]


def test_cleanup_leaves_queue_locks_in_place() -> None:
    # 2026-10-12 review: cleanup_stale_state deleted queue lock files past
    # the TTL. A run could lock one just as it was unlinked; the next run
    # then made and locked a new file at the same path, and both applied the
    # session's events at once. Lock files now stay put.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"):
        _run_hook("pre_tool_use.sh", PRE_PAYLOAD, _base_env(tmp, BQAA_HOOK_WAIT_SECONDS="5"))
        (lock,) = (tmp / "state" / "queue").glob(".lock-*")
        # A run of the session holds the lock, which by age is past the TTL.
        fd = os.open(lock, os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            long_ago = time.time() - 48 * 3600
            os.utime(lock, (long_ago, long_ago))
            bqaa_tracing.cleanup_stale_state(tmp / "state", 24)
            assert lock.exists() and lock.stat().st_ino == os.fstat(fd).st_ino
            # So the session's next run waits for the one holding it.
            _run_hook("post_tool_use.sh", POST_PAYLOAD, _base_env(tmp))
            time.sleep(1.0)
            assert [row["event_type"] for row in _spooled_rows(tmp / "spool")] == ["TOOL_STARTING"]
        finally:
            os.close(fd)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and _queued_entries(tmp / "state"):
            time.sleep(0.1)
        assert _queued_entries(tmp / "state") == []
        assert [row["event_type"] for row in _spooled_rows(tmp / "spool")] == ["TOOL_STARTING", "TOOL_COMPLETED"]


def test_saturated_queue_of_expired_entries_is_pruned() -> None:
    # 2026-10-12 review: at QUEUE_MAX (10,000) queued events the hook exited
    # before starting Python, so when adapter runs never got going and every
    # entry sat past the TTL, the TTL cleanup that frees the queue never ran
    # and no event could ever be queued again. The hook now gives Python one
    # bounded shot at the cleanup before dropping the event.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"):
        queue = tmp / "state" / "queue"
        queue.mkdir(parents=True)
        long_ago = time.time() - 48 * 3600
        payload = json.dumps(PRE_PAYLOAD)
        for n in range(1, 10_001):
            # Unfinished entries (no end line): nothing can apply them, and
            # cleanup prunes them by age.
            path = queue / f"{n:012d}"
            path.write_text(f"PreToolUse\n{payload}\n", encoding="utf-8")
            os.utime(path, (long_ago, long_ago))
        elapsed, proc = _run_hook("pre_tool_use.sh", PRE_PAYLOAD, _base_env(tmp))
        assert proc.returncode == 0 and proc.stdout == "" and proc.stderr == "", proc
        assert elapsed < HOOK_DEADLINE_SECONDS, f"hook held the agent for {elapsed:.1f}s"
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and _queued_entries(tmp / "state"):
            time.sleep(0.2)
        assert _queued_entries(tmp / "state") == [], "expired entries were never pruned"
        # The pruned numbers stay used: no run is left to come across a newer
        # event under a number it has already passed.
        used = int((queue / "last").read_text(encoding="ascii"))
        assert used >= 10_000, used
        # And the queue takes events again, numbered above the pruned ones.
        stub, record = _recording_stub(tmp)
        _, proc = _run_hook("pre_tool_use.sh", PRE_PAYLOAD, _base_env(tmp, BQAA_PYTHON=str(stub)))
        assert proc.returncode == 0, proc
        ((_, entry, _),) = _recorded_runs(record)
        assert int(entry) > 10_000, entry
        assert [path.name for path in _queued_entries(tmp / "state")] == [entry]


# ---------------------------------------------------------------------------
# A payload Python can't parse holds up nothing else
# ---------------------------------------------------------------------------


def _deeply_nested(payload: dict, key: str) -> str:
    """payload as JSON, with key's value nested deeper than json can parse."""
    return json.dumps(dict(payload, **{key: "NESTED"})).replace('"NESTED"', "[" * 100_000 + "]" * 100_000)


def _with_huge_integer(payload: dict, key: str) -> str:
    """payload as JSON, with a 5,000-digit integer as key's value."""
    return json.dumps(dict(payload, **{key: "NUMBER"})).replace('"NUMBER"', "9" * 5000)


def test_payload_that_cannot_be_parsed_holds_up_no_other_event() -> None:
    # 2026-10-12 review: every run parses every queued payload to find its
    # session's events, and only a JSONDecodeError was caught. Deep nesting
    # raises RecursionError and a 5,000-digit integer ValueError, so either
    # one stopped every session's runs and stayed in the queue. Such an
    # event is now applied on its own, which drops it with a log line, and
    # the other runs pass it by.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"):
        stub, record = _recording_stub(tmp)
        hook_env = _base_env(tmp, BQAA_PYTHON=str(stub))
        nested = _deeply_nested(dict(PRE_PAYLOAD, session_id="session-a"), "tool_input")
        huge = _with_huge_integer(dict(POST_PAYLOAD, session_id="session-b"), "tool_response")
        _run_hook("pre_tool_use.sh", dict(PRE_PAYLOAD, session_id="session-a"), hook_env)
        _run_hook("pre_tool_use.sh", nested, hook_env)
        _run_hook("pre_tool_use.sh", dict(PRE_PAYLOAD, session_id="session-b"), hook_env)
        _run_hook("post_tool_use.sh", huge, hook_env)
        a_run, nested_run, b_run, huge_run = _recorded_runs(record)
        with _environ(_base_env(tmp)):
            # Through main(), as bqaa_hook.py runs them.
            for run in (a_run, b_run):
                assert bqaa_tracing.main(["--queue", *run]) == 0
            sessions = [row["session_id"] for row in _spooled_rows(tmp / "spool")]
            assert sessions == ["session-a", "session-b"], sessions
            assert [path.name for path in _queued_entries(tmp / "state")] == [nested_run[1], huge_run[1]]
            for run in (nested_run, huge_run):
                assert bqaa_tracing.main(["--queue", *run]) == 0
        assert _queued_entries(tmp / "state") == []
        assert len(_spool_files(tmp / "spool")) == 2
        log = (tmp / "bqaa.log").read_text(encoding="utf-8")
        assert "PreToolUse payload can't be parsed: RecursionError" in log, log[-3000:]
        assert "PostToolUse payload can't be parsed: ValueError" in log, log[-3000:]


def test_transcript_lines_that_cannot_be_parsed_are_skipped() -> None:
    # Transcript lines get parsed too (tool results in them can hold any
    # JSON). The same two kinds of line made a late UserPromptSubmit, or a
    # Stop, fail, and the turn's reply was lost. They're passed over like
    # any other line that isn't JSON.
    with _tmpdir() as tmp:
        transcript = tmp / "transcript.jsonl"
        _append_transcript(
            transcript,
            {"type": "user", "message": {"role": "user", "content": "q"}, "timestamp": "2026-10-12T10:00:00.000Z"},
            {
                "type": "assistant",
                "message": {"model": "claude-test", "content": [{"type": "text", "text": "reply"}]},
                "timestamp": "2026-10-12T10:00:02.000Z",
            },
        )
        lines = [
            _with_huge_integer({"type": "user", "timestamp": "2026-10-12T10:00:03.000Z"}, "toolUseResult"),
            _deeply_nested({"type": "user", "timestamp": "2026-10-12T10:00:04.000Z"}, "toolUseResult"),
        ]
        with transcript.open("a", encoding="utf-8") as handle:
            handle.write("".join(line + "\n" for line in lines))
        hook_ns = int(datetime(2026, 10, 12, 10, 0, 1, tzinfo=timezone.utc).timestamp()) * 1_000_000_000
        with bqaa_tracing._event_clock(hook_ns):  # a UserPromptSubmit between the prompt and the reply
            assert bqaa_tracing._line_count(str(transcript)) == 1
        output, model, _, _ = bqaa_tracing._read_transcript_since(str(transcript), 1, 1 << 20)
        assert (output, model) == ("reply", "claude-test"), (output, model)


def test_drainer_sends_spooled_row_unchanged() -> None:
    with _tmpdir() as tmp, _fake_google_importable(tmp / "fake"):
        with _environ(_base_env(tmp, BQAA_NETWORK_TIMEOUT_SECONDS="7")):
            config = bqaa_tracing.BQAAConfig.from_env()
            path = _spool_tool_event(config)
            spooled_row = json.loads(path.read_text(encoding="utf-8"))["row"]
            asyncio.run(bqaa_drain._drain_once(config, use_storage_api=False))
        from google.cloud import bigquery

        # The insertId is the row's content hash, so a resend of the same
        # row carries the same one.
        insert_id = hashlib.sha256(json.dumps(spooled_row, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        assert _insert_calls(bigquery) == [
            ("insert_rows_json", "test-project.test_dataset.agent_events", 7.0, [spooled_row], [insert_id])
        ], _insert_calls(bigquery)
        assert all(call[2] == 7.0 for call in bigquery.CALLS), bigquery.CALLS
        assert bigquery.TABLE == [spooled_row]
        assert not path.exists()
        assert _dead_letters(config) == []


def test_drainer_gives_up_on_hung_auth() -> None:
    # The drainer is detached from the agent, but a hung ADC lookup pinned
    # the single drainer (and its pidfile lock) indefinitely, so nothing
    # else in the spool was written either.
    with _tmpdir() as tmp, _fake_google_importable(tmp / "fake"):
        env = _base_env(tmp, BQAA_NETWORK_TIMEOUT_SECONDS="0.5", FAKE_GOOGLE_ADC_DELAY=str(STALL_SECONDS))
        with _environ(env):
            config = bqaa_tracing.BQAAConfig.from_env()
            path = _spool_tool_event(config)
            start = time.monotonic()
            asyncio.run(bqaa_drain._drain_once(config, use_storage_api=False))
            elapsed = time.monotonic() - start
        assert elapsed < 3.0, f"drainer waited {elapsed:.1f}s on a hung ADC lookup"
        assert not path.exists()
        assert len(_dead_letters(config)) == 1


def test_drainer_gives_up_on_hung_insert() -> None:
    with _tmpdir() as tmp, _fake_google_importable(tmp / "fake"):
        env = _base_env(tmp, BQAA_NETWORK_TIMEOUT_SECONDS="0.5", FAKE_BIGQUERY_INSERT_DELAY=str(STALL_SECONDS))
        with _environ(env):
            config = bqaa_tracing.BQAAConfig.from_env()
            path = _spool_tool_event(config)
            envelope = bqaa_drain._read_envelope(path)
            ((key, batch),) = bqaa_drain._group_envelopes([envelope]).items()
            start = time.monotonic()
            asyncio.run(
                bqaa_drain._drain_group_async(
                    key=key,
                    envelopes=batch,
                    retry=bqaa_drain._RetryConfig(max_retries=0),
                    config=config,
                    use_storage_api=False,
                )
            )
            elapsed = time.monotonic() - start
        assert elapsed < 3.0, f"drainer waited {elapsed:.1f}s on a hung insert"
        assert not path.exists()
        assert len(_dead_letters(config)) == 1


# ---------------------------------------------------------------------------
# Retries never write a row twice
# ---------------------------------------------------------------------------


def test_drainer_takes_late_insert_result_instead_of_resending() -> None:
    # 2026-10-11 review: a timed-out insert was retried while the first
    # request was still running on its thread; both landed, so the row was
    # written twice and the batch reported success.
    with _tmpdir() as tmp, _fake_google_importable(tmp / "fake"):
        plan = json.dumps([{"delay": 1.0}, {"delay": 0}])
        env = _base_env(tmp, BQAA_NETWORK_TIMEOUT_SECONDS="0.3", FAKE_BIGQUERY_INSERT_PLAN=plan)
        with _environ(env):
            config = bqaa_tracing.BQAAConfig.from_env()
            path, _ = _insert_once(config, bqaa_drain._RetryConfig(max_retries=1, initial_delay=1.0, max_delay=1.0))
        from google.cloud import bigquery

        assert len(_insert_calls(bigquery)) == 1, _insert_calls(bigquery)
        assert len(bigquery.TABLE) == 1, bigquery.TABLE
        assert not path.exists()
        assert _dead_letters(config) == []


def test_drainer_does_not_resend_while_insert_is_in_flight() -> None:
    # If the timed-out request still hasn't finished by the time a retry
    # is due, sending another copy could write the row twice; the batch is
    # dead-lettered instead (it may still land).
    with _tmpdir() as tmp, _fake_google_importable(tmp / "fake"):
        env = _base_env(tmp, BQAA_NETWORK_TIMEOUT_SECONDS="0.3", FAKE_BIGQUERY_INSERT_PLAN='[{"delay": 3.0}]')
        with _environ(env):
            config = bqaa_tracing.BQAAConfig.from_env()
            path, elapsed = _insert_once(config, bqaa_drain._RetryConfig(max_retries=3, initial_delay=0.5, max_delay=0.5))
        from google.cloud import bigquery

        assert elapsed < 2.0, f"drainer waited {elapsed:.1f}s"
        assert not path.exists()
        assert len(_dead_letters(config)) == 1
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not bigquery.TABLE:
            time.sleep(0.1)
        time.sleep(0.5)
        assert len(_insert_calls(bigquery)) == 1, _insert_calls(bigquery)
        assert len(bigquery.TABLE) == 1, bigquery.TABLE


def test_drainer_retries_reuse_insert_ids() -> None:
    # A request can land even though its response fails. The retry sends
    # the same insertIds, so BigQuery drops the second copy.
    with _tmpdir() as tmp, _fake_google_importable(tmp / "fake"):
        env = _base_env(tmp, FAKE_BIGQUERY_INSERT_PLAN='[{"error": "ServiceUnavailable"}, {}]')
        with _environ(env):
            config = bqaa_tracing.BQAAConfig.from_env()
            path, _ = _insert_once(config, bqaa_drain._RetryConfig(max_retries=1, initial_delay=0.01, max_delay=0.01))
        from google.cloud import bigquery

        calls = _insert_calls(bigquery)
        assert len(calls) == 2, calls
        assert calls[0][4] == calls[1][4], calls
        assert len(bigquery.TABLE) == 1, bigquery.TABLE
        assert not path.exists()
        assert _dead_letters(config) == []


def test_drainer_resends_at_once_when_late_insert_fails() -> None:
    # The timed-out request finishes during the backoff, but with an error:
    # the backoff has been spent waiting on it, so the resend goes out then.
    with _tmpdir() as tmp, _fake_google_importable(tmp / "fake"):
        plan = json.dumps([{"delay": 0.6, "error": "ServiceUnavailable"}, {}])
        env = _base_env(tmp, BQAA_NETWORK_TIMEOUT_SECONDS="0.3", FAKE_BIGQUERY_INSERT_PLAN=plan)
        with _environ(env):
            config = bqaa_tracing.BQAAConfig.from_env()
            path, elapsed = _insert_once(config, bqaa_drain._RetryConfig(max_retries=1, initial_delay=2.0, max_delay=2.0))
        from google.cloud import bigquery

        assert elapsed < 1.5, f"drainer took {elapsed:.1f}s"
        calls = _insert_calls(bigquery)
        assert len(calls) == 2 and calls[0][4] == calls[1][4], calls
        assert len(bigquery.TABLE) == 1, bigquery.TABLE
        assert not path.exists()


def main() -> int:
    for test in (
        test_hook_returns_fast_when_python_cannot_start,
        test_hook_returns_fast_when_bigquery_auth_hangs,
        test_hook_returns_when_agent_keeps_stdin_open,
        test_cut_off_payload_is_dropped_not_made_up,
        test_direct_write_gives_up_on_hung_auth,
        test_hook_fails_open_when_python_fails,
        test_main_fails_open_on_bad_input,
        test_hook_enqueues_tool_event_before_returning,
        test_healthy_hook_does_not_sit_out_the_wait_and_drainer_sends,
        test_usercustomize_cannot_restore_a_real_google,
        test_stalled_hook_still_enqueues_event_after_returning,
        test_unconfigured_hook_does_not_start_python,
        test_late_hooks_still_apply_in_order,
        test_late_turns_keep_their_own_replies,
        test_late_hooks_group_by_top_level_session_id,
        test_numbers_freed_during_a_run_do_not_reorder_its_session,
        test_parallel_hooks_each_queue_their_event,
        test_hook_does_not_take_a_number_used_up_since_its_listing,
        test_queue_applies_only_its_own_sessions_events,
        test_queue_numbers_are_never_handed_out_twice,
        test_cleanup_leaves_queue_locks_in_place,
        test_saturated_queue_of_expired_entries_is_pruned,
        test_payload_that_cannot_be_parsed_holds_up_no_other_event,
        test_transcript_lines_that_cannot_be_parsed_are_skipped,
        test_drainer_sends_spooled_row_unchanged,
        test_drainer_gives_up_on_hung_auth,
        test_drainer_gives_up_on_hung_insert,
        test_drainer_takes_late_insert_result_instead_of_resending,
        test_drainer_does_not_resend_while_insert_is_in_flight,
        test_drainer_retries_reuse_insert_ids,
        test_drainer_resends_at_once_when_late_insert_fails,
    ):
        test()
    print("hook nonblocking tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
