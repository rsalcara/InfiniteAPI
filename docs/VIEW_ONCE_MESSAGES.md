# Guia de Mensagens de Visualizacao Unica

O InfiniteAPI envia, recebe, classifica e persiste mensagens de visualizacao
unica de **imagem**, **video** e **audio**.

> [!IMPORTANT]
> O contrato completo de recebimento, incluindo os bytes descriptografaveis da
> midia, exige uma **sessao nova pareada por QR no transporte
> `native_android`**. Uma sessao Web existente nao se transforma em Android ao
> trocar uma configuracao. Ela precisa ser removida e pareada novamente.

---

## Visao geral

| Tipo                  | Label do evento   | `message.message_type` | Envio | Recebimento com bytes |
| --------------------- | ----------------- | ---------------------: | ----: | --------------------: |
| Imagem unica          | `view_once_image` |                   `42` |   Sim |        Native Android |
| Video unico           | `view_once_video` |                   `43` |   Sim |        Native Android |
| Audio unico           | `view_once_audio` |                   `82` |   Sim |        Native Android |
| Conteudo indisponivel | `view_once`       |          nao inventado |   N/A |           Placeholder |

O perfil Web continua sendo o padrao estavel da biblioteca. Ele pode receber
`<unavailable type="view_once">` sem a chave, URL ou `directPath` necessarios
para baixar a midia. O consumidor deve mostrar um placeholder e nunca
classificar esse caso como imagem, video ou audio sem evidencia.

### O que o consumidor precisa implementar

Uma integracao completa tem cinco responsabilidades:

1. criar e conservar uma sessao `native_android` pareada por QR;
2. enviar imagem, video ou audio por `sock.sendMessage()` com
   `viewOnce: true`;
3. consumir **todos** os itens de `messages.upsert` e reconhecer os labels
   `view_once_image`, `view_once_video`, `view_once_audio` e `view_once`;
4. baixar ou transmitir a midia enquanto os metadados estiverem disponiveis;
5. publicar para sua aplicacao um contrato que diferencie
   `available: true` de `available: false`.

O evento da InfiniteAPI entrega o `WAMessage`; ele nao entrega automaticamente
um arquivo em uma rota HTTP nem envia um webhook. Essas duas interfaces, quando
necessarias, pertencem ao adaptador do consumidor. A recomendacao e publicar os
metadados no evento e oferecer os bytes por uma rota autenticada, sem colocar
Base64 ou `mediaKey` no webhook.

---

## 1. Pre-requisitos obrigatorios

Para usar o fluxo completo:

1. selecione `native_android` antes de criar a sessao;
2. escolha `business` ou `consumer` antes de gerar o QR;
3. use uma identidade Android coerente e o provider de attestation;
4. gere um QR novo e leia-o com o aplicativo correspondente a variante;
5. persista a identidade e as credenciais para as reconexoes;
6. use `multi_db_sqlite` quando precisar do espelho Android de mensagens e
   metadados de midia.

Exemplo de configuracao de um orquestrador:

```env
INFINITEAPI_TRANSPORT=native_android
INFINITEAPI_AUTH_STORAGE=multi_db_sqlite
NATIVE_ANDROID_APP_VARIANT=business
INFINITEAPI_NATIVE_ANDROID_STATE_DIR=./sessions/native-android-attestation
```

O transporte tambem deve ser informado ao socket:

```ts
const sock = makeWASocket({
	auth: state,
	transportProfile: 'native_android',
	nativeAndroid: {
		enabled: true,
		appVariant: 'business',
		appVersion: [2, 26, 27, 83],
		device,
		historySync,
		attestationProvider
	},
	multiDbStore: store
})
```

Os objetos `device`, `historySync` e `attestationProvider` devem seguir o
contrato descrito em
[`NATIVE_ANDROID_TRANSPORT.md`](./NATIVE_ANDROID_TRANSPORT.md). O provider Node
interno e descrito em
[`NATIVE_ANDROID_NODE_ATTESTATION.md`](./NATIVE_ANDROID_NODE_ATTESTATION.md).

### QR, Pair Code e sessoes existentes

