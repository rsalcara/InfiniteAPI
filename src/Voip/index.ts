/**
 * VoIP module — WhatsApp voice calling for Node.js.
 *
 * Wraps WhatsApp Web's official VoIP WASM stack and routes signaling through
 * the fork's own socket. Public surface:
 *
 *   const client = new VoipClient({ authDir })
 *   await client.connect()
 *   const call = await client.call("12345678901", { audioSource: "./hi.mp3" })
 *
 * `@roamhq/wrtc` + `qrcode-terminal` are declared as OPTIONAL peer
 * dependencies so the published package doesn't force ~50MB of native WebRTC
 * bindings on users who never place a call. `ffmpeg` on PATH is also
 * required for MP3/WAV source decoding.
 *
 * The `whatsapp.wasm` / `loader.js` / `worker-modules.js` blobs in
 * `assets/wasm/` originate from WhatsApp Web's own VoIP module
 * (Meta-authored binaries).
 */
import { EventEmitter } from "node:events";
import { randomBytes, createHmac } from "node:crypto";
import { resolve } from "node:path";

import { WasmEngine } from "./wasm-engine.js";
import { RelayRtcTransport, type RelayListUpdatePayload } from "./relay-transport.js";
import { SignalingBridge } from "./signaling.js";
import { AudioFeeder } from "./audio-feeder.js";
import { CallState, type VoipSdkConfig } from "./types.js";

export type { VoipSdkConfig, CallOptions, CallEvents, AudioConfig } from "./types.js";
export { CallState } from "./types.js";

// Direct imports from our own InfiniteAPI codebase — the third-party
// version lazy-loaded `@whiskeysockets/baileys` as a peer dep. Inside the fork
// we ship as part of the same package, so static imports are cleaner and
// remove the runtime `import()` ceremony.
import makeWASocket from "../Socket/index";
import { useMultiFileAuthState } from "../Utils/use-multi-file-auth-state";
import { DisconnectReason } from "../Types/index";

const SHA256_LEN = 32;

const loadBaileys = async (): Promise<any> => ({
  default: makeWASocket,
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
});

const toBareJid = (jid: string): string => {
  if (!jid) return jid;
  const at = jid.indexOf("@");
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(":")[0];
  return `${user}@${jid.slice(at + 1)}`;
};

const computeHkdf = (
  key: Uint8Array,
  salt: Uint8Array | null,
  info: Uint8Array,
  length: number,
): Uint8Array => {
  const effectiveSalt = salt && salt.length > 0 ? Buffer.from(salt) : Buffer.alloc(SHA256_LEN, 0);
  const prk = createHmac("sha256", effectiveSalt).update(key).digest();
  const blocks = Math.ceil(length / SHA256_LEN);
  const okm = Buffer.alloc(blocks * SHA256_LEN);
  let prev = Buffer.alloc(0);
  for (let i = 1; i <= blocks; i += 1) {
    prev = createHmac("sha256", prk)
      .update(prev)
      .update(info)
      .update(Buffer.from([i]))
      .digest();
    prev.copy(okm, (i - 1) * SHA256_LEN);
  }
  return new Uint8Array(okm.buffer, okm.byteOffset, length);
};

const computeHmacSha256 = (data: Uint8Array, key: Uint8Array): Uint8Array => {
  const result = createHmac("sha256", Buffer.from(key)).update(data).digest();
  return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
};

const isCallReceiptNode = (node: any): boolean => {
  if (node?.tag !== "receipt") return false;
  const child = Array.isArray(node.content) ? node.content[0] : null;
  return !!(child?.attrs?.["call-id"] || child?.attrs?.call_id);
};

/** A live or recently-ended call. */
export class ActiveCall extends EventEmitter {
  #state: CallState = CallState.Idle;
  #endResolver!: (reason: string) => void;
  readonly #endPromise: Promise<string>;
  #endTimer: NodeJS.Timeout | null = null;
  #ended = false;

  /** @internal mirrors the source path for the audio feeder */
  _audioSource: string = "silence";

