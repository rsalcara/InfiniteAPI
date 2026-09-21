import json
import os
import secrets
import base64
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import frida

BRIDGE_PORT = int(os.getenv("BRIDGE_PORT", "9876"))
BRIDGE_TOKEN = os.getenv("BRIDGE_TOKEN", "")
FRIDA_HOST = os.getenv("FRIDA_HOST", "android")
FRIDA_PORT = int(os.getenv("FRIDA_PORT", "27042"))
WHATSAPP_PACKAGE = os.getenv("WHATSAPP_PACKAGE", "com.whatsapp.w4b")
WHATSAPP_PACKAGES = tuple(
    package.strip()
    for package in os.getenv("WHATSAPP_PACKAGES", "com.whatsapp.w4b,com.whatsapp").split(",")
    if package.strip()
)
DEFAULT_CLOUD_PROJECT_NUMBER = 293955441834
MAX_RESPONSE_BYTES = 1024 * 1024
REGISTRATION_WIRE_CAPTURE_DIR = Path(os.getenv("REGISTRATION_WIRE_CAPTURE_DIR", "/tmp/infiniteapi-bridge"))
RPC_TIMEOUT_SECONDS = int(os.getenv("RPC_TIMEOUT_SECONDS", "20"))
WARMUP_ENABLED = os.getenv("WARMUP_ENABLED", "true").lower() in {"1", "true", "yes"}
WARMUP_CLOUD_PROJECT_NUMBER = int(os.getenv("WARMUP_CLOUD_PROJECT_NUMBER", str(DEFAULT_CLOUD_PROJECT_NUMBER)))
WARMUP_INITIAL_DELAY_SECONDS = int(os.getenv("WARMUP_INITIAL_DELAY_SECONDS", "20"))
WARMUP_REFRESH_SECONDS = int(os.getenv("WARMUP_REFRESH_SECONDS", "0"))
WARMUP_MAX_DELAY_SECONDS = int(os.getenv("WARMUP_MAX_DELAY_SECONDS", "300"))
WARMUP_RESTART_ON_RETRY = os.getenv("WARMUP_RESTART_ON_RETRY", "true").lower() in {"1", "true", "yes"}
AUTO_LAUNCH_WHATSAPP = os.getenv("AUTO_LAUNCH_WHATSAPP", "true").lower() in {"1", "true", "yes"}

state_lock = threading.Lock()
bootstrap_locks = {}
request_locks = {}
rpc_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="frida-rpc")


def persist_registration_wire_captures(captures):
    if not isinstance(captures, list):
        return
    try:
        REGISTRATION_WIRE_CAPTURE_DIR.mkdir(parents=True, exist_ok=True)
        destination = REGISTRATION_WIRE_CAPTURE_DIR / f"registration-wire-{time.strftime('%Y%m%d')}.jsonl"
        with destination.open("a", encoding="utf-8") as output:
            for item in captures:
                if isinstance(item, dict):
                    item = dict(item)
                    item.setdefault("persistedAt", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
                    item.setdefault("captureId", str(uuid.uuid4()))
                    output.write(json.dumps(item, separators=(",", ":"), ensure_ascii=False) + "\n")
    except Exception as error:
        print(f"[BRIDGE] Failed to persist registration wire captures: {error}", flush=True)


def new_target_state():
    return {
        "device": None,
        "session": None,
        "script": None,
        "pid": None,
        "bootstrapped": False,
        "providerReady": False,
        "readyAt": None,
        "lastWarmupError": None,
        "lastWarmupAt": None,
        "targetPackage": None,
        "lastFullWarmupAt": None,
    }


def normalized_package(package_name=None):
    package = package_name or WHATSAPP_PACKAGE
    if package not in WHATSAPP_PACKAGES:
        raise ValueError(f"unsupported WhatsApp package: {package}")
    return package


def lock_for(locks, package_name):
    package = normalized_package(package_name)
    return locks.setdefault(package, threading.Lock())


states = {package: new_target_state() for package in WHATSAPP_PACKAGES}
last_full_warmup = {package: 0.0 for package in WHATSAPP_PACKAGES}

metrics_lock = threading.Lock()
metrics = {
    "startedAt": time.time(),
    "requests": {"live": 0, "warmup": 0, "diagnostic": 0, "pairing": 0, "registration": 0},
    "successes": {"live": 0, "warmup": 0, "diagnostic": 0, "pairing": 0, "registration": 0},
    "failures": {"live": 0, "warmup": 0, "diagnostic": 0, "pairing": 0, "registration": 0},
    "durationsMs": {"live": [], "warmup": [], "diagnostic": [], "pairing": [], "registration": []},
    "successDurationsMs": {"live": [], "warmup": [], "diagnostic": [], "pairing": [], "registration": []},
    "failureDurationsMs": {"live": [], "warmup": [], "diagnostic": [], "pairing": [], "registration": []},
    "tokenBytes": {"live": [], "warmup": [], "diagnostic": [], "pairing": [], "registration": []},
    "events": [],
}


def token_shape(token):
    segments = token.split(".")
    decoded = 0
    for segment in segments:
        if not segment:
            continue
        try:
            decoded += len(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))
        except Exception:
            decoded = None
            break

    if len(segments) == 5:
        token_format = "compact-jwe"
    elif len(segments) == 3:
        token_format = "compact-jws"
    else:
        token_format = "opaque"

    return {
        "characters": len(token),
        "segments": len(segments),
        "decodedBytes": decoded,
        "format": token_format,
        "opaque": token_format != "compact-jws",
    }