- Native Android usa o fluxo oficial de **QR de aparelhos conectados**.
- Pair Code por numero de telefone pertence ao transporte Web e nao e o fluxo
  de pareamento Native Android.
- Alterar `INFINITEAPI_TRANSPORT` nao converte credenciais ja registradas.
- Para migrar de Web para Native Android, encerre a sessao, remova as
  credenciais antigas, crie uma sessao vazia e leia um QR novo.
- Um QR `business` deve ser lido pelo aplicativo Business; um QR `consumer`,
  pelo aplicativo Consumer.

---

## 2. Enviando mensagens

O InfiniteAPI e uma biblioteca. Seu contrato nativo de envio e
`sock.sendMessage(jid, content)`. O campo `viewOnce: true` fica no objeto de
conteudo, ao lado de `image`, `video` ou `audio`.

### 2.1 Imagem de visualizacao unica

```ts
const result = await sock.sendMessage(jid, {
	image: { url: './media/foto.jpg' },
	caption: 'Foto de visualizacao unica',
	viewOnce: true
})

console.log(result.key.id)
```

Tambem e aceito um `Buffer`:

```ts
await sock.sendMessage(jid, {
	image: imageBuffer,
	caption: 'Foto de visualizacao unica',
	viewOnce: true
})
```

### 2.2 Video de visualizacao unica

```ts
await sock.sendMessage(jid, {
	video: { url: './media/video.mp4' },
	caption: 'Video de visualizacao unica',
	viewOnce: true
})
```

### 2.3 Audio de visualizacao unica

```ts
await sock.sendMessage(jid, {
	audio: { url: './media/audio.ogg' },
	mimetype: 'audio/ogg; codecs=opus',
	ptt: true,
	viewOnce: true
})
```

Para audio comum em vez de nota de voz, use `ptt: false` e o MIME correto do
arquivo.

### Contrato JSON recomendado para adaptadores HTTP

O InfiniteAPI nao cria endpoints HTTP. Uma camada HTTP pode expor os mesmos
campos sem alterar a semantica:

```json
{
	"instance": "main",
	"to": "5511999999999",
	"imageUrl": "https://example.invalid/foto.jpg",
	"caption": "Foto de visualizacao unica",
	"viewOnce": true
}
```

```json
{
	"instance": "main",
	"to": "5511999999999",
	"videoBase64": "BASE64_SEM_QUEBRAS",
	"caption": "Video de visualizacao unica",
	"viewOnce": true
}
```

```json
{
	"instance": "main",
	"to": "5511999999999",
	"audioUrl": "https://example.invalid/audio.ogg",
	"mimetype": "audio/ogg; codecs=opus",
	"ptt": true,
	"viewOnce": true
}
```

A camada HTTP deve validar que `viewOnce` seja usado somente com imagem, video
ou audio e deve retornar pelo menos `ok` e `messageId`.

---

## 3. Recebendo mensagens

Percorra todos os itens de `messages.upsert`; um evento pode conter mais de uma
mensagem.

```ts
import { downloadMediaMessage, getMessageTypeLabel, normalizeMessageContent } from 'baileys'

sock.ev.on('messages.upsert', async ({ messages }) => {
	for (const msg of messages) {
		const messageType = getMessageTypeLabel(msg.message, {
			isViewOnce: msg.key?.isViewOnce
		})

		if (!messageType.startsWith('view_once')) continue

		const content = normalizeMessageContent(msg.message)
		console.log({
			messageId: msg.key?.id,
			messageType,
			image: content?.imageMessage,
			video: content?.videoMessage,
			audio: content?.audioMessage
		})
	}
})
```

### Midia disponivel

Quando o servidor entrega o conteudo ao linked device, o label e um destes:

```text
view_once_image
view_once_video
view_once_audio
```

`normalizeMessageContent(msg.message)` remove wrappers como
`viewOnceMessageV2` e expoe `imageMessage`, `videoMessage` ou `audioMessage`.
Esses objetos carregam `mediaKey`, `directPath`/`url`, MIME, tamanho e demais
metadados necessarios para o download.

### Conteudo indisponivel

Se o WhatsApp nao fornecer a midia, o InfiniteAPI preserva um placeholder:

