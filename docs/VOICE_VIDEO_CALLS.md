# Voice & Video Calls Guide

O InfiniteAPI faz **chamadas de voz e de vídeo** pelo WhatsApp usando um engine
de mídia embutido (WebAssembly — o mesmo do WhatsApp Web). A mídia trafega
**P2P pelos servidores do próprio WhatsApp** (ICE/TURN), sem SDK externo e sem
servidor de mídia próprio.

- ✅ Áudio outbound e inbound
- ✅ **Vídeo** (VP8 / H.264 / AV1 negociados automaticamente)
- ✅ Acesso direto ao PCM/frames (gravação, IVR, STT, etc.)
- ✅ Funciona pela mesma sessão Baileys que você já usa para mensagens

---

## Como funciona

Toda a chamada é feita pela classe `VoipClient`, exportada pelo pacote:

```typescript
import { VoipClient } from 'baileys'
```

Ela tem **dois modos**:

| Modo | Config | Quando usar |
|---|---|---|
| **Standalone** | `{ authDir }` | Servidor dedicado a chamadas — cria a própria sessão e imprime o QR na 1ª vez |
| **Embedded** | `{ socket }` | Você já tem um socket Baileys aberto (mensagens) e quer reaproveitá-lo |

Passe **um** dos dois, nunca os dois.

### Dependências

- O engine de mídia (WASM) já vem no pacote — **nada a instalar** para tocar um
  arquivo de áudio ou receber PCM/frames.
- Para **áudio ao vivo** (capturar microfone de um navegador e reencodar),
  instale `ffmpeg` no host e, se for fazer a ponte via WebRTC, o peer opcional
  `@roamhq/wrtc`.

---

## Visão geral da API

| Ação | Chamada |
|---|---|
| Conectar o engine | `await voip.connect()` |
| Ligar (áudio) | `await voip.call(numero, { audioSource })` |
| Ligar (vídeo) | `await voip.call(numero, { video: { output: 'yuv420' } })` |
| Receber chamadas | `voip.on('incoming', handle => …)` |
| Atender | `await handle.accept({ audioSource, video })` |
| Rejeitar | `await handle.reject('busy')` |
| Desligar | `call.end()` |
| Eventos | `call.on('ringing' | 'connected' | 'audio' | 'video-frame' | 'ended' | 'error', …)` |

---

## 1. Fazer uma chamada de ÁUDIO

```typescript
import { VoipClient } from 'baileys'

const voip = new VoipClient({ authDir: './auth_calls' })
await voip.connect() // 1ª vez: escaneie o QR impresso no terminal

const call = await voip.call('5511999999999', {
  audioSource: './mensagem.mp3', // MP3/WAV tocado no uplink; ou 'silence'
  durationMs: 60_000             // desliga sozinho após 60s (0 = sem limite)
})

call.on('ringing',   () => console.log('chamando…'))
call.on('connected', () => console.log('atendida!'))
call.on('audio',     (pcm) => { /* Float32 PCM 16 kHz mono do outro lado */ })
call.on('ended',     (reason) => console.log('encerrada:', reason))
call.on('error',     (err) => console.error(err))
```

**`voip.call(phoneNumber, options)`**

| Campo | Tipo | Descrição |
|---|---|---|
| `phoneNumber` | string | Número com DDI/DDD, só dígitos (ex.: `"5511999999999"`) |
| `audioSource` | string | Fonte do áudio de saída: caminho de um MP3/WAV, `"silence"`, ou uma URL de stream que o `ffmpeg` leia (ver "áudio ao vivo") |
| `durationMs` | number | Auto-desliga após N ms (padrão `120000`; `0` = sem limite) |
| `video` | VideoConfig | Presente = chamada de **vídeo** (ver abaixo) |

Retorna um `ActiveCall`.

---

## 2. Fazer uma chamada de VÍDEO

Basta passar `video`. A presença desse campo faz o engine negociar o codec de
vídeo com o destinatário.

```typescript
const call = await voip.call('5511999999999', {
  video: { output: 'yuv420' } // formato dos frames entregues a você
})

call.on('connected', () => console.log('vídeo conectado'))
call.on('video-frame', (frame) => {
  // frame.data (Buffer), frame.width, frame.height, frame.timestamp
})
```

**`VideoConfig`**

| Campo | Valores | Descrição |
|---|---|---|
| `output` | `'h264-raw'` \| `'yuv420'` \| `'rgba'` | `h264-raw` = NAL units crus (você decodifica); `yuv420`/`rgba` = já decodificado |
| `decoder` | `'libavjs'` \| `'ffmpeg'` \| `'auto'` | Backend de decode (padrão `auto`) |
| `maxFps` | number | Limita os frames entregues (`0` = sem cap) |

---

## 3. Receber chamadas

```typescript
voip.on('incoming', async (incoming) => {
  console.log('chamada de', incoming.fromPn, incoming.isVideo ? '(vídeo)' : '(áudio)')

  // Atender:
  const call = await incoming.accept({ audioSource: 'silence' })
  call.on('connected', () => console.log('atendida'))
  call.on('audio', (pcm) => { /* … */ })

  // …ou rejeitar:
  // await incoming.reject('busy')
})
```