  constructor(
    public readonly callId: string,
    private readonly engine: WasmEngine,
    durationMs: number,
  ) {
    super();
    this.#endPromise = new Promise((res) => { this.#endResolver = res; });
    if (durationMs > 0) {
      this.#endTimer = setTimeout(() => this.end(), durationMs);
    }
  }

  get state(): CallState { return this.#state; }

  end = (): void => {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#endTimer) { clearTimeout(this.#endTimer); this.#endTimer = null; }
    try { this.engine.endCall(0, true); } catch {}
  };

  mute = (muted: boolean): void => {
    try { this.engine.setMute(muted); } catch {}
  };

  waitForEnd = (): Promise<string> => this.#endPromise;

  /** @internal — called by VoipClient on WASM call-state change */
  _updateState = (state: number): void => {
    this.#state = state as CallState;
    if (state === CallState.PreacceptReceived) this.emit("ringing");
    else if (state === CallState.Active) this.emit("connected");
    else if (state === CallState.Idle || state === CallState.Ending) {
      this._forceEnd("ended");
    }
  };

  /** @internal */
  _emitAudio = (pcm: Float32Array): void => { this.emit("audio", pcm); };

  /** @internal */
  _forceEnd = (reason: string): void => {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#endTimer) { clearTimeout(this.#endTimer); this.#endTimer = null; }
    this.emit("ended", reason);
    this.#endResolver(reason);
  };
}

/** Top-level client. Connects to WhatsApp and lets you place calls. */
export class VoipClient extends EventEmitter {
  readonly #config: VoipSdkConfig;
  #engine: WasmEngine | null = null;
  #relay: RelayRtcTransport | null = null;
  #signaling: SignalingBridge | null = null;
  #sock: any = null;
  #activeCall: ActiveCall | null = null;
  #baileys: any = null;
  /** Tracks incoming call IDs we have already surfaced as `'incoming'` to dedupe
   *  re-emits when the same `<call>` stanza is delivered with multiple children
   *  (e.g. offer + transport in the same node). */
  #seenIncomingIds = new Set<string>();

  // Capture state populated when WASM negotiates audio params
  #capturePtr = 0;
  #captureChunkBytes = 0;
  #captureSampleRate = 16000;
  #captureChannels = 1;
  #captureFramesPerChunk = 320;
  #feeder: AudioFeeder | null = null;

  constructor(config: VoipSdkConfig) {
    super();
    if (!config.authDir && !config.socket) {
      throw new Error('VoipSdkConfig: must provide either `authDir` (standalone) or `socket` (embedded).');
    }
    if (config.authDir && config.socket) {
      throw new Error('VoipSdkConfig: `authDir` and `socket` are mutually exclusive — pass one only.');
    }
    this.#config = config;
  }