```ts
const unavailable = msg.key?.isViewOnce === true && msg.messageStubParameters?.includes('view_once_unavailable')
```

Nesse caso:

- `getMessageTypeLabel(...)` retorna `view_once`;
- nao ha bytes para baixar;
- nao e possivel determinar se era imagem, video ou audio;
- o consumidor deve emitir `available: false`;
- nao deve iniciar retry de descriptografia ou inventar um tipo concreto.

O placeholder ainda pode ocorrer em Native Android quando a midia ja foi
aberta, expirou ou o servidor decidiu nao entrega-la. Native Android habilita o
fluxo suportado; ele nao ignora as regras de visualizacao unica do WhatsApp.

---

## 4. Baixando a midia recebida

Use a mensagem original entregue por `messages.upsert`:

```ts
const buffer = await downloadMediaMessage(
	msg,
	'buffer',
	{ host: sock.getMediaHost() },
	{
		logger,
		reuploadRequest: sock.updateMediaMessage
	}
)
```

Para arquivos grandes, prefira streaming:

```ts
const stream = await downloadMediaMessage(
	msg,
	'stream',
	{ host: sock.getMediaHost() },
	{
		logger,
		reuploadRequest: sock.updateMediaMessage
	}
)

stream.pipe(destination)
```

Baixar ou descriptografar a midia **nao envia automaticamente** um recibo de
visualizacao. Nao chame `readMessages` nem emita recibo `played/viewed` se a
operacao deve permanecer apenas tecnica.

Um adaptador pode retornar um descritor neutro ao seu consumidor:

```json
{
	"messageType": "view_once_image",
	"msgId": "MESSAGE_ID",
	"media": {
		"viewOnce": true,
		"available": true,
		"downloadPath": "/messages/MESSAGE_ID/media"
	}
}
```

Para o placeholder:

```json
{
	"messageType": "view_once",
	"msgId": "MESSAGE_ID",
	"media": {
		"viewOnce": true,
		"available": false,
		"downloadPath": null
	}
}
```

---

## 5. Implementacao de referencia do consumidor

O exemplo abaixo concentra a regra de envio em uma funcao. A aplicacao pode
chama-la a partir de uma fila, controller HTTP, job ou outro adaptador.

```ts
import type { WASocket } from 'baileys'

type ViewOnceInput = {
	kind: 'image' | 'video' | 'audio'
	media: Buffer | { url: string }
	caption?: string
	mimetype?: string
	ptt?: boolean
}

export async function sendViewOnce(sock: WASocket, jid: string, input: ViewOnceInput) {
	if (input.kind === 'image') {
		return sock.sendMessage(jid, {
			image: input.media,
			caption: input.caption,
			viewOnce: true
		})
	}

	if (input.kind === 'video') {
		return sock.sendMessage(jid, {
			video: input.media,
			caption: input.caption,
			viewOnce: true
		})
	}

	return sock.sendMessage(jid, {
		audio: input.media,
		mimetype: input.mimetype || 'audio/ogg; codecs=opus',
		ptt: input.ptt ?? true,
		viewOnce: true
	})
}
```

O retorno de `sendViewOnce` e um `WAMessage`; use `result.key.id` como ID
externo da operacao. Nao gere um ID paralelo para substituir essa chave.

### Consumindo o evento recebido

Esta funcao converte a mensagem bruta em um resultado que distingue conteudo
disponivel de placeholder:

