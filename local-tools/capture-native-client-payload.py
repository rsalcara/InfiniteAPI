from pathlib import Path
import os
import sys
import threading
import time

import frida


PACKAGE = os.getenv("FRIDA_PACKAGE", "com.whatsapp.w4b")
HOOK = Path(__file__).with_suffix(".js")
CAPTURED = threading.Event()


def on_message(message, data):
    if message["type"] == "send":
        print(message["payload"], flush=True)
        if '"hex":' in str(message["payload"]):
            CAPTURED.set()
    elif message["type"] == "log":
        payload = message.get("payload", "")
        print(payload, flush=True)
        if '"hex":' in str(payload):
            CAPTURED.set()
    elif message["type"] == "error":
        print(message.get("stack", message), file=sys.stderr, flush=True)
    else:
        print(message, flush=True)


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

try:
    deadline = time.monotonic() + float(os.getenv("CAPTURE_SECONDS", "60"))
    while time.monotonic() < deadline and not CAPTURED.wait(timeout=0.25):
        pass
except KeyboardInterrupt:
    pass
finally:
    session.detach()