def metric_begin(source, metadata=None):
    event = {
        "id": secrets.token_hex(8),
        "source": source,
        "startedAt": time.time(),
        "durationMs": None,
        "ok": None,
        "error": None,
        "token": None,
        **(metadata or {}),
    }
    with metrics_lock:
        metrics["requests"][source] += 1
        metrics["events"].append(event)
        if len(metrics["events"]) > 200:
            metrics["events"] = metrics["events"][-200:]
    return event


def metric_end(event, error=None, token=None):
    source = event["source"]
    duration_ms = round((time.time() - event["startedAt"]) * 1000, 2)
    with metrics_lock:
        event["startedAt"] = round(event["startedAt"] * 1000) / 1000
        event["durationMs"] = duration_ms
        event["ok"] = error is None
        event["error"] = str(error)[:500] if error else None
        event["token"] = token_shape(token) if token else None
        if error is None:
            metrics["successes"][source] += 1
            metrics["successDurationsMs"][source].append(duration_ms)
            metrics["successDurationsMs"][source] = metrics["successDurationsMs"][source][-500:]
        else:
            metrics["failures"][source] += 1
            metrics["failureDurationsMs"][source].append(duration_ms)
            metrics["failureDurationsMs"][source] = metrics["failureDurationsMs"][source][-500:]
        metrics["durationsMs"][source].append(duration_ms)
        metrics["durationsMs"][source] = metrics["durationsMs"][source][-500:]
        if token:
            size = len(token.encode("utf-8"))
            metrics["tokenBytes"][source].append(size)
            metrics["tokenBytes"][source] = metrics["tokenBytes"][source][-500:]


def metric_summary():
    def summary_for(source):
        values = sorted(metrics["durationsMs"][source])
        success_values = sorted(metrics["successDurationsMs"][source])
        failure_values = sorted(metrics["failureDurationsMs"][source])
        sizes = sorted(metrics["tokenBytes"][source])

        def percentile(items, percentile_value):
            if not items:
                return None
            index = max(0, min(len(items) - 1, round((len(items) - 1) * percentile_value)))
            return items[index]

        def distribution(items):
            return {
                "averageMs": round(sum(items) / len(items), 2) if items else None,
                "p50Ms": percentile(items, 0.50),
                "p95Ms": percentile(items, 0.95),
                "maxMs": items[-1] if items else None,
            }

        return {
            "requests": metrics["requests"][source],
            "successes": metrics["successes"][source],
            "failures": metrics["failures"][source],
            "averageLatencyMs": round(sum(values) / len(values), 2) if values else None,
            "p50LatencyMs": percentile(values, 0.50),
            "p95LatencyMs": percentile(values, 0.95),
            "maxLatencyMs": values[-1] if values else None,
            "averageTokenBytes": round(sum(sizes) / len(sizes), 2) if sizes else None,
            "successfulLatency": distribution(success_values),
            "failureDuration": distribution(failure_values),
        }

    with metrics_lock:
        events = [dict(item) for item in metrics["events"][-100:]]
        return {
            "startedAt": metrics["startedAt"],
            "now": time.time(),
            "uptimeSeconds": round(time.time() - metrics["startedAt"], 2),
            "totals": {source: summary_for(source) for source in metrics["requests"]},
            "recentEvents": list(reversed(events)),
        }


def clear_state(package_name=None):
    with state_lock:
        packages = [normalized_package(package_name)] if package_name else list(states)
        for package in packages:
            states[package].update(
                {
                    "device": None,
                    "session": None,
                    "script": None,
                    "pid": None,
                    "bootstrapped": False,
                    "providerReady": False,
                    "readyAt": None,
                    "targetPackage": None,
                }
            )