```ts
import type { WAMessage, WASocket } from 'baileys'
import { downloadMediaMessage, getMessageTypeLabel, normalizeMessageContent } from 'baileys'

type ConsumedViewOnce = {
	messageId: string | null
	remoteJid: string | null
	remoteJidAlt: string | null
	messageType: 'view_once' | 'view_once_image' | 'view_once_video' | 'view_once_audio'
	available: boolean
	mimetype: string | null
	fileLength: string | null
	data: Buffer | null
}

export async function consumeViewOnce(
	sock: WASocket,
	msg: WAMessage,
	logger: NonNullable<Parameters<typeof downloadMediaMessage>[3]>['logger']
): Promise<ConsumedViewOnce | null> {
	const messageType = getMessageTypeLabel(msg.message, {
		isViewOnce: msg.key?.isViewOnce
	}) as ConsumedViewOnce['messageType']

	if (!messageType.startsWith('view_once')) return null

	const unavailable =
		messageType === 'view_once' || msg.messageStubParameters?.includes('view_once_unavailable') === true

	if (unavailable) {
		return {
			messageId: msg.key?.id || null,
			remoteJid: msg.key?.remoteJid || null,
			remoteJidAlt: msg.key?.remoteJidAlt || null,
			messageType: 'view_once',
			available: false,
			mimetype: null,
			fileLength: null,
			data: null
		}
	}

	const content = normalizeMessageContent(msg.message)
	const media = content?.imageMessage || content?.videoMessage || content?.audioMessage

	if (!media) {
		throw new Error(`view-once ${msg.key?.id || 'sem id'} sem conteudo de midia`)
	}

	const data = await downloadMediaMessage(
		msg,
		'buffer',
		{ host: sock.getMediaHost() },
		{
			logger,
			reuploadRequest: sock.updateMediaMessage
		}
	)

	return {
		messageId: msg.key?.id || null,
		remoteJid: msg.key?.remoteJid || null,
		remoteJidAlt: msg.key?.remoteJidAlt || null,
		messageType,
		available: true,
		mimetype: media.mimetype || null,
		fileLength: media.fileLength ? String(media.fileLength) : null,
		data
	}
}
```

O listener deve percorrer o lote e isolar falhas por mensagem:

```ts
sock.ev.on('messages.upsert', async ({ messages }) => {
	for (const msg of messages) {
		try {
			const received = await consumeViewOnce(sock, msg, logger)
			if (!received) continue

			if (!received.available) {
				await publish({
					...received,
					data: undefined,
					text: 'Mensagem de visualizacao unica indisponivel'
				})
				continue
			}

			await persistOrStream(received)
		} catch (error) {
			logger.error({ messageId: msg.key?.id, error }, 'falha ao consumir mensagem de visualizacao unica')
		}
	}
})
```

`publish` e `persistOrStream` sao pontos de integracao da aplicacao. Eles devem
ser implementados pelo consumidor conforme sua autorizacao, retencao e destino
dos bytes. O exemplo nao define transporte HTTP, webhook ou banco de negocio.

### Download depois de reiniciar o processo

Se o `WAMessage` original nao estiver mais em memoria, consulte os metadados
persistidos no `msgstore.db` e use `downloadContentFromMessage`:

```ts
import { downloadContentFromMessage, wasmBridgeReady } from 'baileys'

const mediaTypeByMessageType = {
	42: 'image',
	43: 'video',
	82: 'audio'
} as const

type PersistedViewOnceRow = {
	message_type: number | null
	media_key: Buffer | null
	direct_path: string | null
	message_url: string | null
}

const row = db
	.prepare(
		`
  SELECT m.message_type, mm.media_key, mm.direct_path, mm.message_url
  FROM message AS m
  JOIN message_view_once_media AS v ON v.message_row_id = m._id
  JOIN message_media AS mm ON mm.message_row_id = m._id
  WHERE m.key_id = ? AND m.from_me = 0
  LIMIT 1
`
	)
	.get(messageId) as PersistedViewOnceRow | undefined

if (!row) {
	throw new Error('view_once_message_not_found')
}

const mediaType = mediaTypeByMessageType[row.message_type as keyof typeof mediaTypeByMessageType]
if (!mediaType || !row.media_key || (!row.direct_path && !row.message_url)) {
	throw new Error('view_once_media_unavailable')
}

await wasmBridgeReady
const stream = await downloadContentFromMessage(
	{
		mediaKey: row.media_key,
		directPath: row.direct_path || undefined,
		url: row.message_url || undefined
	},
	mediaType,
	{ host: sock.getMediaHost() }
)
```

O endpoint que entrega esse stream deve usar autenticacao, autorizacao por
instancia, `Content-Type` real, `Cache-Control: private, no-store` e
`X-Content-Type-Options: nosniff`.

---

## 6. Persistencia no multi-DB SQLite