**`IncomingCallHandle`**

| Campo/método | Descrição |
|---|---|
| `callId` | Identificador da chamada |
| `from` / `fromPn` | JID e número do chamador |
| `isVideo` | `true` para chamada de vídeo |
| `isGroup` | `true` para chamada de grupo / link |
| `accept(opts?)` | Atende. `opts`: `{ audioSource?, video?, durationMs? }` → retorna o `ActiveCall` |
| `reject(reason?)` | Rejeita. `reason`: `'busy'` (padrão) \| `'declined'` \| `'timeout'` |

---

## 4. Eventos da chamada (`ActiveCall`)

| Evento | Payload | Quando |
|---|---|---|
| `ringing` | — | O destinatário está tocando |
| `connected` | — | Chamada estabelecida (mídia fluindo) |
| `audio` | `Float32Array` | Frame de áudio do outro lado (16 kHz mono PCM) |
| `video-frame` | `VideoFrame` | Frame de vídeo do outro lado (só se `video` foi setado) |
| `ended` | `string` | Encerrada. Motivo: `hangup` \| `timeout` \| `rejected` \| `remote_end` \| `disconnect` |
| `error` | `Error` | Falha durante a chamada |

---

## 5. Encerrar (desligar)

```typescript
call.end()               // desliga localmente (síncrono)
await call.waitForEnd()  // aguarda o teardown completar (opcional)
```

---

## 6. Áudio ao vivo (microfone ↔ WhatsApp)

Para tocar áudio **ao vivo** (ex.: microfone de um navegador) em vez de um
arquivo, aponte `audioSource` para uma URL que o `ffmpeg` consiga ler — o padrão
é um pequeno servidor TCP que serve um stream WAV. Você escreve o PCM do
microfone nesse servidor; o downlink chega pelo evento `audio`.

```typescript
import { createServer } from 'node:net'

// 1) sobe um bridge TCP que serve um stream WAV 16 kHz mono
const SAMPLE_RATE = 16_000
let client: import('node:net').Socket | null = null
const server = createServer((s) => {
  client = s
  s.write(wavHeader(SAMPLE_RATE)) // cabeçalho WAV com tamanho "infinito"
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = (server.address() as any).port

// 2) usa o bridge como fonte de áudio da chamada
const call = await voip.call('5511999999999', {
  audioSource: `tcp://127.0.0.1:${port}`
})

// 3) escreva o PCM do microfone (Int16 LE, 16 kHz mono) conforme chega
function pushMic(pcm16: Buffer) {
  client?.write(pcm16)
}

// 4) downlink: repasse para o seu player / navegador
call.on('audio', (pcm) => sendToClient(pcm)) // Float32 16 kHz