def close_frida(package_name=None):
    package = normalized_package(package_name)
    with state_lock:
        target = states[package]
        script = target.get("script")
        session = target.get("session")
        device = target.get("device")
        target.update(
            {
                "device": None,
                "session": None,
                "script": None,
                "pid": None,
                "bootstrapped": False,
                "providerReady": False,
                "readyAt": None,
            }
        )
    if script:
        try:
            script.unload()
        except Exception:
            pass
    if session:
        try:
            session.detach()
        except Exception:
            pass
    if device:
        try:
            device.close()
        except Exception:
            pass


def on_detached(package_name, reason, *args):
    print(f"[BRIDGE] {package_name} Frida session detached: {reason}", flush=True)
    clear_state(package_name)


def on_message(message, data):
    if message.get("type") == "error":
        print(f"[BRIDGE] Frida script error: {message.get('description')}", flush=True)
        return
    if message.get("type") != "send":
        return
    payload = message.get("payload") or {}
    if payload.get("type") in {"log", "error"}:
        print(f"[BRIDGE] agent: {payload}", flush=True)


def find_whatsapp(device, package_name=None):
    package = package_name or WHATSAPP_PACKAGE
    processes = device.enumerate_processes()
    return next((item for item in processes if item.name == package), None)


def script_ping(script):
    exports = getattr(script, "exports_sync", None) or script.exports
    result = exports.ping()
    if result != "ok":
        raise RuntimeError(f"invalid Frida ping response: {result!r}")


def launch_whatsapp(device, package_name=None):
    package = package_name or WHATSAPP_PACKAGE
    """Start WhatsApp and tolerate the Android launcher still settling."""
    last_error = None
    for attempt in range(3):
        process = find_whatsapp(device, package)
        if process:
            return process.pid, process
        try:
            pid = device.spawn([package])
            print(f"[BRIDGE] Started {package} (pid {pid})", flush=True)
            return pid, None
        except Exception as error:
            last_error = error
            # Frida can report a launch timeout even though Android starts the
            # process a moment later; observe the process before retrying.
            time.sleep(2 + attempt * 3)
            process = find_whatsapp(device, package)
            if process:
                print(
                    f"[BRIDGE] WhatsApp became available after launch attempt {attempt + 1}",
                    flush=True,
                )
                return process.pid, process
    raise RuntimeError(f"unable to launch {WHATSAPP_PACKAGE}: {last_error}")


def bootstrap(force=False, package_name=None):
    package = normalized_package(package_name)
    with lock_for(bootstrap_locks, package):
        if not force:
            with state_lock:
                target = states[package]
                force = target.get("targetPackage") != package
                existing_script = (
                    target.get("script")
                    if target.get("device") and target.get("session") and target.get("script")
                    else None
                )
            if existing_script:
                try:
                    script_ping(existing_script)
                    return
                except Exception as error:
                    print(f"[BRIDGE] Existing Frida script is unusable: {error}", flush=True)

        close_frida(package)
        device = frida.get_device_manager().add_remote_device(f"{FRIDA_HOST}:{FRIDA_PORT}")
        session = None
        try:
            process = find_whatsapp(device, package)
            spawned_pid = None
            if not process:
                if not AUTO_LAUNCH_WHATSAPP:
                    raise RuntimeError(
                        f"WhatsApp ({package}) is not running on {FRIDA_HOST}. "
                        "Open WhatsApp in the bridge device before calling bootstrap."
                    )
                spawned_pid, process = launch_whatsapp(device, package)
                process_pid = spawned_pid
            else:
                process_pid = process.pid

            session = device.attach(process_pid)
            session.on("detached", lambda reason, *args: on_detached(package, reason, *args))
            source = Path("/app/hook.js").read_text(encoding="utf-8")
            capture_key = os.getenv("REGISTRATION_CAPTURE_HMAC_KEY_B64", "").strip()
            if capture_key:
                source = (
                    "const REGISTRATION_CAPTURE_HMAC_KEY_B64_OVERRIDE = "
                    + json.dumps(capture_key) + ";\n" + source
                )
            script = session.create_script(source)
            script.on("message", on_message)
            script.load()
            if spawned_pid is not None:
                device.resume(spawned_pid)
                time.sleep(0.5)
            script_ping(script)
            with state_lock:
                states[package].update(
                    {
                        "device": device,
                        "session": session,
                        "script": script,
                        "pid": process_pid,
                        "bootstrapped": True,
                        "targetPackage": package,
                    }
                )
            attached_name = process.name if process else package
            print(f"[BRIDGE] Frida attached to {attached_name} (pid {process_pid})", flush=True)
        except Exception:
            if session:
                try:
                    session.detach()
                except Exception:
                    pass
            try:
                device.close()
            except Exception:
                pass
            clear_state(package)
            raise


def current_process_id(package_name=None):
    package = normalized_package(package_name)
    with state_lock:
        device = states[package].get("device")
    if not device:
        return None
    try:
        return find_whatsapp(device, package_name).pid
    except Exception:
        return None