Com `multiDbStore` conectado ao socket, o espelho em `msgstore.db` grava:

- `message.message_type=42` para imagem unica;
- `message.message_type=43` para video unico;
- `message.message_type=82` para audio unico;
- `message_view_once_media.state=0` para uma mensagem ainda nao aberta;
- `message_media` com chave, URL/caminho, MIME, tamanho e hashes disponiveis.

O estado e monotonicamente promovido: uma redelivery nunca reduz um estado
mais avancado novamente para `0`.

Exemplo de consulta:

```sql
SELECT
  m.key_id,
  m.message_type,
  v.state,
  mm.mime_type,
  mm.file_length,
  mm.media_key,
  mm.direct_path,
  mm.message_url
FROM message AS m
JOIN message_view_once_media AS v ON v.message_row_id = m._id
LEFT JOIN message_media AS mm ON mm.message_row_id = m._id
WHERE m.key_id = ? AND m.from_me = 0
LIMIT 1;
```

Metadados persistidos nao substituem autorizacao. Qualquer endpoint de
download deve autenticar o chamador e limitar a consulta a instancia correta.

---

## 7. Matriz de suporte

| Cenario                                      |                               Web |                   Native Android |
| -------------------------------------------- | --------------------------------: | -------------------------------: |
| Enviar `viewOnce: true` pelo protocolo       |       Fora do contrato deste guia |                              Sim |
| Receber label/placeholder                    |                               Sim |                              Sim |
| Receber imagem unica com bytes               |                     Nao suportado |      Sim, quando disponibilizada |
| Receber video unico com bytes                |                     Nao suportado |      Sim, quando disponibilizado |
| Receber audio unico com bytes                |                     Nao suportado |      Sim, quando disponibilizado |
| Persistir tipos `42`, `43`, `82` no multi-DB | Somente o que o servidor entregar |                              Sim |
| Parear por QR oficial                        |                               Sim | Sim, obrigatorio para este fluxo |
| Parear Native Android por Pair Code          |                     Nao aplicavel |                              Nao |

Para uma integracao que precisa enviar **e** receber o conteudo, considere
`native_android` uma exigencia, nao uma otimizacao.

---

## 8. Seguranca e retencao

- Nao registre `mediaKey`, URL assinada, `directPath`, Base64 ou bytes da midia.
- Nao inclua o conteudo view-once em logs de webhook ou tracing.
- Use autenticacao e autorizacao por instancia no download.
- Responda com `Cache-Control: private, no-store`.
- Evite cache de CDN, proxy reverso, navegador e service worker.
- Aplique TTL curto a arquivos temporarios e remova-os apos o streaming.
- Nao envie receipts de leitura/visualizacao durante processamento tecnico.
- Preserve `available: false` quando o servidor nao entregar o conteudo.

---

## 9. Checklist de homologacao

1. Remova qualquer sessao Web usada no teste.
2. Crie uma sessao vazia com `transportProfile: 'native_android'`.
3. Gere e leia o QR oficial com a variante correta.
4. Confirme no log `platform=ANDROID` ou `platform=SMB_ANDROID`.
5. Envie imagem, video e audio com `viewOnce: true`.
6. Receba os tres tipos a partir de outro numero.
7. Confirme labels `view_once_image`, `view_once_video` e
   `view_once_audio`.
8. Baixe cada midia e valide MIME, tamanho e hash.
9. Confirme os tipos `42`, `43`, `82` e `state=0` no `msgstore.db`.
10. Reinicie o processo e valide a reconexao sem novo QR.
11. Confirme que o download nao alterou o estado nem enviou receipt.
12. Teste um placeholder `view_once_unavailable` sem tentar baixar ou
    adivinhar o tipo.

---

## Referencias

- [`NATIVE_ANDROID_TRANSPORT.md`](./NATIVE_ANDROID_TRANSPORT.md)
- [`NATIVE_ANDROID_NODE_ATTESTATION.md`](./NATIVE_ANDROID_NODE_ATTESTATION.md)
- [`STORAGE_AND_TRANSPORT.md`](./STORAGE_AND_TRANSPORT.md)