  /**
   * Connect to WhatsApp and bring up the WASM VoIP stack.
   *
   * Two modes:
   *  - **Embedded** (`config.socket` provided): skips auth/QR; reuses the
   *    caller's socket. Returns once the WASM engine is up.
   *  - **Standalone** (`config.authDir` provided): creates its own Baileys
   *    socket, prints QR on first run, waits for connection.
   */
  connect = async (): Promise<void> => {
    // Embedded mode: socket already provided by the caller. Skip the
    // auth/QR ceremony and go straight to wiring the WASM stack.
    if (this.#config.socket) {
      this.#sock = this.#config.socket;
      await this.#initEngineWithSocket();
      this.#wireIncomingCallListener();
      return;
    }

    this.#baileys = await loadBaileys();
    const { useMultiFileAuthState, default: makeWASocket, DisconnectReason } = this.#baileys;
    const makeSocket: (opts: any) => any =
      makeWASocket ?? this.#baileys.makeWASocket ?? this.#baileys;

    // `authDir` is required in standalone mode — the constructor guard above
    // already rejected configs that have neither `authDir` nor `socket`, so
    // by the time we get here the non-null assertion is sound.
    const authDir = resolve(this.#config.authDir!);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const silentLogger: any = {
      level: "silent",
      child: () => silentLogger,
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    };

    const createSocket = () => makeSocket({
      auth: state,
      emitOwnEvents: true,
      logger: silentLogger,
    });

    // Connect with auto-reconnect on the post-QR 515 stream-error path.
    await new Promise<void>((resolveOpen, rejectOpen) => {
      let opened = false;
      let retries = 0;
      const maxRetries = 5;

      const connectSocket = () => {
        this.#sock = createSocket();
        this.#sock.ev.on("creds.update", saveCreds);

        process.removeAllListeners("uncaughtException");
        process.on("uncaughtException", (err: any) => {
          const code = err?.output?.statusCode ?? err?.data?.attrs?.code;
          if ((code === 515 || code === "515") && !opened && retries < maxRetries) {
            retries += 1;
            setTimeout(connectSocket, 1500);
          } else if (!opened) {
            rejectOpen(err);
          }
        });

        this.#sock.ev.on("connection.update", (update: any) => {
          if (update.qr) {
            void import("qrcode-terminal")
              .then((qrt) => (qrt.default ?? qrt).generate(update.qr, { small: true }))
              .catch(() => {
                console.log("Scan this QR code in WhatsApp > Linked Devices:");
                console.log(update.qr);
              });
          }
          if (update.connection === "open") {
            opened = true;
            process.removeAllListeners("uncaughtException");
            resolveOpen();
            return;
          }
          if (update.connection === "close" && !opened) {
            const statusCode = update.lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect =
              statusCode === 515 || statusCode === DisconnectReason?.restartRequired;
            if (shouldReconnect && retries < maxRetries) {
              retries += 1;
              setTimeout(connectSocket, 1000);
            } else {
              rejectOpen(update.lastDisconnect?.error ?? new Error("socket closed before open"));
            }
          }
        });
      };

      connectSocket();
    });

