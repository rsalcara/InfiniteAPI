from pathlib import Path
import json
import os
import sys
import threading
import time

import frida


PACKAGE = os.getenv("FRIDA_PACKAGE", "com.whatsapp.w4b")
HOOK = Path(__file__).with_suffix(".js")
TOOL_DIR = Path(__file__).resolve().parent
OUTPUT_NAME = Path(os.getenv("CAPTURE_OUTPUT", "native-client-payload-capture.jsonl"))
if OUTPUT_NAME.is_absolute() or len(OUTPUT_NAME.parts) != 1:
    raise ValueError("CAPTURE_OUTPUT must be a file name inside local-tools")
OUTPUT = TOOL_DIR / OUTPUT_NAME
CAPTURED = threading.Event()


def record(payload):
    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    fd = os.open(OUTPUT, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8", newline="\n") as capture_file:
        capture_file.write(line + "\n")
    if '"hex":' in line:
        CAPTURED.set()


def on_message(message, data):
    if message["type"] == "send":
        record(message["payload"])
    elif message["type"] == "log":
        payload = message.get("payload", "")
        record({"kind": "log", "payload": payload})
    elif message["type"] == "error":
        print(message.get("stack", message), file=sys.stderr, flush=True)
    else:
        print(message, flush=True)


session = None
try:
    device = frida.get_usb_device(timeout=10)
    print("[NATIVE-CLIENT-PAYLOAD] device acquired", flush=True)
    pid = device.spawn([PACKAGE])
    print(f"[NATIVE-CLIENT-PAYLOAD] spawned suspended {PACKAGE} pid={pid}", flush=True)
    session = device.attach(pid)
    print("[NATIVE-CLIENT-PAYLOAD] attached", flush=True)
    script = session.create_script(HOOK.read_text(encoding="utf-8"))
    script.on("message", on_message)
    script.load()
    device.resume(pid)
    print(f"[NATIVE-CLIENT-PAYLOAD] resumed {PACKAGE} pid={pid}", flush=True)
    deadline = time.monotonic() + float(os.getenv("CAPTURE_SECONDS", "60"))
    while time.monotonic() < deadline and not CAPTURED.wait(timeout=0.25):
        pass
except KeyboardInterrupt:
    pass
finally:
    if session is not None:
        session.detach()