def request_token(nonce, cloud_project_number, package_name=None):
    package = normalized_package(package_name)
    with lock_for(request_locks, package):
        for attempt in range(2):
            bootstrap(package_name=package)
            with state_lock:
                target = states[package]
                script = target.get("script")
            if not script:
                raise RuntimeError("Frida script is not available")

            exports = getattr(script, "exports_sync", None) or script.exports
            future = rpc_executor.submit(exports.request_nonce, nonce, cloud_project_number)
            try:
                jws = future.result(timeout=RPC_TIMEOUT_SECONDS)
            except FutureTimeoutError as error:
                print(
                    f"[BRIDGE] Play Integrity request exceeded {RPC_TIMEOUT_SECONDS}s; keeping Frida session alive",
                    flush=True,
                )
                try:
                    bootstrap(force=True, package_name=package)
                except Exception as bootstrap_error:
                    print(f"[BRIDGE] Reattach after Play Integrity timeout failed: {bootstrap_error}", flush=True)
                with state_lock:
                    states[package]["providerReady"] = False
                    states[package]["lastWarmupError"] = "Frida Play Integrity request timed out"
                    states[package]["lastWarmupAt"] = time.time()
                raise RuntimeError("Frida Play Integrity request timed out") from error
            except Exception as error:
                message = str(error)
                with state_lock:
                    states[package]["providerReady"] = False
                    states[package]["lastWarmupError"] = message
                    states[package]["lastWarmupAt"] = time.time()
                if attempt == 0 and ("destroyed" in message.lower() or "detached" in message.lower()):
                    print(f"[BRIDGE] Recoverable Frida RPC failure: {message}", flush=True)
                    bootstrap(force=True, package_name=package)
                    continue
                raise

            if not isinstance(jws, str) or not jws or len(jws.encode("utf-8")) > MAX_RESPONSE_BYTES:
                raise RuntimeError("bridge returned an invalid token")
            return jws
        raise RuntimeError("Frida RPC failed after reattach")


def restart_target(package_name=None):
    package = normalized_package(package_name)
    with state_lock:
        script = states[package].get("script")
    if not script:
        return
    exports = getattr(script, "exports_sync", None) or script.exports
    try:
        exports.restart_target()
    except Exception as error:
        print(f"[BRIDGE] Target restart request finished with {error}", flush=True)


def request_pairing_material(challenge_base64, cloud_project_number, package_name=None):
    package = normalized_package(package_name)
    with lock_for(request_locks, package):
        for attempt in range(2):
            bootstrap(package_name=package)
            with state_lock:
                target = states[package]
                script = target.get("script")
            if not script:
                raise RuntimeError("Frida script is not available")

            exports = getattr(script, "exports_sync", None) or script.exports
            future = rpc_executor.submit(
                exports.request_pairing_material,
                challenge_base64,
                cloud_project_number,
            )
            try:
                material = future.result(timeout=RPC_TIMEOUT_SECONDS + 20)
            except FutureTimeoutError as error:
                print(
                    "[BRIDGE] Pairing material request exceeded timeout; keeping Frida session alive",
                    flush=True,
                )
                try:
                    bootstrap(force=True, package_name=package)
                except Exception as bootstrap_error:
                    print(f"[BRIDGE] Reattach after pairing timeout failed: {bootstrap_error}", flush=True)
                with state_lock:
                    states[package]["providerReady"] = False
                    states[package]["lastWarmupError"] = "Frida pairing material request timed out"
                    states[package]["lastWarmupAt"] = time.time()
                raise RuntimeError("Frida pairing material request timed out") from error
            except Exception as error:
                message = str(error)
                with state_lock:
                    states[package]["providerReady"] = False
                    states[package]["lastWarmupError"] = message
                    states[package]["lastWarmupAt"] = time.time()
                if attempt == 0 and ("destroyed" in message.lower() or "detached" in message.lower()):
                    print(f"[BRIDGE] Recoverable pairing RPC failure: {message}", flush=True)
                    bootstrap(force=True, package_name=package)
                    continue
                raise

            if (
                not isinstance(material, dict)
                or not isinstance(material.get("keyAttestationBase64"), str)
                or not material.get("keyAttestationBase64")
                or not isinstance(material.get("gpia"), str)
                or not material.get("gpia")
            ):
                raise RuntimeError("bridge returned invalid pairing material")
            return material
        raise RuntimeError("Frida pairing RPC failed after reattach")


