from pathlib import Path
import json
import os
import sys
import threading
import time

import frida


PACKAGE = os.getenv("FRIDA_PACKAGE", "com.whatsapp.w4b")
ATTACH = os.getenv("FRIDA_ATTACH", "0") == "1"
ATTACH_PID = int(os.getenv("FRIDA_PID", "0"))
TOOL_DIR = Path(__file__).resolve().parent
HOOK = Path(__file__).with_suffix(".js")
CAPTURE_SECONDS = float(os.getenv("CAPTURE_SECONDS", "300"))
OUTPUT_NAME = Path(os.getenv("CAPTURE_OUTPUT", "native-registration-capture.jsonl"))
if OUTPUT_NAME.is_absolute() or len(OUTPUT_NAME.parts) != 1:
    raise ValueError("CAPTURE_OUTPUT must be a file name inside local-tools")
OUTPUT = TOOL_DIR / OUTPUT_NAME
COMPLETED = threading.Event()
SEEN_PAYLOAD = False


def record(payload):
    global SEEN_PAYLOAD

    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    fd = os.open(OUTPUT, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8", newline="\n") as capture_file:
        capture_file.write(line + "\n")

    kind = payload.get("kind")
    tag = payload.get("tag")
    print(
        f"[NATIVE-REGISTRATION] captured kind={kind or 'unknown'}"
        + (f" tag={tag}" if tag else ""),
        flush=True,
    )

    if kind == "client-payload":
        SEEN_PAYLOAD = True
    elif (
        kind == "binary-node"
        and tag == "pair-device-sign"
        and SEEN_PAYLOAD
    ):
        COMPLETED.set()


def on_message(message, data):
    if message["type"] == "send":
        record(message["payload"])
    elif message["type"] == "error":
        print(message.get("stack", message), file=sys.stderr, flush=True)
    else:
        print(message, flush=True)


OUTPUT.parent.mkdir(parents=True, exist_ok=True)
OUTPUT.unlink(missing_ok=True)

session = None
try:
    device = frida.get_usb_device(timeout=10)
    print("[NATIVE-REGISTRATION] device acquired", flush=True)
    if ATTACH:
        pid = ATTACH_PID or device.get_process(PACKAGE).pid
        print(f"[NATIVE-REGISTRATION] attaching to running {PACKAGE} pid={pid}", flush=True)
    else:
        pid = device.spawn([PACKAGE])
        print(f"[NATIVE-REGISTRATION] spawned suspended {PACKAGE} pid={pid}", flush=True)
    session = device.attach(pid)
    print("[NATIVE-REGISTRATION] attached", flush=True)
    script = session.create_script(HOOK.read_text(encoding="utf-8"))
    script.on("message", on_message)
    script.load()
    if not ATTACH:
        device.resume(pid)
        print(f"[NATIVE-REGISTRATION] resumed {PACKAGE} pid={pid}", flush=True)
    deadline = time.monotonic() + CAPTURE_SECONDS
    while time.monotonic() < deadline and not COMPLETED.wait(timeout=0.25):
        pass
except KeyboardInterrupt:
    pass
finally:
    if session is not None:
        session.detach()

if COMPLETED.is_set():
    print(f"[NATIVE-REGISTRATION] complete capture written to {OUTPUT}", flush=True)
else:
    print(
        f"[NATIVE-REGISTRATION] capture window ended before pair-device-sign; partial output is at {OUTPUT}",
        file=sys.stderr,
        flush=True,
    )