    await this.#initEngineWithSocket();
    this.#wireIncomingCallListener();
  };

  /**
   * Spin up the WASM engine + RTP transport + signaling bridge against the
   * already-attached `this.#sock`. Extracted from the original `connect()`
   * body so it can be reused by the embedded-mode path (which skips the
   * QR/auth ceremony and goes straight here).
   */
  #initEngineWithSocket = async (): Promise<void> => {
    this.#signaling = new SignalingBridge({ sock: this.#sock });
    await this.#signaling.init();

    this.#relay = new RelayRtcTransport({
      onTransportMessage: (data, ip, port) => this.#engine?.handleOnTransportMessage(data, ip, port),
      onIceRtt: (rttMs, ip, port) => this.#engine?.updateIceRtt(rttMs, ip, port),
    });

    this.#engine = new WasmEngine({
      callbacks: {
        onSignalingXmpp: (peerJid, callId, xmlPayload) =>
          this.#signaling!.sendSignaling(peerJid, callId, xmlPayload),
        onCallEvent: (eventType, eventData) => this.#handleCallEvent(eventType, eventData),
        sendDataToRelay: (data, ip, port) => this.#relay!.send(data, ip, port),
        onAudioCaptureInit: (config) => this.#handleAudioCaptureInit(config),
        onAudioCaptureStart: () => this.#handleAudioCaptureStart(),
        onAudioCaptureStop: () => this.#handleAudioCaptureStop(),
        onAudioPlaybackData: (audioData) => this.#activeCall?._emitAudio(audioData),
        cryptoHkdf: computeHkdf,
        hmacSha256: computeHmacSha256,
      },
    });

    await this.#engine.initialize();
    this.#signaling.attachEngine(this.#engine);

    const selfPnJid = this.#sock.authState.creds.me?.id;
    const selfLidJid = this.#sock.authState.creds.me?.lid;
    this.#engine.initVoipStack(selfPnJid, toBareJid(selfPnJid), selfLidJid);
    await this.#engine.waitForVoipStackReady();
    try { this.#engine.updateNetworkMedium(2, 0); } catch {}

    // Direct binary-node hooks used for incoming stanza processing. In embedded
    // mode the socket exposes `.ws` (the underlying ws.WebSocket); in standalone
    // mode it's the socket the client just built. Both expose the same handle.
    if (this.#sock.ws?.on) {
      this.#sock.ws.on("CB:call", (node: any) => {
        this.#signaling!.processIncomingCall(node, this.#engine!, this.#activeCall?.callId ?? "");
      });
      this.#sock.ws.on("CB:receipt", (node: any) => {
        if (!isCallReceiptNode(node)) return;
        this.#signaling!.processIncomingReceipt(node, this.#engine!, this.#activeCall?.callId ?? "");
      });
    }
  };

  /**
   * Subscribe to the socket's `'call'` event. When an offer arrives that we
   * haven't already surfaced (dedupe by call-id), construct an
   * `IncomingCallHandle` and emit `'incoming'` so the caller can
   * `accept()` / `reject()`.
   *
   * Other call statuses (`terminate`, `transport`, `relaylatency`, etc.)
   * are forwarded into the engine via the SignalingBridge — this listener
   * only cares about the `offer` first-touch.
   */
  #wireIncomingCallListener = (): void => {
    if (!this.#sock?.ev?.on) return;
    this.#sock.ev.on('call', (calls: Array<Record<string, unknown>>) => {
      for (const call of calls) {
        if (call?.status !== 'offer') continue;
        const callId = String(call.id ?? '');
        if (!callId || this.#seenIncomingIds.has(callId)) continue;
        this.#seenIncomingIds.add(callId);
        const incoming = this.#makeIncomingHandle(call);
        this.emit('incoming', incoming);
      }
    });
  };

  /**
   * Build an `IncomingCallHandle` for an `'offer'` event from the socket.
   * `accept()` performs the signaling stanza + sets up the active call;
   * `reject()` just sends the rejection signaling and removes the dedupe
   * marker so a re-offer with the same id can be surfaced again.
   */
  #makeIncomingHandle = (call: Record<string, unknown>): import('./types.js').IncomingCallHandle => {
    const self = this;
    const callId = String(call.id ?? '');
    const from = String(call.from ?? '');
    const fromPn = (call.callerPn as string | undefined) ?? undefined;
    const isVideo = !!call.isVideo;
    const isGroup = !!call.isGroup;
    const arrivedAt = call.date instanceof Date ? call.date : new Date();

    return {
      callId,
      from,
      fromPn,
      isVideo,
      isGroup,
      arrivedAt,
      accept: async (opts) => {
        if (!self.#sock?.acceptCall) {
          throw new Error('Socket does not expose acceptCall — is the fork’s call signaling wired up?');
        }
        // Pre-accept first (acknowledges ringing without committing audio
        // path yet), then accept proper. Matches what WA Web does on
        // incoming-call answer.
        if (self.#sock.preacceptCall) {
          await self.#sock.preacceptCall(callId, from, isVideo);
        }
        await self.#sock.acceptCall(callId, from, isVideo);

        // Spin up an ActiveCall and hand it back. The engine was already
        // initialised in `connect()`; we just need to register the call id
        // so audio playback / video frame dispatch routes through it.
        const active = new ActiveCall(callId, self.#engine!, opts?.durationMs ?? 0);
        // mark the source so AudioFeeder can attach later if requested
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (active as any)._audioSource = opts?.audioSource ?? 'silence';
        self.#activeCall = active;
        return active as unknown as import('./types.js').ActiveCallHandle;
      },
      reject: async (reason) => {
        if (!self.#sock?.rejectCall) {
          throw new Error('Socket does not expose rejectCall — is the fork’s call signaling wired up?');
        }
        await self.#sock.rejectCall(callId, from);
        // Allow a re-offer with the same id to surface again (the server
        // sometimes redelivers an offer when the recipient ignored the
        // first attempt).
        self.#seenIncomingIds.delete(callId);
        if (reason) {
          // Surface as an `ended` event semantically — useful for logging.
          self.emit('rejected', { callId, reason });
        }
      },
    };
  };

  /** Place an outbound voice call. */
  call = async (
    phoneNumber: string,
    opts: { audioSource?: string; durationMs?: number } = {},
  ): Promise<ActiveCall> => {
    if (!this.#engine || !this.#signaling) throw new Error("Not connected. Call connect() first.");
    if (this.#activeCall) throw new Error("A call is already active.");

    const targetNumber = phoneNumber.replace(/\D/g, "");
    const targetPnJid = `${targetNumber}@s.whatsapp.net`;
    const durationMs = opts.durationMs ?? 120_000;
    const audioSource = opts.audioSource ?? "silence";

    const peerLid = await this.#signaling.resolveLid(targetPnJid);
    if (!peerLid) throw new Error(`Could not resolve LID for ${targetPnJid}`);

    for (const jid of [targetPnJid, peerLid]) {
      try { await this.#sock.presenceSubscribe(jid); } catch {}
    }
    await new Promise((r) => setTimeout(r, 750));

    const peerDeviceJids = await this.#signaling.discoverPeerDevices(peerLid);
    const deviceList = peerDeviceJids.length ? peerDeviceJids : [toBareJid(peerLid)];

    await this.#signaling.ensureSessionsForPeers(deviceList);

    await new Promise((r) => setTimeout(r, 500));
    await this.#signaling.issueTcToken(peerLid);
    const tcToken = await this.#signaling.ensureTcToken(peerLid, targetPnJid);

    const callId = ("00" + randomBytes(16).toString("hex").slice(2)).toUpperCase();

    const call = new ActiveCall(callId, this.#engine, durationMs);
    call._audioSource = audioSource;
    this.#activeCall = call;

    this.#engine.startCall({
      peerJid: peerLid,
      peerPn: targetPnJid,
      peerList: deviceList,
      callId,
      isVideo: false,
      isLidCall: true,
      isFromDialer: false,
      extraData: tcToken,
    });

    return call;
  };

  /** Tear down the WhatsApp socket and release resources. */
  disconnect = (): void => {
    this.#activeCall?._forceEnd("disconnect");
    this.#activeCall = null;
    this.#relay?.closeAll();
    this.#engine?.destroy();
    this.#sock?.end?.();
    this.#engine = null;
    this.#relay = null;
    this.#signaling = null;
    this.#sock = null;
  };

  // ─── private ──────────────────────────────────────────────────────────────

  #handleCallEvent = (eventType: number, eventData?: string): void => {
    if (eventType === 16 && eventData) {
      try {
        const parsed = JSON.parse(eventData);
        const info = parsed.call_info ?? parsed.callInfo ?? {};
        const callState = Number(info.call_state ?? info.callState ?? 0);
        this.#activeCall?._updateState(callState);
      } catch {}
    } else if (eventType === 156 && eventData) {
      try {
        const update = JSON.parse(eventData) as RelayListUpdatePayload;
        this.#relay?.updateRelayList(update);
      } catch {}
    } else if (eventType === 2) {
      this.#activeCall?._forceEnd("remote_end");
    }
  };

  #handleAudioCaptureInit = (config: {
    sampleRate: number; channels: number; bitsPerSample: number; framesPerChunk: number;
  }): void => {
    if (!this.#engine) return;
    this.#captureSampleRate = config.sampleRate || 16000;
    this.#captureChannels = config.channels || 1;
    this.#captureFramesPerChunk = config.framesPerChunk || 320;
    const chunkSamples = this.#captureFramesPerChunk * this.#captureChannels;
    this.#captureChunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
    this.#capturePtr = this.#engine.malloc(this.#captureChunkBytes);
  };

  #handleAudioCaptureStart = (): void => {
    if (!this.#engine || !this.#capturePtr) return;
    const audioSource = this.#activeCall?._audioSource ?? "silence";
    this.#feeder = new AudioFeeder(
      this.#captureSampleRate,
      this.#captureChannels,
      this.#captureFramesPerChunk,
      (chunk) => {
        if (this.#engine && this.#capturePtr) this.#engine.sendAudioData(chunk, this.#capturePtr);
      },
      audioSource,
    );
    this.#feeder.start();
  };

  #handleAudioCaptureStop = (): void => {
    this.#feeder?.stop();
    this.#feeder = null;
    if (this.#engine && this.#capturePtr) {
      try { this.#engine.free(this.#capturePtr); } catch {}
      this.#capturePtr = 0;
    }
  };
}