def request_registration_material(endpoint, registration_type, registration_body, package_name=None):
    package = normalized_package(package_name)
    with lock_for(request_locks, package):
        for attempt in range(2):
            bootstrap(package_name=package)
            with state_lock:
                target = states[package]
                script = target.get("script")
            if not script:
                raise RuntimeError("Frida script is not available")

            exports = getattr(script, "exports_sync", None) or script.exports
            future = rpc_executor.submit(
            exports.request_registration_step,
                endpoint,
                registration_type,
                registration_body,
            )
            try:
                result = future.result(timeout=RPC_TIMEOUT_SECONDS + 10)
            except FutureTimeoutError as error:
                print("[BRIDGE] Registration request exceeded timeout; keeping Frida session alive", flush=True)
                try:
                    bootstrap(force=True, package_name=package)
                except Exception as bootstrap_error:
                    print(f"[BRIDGE] Reattach after registration timeout failed: {bootstrap_error}", flush=True)
                with state_lock:
                    states[package]["providerReady"] = False
                    states[package]["lastWarmupError"] = "Frida registration request timed out"
                    states[package]["lastWarmupAt"] = time.time()
                raise RuntimeError("Frida registration request timed out") from error
            except Exception as error:
                message = str(error)
                with state_lock:
                    states[package]["providerReady"] = False
                    states[package]["lastWarmupError"] = message
                    states[package]["lastWarmupAt"] = time.time()
                if attempt == 0 and ("destroyed" in message.lower() or "detached" in message.lower()):
                    print(f"[BRIDGE] Recoverable registration RPC failure: {message}", flush=True)
                    bootstrap(force=True, package_name=package)
                    continue
                raise

            if not isinstance(result, dict):
                raise RuntimeError("bridge returned an invalid registration result")
            return result
        raise RuntimeError("Frida registration RPC failed after reattach")


def request_registration_environment(package_name=None, cloud_project_number=None):
    package = normalized_package(package_name)
    with lock_for(request_locks, package):
        for attempt in range(2):
            bootstrap(package_name=package)
            with state_lock:
                target = states[package]
                script = target.get("script")
            if not script:
                raise RuntimeError("Frida script is not available")

            exports = getattr(script, "exports_sync", None) or script.exports
            future = rpc_executor.submit(
                exports.collect_registration_environment,
                cloud_project_number or WARMUP_CLOUD_PROJECT_NUMBER,
            )
            try:
                environment = future.result(timeout=RPC_TIMEOUT_SECONDS + 10)
            except FutureTimeoutError as error:
                print("[BRIDGE] Registration environment request timed out; keeping Frida session alive", flush=True)
                raise RuntimeError("Frida registration environment request timed out") from error
            except Exception as error:
                message = str(error)
                if attempt == 0 and ("destroyed" in message.lower() or "detached" in message.lower()):
                    bootstrap(force=True, package_name=package)
                    continue
                raise

            if not isinstance(environment, dict) or not isinstance(environment.get("gpia"), str):
                raise RuntimeError("bridge returned invalid registration environment")
            return environment
        raise RuntimeError("Frida registration environment RPC failed after reattach")


def mark_provider_ready(package_name=None):
    package = normalized_package(package_name)
    with state_lock:
        states[package]["providerReady"] = True
        states[package]["readyAt"] = time.time()
        states[package]["lastWarmupError"] = None
        states[package]["lastWarmupAt"] = time.time()
        states[package]["lastFullWarmupAt"] = time.time()
        last_full_warmup[package] = time.time()


def aggregate_target_state():
    with state_lock:
        target_items = [dict(states[package]) for package in WHATSAPP_PACKAGES]
    for item in target_items:
        item.pop("device", None)
        item.pop("session", None)
        item.pop("script", None)
    return {
        "bootstrapped": bool(target_items) and all(item["bootstrapped"] for item in target_items),
        "providerReady": bool(target_items) and all(item["providerReady"] for item in target_items),
        "readyAt": max((item["readyAt"] for item in target_items if item["readyAt"] is not None), default=None),
        "lastWarmupError": next((item["lastWarmupError"] for item in target_items if item["lastWarmupError"]), None),
        "lastWarmupAt": max((item["lastWarmupAt"] for item in target_items if item["lastWarmupAt"] is not None), default=None),
        "whatsappPid": next((item["pid"] for item in target_items if item["pid"] is not None), None),
        "targets": [
            {
                "package": package,
                "pid": item["pid"],
                "bootstrapped": item["bootstrapped"],
                "providerReady": item["providerReady"],
                "readyAt": item["readyAt"],
                "lastWarmupError": item["lastWarmupError"],
                "lastWarmupAt": item["lastWarmupAt"],
                "lastFullWarmupAt": item["lastFullWarmupAt"],
            }
            for package, item in zip(WHATSAPP_PACKAGES, target_items)
        ],
    }