function wavHeader(rate: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(0xffffffff, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(0xffffffff, 40)
  return h
}
```

---

## 7. Expondo como API HTTP (para qualquer aplicação)

Se você quer que **qualquer aplicação** dispare chamadas por HTTP, embrulhe o
`VoipClient` num pequeno serviço. O padrão é: **um `VoipClient` por sessão** +
endpoints REST para o ciclo de vida + um canal em tempo real (WebSocket/Socket.IO)
para o áudio e os eventos.

### 7.1. Manager — um `VoipClient` por sessão

```typescript
import { EventEmitter } from 'node:events'
import { VoipClient, type ActiveCall, type IncomingCallHandle } from 'baileys'

class CallManager extends EventEmitter {
  private clients = new Map<string, VoipClient>()          // sessionId -> client
  private calls = new Map<string, ActiveCall>()            // callId -> call
  private incoming = new Map<string, IncomingCallHandle>() // callId -> handle

  /** Reaproveita o socket Baileys que a sessão já mantém aberto. */
  async ensureClient(sessionId: string, socket: any): Promise<VoipClient> {
    let client = this.clients.get(sessionId)
    if (client) return client

    client = new VoipClient({ socket })
    client.on('incoming', (handle) => {
      this.incoming.set(handle.callId, handle)
      this.emit('incoming', {
        sessionId, callId: handle.callId, from: handle.fromPn, isVideo: handle.isVideo
      })
    })
    await client.connect()
    this.clients.set(sessionId, client)
    return client
  }

  async start(sessionId: string, socket: any, to: string, video: boolean, audioSource: string) {
    const client = await this.ensureClient(sessionId, socket)
    const call = await client.call(to, {
      audioSource,
      ...(video ? { video: { output: 'yuv420' } } : {})
    })
    this.calls.set(call.callId, call)
    this.wire(sessionId, call)
    return call.callId
  }

  hangup(callId: string) {
    this.calls.get(callId)?.end()
  }

  async accept(callId: string, video: boolean, audioSource: string) {
    const handle = this.incoming.get(callId)
    if (!handle) throw new Error('incoming call not found')
    const call = await handle.accept({ audioSource, ...(video ? { video: { output: 'yuv420' } } : {}) })
    this.incoming.delete(callId)
    this.calls.set(callId, call as any)
    this.wire('', call as any)
  }

  async reject(callId: string, reason: 'busy' | 'declined' | 'timeout' = 'busy') {
    await this.incoming.get(callId)?.reject(reason)
    this.incoming.delete(callId)
  }

  private wire(sessionId: string, call: ActiveCall) {
    call.on('ringing',   () => this.emit('ringing',   { callId: call.callId, sessionId }))
    call.on('connected', () => this.emit('connected', { callId: call.callId, sessionId }))
    call.on('audio',     (pcm) => this.emit('audio', { callId: call.callId, pcm }))
    call.on('video',     (frame) => this.emit('video', { callId: call.callId, frame }))
    call.on('ended',     (reason) => { this.emit('ended', { callId: call.callId, reason }); this.calls.delete(call.callId) })
    call.on('error',     (err) => this.emit('error', { callId: call.callId, error: String(err?.message ?? err) }))
  }
}

export const callManager = new CallManager()
```

### 7.2. Endpoints REST

```
POST /v1/calls/initiate   { instance, to, video?, audioSource? }  → { ok, callId }
POST /v1/calls/terminate  { callId }                              → { ok }
POST /v1/calls/accept     { callId, video?, audioSource? }        → { ok }
POST /v1/calls/reject     { callId, reason? }                     → { ok }
```

```typescript
import { Router } from 'express'
import { callManager } from './call-manager'
import { getSocket } from './sessions' // seu registro de sessões Baileys

const router = Router()

// POST /v1/calls/initiate
router.post('/v1/calls/initiate', async (req, res) => {
  const { instance, to, video = false, audioSource = 'silence' } = req.body || {}
  try {
    const socket = getSocket(instance)
    if (!socket) return res.status(404).json({ ok: false, error: 'instance_not_found' })
    const callId = await callManager.start(instance, socket, to, !!video, audioSource)
    return res.json({ ok: true, callId })
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
})

// POST /v1/calls/terminate
router.post('/v1/calls/terminate', (req, res) => {
  callManager.hangup(req.body?.callId)
  res.json({ ok: true })
})

// POST /v1/calls/accept
router.post('/v1/calls/accept', async (req, res) => {
  const { callId, video = false, audioSource = 'silence' } = req.body || {}
  await callManager.accept(callId, !!video, audioSource)
  res.json({ ok: true })
})

// POST /v1/calls/reject
router.post('/v1/calls/reject', async (req, res) => {
  await callManager.reject(req.body?.callId, req.body?.reason)
  res.json({ ok: true })
})

export default router
```

Exemplo de disparo por qualquer aplicação:

```bash
# Chamada de ÁUDIO
curl -X POST http://localhost:8787/v1/calls/initiate \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{ "instance": "main", "to": "5511999999999" }'

# Chamada de VÍDEO
curl -X POST http://localhost:8787/v1/calls/initiate \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{ "instance": "main", "to": "5511999999999", "video": true }'

# Desligar
curl -X POST http://localhost:8787/v1/calls/terminate \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{ "callId": "A1B2C3…" }'
```

### 7.3. Áudio e eventos em tempo real (WebSocket)

O ciclo de vida (`ringing`/`connected`/`ended`) e o áudio (`audio`) são
contínuos — entregue-os por um canal em tempo real. O microfone do cliente
volta pela mesma via para o bridge de áudio (item 6).

```typescript
import { Server as IoServer } from 'socket.io'
import { callManager } from './call-manager'

export function attachCallsToIo(io: IoServer) {
  callManager.on('ringing',   (p) => io.to(`call:${p.callId}`).emit('call:ringing', p))
  callManager.on('connected', (p) => io.to(`call:${p.callId}`).emit('call:connected', p))
  callManager.on('ended',     (p) => io.to(`call:${p.callId}`).emit('call:ended', p))
  callManager.on('audio',     ({ callId, pcm }) => io.to(`call:${callId}`).emit('call:audio', pcm.buffer))

  io.on('connection', (socket) => {
    socket.on('call:join',  ({ callId }) => socket.join(`call:${callId}`))
    socket.on('call:mic',   ({ callId, pcm }) => pushMicToBridge(callId, Buffer.from(pcm)))
  })
}
```

---

## Notas

- **Áudio:** downlink em `Float32Array` PCM **16 kHz mono**; uplink por arquivo,
  `'silence'`, ou stream (bridge WAV/`ffmpeg`).
- **Vídeo:** codec (VP8/H.264/AV1) e ICE são negociados pelo próprio engine —
  você só escolhe o formato de saída (`h264-raw`/`yuv420`/`rgba`).
- **Grupos / links de chamada:** suportados para **receber/entrar**; iniciar
  chamada de grupo ainda não.
- **Auto-hangup:** `durationMs` encerra a chamada sozinho — útil para avisos
  automáticos/IVR (padrão 120 s; `0` desativa).
- **Mídia P2P:** usa os servidores STUN/TURN do próprio WhatsApp — sem
  infraestrutura de mídia adicional.