def warmup_worker():
    delay = WARMUP_INITIAL_DELAY_SECONDS
    while True:
        try:
            for package in WHATSAPP_PACKAGES:
                with state_lock:
                    target = states[package]
                    ready = bool(target.get("providerReady"))
                    script = target.get("script")
                    needs_refresh = (
                        WARMUP_REFRESH_SECONDS > 0
                        and time.time() - last_full_warmup[package] >= WARMUP_REFRESH_SECONDS
                    )

                if ready and script and not needs_refresh:
                    try:
                        script_ping(script)
                        continue
                    except Exception as error:
                        print(f"[BRIDGE] {package} provider readiness lost: {error}", flush=True)
                        clear_state(package)

                nonce = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
                print(f"[BRIDGE] Starting controlled Play Integrity warm-up for {package}", flush=True)
                event = metric_begin(
                    "warmup",
                    {
                        "kind": "gpia",
                        "cloudProjectNumber": WARMUP_CLOUD_PROJECT_NUMBER,
                        "packageName": package,
                    },
                )
                try:
                    token = request_token(nonce, WARMUP_CLOUD_PROJECT_NUMBER, package)
                    metric_end(event, token=token)
                except Exception as error:
                    metric_end(event, error=error)
                    raise
                mark_provider_ready(package)
                print(f"[BRIDGE] {package} Play Integrity provider is ready", flush=True)
            delay = WARMUP_INITIAL_DELAY_SECONDS
            time.sleep(15)
        except Exception as error:
            message = str(error)
            print(f"[BRIDGE] Warm-up failed; retrying in {delay}s: {message}", flush=True)
            if WARMUP_RESTART_ON_RETRY:
                with state_lock:
                    failed_package = next(
                        (package for package, item in states.items() if not item.get("providerReady")),
                        WHATSAPP_PACKAGE,
                    )
                restart_target(failed_package)
            time.sleep(delay)
            delay = min(WARMUP_MAX_DELAY_SECONDS, delay * 2)


class Handler(BaseHTTPRequestHandler):
    server_version = "InfiniteBridge/1.2"

    def authorized(self):
        return not BRIDGE_TOKEN or self.headers.get("Authorization") == f"Bearer {BRIDGE_TOKEN}"

    def resolve_package(self, requested_package, required=True):
        if not requested_package:
            return WHATSAPP_PACKAGE if not required else None
        return requested_package if requested_package in WHATSAPP_PACKAGES else None

    def do_GET(self):
        if self.path not in {"/health", "/ready"} and not self.authorized():
            return self.send_json(401, {"error": "unauthorized"})

        if self.path == "/health":
            health = aggregate_target_state()
            return self.send_json(
                200,
                {
                    "status": "ok",
                    "package": WHATSAPP_PACKAGE,
                    "packages": list(WHATSAPP_PACKAGES),
                    "fridaHost": FRIDA_HOST,
                    "fridaPort": FRIDA_PORT,
                    "bootstrapped": health["bootstrapped"],
                    "providerReady": health["providerReady"],
                    "readyAt": health["readyAt"],
                    "lastWarmupError": health["lastWarmupError"],
                    "lastWarmupAt": health["lastWarmupAt"],
                    "targets": health["targets"],
                    "warmupEnabled": WARMUP_ENABLED,
                    "autoLaunchWhatsApp": AUTO_LAUNCH_WHATSAPP,
                },
            )

        if self.path == "/ready":
            health = aggregate_target_state()
            provider_ready = health["providerReady"]
            bootstrapped = health["bootstrapped"]
            if not provider_ready:
                return self.send_json(
                    503,
                    {"status": "warming-up", "providerReady": False, "bootstrapped": bootstrapped},
                )
            return self.send_json(
                200,
                {"status": "ready", "providerReady": True, "bootstrapped": bootstrapped},
            )

        if self.path == "/status":
            try:
                status_targets = []
                for package in WHATSAPP_PACKAGES:
                    bootstrap(package_name=package)
                    try:
                        with state_lock:
                            script = states[package].get("script")
                            pid = states[package].get("pid")
                        script_ping(script)
                        connected = True
                    except Exception as error:
                        print(f"[BRIDGE] {package} status ping failed: {error}", flush=True)
                        connected = False
                    health = aggregate_target_state()
                    status_targets.append(
                        {
                            "package": package,
                            "pid": pid,
                            "fridaConnected": connected,
                            "providerReady": health["providerReady"],
                        }
                    )
                connected = all(item["fridaConnected"] for item in status_targets)
                health = aggregate_target_state()
                return self.send_json(
                    200,
                    {
                        "status": "ok",
                        "whatsappRunning": health["whatsappPid"] is not None,
                        "whatsappPid": health["whatsappPid"],
                        "fridaConnected": connected,
                        "bootstrapped": connected,
                        "providerReady": health["providerReady"],
                        "targets": status_targets,
                    },
                )
            except Exception as error:
                return self.send_json(503, {"status": "error", "error": str(error), "fridaConnected": False})

        if self.path == "/metrics":
            health = aggregate_target_state()
            return self.send_json(
                200,
                {
                    "status": "ok" if health["providerReady"] else "warming-up",
                    "package": WHATSAPP_PACKAGE,
                    "packages": list(WHATSAPP_PACKAGES),
                    "tokenVisibility": "opaque-to-infiniteapi",
                    "health": health,
                    "metrics": metric_summary(),
                },
            )

        if self.path == "/debug/registration-wire":
            captures = []
            try:
                for package in WHATSAPP_PACKAGES:
                    with state_lock:
                        script = states[package].get("script")
                    if not script:
                        continue
                    exports = getattr(script, "exports_sync", None) or script.exports
                    getter = getattr(exports, "get_registration_wire_captures", None)
                    if getter:
                        result = getter()
                        if isinstance(result, list):
                            valid_captures = [item for item in result if isinstance(item, dict)]
                            captures.extend(valid_captures)
                            persist_registration_wire_captures(valid_captures)
                return self.send_json(200, {"status": "ok", "captures": captures})
            except Exception as error:
                return self.send_json(500, {"status": "error", "error": str(error)})

        if self.path == "/debug/official-user-agent":
            package = WHATSAPP_PACKAGES[0]
            try:
                with state_lock:
                    script = states[package].get("script")
                if not script:
                    return self.send_json(503, {"status": "error", "error": "frida_not_connected"})
                exports = getattr(script, "exports_sync", None) or script.exports
                getter = getattr(exports, "get_official_user_agent", None)
                if not getter:
                    return self.send_json(503, {"status": "error", "error": "agent_not_reloaded"})
                return self.send_json(200, {"status": "ok", "userAgent": getter()})
            except Exception as error:
                return self.send_json(500, {"status": "error", "error": str(error)})

        self.send_error(404)

    def do_POST(self):
        if not self.authorized():
            return self.send_json(401, {"error": "unauthorized"})

        length = int(self.headers.get("Content-Length", "0"))
        if length > 64 * 1024:
            return self.send_json(413, {"error": "payload too large"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self.send_json(400, {"error": "invalid json"})

        if self.path == "/bootstrap":
            try:
                requested_package = body.get("packageName")
                packages = [normalized_package(requested_package)] if requested_package else list(WHATSAPP_PACKAGES)
                for package in packages:
                    bootstrap(force=True, package_name=package)
                return self.send_json(200, {"status": "ok", "bootstrapped": True})
            except Exception as error:
                traceback.print_exc()
                return self.send_json(500, {"error": str(error)})

        if self.path == "/integrity/gpia":
            nonce = body.get("nonce")
            request_hash = body.get("requestHash")
            kind = body.get("kind") or "gpia"
            if kind not in {"gpia", "safetynet"}:
                return self.send_json(400, {"error": "unsupported integrity kind"})
            if not isinstance(nonce, str) or not nonce:
                return self.send_json(400, {"error": "nonce is required"})
            if nonce != request_hash:
                return self.send_json(400, {"error": "requestHash must equal nonce"})
            try:
                cloud_project_number = int(body.get("cloudProjectNumber") or DEFAULT_CLOUD_PROJECT_NUMBER)
            except Exception:
                return self.send_json(400, {"error": "cloudProjectNumber must be an integer"})
            requested_package = body.get("packageName")
            resolved_package = self.resolve_package(requested_package, required=False)
            if requested_package and resolved_package != requested_package:
                return self.send_json(
                    409,
                    {
                        "error": "package_mismatch",
                        "requestedPackage": requested_package,
                        "providerPackages": list(WHATSAPP_PACKAGES),
                    },
                )

            try:
                source = "diagnostic" if body.get("diagnostic") is True else "live"
                event = metric_begin(
                    source,
                    {
                        "kind": kind,
                        "cloudProjectNumber": cloud_project_number,
                        "packageName": body.get("packageName"),
                        "appVariant": body.get("appVariant"),
                        "profileId": body.get("profileId"),
                    },
                )
                try:
                    jws = request_token(nonce, cloud_project_number, resolved_package)
                    metric_end(event, token=jws)
                except Exception as error:
                    metric_end(event, error=error)
                    raise
                return self.send_json(200, {"jws": jws})
            except Exception as error:
                traceback.print_exc()
                return self.send_json(500, {"error": str(error)})

        if self.path == "/pairing/attestation":
            client_app_id = body.get("clientAppId")
            app_variant = body.get("appVariant")
            requested_package = body.get("packageName")
            challenge = body.get("challenge")
            if app_variant not in {"business", "consumer"}:
                return self.send_json(400, {"error": "appVariant must be business or consumer"})
            if not isinstance(client_app_id, str) or client_app_id not in {
                "473039703209605",
                "994766073959253",
            }:
                return self.send_json(400, {"error": "unsupported clientAppId"})
            resolved_package = self.resolve_package(requested_package)
            if not resolved_package:
                return self.send_json(
                    409,
                    {
                        "error": "package_mismatch",
                        "requestedPackage": requested_package,
                        "providerPackages": list(WHATSAPP_PACKAGES),
                    },
                )
            if not isinstance(challenge, str) or not challenge:
                return self.send_json(400, {"error": "challenge is required"})
            try:
                decoded_challenge = base64.b64decode(challenge, validate=True)
            except Exception:
                return self.send_json(400, {"error": "challenge must be base64"})
            if not 16 <= len(decoded_challenge) <= 1024:
                return self.send_json(400, {"error": "challenge has an invalid length"})
            try:
                cloud_project_number = int(body.get("cloudProjectNumber") or DEFAULT_CLOUD_PROJECT_NUMBER)
            except Exception:
                return self.send_json(400, {"error": "cloudProjectNumber must be an integer"})

            try:
                event = metric_begin(
                    "pairing",
                    {
                        "cloudProjectNumber": cloud_project_number,
                        "packageName": requested_package,
                        "appVariant": app_variant,
                        "clientAppId": client_app_id,
                        "profileId": body.get("profileId"),
                    },
                )
                try:
                    material = request_pairing_material(challenge, cloud_project_number, resolved_package)
                    material["clientAppId"] = client_app_id
                    metric_end(event, token=material["gpia"])
                except Exception as error:
                    metric_end(event, error=error)
                    raise
                return self.send_json(200, material)
            except Exception as error:
                traceback.print_exc()
                return self.send_json(500, {"error": str(error)})

        if self.path == "/registration/attestation":
            endpoint = body.get("endpoint")
            app_variant = body.get("appVariant")
            phone_number = body.get("phoneNumber")
            login = body.get("login")
            registration_body = body.get("body")
            registration_type = int(body.get("registrationType", 0))

            if app_variant not in {"business", "consumer"}:
                return self.send_json(400, {"error": "appVariant must be business or consumer"})
            if not isinstance(endpoint, str) or not endpoint.startswith("/v2/"):
                return self.send_json(400, {"error": "endpoint must be a /v2/ path"})
            if not isinstance(login, str) or not login:
                return self.send_json(400, {"error": "login is required"})
            if not isinstance(registration_body, str) or not registration_body:
                return self.send_json(400, {"error": "body is required"})

            requested_package = "com.whatsapp.w4b" if app_variant == "business" else "com.whatsapp"
            try:
                event = metric_begin(
                    "registration",
                    {
                        "endpoint": endpoint,
                        "appVariant": app_variant,
                        "packageName": requested_package,
                    },
                )
                try:
                    result = request_registration_material(
                        endpoint, registration_type, registration_body, requested_package
                    )
                    metric_end(event)
                except Exception as error:
                    metric_end(event, error=error)
                    raise
                return self.send_json(200, result)
            except Exception as error:
                traceback.print_exc()
                return self.send_json(500, {"error": str(error)})

        if self.path == "/registration/environment":
            app_variant = body.get("appVariant")
            if app_variant not in {"business", "consumer"}:
                return self.send_json(400, {"error": "appVariant must be business or consumer"})
            package_name = "com.whatsapp.w4b" if app_variant == "business" else "com.whatsapp"
            try:
                environment = request_registration_environment(package_name)
                return self.send_json(200, {"environment": environment})
            except Exception as error:
                traceback.print_exc()
                return self.send_json(500, {"error": str(error)})

        self.send_error(404)

    def send_json(self, status, payload):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, format_string, *args):
        if self.path.startswith("/health"):
            return
        print("[BRIDGE] " + (format_string % args), flush=True)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    print(
        f"[BRIDGE] Server running on port {BRIDGE_PORT}; default target {WHATSAPP_PACKAGE}; "
        f"supported targets {', '.join(WHATSAPP_PACKAGES)} at "
        f"{FRIDA_HOST}:{FRIDA_PORT}; auto-launch {'enabled' if AUTO_LAUNCH_WHATSAPP else 'disabled'}; "
        f"auth {'enabled' if BRIDGE_TOKEN else 'disabled'}",
        flush=True,
    )
    if WARMUP_ENABLED:
        threading.Thread(target=warmup_worker, name="play-integrity-warmup", daemon=True).start()
    Server(("0.0.0.0", BRIDGE_PORT), Handler).serve_forever()
