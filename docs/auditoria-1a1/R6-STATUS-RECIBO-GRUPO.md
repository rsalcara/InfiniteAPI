# R6 — Status de recibo em grupo + órfão com o inteiro do app

**Item do plano:** R6 de `docs/auditoria-1a1/PLANO_DE_ACAO_PRS.md:88` —
`fix(receipts): status agregado em grupo e órfão com inteiro do app` (restante do R-09, risco médio).

**Data:** 2026-10-15 · **Branch de trabalho:** `docs/auditoria-1a1-producao-motor` (não commitado neste branch)
**PR alvo quando subir:** `InfiniteZAP/InfiniteAPI@develop`.

**Arquivos alterados (8 + 1 novo):**

| Arquivo | Mudança |
| --- | --- |
| `src/Utils/multi-db-sqlite/store.ts` | Migração **v10** do msgstore.db: códigos de órfão 0‑3 → inteiros Android |
| `src/Utils/multi-db-sqlite/message-store-backend.ts` | Coluna `message.recipient_count` no INSERT/upsert + `RecordMessageInput.recipientCount` |
| `src/Utils/multi-db-sqlite/receipt-backend.ts` | Órfão com inteiro Android; agregação de grupo; replay reformulado (18→8, 15 consumido sem apply) |
| `src/Utils/process-message.ts` | `WeakMap` que carrega o `recipient_count` do fan-out até o mirror |
| `src/Socket/messages-send.ts` | Fixa `recipient_count = participantes − 1` no fan-out de grupo |
| `src/Socket/messages-recv.ts` | Apply vivo corrigido (played‑self aplica **8**, inactive nunca aplica) + played‑self em grupo como linha played do próprio usuário |
| `src/__tests__/Utils/message-store-backends.test.ts` | 6 testes novos + 2 ajustados à semântica nova |
| `src/__tests__/Socket/audit-1a1-regressions.test.ts` | Errata R‑09 (expectativas 18→8 e 15→null) + teste novo de played‑self em grupo |
| `src/__tests__/Utils/receipt-orphan-status-migration.test.ts` | **Novo** — migração v10 |

---

## 1. Fidelidade: de onde veio a semântica (o `C25971Db.A02` que faltava)

O plano R-06/R-09 original dizia: *“Para fazer fiel, preciso do smali do `C25971Db.A02` (não foi decompilado) ou de uma captura Frida.”* Isso era verdade no tree **2.26.36.72**. No tree novo **2.26.38.10** (`C:\Users\alcar\Downloads\Whatsapp_decompiler\libwhatsapp_2.26.38.10\study\`) a classe equivalente **está decompilada nas duas formas**:

- **jadx:** `02_jadx\sources\X\C17C.java` — `MessageStatusStore.addReceiptsAndNotifyListeners` (método `A02`), replay de órfãos (`A03`, log `MessageStatusStore/applyingorphanedreceipt`), apply de status (`A01`).
- **apktool:** `01_apktool\base\smali\X\17C.smali` — mesmo método em smali (agregação nos rótulos `:cond_4f` etc., ~5240‑5965), usado para confirmar o fluxo que o jadx desfigura (merge errado de `else if` no laço de contadores).

**Não foi necessária captura Frida**: toda a semântica abaixo foi extraída de fonte primária, com confirmação cruzada jadx↔smali. Classes usadas: `CSY.java` (ReceiptStanzaHelper), `C28106CSb.java` (MessageStatusUpdateHelper), `C17C.java` (MessageStatusStore), `C17E.java` (orphaned receipt store), `C9A.java` (mapa per‑usuário), `AbstractC33221dh.java` (tabela de rank), `A7L.java` (BotUtilPreprocessor — recipient_count), `C28866Cjx.java` (audiência de status).

## 2. Semântica do app (2.26.38.10) — evidência

### 2.1 Tipo de recibo → inteiro (`CSY.A00(String)`, linhas 338‑376)

| tipo no wire | status Android |
| --- | --- |
| `sender`, `delivery` | **5** (DELIVERY_ACK) |
| `read` | **13** (READ) |
| `played` | **8** (PLAYED) |
| `read-self` | **17** (READ_SELF) |
| `played-self` | **18** (PLAYED_SELF) |
| `inactive` | **15** (INACTIVE) |

O tipo é validado antes: desconhecido → exceção `ReceiptStanzaHandler/parseMessageStatusUpdateReceipt unknown type=`. É a mesma tabela que o motor já tinha (`androidStatusFromReceiptType`) — a parte de **parse** do R‑09 estava certa.

### 2.2 Caminho vivo — `C28106CSb` (MessageStatusUpdateHelper)

Para recibo com mensagem **existente** (linhas ~262‑323, triplicada por variantes de CoEx):

```java
c27852CFq = new CFq(deviceJid, userJid, fMessage, CL1(), iCej /* int cru */, timestamp);
if (fMessage.A0X()) { A1B3 }                       // caso especial
else if (fMessage instanceof AbstractC33791ek) { A1B4 }
else if (iCej == 17) { /* efeito colateral */ A1B2+A01  ou  A1B6 com 17 cru }
else if (iCej == 18) {
    A1B5.add(new CFq(device, user, fMessage, CL1(), 8, timestamp));   // ← 18 vira 8
}
else { A1B6.add(c27852CFq); }                      // 5/8/13/15 crus
```

`A1B5`/`A1B6`/`A1B3`/`A1B4` são consumidas por `A00(list)` (“onMessageStatusUpdateForTargets”), que monta `CFH` via `C5W.A00(deviceJid, userJid, fMessage, status, ts)` e alimenta `C17C.A02`. Conclusões:

1. **played‑self (18) aplica status 8 (PLAYED)** no `message.status` — o 18 cru nunca chega ao pipeline de status pelo caminho vivo.
2. **read‑self (17) aplica 17** (com efeito colateral para o marcador de leitura).
3. **inactive (15)**: cai no `A1B6` com 15 cru, e dentro de `C17C.A02` é descartado como *“statusunchanged”* (linha ~400) — **nunca** chega ao `message.status`.

Para mensagem **inexistente** (“nosuchmessage”, linhas ~427‑470): grava órfão com **inteiro cru** — `C27813CEd(deviceJid, userJid, iCej4, ts)` → `put("status", Integer.valueOf(i4))` (18 incluso), `receipt_recipient_jid_row_id` só quando `userJid != null`, e **timestamp ≤ 0 é rejeitado** (“orphanedreceiptstore/…/invalid timestamp”).

### 2.3 Pipeline `C17C.A02` — agregação de grupo (linhas 312‑891)

Split em 4 listas; o que importa:

- **1:1 (não grupo/broadcast/newsletter):** caminho único → `A04(current, incoming)` (downgrade‑ou‑igual) **recusa** e só loga *“splitStatusUpdateReceipts/statusdowngrade”*; caso contrário aplica direto (`A01(fMessage, status)`). É o `shouldAdvanceAndroidMessageStatus` que o motor já usa.
- **Grupo (multi):** filtro por usuário (`filterMultiParticipantReceiptsDowngrade`, ~linha 552): recibo que não é **upgrade estrito** sobre o estado atual daquele usuário é descartado (log *“statusdowngrade”*). O motor alcança o mesmo resultado com os upserts monótonos por coluna (o estado máximo por usuário nunca regride).
- **Persistência por usuário** (`ReceiptUserStore/upsertUserReceiptForMessage` + `C9A.A01`): **somente 5/8/13** viram linha em `receipt_user` (coluna `receipt_timestamp`/`read_timestamp`/`played_timestamp`); 15/17/18 não são persistíveis (o store lança `Unexpected message status N for user receipt`). O motor já tem exatamente esse modelo de 3 colunas.
- **Agregado** (~linhas 823‑891), confirmado no smali (`:cond_4f`):

```java
// por usuário do mapa: 8 → played++ read++ delivered++ ; 13 → read++ delivered++ ; 5 → delivered++
if (played   >= recipientCount) status = 8;
else if (read    >= recipientCount) status = 13;
else { status = 4; if (delivered >= recipientCount) status = 5; }

if (status != atual) {
    if (rank(atual) > rank(status))  // DOWNGRADE
        Log.e("MessageStatusStore/statusDowngrade: … current/new/recipientCount/statuses")  // só telemetria
    A01(fMessage, status);           // APLICA MESMO ASSIM (downgrade incluso)
}
```

Igualdade promove (`>=`). O agregado do multi‑path é aplicado **sempre que difere do atual, inclusive downgrade** — só há log/telemetria. (É por isso que no app o tick do grupo só regride quando o agregado inteiro regride, nunca por um recibo atrasado de um membro.)

### 2.4 Replay do órfão — `C17C.A03` (“applyingorphanedreceipt”)

Le as linhas `ORDER BY _id ASC` (`C17E.A00`), e por linha:

```java
int i3 = receipt.status;                       // inteiro cru gravado
if (i3 == 17) { /* efeito colateral */ }       // 17 continua 17
else if (i3 == 18) { /* efeito colateral */ i3 = 8; }   // 18 → 8 ANTES do pipeline
A02(singletonList(C5W.A00(deviceJid, null, fMessage, i3, ts)));
```

Depois: `C17E.A01` → **DELETE de todas as linhas daquela chave**; retenção de 60 dias (`deleteOldOrphanedReceipts`, cutoff `now − 5184000000` ms). O recibo re‑entra no MESMO pipeline do caminho vivo (logo: em grupo alimenta o agregado; em 1:1 obedece à recusa de downgrade).

### 2.5 `recipient_count` — `A7L.CJ6` (BotUtilPreprocessor, no add‑msg)

```java
grupo:      rc = participantes.size() + (zA03?1:0) − 1;      // EXCLUI o próprio remetente
broadcast:  rc = participantes + (zA03?1:0) − (contém(mim)?1:0);
zA03(1:1):  rc = 2;
1:1 comum:  rc não é setado (fica 0 — irrelevante: 1:1 usa caminho único)
```

Para o motor, só o caso **grupo** importa: `rc = participantes(incluindo eu) − 1`. Coluna persistida em `message.recipient_count` (`AnonymousClass171: put("recipient_count", A06)`).

### 2.6 Errata da MATRIZ R‑09 (importante)

Com o `C25971Db.A02` agora decompilado, **dois pontos da MATRIZ R‑09 precisam de correção**:

| Recibo | MATRIZ R‑09 (motor antigo) | App real (38.10) | Correção aplicada |
| --- | --- | --- | --- |
| `played-self` em `message.status` | gravava **18** | aplica **8** (18 é só o inteiro de wire/órfão) | ✅ apply = 8; órfão continua 18 |
| `inactive` em `message.status` | gravava **15** | **nunca** aplica (drop “statusunchanged”) | ✅ sem apply; órfão continua 15 |

A parte de **parse** (tabela 2.1) e o **órfão com o inteiro cru** estavam certos e continuam.

---

## 3. Implementação — código final por bloco

### 3.1 `store.ts` — migração v10 (msgstore.db)

```ts
{
	// R6 (audit PR-30): `receipt_orphaned.status` now stores the app's own
	// Android status integer, exactly as MessageStatusUpdateHelper writes it
	// (`put("status", i)`, X/C28106CSb.java — 2.26.38.10): delivery 5,
	// read 13, played 8, inactive 15, read-self 17, played-self 18. Older
	// builds invented private codes (0 device ack, 1/2/3 user delivery/
	// read/played); rewrite them in place. NULL (pre-hardening generic ack)
	// is deliberately left NULL — it identifies the replay-by-device shape.
	// The mapping cannot collide on the unique index: 0 was only ever
	// written with a NULL recipient and 1 only with a recipient set.
	version: 10,
	name: 'rewrite legacy receipt orphan codes to Android status integers',
	sql: `
		UPDATE receipt_orphaned
		SET status = CASE status
			WHEN 0 THEN 5
			WHEN 1 THEN 5
			WHEN 2 THEN 13
			WHEN 3 THEN 8
			ELSE status
		END
		WHERE status IN (0, 1, 2, 3);
	`
}
```

### 3.2 `message-store-backend.ts` — `recipient_count`

`RecordMessageInput` ganha o campo:

```ts
/** `message.recipient_count` — the aggregate-status audience the app
 * computes at add-msg time (BotUtilPreprocessor, X/A7L.java — 2.26.38.10):
 * group = participants including me − 1. Drives the group receipt
 * aggregate (MessageStatusStore.A02); NULL when the fan-out count is
 * unknown (history-synced sends), which disables aggregation for that
 * message exactly like an unreadable participant list would. */
recipientCount?: number | null
```

`upsertMessage` (SQL completo):

```ts
upsertMessage: this.db.prepare(
	'INSERT INTO message (chat_row_id, from_me, key_id, sender_jid_row_id, status, timestamp, ' +
		'received_timestamp, server_sts, message_type, text_data, view_mode, recipient_count, sort_id) ' +
		'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
		'ON CONFLICT(chat_row_id, from_me, key_id, sender_jid_row_id) DO UPDATE SET ' +
		'status = CASE ' +
		'WHEN excluded.status IS NULL THEN message.status ' +
		'WHEN message.status IS NULL THEN excluded.status ' +
		'WHEN (CASE excluded.status WHEN 0 THEN 0 WHEN 4 THEN 1 WHEN 5 THEN 2 WHEN 13 THEN 3 WHEN 8 THEN 4 ELSE -1 END) ' +
		'>= (CASE message.status WHEN 0 THEN 0 WHEN 4 THEN 1 WHEN 5 THEN 2 WHEN 13 THEN 3 WHEN 8 THEN 4 ELSE 99 END) ' +
		'THEN excluded.status ELSE message.status END, ' +
		'received_timestamp = COALESCE(excluded.received_timestamp, message.received_timestamp), ' +
		'server_sts = COALESCE(excluded.server_sts, message.server_sts), ' +
		'message_type = COALESCE(excluded.message_type, message.message_type), ' +
		'text_data = COALESCE(excluded.text_data, message.text_data), ' +
		'view_mode = COALESCE(excluded.view_mode, message.view_mode), ' +
		// The app fixes recipient_count once, at add-msg; a later
		// re-record of the same key (retry/history) must not clobber a
		// known count with an unknown one.
		'recipient_count = COALESCE(excluded.recipient_count, message.recipient_count)'
),
```

E a passada de parâmetro em `recordMessageInsideTransaction` (após `viewMode`, antes de `sort_id`): `input.recipientCount ?? null`.

### 3.3 `process-message.ts` — transporte do `recipient_count` (WeakMap)

```ts
// The group fan-out in messages-send knows the participant list; by the time
// the sent message echoes through processMessage that context is gone. Carry
// the app's add-msg recipient_count (participants including me − 1, X/A7L.java)
// on the relayed content object — the same out-of-band pattern as
// rawProtocolSenders. A missed lookup leaves recipient_count NULL, which just
// disables aggregate promotion for that message (R6).
const relayedRecipientCounts = new WeakMap<proto.IMessage, number>()

export const rememberRelayedRecipientCount = (content: proto.IMessage, recipientCount: number): void => {
	relayedRecipientCounts.set(content, recipientCount)
}

export const takeRelayedRecipientCount = (content: proto.IMessage | null | undefined): number | null =>
	(content && relayedRecipientCounts.get(content)) ?? null
```

Na chamada do mirror (dentro de `processMessage`): `recipientCount: takeRelayedRecipientCount(message.message),`

### 3.4 `messages-send.ts` — fixação no fan-out de grupo

```ts
const participantsList = groupData ? groupData.participants.map(p => p.id) : []
// … (ephemeral / statusJidList inalterados) …

if (isGroup) {
	// R6: pin the app's add-msg recipient_count (participants
	// including me − 1, BotUtilPreprocessor X/A7L.java) on the relayed
	// content so the mirrored message row can aggregate group receipt
	// status exactly like MessageStatusStore.A02.
	rememberRelayedRecipientCount(message, Math.max(participantsList.length - 1, 0))
}
```

`message` aqui é o objeto `proto.IMessage` passado a `relayMessageUnsafe` — o **mesmo objeto** que volta pelo `upsertMessage(fullMsg, 'append')` → `processMessage`, então o lookup do WeakMap acerta. Mudança **sem efeito no stanza** (nenhum atributo novo, nenhum caminho de envio alterado — carrossel/interativos intocados).

### 3.5 `receipt-backend.ts` — órfão com inteiro + agregação de grupo

Constantes (códigos 0‑3 extintos):

```ts
/**
 * `receipt_orphaned.status` stores the app's own Android status integer for
 * the receipt, exactly as MessageStatusUpdateHelper writes the row
 * (`put("status", Integer.valueOf(i4))`, X/C28106CSb.java — 2.26.38.10):
 * delivery 5, read 13, played 8, inactive 15, read-self 17, played-self 18.
 * A user-level orphan carries the recipient row; a device-level ack carries
 * a NULL recipient with status 5 — the same distinction as the app's
 * `C27813CEd(deviceJid, userJid|null, status, timestamp)`. Codes 0-3 were an
 * earlier engine invention removed by R6 (msgstore.db migration v10 rewrites
 * any rows still carrying them).
 */
const ORPHAN_KIND_STATUS: Record<ReceiptKind, number> = {
	delivery: ANDROID_MESSAGE_STATUS.DELIVERY_ACK,
	read: ANDROID_MESSAGE_STATUS.READ,
	played: ANDROID_MESSAGE_STATUS.PLAYED
}
```

Filtro do replay e novo statement de agregado:

```ts
listOrphaned: this.db.prepare(
	'SELECT _id, receipt_device_jid_row_id, receipt_recipient_jid_row_id, status, timestamp ' +
		'FROM receipt_orphaned WHERE chat_row_id = ? AND from_me = ? AND key_id = ? ' +
		'AND (status IS NULL OR status IN (5, 8, 13, 15, 17, 18)) ' +
		`ORDER BY _id ASC LIMIT ${RECEIPT_ORPHAN_REPLAY_LIMIT}`
),
// …
getMessageAggregate: this.db.prepare(
	'SELECT status, recipient_count, ' +
		'(SELECT COUNT(*) FROM receipt_user ru WHERE ru.message_row_id = message._id AND ru.played_timestamp IS NOT NULL) AS played_count, ' +
		'(SELECT COUNT(*) FROM receipt_user ru WHERE ru.message_row_id = message._id ' +
		'AND (ru.played_timestamp IS NOT NULL OR ru.read_timestamp IS NOT NULL)) AS read_count, ' +
		'(SELECT COUNT(*) FROM receipt_user ru WHERE ru.message_row_id = message._id ' +
		'AND (ru.played_timestamp IS NOT NULL OR ru.read_timestamp IS NOT NULL OR ru.receipt_timestamp IS NOT NULL)) AS delivered_count ' +
		'FROM message WHERE _id = ?'
),
```

Gravação de órfãos (user e device) — trecho que muda nos dois métodos:

```ts
// recordUserReceipt (mensagem inexistente):
this.stmts.insertOrphaned.run(
	chatRowId, input.fromMe ? 1 : 0, input.keyId,
	receiptUserRowId, receiptUserRowId,          // device = recipient = usuário (bare)
	ORPHAN_KIND_STATUS[input.kind],              // 5 | 13 | 8
	this.orphanTimestamp(input.timestamp)
)

// recordDeviceReceipt (mensagem inexistente):
this.stmts.insertOrphaned.run(
	chatRowId, input.fromMe ? 1 : 0, input.keyId,
	receiptDeviceRowId, null,                    // recipient NULL = ack de dispositivo
	ANDROID_MESSAGE_STATUS.DELIVERY_ACK,         // 5
	this.orphanTimestamp(input.timestamp)
)
```

Gatilho da agregação no fim do `recordUserReceipt`:

```ts
stmt.run(messageRowId, receiptUserRowId, input.timestamp)

// Group receipts promote the message status through the recipient
// aggregate (R6); 1:1 keeps the live handler's single-path advance.
if (isJidGroup(input.chatJid)) {
	this.promoteGroupMessageStatus(messageRowId)
}
```

Método novo (núcleo do R6):

```ts
/**
 * Group aggregate promotion — the multi-participant path of
 * MessageStatusStore.A02 (X/C17C.java:823-891, WhatsApp 2.26.38.10):
 *
 *   played >= recipientCount → PLAYED 8
 *   read    >= recipientCount → READ 13
 *   delivered >= recipientCount → DELIVERY_ACK 5
 *   otherwise → SERVER_ACK 4
 *
 * and, unlike the 1:1 single path, the aggregate is applied whenever it
 * differs from the current status — DOWNGRADES INCLUDED. The app only
 * emits "MessageStatusStore/statusDowngrade" telemetry on the way; the
 * write still happens (which is why a group's ticks can only regress when
 * the aggregate itself regresses, never from one member's stale receipt —
 * the per-user map keeps each member's max state, mirroring our monotonic
 * max-timestamp upserts).
 *
 * Deliberate deviation: a NULL or non-positive `recipient_count` (a send
 * whose fan-out list this engine never saw, e.g. history-synced) skips
 * promotion entirely. The app's add-msg preprocessor always sets the
 * count, so its degenerate recipientCount=0 branch (0 counters >= 0 → 8)
 * is unreachable on a real device; fabricating it here would invent a
 * played state from nothing.
 */
private promoteGroupMessageStatus(messageRowId: number): number | null {
	const row = this.stmts.getMessageAggregate.get(messageRowId) as
		| {
				status: number | null
				recipient_count: number | null
				played_count: number
				read_count: number
				delivered_count: number
		  }
		| undefined
	if (!row || row.recipient_count === null || row.recipient_count <= 0) return null

	const aggregate =
		row.played_count >= row.recipient_count
			? ANDROID_MESSAGE_STATUS.PLAYED
			: row.read_count >= row.recipient_count
				? ANDROID_MESSAGE_STATUS.READ
				: row.delivered_count >= row.recipient_count
					? ANDROID_MESSAGE_STATUS.DELIVERY_ACK
					: ANDROID_MESSAGE_STATUS.SERVER_ACK

	if (aggregate === row.status) return null
	this.stmts.updateMessageStatus.run(aggregate, messageRowId)
	return aggregate
}
```

`replayOrphaned` reformulado (corpo completo):

```ts
/** Replays receipts that arrived before their message row, then removes only rows successfully materialized. */
replayOrphaned(chatJid: string, fromMe: boolean, keyId: string): number {
	return this.db.transaction(() => {
		this.maybePruneExpiredOrphaned(Math.floor(Date.now() / 1000))
		const chatRowId = this.chatResolver.resolveChatRowId(chatJid)
		const messageRowId = this.resolveMessageRowId(chatJid, fromMe, keyId)
		if (messageRowId === null) return 0
		let replayed = 0
		// Same three-way split as MessageStatusStore.A02: status broadcasts
		// never touch message status (status.db owns those receipts); 1:1
		// keeps the single path's advance-only promotion; groups promote
		// through the recipient aggregate once every row is materialized.
		const isGroup = isJidGroup(chatJid)
		const canPromoteMessageStatus = !isJidStatusBroadcast(chatJid)
		const messageStatusRow = canPromoteMessageStatus
			? (this.stmts.getMessageStatus.get(messageRowId) as { status: number | null } | undefined)
			: undefined
		let promotedStatus = messageStatusRow?.status ?? null
		let materializedUserReceipt = false

		for (;;) {
			const rows = this.stmts.listOrphaned.all(chatRowId, fromMe ? 1 : 0, keyId) as Array<{
				_id: number
				receipt_device_jid_row_id: number
				receipt_recipient_jid_row_id: number | null
				status: number | null
				timestamp: number | null
			}>
			if (rows.length === 0) break

			let replayedInBatch = 0
			for (const row of rows) {
				// Pre-hardening rows stored NULL for both receipt forms. They cannot
				// recover the user-level progression kind, but they did preserve the
				// target jid and timestamp; materialize that legacy shape as the
				// schema's generic per-device acknowledgement instead of leaking an
				// unreplayable orphan forever.
				if (row.status === null) {
					this.stmts.upsertDeviceReceipt.run(messageRowId, row.receipt_device_jid_row_id, row.timestamp)
				} else if (row.status === ANDROID_MESSAGE_STATUS.INACTIVE) {
					// inactive(15) never reaches message.status: the app drops it
					// as "statusunchanged" (X/C17C.java:400). The orphan row is
					// consumed so retention doesn't leak it — same end state.
				} else if (row.status === ANDROID_MESSAGE_STATUS.READ_SELF) {
					// read-self(17) replays verbatim (C17C.A03 keeps i3 = 17) and
					// only the non-group single path can apply it — the app's
					// receipt_user store rejects 17 outright (C9A.A01).
					if (!isGroup && shouldAdvanceAndroidMessageStatus(promotedStatus, row.status)) {
						promotedStatus = row.status
					}
				} else if (row.status === ANDROID_MESSAGE_STATUS.PLAYED_SELF) {
					// played-self(18) is normalized to PLAYED 8 at replay
					// ("applyingorphanedreceipt", X/C17C.java:124-129: i3 = 8).
					// In a group the app would also materialize a played
					// receipt_user row for the sending device's user; this
					// engine's orphan row keeps only the device jid row id, so
					// that corner degrades to consuming the row (documented R6
					// deviation — status-only orphans in groups are rare).
					if (!isGroup && shouldAdvanceAndroidMessageStatus(promotedStatus, ANDROID_MESSAGE_STATUS.PLAYED)) {
						promotedStatus = ANDROID_MESSAGE_STATUS.PLAYED
					}
				} else if (row.receipt_recipient_jid_row_id !== null) {
					const stmt =
						row.status === ANDROID_MESSAGE_STATUS.DELIVERY_ACK
							? this.stmts.upsertUserReceiptDelivery
							: row.status === ANDROID_MESSAGE_STATUS.READ
								? this.stmts.upsertUserReceiptRead
								: row.status === ANDROID_MESSAGE_STATUS.PLAYED
									? this.stmts.upsertUserReceiptPlayed
									: null
					if (!stmt) continue
					stmt.run(messageRowId, row.receipt_recipient_jid_row_id, row.timestamp)
					materializedUserReceipt = true
					if (!isGroup && shouldAdvanceAndroidMessageStatus(promotedStatus, row.status)) {
						promotedStatus = row.status
					}
				} else {
					// Device-level delivery ack (status 5, no recipient). The
					// app's replay feeds device acks back through A02, which keys
					// receipt_user by the DEVICE'S USER; group device orphans here
					// were written under the participant's bare jid, so the stored
					// row id already is the user's. Non-group device acks keep the
					// per-device row only (a 1:1 sender's jid may carry a device
					// suffix this schema can't reverse-map to its user).
					this.stmts.upsertDeviceReceipt.run(messageRowId, row.receipt_device_jid_row_id, row.timestamp)
					if (isGroup) {
						this.stmts.upsertUserReceiptDelivery.run(
							messageRowId,
							row.receipt_device_jid_row_id,
							row.timestamp
						)
						materializedUserReceipt = true
					}
				}

				this.stmts.deleteOrphaned.run(row._id)
				replayed += 1
				replayedInBatch += 1
			}

			// Unsupported future status values are excluded by the query and
			// remain available for diagnosis without blocking valid receipts.
			if (rows.length < RECEIPT_ORPHAN_REPLAY_LIMIT || replayedInBatch === 0) break
		}

		if (isGroup) {
			if (materializedUserReceipt) this.promoteGroupMessageStatus(messageRowId)
		} else if (messageStatusRow && promotedStatus !== messageStatusRow.status) {
			this.stmts.updateMessageStatus.run(promotedStatus, messageRowId)
		}

		return replayed
	})()
}
```

### 3.6 `messages-recv.ts` — apply vivo corrigido + played‑self em grupo

`mirrorReceiptStatus` (função completa):

```ts
const mirrorReceiptStatus = () => {
	const androidStatus = androidStatusFromReceiptType(attrs.type)
	if (!receiptChatResolver || !key.remoteJid || androidStatus === null) return
	const statusOnly = attrs.type === 'read-self' || attrs.type === 'played-self' || attrs.type === 'inactive'
	const applyStatus =
		androidStatus === ANDROID_MESSAGE_STATUS.PLAYED_SELF
			? ANDROID_MESSAGE_STATUS.PLAYED
			: androidStatus === ANDROID_MESSAGE_STATUS.INACTIVE
				? null
				: androidStatus
	try {
		for (const id of ids) {
			const applied =
				applyStatus !== null && receiptChatResolver.updateMessageStatus(key.remoteJid, !!key.fromMe, id, applyStatus)
			if (!applied && statusOnly && receiptBackend) {
				receiptBackend.recordStatusOrphan({
					chatJid: key.remoteJid,
					fromMe: !!key.fromMe,
					keyId: id,
					receiptDeviceJid: attrs.from!,
					androidStatus,           // inteiro CRU no órfão (18/15/17)
					timestamp: +(attrs.t ?? 0)
				})
			}
		}
	} catch (err) {
		logger.warn({ err }, 'failed to advance message status mirror')
	}
}
```

Bloco novo (logo após o `if (typeof status === 'undefined' && !isJidGroup(…) …) mirrorReceiptStatus()`):

```ts
// played-self in a group: my other companion played the voice
// note I sent. The app normalizes it to played(8) and stores a
// receipt_user row for MY user (C5W.A00(device, null, ...) →
// device.userJid), which feeds the group aggregate like any
// participant's played receipt. read-self(17) is not storable in
// receipt_user (C9A.A01 rejects it) and inactive(15) is dropped,
// so only played-self needs handling here.
if (
	typeof status === 'undefined' &&
	attrs.type === 'played-self' &&
	isJidGroup(remoteJid) &&
	attrs.participant &&
	receiptBackend &&
	key.remoteJid
) {
	try {
		const resolvedSelfJid = await resolveLidToPn(attrs.participant, lidMapping, logger)
		const normalizedSelfJid = jidNormalizedUser(resolvedSelfJid || attrs.participant)
		for (const id of ids) {
			receiptBackend.recordUserReceipt({
				chatJid: key.remoteJid,
				fromMe: !!key.fromMe,
				keyId: id,
				receiptUserJid: normalizedSelfJid,
				kind: 'played',
				timestamp: +attrs.t!
			})
		}
	} catch (err) {
		logger.warn({ err }, 'failed to record played-self group receipt row')
	}
}
```

**Contrato de eventos intacto:** o consumidor continua recebendo `message-receipt.update` para recibos de participante em grupo e `messages.update` (status Web) para 1:1 — o R6 muda **apenas o mirror msgstore.db** (`message.status` com o inteiro Android), igual ao princípio “mirror only” do R‑09.

---

## 4. Testes

### 4.1 Novos (mensagem‑store backends)

1. `promotes group message status through the recipient aggregate like MessageStatusStore.A02` — progressão completa com `recipientCount: 2`: 1 delivery → 4; 2 deliveries → 5; 1 read → 5; 2 reads → 13; 1 played → 13; 2 played → 8.
2. `keeps a partial group aggregate at the lower status while recipient_count is not reached` — rc=3 com 2 leituras → fica em 4.
3. `applies a group aggregate downgrade like the app multi-participant path` — status 13 importado, agregado real 5 → **aplica 5** (downgrade, como o app).
4. `promotes a group message from orphaned receipts through the aggregate once the message arrives` — 3 órfãos (delivery+read do Alice, read do Bob) → replay → 13, com merge das duas linhas do Alice em uma `receipt_user`.
5. `writes receipt_orphaned rows with the app Android status integer` — linhas de órfão com 5/13/8 (recipient setado) e 5 com recipient NULL para o ack de dispositivo.
6. `materializes an orphan group receipt without promoting … when recipient_count is unknown` (reescrito) — sem `recipient_count`, materializa e **não** promove.

### 4.2 Novo arquivo — migração v10

`src/__tests__/Utils/receipt-orphan-status-migration.test.ts` (completo):

```ts
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { MultiDbSqliteStore } from '../../Utils/multi-db-sqlite'

// R6 (audit PR-30): receipt_orphaned.status now stores the app's Android
// status integer (delivery 5, read 13, played 8 — MessageStatusUpdateHelper,
// X/C28106CSb.java in 2.26.38.10). Older builds invented private codes
// (0 device ack, 1/2/3 user delivery/read/played); migration v10 rewrites
// them in place. NULL (pre-hardening generic ack) keeps its replay shape.
describe('msgstore.db migration v10 — legacy receipt orphan codes to Android integers', () => {
	let dir: string
	let store: MultiDbSqliteStore | undefined

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'receipt-orphan-status-migration-test-'))
	})

	afterEach(async () => {
		store?.close()
		await rm(dir, { recursive: true, force: true })
	})

	it('rewrites legacy codes 0-3 to the app integers and leaves NULL and known integers untouched', async () => {
		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		const db = store.handle('msgstore.db')
		db.prepare(
			"INSERT INTO jid (user, server, raw_string) VALUES ('legacy', 's.whatsapp.net', 'legacy@s.whatsapp.net')"
		).run()
		const jidRowId = (
			db.prepare("SELECT _id FROM jid WHERE raw_string = 'legacy@s.whatsapp.net'").get() as { _id: number }
		)._id
		const chatRowId = Number(db.prepare('INSERT INTO chat (jid_row_id) VALUES (?)').run(jidRowId).lastInsertRowid)
		const insert = db.prepare(
			'INSERT INTO receipt_orphaned (chat_row_id, from_me, key_id, receipt_device_jid_row_id, receipt_recipient_jid_row_id, status, timestamp) VALUES (?, 1, ?, ?, ?, ?, 1000)'
		)
		insert.run(chatRowId, 'LEGACY-DEVICE-0', jidRowId, null, 0)
		insert.run(chatRowId, 'LEGACY-USER-1', jidRowId, jidRowId, 1)
		insert.run(chatRowId, 'LEGACY-USER-2', jidRowId, jidRowId, 2)
		insert.run(chatRowId, 'LEGACY-USER-3', jidRowId, jidRowId, 3)
		insert.run(chatRowId, 'LEGACY-NULL', jidRowId, null, null)
		insert.run(chatRowId, 'ALREADY-RAW-13', jidRowId, jidRowId, 13)
		db.prepare('DELETE FROM schema_migrations WHERE version = 10').run()
		store.close()
		store = undefined

		store = new MultiDbSqliteStore({ sessionDir: dir })
		await store.open()
		const migrated = store.handle('msgstore.db')
		const rows = migrated
			.prepare('SELECT key_id, status FROM receipt_orphaned ORDER BY key_id')
			.all() as Array<{ key_id: string; status: number | null }>
		expect(rows).toEqual([
			{ key_id: 'ALREADY-RAW-13', status: 13 },
			{ key_id: 'LEGACY-DEVICE-0', status: 5 },
			{ key_id: 'LEGACY-NULL', status: null },
			{ key_id: 'LEGACY-USER-1', status: 5 },
			{ key_id: 'LEGACY-USER-2', status: 13 },
			{ key_id: 'LEGACY-USER-3', status: 8 }
		])
		expect(migrated.prepare('SELECT name FROM schema_migrations WHERE version = 10').get()).toMatchObject({
			name: 'rewrite legacy receipt orphan codes to Android status integers'
		})
	})
})
```

### 4.3 Ajustados

- `replays a status-only orphan through the app status pipeline after the message arrives` (ex “with the app status”) — agora espera **17 / 8 / null** e verifica que as linhas de órfão guardam `[15, 18, 17]` crus.
- `records a played-self group receipt as the own-user played row and promotes the aggregate` (novo, no `audit-1a1-regressions.test.ts`) — stanza de grupo (`from` = jid do grupo, `participant` = eu, `type: 'played-self'`) → linha `receipt_user` played para mim + agregado 8, **sem** `message-receipt.update`.
- Errata R‑09 no teste de espelho vivo: `'R09-played-self': 8` (era 18) e `'R09-inactive': null` (era 15); `waitFor` ajustado (inactive não chama mais `updateMessageStatus`).

### 4.4 Resultados

| Suíte | Resultado |
| --- | --- |
| `message-store-backends` + `receipt-orphan*` (3 arquivos) | **58/58 passaram** |
| `audit-1a1-regressions` | **11 passaram** (branch de docs; no develop o C‑03 antigo `it.failing` já foi substituído pelo teste real do PR‑08) |
| Varredura de regressão `messages-send\|process-message\|retry-receipt\|chats-message\|multi-db\|history-sync\|lid` (27 suítes) | **648 passaram, 2 skip, 0 falha** — envios (carrossel/interativos incluídos) sem regressão |
| Suítes receipts/migração/auditoria no worktree limpo base `develop` | **69 passaram, 1 skip** |
| `tsc --noEmit` | limpo |
| Suíte completa (207 arquivos) | **2731 passaram**; a única falha observada foi flakiness de timeout sob carga paralela (`app-state-sync-key-lifecycle`, 107 s no full‑run) que passa isolada **23/23** — caminho app‑state, intocado pelo R6 |

---

## 5. Desvios deliberados do app (documentados)

| # | Comportamento do app | Decisão no motor | Motivo |
| --- | --- | --- | --- |
| 1 | `recipient_count` sempre setado no add‑msg (degenerado rc=0 → agregado 8) | rc NULL/≤0 → **sem promoção** | rc desconhecido = envio que o motor não viu (history sync); inventar 8 seria fabricar estado. rc=0 explícito é patológico (grupo só comigo) |
| 2 | Replay do órfão played‑self (18) em **grupo** materializa `receipt_user` played para o usuário do dispositivo | consome a linha sem materializar | o órfão guarda só o **row id** do jid de dispositivo; sem reverse‑map device→usuário o motor não pode resolver o bare user. Caso raro (órfão + grupo + played‑self) |
| 3 | Replay apaga **todas** as linhas da chave (inclusive desconhecidas) | statuses desconhecidos continuam retidos para diagnóstico | comportamento auditado anteriormente (teste “retained unknown statuses”); fora do escopo R6 |
| 4 | Órfão com timestamp ≤ 0 é **rejeitado** | mantém o fallback para hora local (decisão anterior) | retenção precisa de timestamp; comportamento já auditado |
| 5 | delete de todas as linhas pós‑replay | deleta só as materializadas (loop por `_id`) | mesmo que #3 |
| 6 | Telemetria `statusDowngrade` | não implementada | o motor não tem pipeline de telemetria do app |

## 6. Migração & risco

- **v10** é um único `UPDATE … WHERE status IN (0,1,2,3)` idempotente; sem coluna nova, sem índice novo, sem lock longo (tabela de órfãos é pequena por construção — TTL 60 dias). Rollback: nenhuma estrutura mudou, apenas valores; o writer novo nunca grava 0‑3.
- Colisão no índice único `(chat, from_me, key_id, device, recipient, status)` é impossível: `0` só existia com recipient NULL e `1/2/3` só com recipient setado; os alvos (5/13/8) não se sobrepõem entre si.
- `recipient_count` é `COALESCE(excluded, message.…)` no upsert — re‑gravar a mesma chave sem o campo não apaga um valor conhecido.

## 7. Checklist anti‑regressão de envios

- `messages-send.ts`: única mudança é `rememberRelayedRecipientCount(message, …)` — `WeakMap.set` puro dentro do branch de grupo, **antes** de `getUSyncDevices`; nenhum atributo de stanza, nenhum caminho de criptografia/fan‑out alterado. Testes de assembly de stanza (`messages-send.stanza-assembly`, fixture dourada) passaram.
- `process-message.ts`: campo novo opcional no `recordMessage`; mirror continua best‑effort (falha não derruba o processamento).
- Eventos de consumidor inalterados em todos os casos (1:1 `messages.update`, grupo `message-receipt.update`, status via `status.db`).

---

*Documento gerado em 2026‑10‑15.*

## Apêndice A — Diff completo (unified, todos os arquivos)

### A.1 Motor (`store.ts`, `message-store-backend.ts`, `process-message.ts`, `messages-send.ts`)

```diff

diff --git a/src/Socket/messages-send.ts b/src/Socket/messages-send.ts
index 5e78494e4e..701fa495aa 100644
--- a/src/Socket/messages-send.ts
+++ b/src/Socket/messages-send.ts
@@ -105,6 +105,7 @@ import {
 	resolveSelfSendLid
 } from '../Utils/relay-stanza'
 import { getMessageReportingToken, shouldIncludeReportingToken } from '../Utils/reporting-utils'
+import { rememberRelayedRecipientCount } from '../Utils/process-message'
 import { resolveSessionFetchJids } from '../Utils/session-fetch-addressing'
 import {
 	isRegularUser,
@@ -2153,6 +2154,14 @@ export const makeMessagesSocket = (config: SocketConfig) => {
 					participantsList.push(...statusJidList)
 				}
 
+				if (isGroup) {
+					// R6: pin the app's add-msg recipient_count (participants
+					// including me − 1, BotUtilPreprocessor X/A7L.java) on the relayed
+					// content so the mirrored message row can aggregate group receipt
+					// status exactly like MessageStatusStore.A02.
+					rememberRelayedRecipientCount(message, Math.max(participantsList.length - 1, 0))
+				}
+
 				const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
 				devices.push(...additionalDevices)
 
diff --git a/src/Utils/multi-db-sqlite/message-store-backend.ts b/src/Utils/multi-db-sqlite/message-store-backend.ts
index 5651b9b7e4..bb3bbd3ff7 100644
--- a/src/Utils/multi-db-sqlite/message-store-backend.ts
+++ b/src/Utils/multi-db-sqlite/message-store-backend.ts
@@ -324,6 +324,13 @@ export type RecordMessageInput = {
 	textData?: string | null
 	viewMode?: number | null
 	viewOnceState?: number | null
+	/** `message.recipient_count` — the aggregate-status audience the app
+	 * computes at add-msg time (BotUtilPreprocessor, X/A7L.java — 2.26.38.10):
+	 * group = participants including me − 1. Drives the group receipt
+	 * aggregate (MessageStatusStore.A02); NULL when the fan-out count is
+	 * unknown (history-synced sends), which disables aggregation for that
+	 * message exactly like an unreadable participant list would. */
+	recipientCount?: number | null
 	authorDeviceJid?: string | null
 	messageSecret?: Buffer | null
 	album?: {
@@ -463,8 +470,8 @@ export class MessageStoreBackend implements ChatRowResolver {
 			),
 			upsertMessage: this.db.prepare(
 				'INSERT INTO message (chat_row_id, from_me, key_id, sender_jid_row_id, status, timestamp, ' +
-					'received_timestamp, server_sts, message_type, text_data, view_mode, sort_id) ' +
-					'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
+					'received_timestamp, server_sts, message_type, text_data, view_mode, recipient_count, sort_id) ' +
+					'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
 					'ON CONFLICT(chat_row_id, from_me, key_id, sender_jid_row_id) DO UPDATE SET ' +
 					'status = CASE ' +
 					'WHEN excluded.status IS NULL THEN message.status ' +
@@ -476,7 +483,11 @@ export class MessageStoreBackend implements ChatRowResolver {
 					'server_sts = COALESCE(excluded.server_sts, message.server_sts), ' +
 					'message_type = COALESCE(excluded.message_type, message.message_type), ' +
 					'text_data = COALESCE(excluded.text_data, message.text_data), ' +
-					'view_mode = COALESCE(excluded.view_mode, message.view_mode)'
+					'view_mode = COALESCE(excluded.view_mode, message.view_mode), ' +
+					// The app fixes recipient_count once, at add-msg; a later
+					// re-record of the same key (retry/history) must not clobber a
+					// known count with an unknown one.
+					'recipient_count = COALESCE(excluded.recipient_count, message.recipient_count)'
 			),
 			getMessageByNaturalKey: this.db.prepare(
 				'SELECT * FROM message WHERE chat_row_id = ? AND from_me = ? AND key_id = ? AND sender_jid_row_id IS ?'
@@ -657,6 +668,7 @@ export class MessageStoreBackend implements ChatRowResolver {
 			input.messageType ?? null,
 			input.textData ?? null,
 			input.viewMode ?? null,
+			input.recipientCount ?? null,
 			input.timestamp ?? 0
 		)
 
diff --git a/src/Utils/multi-db-sqlite/store.ts b/src/Utils/multi-db-sqlite/store.ts
index 51d0666899..b2f4ebef87 100644
--- a/src/Utils/multi-db-sqlite/store.ts
+++ b/src/Utils/multi-db-sqlite/store.ts
@@ -304,6 +304,30 @@ const MIGRATIONS: Partial<Record<MultiDbFile, ReadonlyArray<Migration>>> = {
 						DELETE FROM message_view_once_media WHERE message_row_id = old._id;
 					END;
 			`
+		},
+		{
+			// R6 (audit PR-30): `receipt_orphaned.status` now stores the app's own
+			// Android status integer, exactly as MessageStatusUpdateHelper writes it
+			// (`put("status", i)`, X/C28106CSb.java — 2.26.38.10): delivery 5,
+			// read 13, played 8, inactive 15, read-self 17, played-self 18. Older
+			// builds invented private codes (0 device ack, 1/2/3 user delivery/
+			// read/played); rewrite them in place. NULL (pre-hardening generic ack)
+			// is deliberately left NULL — it identifies the replay-by-device shape.
+			// The mapping cannot collide on the unique index: 0 was only ever
+			// written with a NULL recipient and 1 only with a recipient set.
+			version: 10,
+			name: 'rewrite legacy receipt orphan codes to Android status integers',
+			sql: `
+				UPDATE receipt_orphaned
+				SET status = CASE status
+					WHEN 0 THEN 5
+					WHEN 1 THEN 5
+					WHEN 2 THEN 13
+					WHEN 3 THEN 8
+					ELSE status
+				END
+				WHERE status IN (0, 1, 2, 3);
+			`
 		}
 	],
 	'status.db': [
diff --git a/src/Utils/process-message.ts b/src/Utils/process-message.ts
index a68e228414..c5ac80f127 100644
--- a/src/Utils/process-message.ts
+++ b/src/Utils/process-message.ts
@@ -125,6 +125,21 @@ export const rememberRawProtocolSender = (message: WAMessage, senderJid: string)
 	if (senderJid) rawProtocolSenders.set(message, senderJid)
 }
 
+// The group fan-out in messages-send knows the participant list; by the time
+// the sent message echoes through processMessage that context is gone. Carry
+// the app's add-msg recipient_count (participants including me − 1, X/A7L.java)
+// on the relayed content object — the same out-of-band pattern as
+// rawProtocolSenders. A missed lookup leaves recipient_count NULL, which just
+// disables aggregate promotion for that message (R6).
+const relayedRecipientCounts = new WeakMap<proto.IMessage, number>()
+
+export const rememberRelayedRecipientCount = (content: proto.IMessage, recipientCount: number): void => {
+	relayedRecipientCounts.set(content, recipientCount)
+}
+
+export const takeRelayedRecipientCount = (content: proto.IMessage | null | undefined): number | null =>
+	(content && relayedRecipientCounts.get(content)) ?? null
+
 /**
  * Persist history-sync messages into the same typed message/chat tables used
  * by live traffic. History events remain available to consumers, but the
@@ -1292,6 +1307,7 @@ const processMessage = async (message: WAMessage, processContext: ProcessMessage
 				textData: content?.extendedTextMessage?.text ?? content?.conversation ?? null,
 				viewMode: isViewOnce ? 0 : null,
 				viewOnceState: isViewOnce ? ANDROID_VIEW_ONCE_STATE.UNOPENED : null,
+				recipientCount: takeRelayedRecipientCount(message.message),
 				authorDeviceJid,
 				messageSecret: getMessageSecretForStorage(message, content),
 				album: content?.albumMessage
```

### A.2 Motor (`receipt-backend.ts`, `messages-recv.ts`)

```diff
diff --git a/src/Socket/messages-recv.ts b/src/Socket/messages-recv.ts
index 5bca7cbcf1..7e81decf2b 100644
--- a/src/Socket/messages-recv.ts
+++ b/src/Socket/messages-recv.ts
@@ -105,6 +105,7 @@ import {
 	parseTextStatusUpdateNotification
 } from '../Utils/mex-notifications'
 import {
+	ANDROID_MESSAGE_STATUS,
 	androidStatusFromReceiptType,
 	JidMapBackend,
 	MessageStoreBackend,
@@ -3713,13 +3714,26 @@ export const makeMessagesRecvSocket = (config: SocketConfig) => {
 					// A receipt can arrive before its message row is mirrored; the
 					// status-only states then wait in receipt_orphaned with their exact
 					// value (delivery/read/played orphan through receipt_user below).
+					// R6 (MessageStatusUpdateHelper, X/C28106CSb.java:281-323 in
+					// 2.26.38.10): played-self 18 is APPLIED as PLAYED 8 — the live
+					// helper builds the status receipt with 8 (arrayListA1B5) — and
+					// inactive 15 never reaches message.status at all (dropped as
+					// "statusunchanged" in MessageStatusStore.A02, X/C17C.java:400).
+					// The orphan row still holds the raw wire integer either way.
 					const mirrorReceiptStatus = () => {
 						const androidStatus = androidStatusFromReceiptType(attrs.type)
 						if (!receiptChatResolver || !key.remoteJid || androidStatus === null) return
 						const statusOnly = attrs.type === 'read-self' || attrs.type === 'played-self' || attrs.type === 'inactive'
+						const applyStatus =
+							androidStatus === ANDROID_MESSAGE_STATUS.PLAYED_SELF
+								? ANDROID_MESSAGE_STATUS.PLAYED
+								: androidStatus === ANDROID_MESSAGE_STATUS.INACTIVE
+									? null
+									: androidStatus
 						try {
 							for (const id of ids) {
-								const applied = receiptChatResolver.updateMessageStatus(key.remoteJid, !!key.fromMe, id, androidStatus)
+								const applied =
+									applyStatus !== null && receiptChatResolver.updateMessageStatus(key.remoteJid, !!key.fromMe, id, applyStatus)
 								if (!applied && statusOnly && receiptBackend) {
 									receiptBackend.recordStatusOrphan({
 										chatJid: key.remoteJid,
@@ -3740,6 +3754,39 @@ export const makeMessagesRecvSocket = (config: SocketConfig) => {
 						mirrorReceiptStatus()
 					}
 
+					// played-self in a group: my other companion played the voice
+					// note I sent. The app normalizes it to played(8) and stores a
+					// receipt_user row for MY user (C5W.A00(device, null, ...) →
+					// device.userJid), which feeds the group aggregate like any
+					// participant's played receipt. read-self(17) is not storable in
+					// receipt_user (C9A.A01 rejects it) and inactive(15) is dropped,
+					// so only played-self needs handling here.
+					if (
+						typeof status === 'undefined' &&
+						attrs.type === 'played-self' &&
+						isJidGroup(remoteJid) &&
+						attrs.participant &&
+						receiptBackend &&
+						key.remoteJid
+					) {
+						try {
+							const resolvedSelfJid = await resolveLidToPn(attrs.participant, lidMapping, logger)
+							const normalizedSelfJid = jidNormalizedUser(resolvedSelfJid || attrs.participant)
+							for (const id of ids) {
+								receiptBackend.recordUserReceipt({
+									chatJid: key.remoteJid,
+									fromMe: !!key.fromMe,
+									keyId: id,
+									receiptUserJid: normalizedSelfJid,
+									kind: 'played',
+									timestamp: +attrs.t!
+								})
+							}
+						} catch (err) {
+							logger.warn({ err }, 'failed to record played-self group receipt row')
+						}
+					}
+
 					if (
 						typeof status !== 'undefined' &&
 						// basically, we only want to know when a message from us has been delivered to/read by the other person
diff --git a/src/Utils/multi-db-sqlite/receipt-backend.ts b/src/Utils/multi-db-sqlite/receipt-backend.ts
index a95e13c7f4..0f3ff8c0d6 100644
--- a/src/Utils/multi-db-sqlite/receipt-backend.ts
+++ b/src/Utils/multi-db-sqlite/receipt-backend.ts
@@ -13,7 +13,12 @@
  *     `message` row existed locally (same holding-pen pattern as
  *     `message_orphaned_edit`/`status_orphan`) — this backend records into
  *     it whenever `getMessageRowId` can't resolve the target, matching
- *     that observed behavior.
+ *     that observed behavior. Its `status` column carries the app's own
+ *     Android status integer (R6).
+ *
+ * Group message status follows MessageStatusStore.A02's multi-participant
+ * path (X/C17C.java, 2.26.38.10): per-user max state in `receipt_user`,
+ * aggregate against `message.recipient_count`, applied even on downgrade.
  *
  * `message_row_id` is resolved by `(chat_row_id, from_me, key_id)` — NOT
  * the full `message` natural key (which also includes `sender_jid_row_id`)
@@ -32,8 +37,22 @@ import type { SqliteDbLike, SqliteStatementLike } from './types'
 
 export type ReceiptKind = 'delivery' | 'read' | 'played'
 
-const ORPHAN_DEVICE_STATUS = 0
-const ORPHAN_USER_STATUS: Record<ReceiptKind, number> = { delivery: 1, read: 2, played: 3 }
+/**
+ * `receipt_orphaned.status` stores the app's own Android status integer for
+ * the receipt, exactly as MessageStatusUpdateHelper writes the row
+ * (`put("status", Integer.valueOf(i4))`, X/C28106CSb.java — 2.26.38.10):
+ * delivery 5, read 13, played 8, inactive 15, read-self 17, played-self 18.
+ * A user-level orphan carries the recipient row; a device-level ack carries
+ * a NULL recipient with status 5 — the same distinction as the app's
+ * `C27813CEd(deviceJid, userJid|null, status, timestamp)`. Codes 0-3 were an
+ * earlier engine invention removed by R6 (msgstore.db migration v10 rewrites
+ * any rows still carrying them).
+ */
+const ORPHAN_KIND_STATUS: Record<ReceiptKind, number> = {
+	delivery: ANDROID_MESSAGE_STATUS.DELIVERY_ACK,
+	read: ANDROID_MESSAGE_STATUS.READ,
+	played: ANDROID_MESSAGE_STATUS.PLAYED
+}
 export const RECEIPT_ORPHAN_REPLAY_LIMIT = 300
 export const RECEIPT_ORPHAN_TTL_SECONDS = 60 * 24 * 60 * 60
 export const RECEIPT_ORPHAN_PRUNE_INTERVAL_SECONDS = 60 * 60
@@ -41,9 +60,8 @@ export const RECEIPT_ORPHAN_PRUNE_INTERVAL_SECONDS = 60 * 60
 /**
  * Receipt states the app keeps only as the message status, with no
  * receipt_user progression: read-self 17, played-self 18, inactive 15
- * (ReceiptStanzaHelper.A00, X/C29301Csr.java:337-378). An orphan of one of
- * them stores that Android status itself; the values never collide with the
- * user/device orphan codes 0-3.
+ * (ReceiptStanzaHelper.A00, X/CSY.java:338-376 in 2.26.38.10). An orphan of
+ * one of them stores that Android status itself.
  */
 const STATUS_ONLY_ORPHAN_STATUSES = new Set<number>([
 	ANDROID_MESSAGE_STATUS.INACTIVE,
@@ -60,12 +78,6 @@ export type RecordStatusOrphanInput = {
 	timestamp: number
 }
 
-const ANDROID_STATUS_BY_ORPHAN_STATUS: Partial<Record<number, number>> = {
-	[ORPHAN_USER_STATUS.delivery]: ANDROID_MESSAGE_STATUS.DELIVERY_ACK,
-	[ORPHAN_USER_STATUS.read]: ANDROID_MESSAGE_STATUS.READ,
-	[ORPHAN_USER_STATUS.played]: ANDROID_MESSAGE_STATUS.PLAYED
-}
-
 export type RecordUserReceiptInput = {
 	chatJid: string
 	fromMe: boolean
@@ -98,6 +110,7 @@ export class ReceiptBackend {
 		deleteExpiredOrphaned: SqliteStatementLike
 		getMessageStatus: SqliteStatementLike
 		updateMessageStatus: SqliteStatementLike
+		getMessageAggregate: SqliteStatementLike
 		listUserReceipts: SqliteStatementLike
 		listDeviceReceipts: SqliteStatementLike
 	}
@@ -164,13 +177,26 @@ export class ReceiptBackend {
 			listOrphaned: this.db.prepare(
 				'SELECT _id, receipt_device_jid_row_id, receipt_recipient_jid_row_id, status, timestamp ' +
 					'FROM receipt_orphaned WHERE chat_row_id = ? AND from_me = ? AND key_id = ? ' +
-					'AND (status IS NULL OR status IN (0, 1, 2, 3, 15, 17, 18)) ' +
+					'AND (status IS NULL OR status IN (5, 8, 13, 15, 17, 18)) ' +
 					`ORDER BY _id ASC LIMIT ${RECEIPT_ORPHAN_REPLAY_LIMIT}`
 			),
 			deleteOrphaned: this.db.prepare('DELETE FROM receipt_orphaned WHERE _id = ?'),
 			deleteExpiredOrphaned: this.db.prepare('DELETE FROM receipt_orphaned WHERE timestamp IS NULL OR timestamp < ?'),
 			getMessageStatus: this.db.prepare('SELECT status FROM message WHERE _id = ?'),
 			updateMessageStatus: this.db.prepare('UPDATE message SET status = ? WHERE _id = ?'),
+			// Group aggregate inputs, exactly the counters MessageStatusStore.A02
+			// derives from the per-user receipt map: a user's max status is
+			// played(8) when played_timestamp is set, read(13) when read_timestamp
+			// is set, delivered(5) when only receipt_timestamp is (X/C17C.java:823).
+			getMessageAggregate: this.db.prepare(
+				'SELECT status, recipient_count, ' +
+					'(SELECT COUNT(*) FROM receipt_user ru WHERE ru.message_row_id = message._id AND ru.played_timestamp IS NOT NULL) AS played_count, ' +
+					'(SELECT COUNT(*) FROM receipt_user ru WHERE ru.message_row_id = message._id ' +
+					'AND (ru.played_timestamp IS NOT NULL OR ru.read_timestamp IS NOT NULL)) AS read_count, ' +
+					'(SELECT COUNT(*) FROM receipt_user ru WHERE ru.message_row_id = message._id ' +
+					'AND (ru.played_timestamp IS NOT NULL OR ru.read_timestamp IS NOT NULL OR ru.receipt_timestamp IS NOT NULL)) AS delivered_count ' +
+					'FROM message WHERE _id = ?'
+			),
 			listUserReceipts: this.db.prepare(
 				'SELECT _id, message_row_id, receipt_user_jid_row_id, receipt_timestamp, read_timestamp, played_timestamp ' +
 					'FROM receipt_user WHERE message_row_id = ?'
@@ -232,7 +258,7 @@ export class ReceiptBackend {
 					input.keyId,
 					receiptUserRowId,
 					receiptUserRowId,
-					ORPHAN_USER_STATUS[input.kind],
+					ORPHAN_KIND_STATUS[input.kind],
 					this.orphanTimestamp(input.timestamp)
 				)
 				return
@@ -245,6 +271,12 @@ export class ReceiptBackend {
 						? this.stmts.upsertUserReceiptRead
 						: this.stmts.upsertUserReceiptPlayed
 			stmt.run(messageRowId, receiptUserRowId, input.timestamp)
+
+			// Group receipts promote the message status through the recipient
+			// aggregate (R6); 1:1 keeps the live handler's single-path advance.
+			if (isJidGroup(input.chatJid)) {
+				this.promoteGroupMessageStatus(messageRowId)
+			}
 		})()
 	}
 
@@ -270,7 +302,7 @@ export class ReceiptBackend {
 					input.keyId,
 					receiptDeviceRowId,
 					null,
-					ORPHAN_DEVICE_STATUS,
+					ANDROID_MESSAGE_STATUS.DELIVERY_ACK,
 					this.orphanTimestamp(input.timestamp)
 				)
 				return
@@ -305,6 +337,56 @@ export class ReceiptBackend {
 		})()
 	}
 
+	/**
+	 * Group aggregate promotion — the multi-participant path of
+	 * MessageStatusStore.A02 (X/C17C.java:823-891, WhatsApp 2.26.38.10):
+	 *
+	 *   played >= recipientCount → PLAYED 8
+	 *   read    >= recipientCount → READ 13
+	 *   delivered >= recipientCount → DELIVERY_ACK 5
+	 *   otherwise → SERVER_ACK 4
+	 *
+	 * and, unlike the 1:1 single path, the aggregate is applied whenever it
+	 * differs from the current status — DOWNGRADES INCLUDED. The app only
+	 * emits "MessageStatusStore/statusDowngrade" telemetry on the way; the
+	 * write still happens (which is why a group's ticks can only regress when
+	 * the aggregate itself regresses, never from one member's stale receipt —
+	 * the per-user map keeps each member's max state, mirroring our monotonic
+	 * max-timestamp upserts).
+	 *
+	 * Deliberate deviation: a NULL or non-positive `recipient_count` (a send
+	 * whose fan-out list this engine never saw, e.g. history-synced) skips
+	 * promotion entirely. The app's add-msg preprocessor always sets the
+	 * count, so its degenerate recipientCount=0 branch (0 counters >= 0 → 8)
+	 * is unreachable on a real device; fabricating it here would invent a
+	 * played state from nothing.
+	 */
+	private promoteGroupMessageStatus(messageRowId: number): number | null {
+		const row = this.stmts.getMessageAggregate.get(messageRowId) as
+			| {
+					status: number | null
+					recipient_count: number | null
+					played_count: number
+					read_count: number
+					delivered_count: number
+			  }
+			| undefined
+		if (!row || row.recipient_count === null || row.recipient_count <= 0) return null
+
+		const aggregate =
+			row.played_count >= row.recipient_count
+				? ANDROID_MESSAGE_STATUS.PLAYED
+				: row.read_count >= row.recipient_count
+					? ANDROID_MESSAGE_STATUS.READ
+					: row.delivered_count >= row.recipient_count
+						? ANDROID_MESSAGE_STATUS.DELIVERY_ACK
+						: ANDROID_MESSAGE_STATUS.SERVER_ACK
+
+		if (aggregate === row.status) return null
+		this.stmts.updateMessageStatus.run(aggregate, messageRowId)
+		return aggregate
+	}
+
 	/** Replays receipts that arrived before their message row, then removes only rows successfully materialized. */
 	replayOrphaned(chatJid: string, fromMe: boolean, keyId: string): number {
 		return this.db.transaction(() => {
@@ -313,14 +395,17 @@ export class ReceiptBackend {
 			const messageRowId = this.resolveMessageRowId(chatJid, fromMe, keyId)
 			if (messageRowId === null) return 0
 			let replayed = 0
-			// Group receipts are materialized per recipient/device but cannot
-			// establish aggregate message status from one member. Status-broadcast
-			// receipts use status.db instead. Match the live handler's exact split.
-			const canPromoteMessageStatus = !isJidGroup(chatJid) && !isJidStatusBroadcast(chatJid)
+			// Same three-way split as MessageStatusStore.A02: status broadcasts
+			// never touch message status (status.db owns those receipts); 1:1
+			// keeps the single path's advance-only promotion; groups promote
+			// through the recipient aggregate once every row is materialized.
+			const isGroup = isJidGroup(chatJid)
+			const canPromoteMessageStatus = !isJidStatusBroadcast(chatJid)
 			const messageStatusRow = canPromoteMessageStatus
 				? (this.stmts.getMessageStatus.get(messageRowId) as { status: number | null } | undefined)
 				: undefined
 			let promotedStatus = messageStatusRow?.status ?? null
+			let materializedUserReceipt = false
 
 			for (;;) {
 				const rows = this.stmts.listOrphaned.all(chatRowId, fromMe ? 1 : 0, keyId) as Array<{
@@ -339,27 +424,61 @@ export class ReceiptBackend {
 					// target jid and timestamp; materialize that legacy shape as the
 					// schema's generic per-device acknowledgement instead of leaking an
 					// unreplayable orphan forever.
-					if (row.status === null || row.status === ORPHAN_DEVICE_STATUS) {
+					if (row.status === null) {
 						this.stmts.upsertDeviceReceipt.run(messageRowId, row.receipt_device_jid_row_id, row.timestamp)
-					} else if (STATUS_ONLY_ORPHAN_STATUSES.has(row.status)) {
-						if (canPromoteMessageStatus && shouldAdvanceAndroidMessageStatus(promotedStatus, row.status)) {
+					} else if (row.status === ANDROID_MESSAGE_STATUS.INACTIVE) {
+						// inactive(15) never reaches message.status: the app drops it
+						// as "statusunchanged" (X/C17C.java:400). The orphan row is
+						// consumed so retention doesn't leak it — same end state.
+					} else if (row.status === ANDROID_MESSAGE_STATUS.READ_SELF) {
+						// read-self(17) replays verbatim (C17C.A03 keeps i3 = 17) and
+						// only the non-group single path can apply it — the app's
+						// receipt_user store rejects 17 outright (C9A.A01).
+						if (!isGroup && shouldAdvanceAndroidMessageStatus(promotedStatus, row.status)) {
 							promotedStatus = row.status
 						}
-					} else {
-						const recipientRowId = row.receipt_recipient_jid_row_id ?? row.receipt_device_jid_row_id
+					} else if (row.status === ANDROID_MESSAGE_STATUS.PLAYED_SELF) {
+						// played-self(18) is normalized to PLAYED 8 at replay
+						// ("applyingorphanedreceipt", X/C17C.java:124-129: i3 = 8).
+						// In a group the app would also materialize a played
+						// receipt_user row for the sending device's user; this
+						// engine's orphan row keeps only the device jid row id, so
+						// that corner degrades to consuming the row (documented R6
+						// deviation — status-only orphans in groups are rare).
+						if (!isGroup && shouldAdvanceAndroidMessageStatus(promotedStatus, ANDROID_MESSAGE_STATUS.PLAYED)) {
+							promotedStatus = ANDROID_MESSAGE_STATUS.PLAYED
+						}
+					} else if (row.receipt_recipient_jid_row_id !== null) {
 						const stmt =
-							row.status === ORPHAN_USER_STATUS.delivery
+							row.status === ANDROID_MESSAGE_STATUS.DELIVERY_ACK
 								? this.stmts.upsertUserReceiptDelivery
-								: row.status === ORPHAN_USER_STATUS.read
+								: row.status === ANDROID_MESSAGE_STATUS.READ
 									? this.stmts.upsertUserReceiptRead
-									: row.status === ORPHAN_USER_STATUS.played
+									: row.status === ANDROID_MESSAGE_STATUS.PLAYED
 										? this.stmts.upsertUserReceiptPlayed
 										: null
 						if (!stmt) continue
-						stmt.run(messageRowId, recipientRowId, row.timestamp)
-						const receiptStatus = ANDROID_STATUS_BY_ORPHAN_STATUS[row.status]
-						if (receiptStatus !== undefined && shouldAdvanceAndroidMessageStatus(promotedStatus, receiptStatus)) {
-							promotedStatus = receiptStatus
+						stmt.run(messageRowId, row.receipt_recipient_jid_row_id, row.timestamp)
+						materializedUserReceipt = true
+						if (!isGroup && shouldAdvanceAndroidMessageStatus(promotedStatus, row.status)) {
+							promotedStatus = row.status
+						}
+					} else {
+						// Device-level delivery ack (status 5, no recipient). The
+						// app's replay feeds device acks back through A02, which keys
+						// receipt_user by the DEVICE'S USER; group device orphans here
+						// were written under the participant's bare jid, so the stored
+						// row id already is the user's. Non-group device acks keep the
+						// per-device row only (a 1:1 sender's jid may carry a device
+						// suffix this schema can't reverse-map to its user).
+						this.stmts.upsertDeviceReceipt.run(messageRowId, row.receipt_device_jid_row_id, row.timestamp)
+						if (isGroup) {
+							this.stmts.upsertUserReceiptDelivery.run(
+								messageRowId,
+								row.receipt_device_jid_row_id,
+								row.timestamp
+							)
+							materializedUserReceipt = true
 						}
 					}
 
@@ -373,7 +492,9 @@ export class ReceiptBackend {
 				if (rows.length < RECEIPT_ORPHAN_REPLAY_LIMIT || replayedInBatch === 0) break
 			}
 
-			if (messageStatusRow && promotedStatus !== messageStatusRow.status) {
+			if (isGroup) {
+				if (materializedUserReceipt) this.promoteGroupMessageStatus(messageRowId)
+			} else if (messageStatusRow && promotedStatus !== messageStatusRow.status) {
 				this.stmts.updateMessageStatus.run(promotedStatus, messageRowId)
 			}
 
```

### A.3 Testes (`message-store-backends.test.ts`, `audit-1a1-regressions.test.ts`)

```diff
diff --git a/src/__tests__/Socket/audit-1a1-regressions.test.ts b/src/__tests__/Socket/audit-1a1-regressions.test.ts
index fd210f6706..8a9e852a71 100644
--- a/src/__tests__/Socket/audit-1a1-regressions.test.ts
+++ b/src/__tests__/Socket/audit-1a1-regressions.test.ts
@@ -403,20 +403,26 @@ describe('audit 1:1 regressions', () => {
 				client.emit('CB:receipt', { tag: 'receipt', attrs: { ...attrs, id, t: '1789500200' }, content: undefined })
 			}
 
-			await waitFor(() => updateSpy.mock.calls.length === receipts.length)
+			// inactive no longer calls updateMessageStatus at all (R6), so 6 of
+			// the 7 receipts reach the status mirror.
+			await waitFor(() => updateSpy.mock.calls.length === receipts.length - 1)
 			await endSocket(socket)
-			// What msgstore.db really holds after the live receipts.
 			const persisted = Object.fromEntries(
 				receipts.map(({ id, fromMe }) => [id, messages.getMessageByKeyId(DM_A_PN, fromMe, id)?.status])
 			)
+			// R6 errata (2.26.38.10 decompile, X/C28106CSb.java:281-323 +
+			// X/C17C.java:400): played-self 18 is APPLIED as PLAYED 8 (the live
+			// helper builds the status receipt with 8) and inactive 15 never
+			// reaches message.status — dropped as "statusunchanged" — so the
+			// row keeps the NULL recordMessage left.
 			expect(persisted).toEqual({
 				'R09-delivery': 5,
 				'R09-read': 13,
 				'R09-played': 8,
-				'R09-inactive': 15,
+				'R09-inactive': null,
 				'R09-sender': 5,
 				'R09-read-self': 17,
-				'R09-played-self': 18
+				'R09-played-self': 8
 			})
 			// receipt_user progression follows the same table: sender is a delivery.
 			expect(Object.fromEntries(userReceiptKinds)).toEqual({
@@ -466,10 +472,12 @@ describe('audit 1:1 regressions', () => {
 				client.emit('CB:receipt', { tag: 'receipt', attrs: { ...attrs, id, t: '1789500300' }, content: undefined })
 			}
 
-			await waitFor(() => updateSpy.mock.calls.length === receipts.length)
+			// inactive never calls updateMessageStatus under R6 (the app drops
+			// it as "statusunchanged"), so 3 of the 4 receipts reach the mirror.
+			await waitFor(() => updateSpy.mock.calls.length === receipts.length - 1)
 			await endSocket(socket)
 			// read orphans through receipt_user (replays as 13); the status-only
-			// states are held with their own value.
+			// states are held with their exact wire value — the R6 raw integer.
 			expect(Object.fromEntries(orphans)).toEqual({
 				'LATE-inactive': 15,
 				'LATE-read-self': 17,
@@ -484,6 +492,64 @@ describe('audit 1:1 regressions', () => {
 		}
 	})
 
+	// R6 · played-self in a group: the live helper normalizes it to played(8)
+	// and stores a receipt_user row for the SENDER'S OWN user
+	// (C5W.A00(device, null, ...) → device.userJid, X/C28106CSb.java:281-323 in
+	// 2.26.38.10), which feeds the group aggregate exactly like a
+	// participant's played receipt. No consumer event changes: the group
+	// contract stays `message-receipt.update` for participant receipts.
+	it('records a played-self group receipt as the own-user played row and promotes the aggregate', async () => {
+		const sessionDir = mkdtempSync(join(tmpdir(), 'audit-1a1-r06-played-self-'))
+		const store = new MultiDbSqliteStore({ sessionDir })
+		await store.open()
+		const db = store.handle('msgstore.db')
+		const messages = new MessageStoreBackend(db, new JidMapBackend(db))
+		const GROUP = '120363000000000010@g.us'
+		const keyId = 'R06-played-self-group'
+		messages.recordMessage({
+			chatJid: GROUP,
+			fromMe: true,
+			keyId,
+			status: 4, // SERVER_ACK
+			timestamp: 1_789_500_000,
+			recipientCount: 1
+		})
+		try {
+			const { socket } = await makeSocket(undefined, { multiDbStore: store })
+			const client = latestClient()
+			const receiptUpdates: string[] = []
+			socket.ev.on('message-receipt.update', updates => {
+				for (const { key } of updates) receiptUpdates.push(key.id!)
+			})
+			client.emit('CB:receipt', {
+				tag: 'receipt',
+				attrs: {
+					// A group receipt carries the GROUP as `from`; the member is
+					// identified by `participant` — here, ourselves.
+					from: GROUP,
+					participant: ME_PN,
+					type: 'played-self',
+					id: keyId,
+					t: '1789500400'
+				},
+				content: undefined
+			})
+
+			// played 1/1 reaches recipient_count → PLAYED 8 via the aggregate.
+			await waitFor(() => messages.getMessageByKeyId(GROUP, true, keyId)?.status === 8)
+			await endSocket(socket)
+			const messageRow = messages.getMessageByKeyId(GROUP, true, keyId)
+			const userRows = db
+				.prepare('SELECT played_timestamp FROM receipt_user WHERE message_row_id = ?')
+				.all(messageRow!._id) as Array<{ played_timestamp: number }>
+			expect(userRows).toEqual([{ played_timestamp: 1_789_500_400 }])
+			expect(receiptUpdates).toEqual([]) // no participant receipt → no per-user event
+		} finally {
+			store.close()
+			rmSync(sessionDir, { recursive: true, force: true })
+		}
+	})
+
 	// C-03 · app answers server pings (X/AbstractC37331lB.java:384 →
 	// ConnectionThreadRequestsImpl/onServerPingReceived). Fixed by PR-08.
 	it.failing('answers a server ping iq with a result carrying the same id', async () => {
diff --git a/src/__tests__/Utils/message-store-backends.test.ts b/src/__tests__/Utils/message-store-backends.test.ts
index fd6fedaf47..798323d0ff 100644
--- a/src/__tests__/Utils/message-store-backends.test.ts
+++ b/src/__tests__/Utils/message-store-backends.test.ts
@@ -705,42 +705,53 @@ describe('msgstore.db message-store backends', () => {
 			expect(messageStore.getMessageByKeyId(chatJid, true, 'LATE-MESSAGE')?.status).toBe(ANDROID_MESSAGE_STATUS.READ)
 		})
 
-		// Audit R-09: read-self/played-self/inactive exist only as the message
-		// status in the app (17/18/15). A receipt that beats its message keeps
-		// that exact value until the message is mirrored.
-		it('replays a status-only orphan with the app status after the message arrives', () => {
-			const db = store.handle('msgstore.db')
-			const messageStore = new MessageStoreBackend(db, jidMap)
-			const receipts = new ReceiptBackend(db, jidMap, messageStore)
-			const chatJid = '5515991426667@s.whatsapp.net'
-			const myDevice = '5511999999999:2@s.whatsapp.net'
-			const now = Math.floor(Date.now() / 1000)
-			const cases = [
-				{ keyId: 'LATE-READ-SELF', fromMe: false, androidStatus: ANDROID_MESSAGE_STATUS.READ_SELF },
-				{ keyId: 'LATE-PLAYED-SELF', fromMe: false, androidStatus: ANDROID_MESSAGE_STATUS.PLAYED_SELF },
-				{ keyId: 'LATE-INACTIVE', fromMe: true, androidStatus: ANDROID_MESSAGE_STATUS.INACTIVE }
-			]
-			for (const { keyId, fromMe, androidStatus } of cases) {
-				receipts.recordStatusOrphan({
-					chatJid,
-					fromMe,
-					keyId,
-					receiptDeviceJid: myDevice,
-					androidStatus,
-					timestamp: now
-				})
-			}
-
-			expect(db.prepare('SELECT COUNT(*) AS n FROM receipt_orphaned').get()).toMatchObject({ n: 3 })
-			for (const { keyId, fromMe, androidStatus } of cases) {
-				const messageRowId = messageStore.recordMessage({ chatJid, fromMe, keyId, timestamp: now - 1 })
-				expect(receipts.replayOrphaned(chatJid, fromMe, keyId)).toBe(1)
-				expect([keyId, messageStore.getMessageByKeyId(chatJid, fromMe, keyId)?.status]).toEqual([keyId, androidStatus])
-				expect(receipts.listUserReceipts(messageRowId)).toEqual([])
-			}
-
-			expect(db.prepare('SELECT COUNT(*) AS n FROM receipt_orphaned').get()).toMatchObject({ n: 0 })
-		})
+	// Audit R-09 + R6: read-self/played-self/inactive exist only as the message
+	// status in the app. An orphan keeps the exact wire value (17/18/15) until
+	// the message is mirrored; the REPLAY then applies the app's pipeline
+	// (MessageStatusUpdateHelper + MessageStatusStore.A02, 2.26.38.10):
+	// read-self replays verbatim as 17, played-self is normalized 18 → PLAYED
+	// 8 ("applyingorphanedreceipt", X/C17C.java:124-129), and inactive is
+	// consumed without ever touching message.status ("statusunchanged",
+	// X/C17C.java:400).
+	it('replays a status-only orphan through the app status pipeline after the message arrives', () => {
+		const db = store.handle('msgstore.db')
+		const messageStore = new MessageStoreBackend(db, jidMap)
+		const receipts = new ReceiptBackend(db, jidMap, messageStore)
+		const chatJid = '5515991426667@s.whatsapp.net'
+		const myDevice = '5511999999999:2@s.whatsapp.net'
+		const now = Math.floor(Date.now() / 1000)
+		const cases = [
+			{ keyId: 'LATE-READ-SELF', fromMe: false, androidStatus: ANDROID_MESSAGE_STATUS.READ_SELF, applied: 17 },
+			{ keyId: 'LATE-PLAYED-SELF', fromMe: false, androidStatus: ANDROID_MESSAGE_STATUS.PLAYED_SELF, applied: 8 },
+			{ keyId: 'LATE-INACTIVE', fromMe: true, androidStatus: ANDROID_MESSAGE_STATUS.INACTIVE, applied: null }
+		]
+		for (const { keyId, fromMe, androidStatus } of cases) {
+			receipts.recordStatusOrphan({
+				chatJid,
+				fromMe,
+				keyId,
+				receiptDeviceJid: myDevice,
+				androidStatus,
+				timestamp: now
+			})
+		}
+
+		expect(db.prepare('SELECT COUNT(*) AS n FROM receipt_orphaned').get()).toMatchObject({ n: 3 })
+		// The stored orphan rows keep the raw wire integers (key_id order:
+		// INACTIVE, PLAYED-SELF, READ-SELF).
+		const storedStatuses = (
+			db.prepare('SELECT status FROM receipt_orphaned ORDER BY key_id').all() as Array<{ status: number }>
+		).map(row => row.status)
+		expect(storedStatuses).toEqual([15, 18, 17])
+		for (const { keyId, fromMe, applied } of cases) {
+			const messageRowId = messageStore.recordMessage({ chatJid, fromMe, keyId, timestamp: now - 1 })
+			expect(receipts.replayOrphaned(chatJid, fromMe, keyId)).toBe(1)
+			expect(messageStore.getMessageByKeyId(chatJid, fromMe, keyId)?.status).toBe(applied)
+			expect(receipts.listUserReceipts(messageRowId)).toEqual([])
+		}
+
+		expect(db.prepare('SELECT COUNT(*) AS n FROM receipt_orphaned').get()).toMatchObject({ n: 0 })
+	})
 
 		it('lets a read-self orphan win over the read orphan of the same receipt', () => {
 			const db = store.handle('msgstore.db')
@@ -812,37 +823,236 @@ describe('msgstore.db message-store backends', () => {
 			expect(receipts.listUserReceipts(messageRowId)[0]).toMatchObject({ read_timestamp: now })
 		})
 
-		it('materializes an orphan group receipt without promoting the aggregate message status', () => {
-			const db = store.handle('msgstore.db')
-			const messageStore = new MessageStoreBackend(db, jidMap)
-			const receipts = new ReceiptBackend(db, jidMap, messageStore)
-			const chatJid = '120363000000000000@g.us'
-			const participantJid = '5515991426667@s.whatsapp.net'
-			const now = Math.floor(Date.now() / 1000)
+	// R6: without message.recipient_count (a send whose fan-out list this
+	// engine never saw, e.g. history-synced) the aggregate cannot run — the
+	// receipts still materialize per recipient, the status stays untouched.
+	it('materializes an orphan group receipt without promoting the aggregate message status when recipient_count is unknown', () => {
+		const db = store.handle('msgstore.db')
+		const messageStore = new MessageStoreBackend(db, jidMap)
+		const receipts = new ReceiptBackend(db, jidMap, messageStore)
+		const chatJid = '120363000000000000@g.us'
+		const participantJid = '5515991426667@s.whatsapp.net'
+		const now = Math.floor(Date.now() / 1000)
+
+		receipts.recordUserReceipt({
+			chatJid,
+			fromMe: true,
+			keyId: 'GROUP-ORPHAN',
+			receiptUserJid: participantJid,
+			kind: 'read',
+			timestamp: now
+		})
+		const messageRowId = messageStore.recordMessage({
+			chatJid,
+			fromMe: true,
+			keyId: 'GROUP-ORPHAN',
+			status: ANDROID_MESSAGE_STATUS.SERVER_ACK,
+			timestamp: now - 1
+		})
+
+		expect(receipts.replayOrphaned(chatJid, true, 'GROUP-ORPHAN')).toBe(1)
+		expect(receipts.listUserReceipts(messageRowId)[0]).toMatchObject({ read_timestamp: now })
+		expect(messageStore.getMessageByKeyId(chatJid, true, 'GROUP-ORPHAN')?.status).toBe(
+			ANDROID_MESSAGE_STATUS.SERVER_ACK
+		)
+	})
+
+	// R6 (MessageStatusStore.A02, X/C17C.java:823-891 in 2.26.38.10): a group
+	// message's status is the aggregate of the per-user receipt states counted
+	// against recipient_count (participants excluding the sender, X/A7L.java).
+	// played(8) counts played+read+delivered, read(13) counts read+delivered,
+	// delivered(5) counts delivered; every counter must reach recipient_count
+	// before the corresponding status applies, otherwise SERVER_ACK 4.
+	it('promotes group message status through the recipient aggregate like MessageStatusStore.A02', () => {
+		const db = store.handle('msgstore.db')
+		const messageStore = new MessageStoreBackend(db, jidMap)
+		const receipts = new ReceiptBackend(db, jidMap, messageStore)
+		const chatJid = '120363000000000001@g.us'
+		const alice = '5515991426667@s.whatsapp.net'
+		const bob = '5515998888888@s.whatsapp.net'
+		const now = Math.floor(Date.now() / 1000)
+		const keyId = 'GROUP-AGGREGATE'
+		messageStore.recordMessage({
+			chatJid,
+			fromMe: true,
+			keyId,
+			status: ANDROID_MESSAGE_STATUS.PENDING,
+			timestamp: now - 1,
+			recipientCount: 2
+		})
+
+		const record = (receiptUserJid: string, kind: 'delivery' | 'read' | 'played', timestamp: number) =>
+			receipts.recordUserReceipt({ chatJid, fromMe: true, keyId, receiptUserJid, kind, timestamp })
+		const status = () => messageStore.getMessageByKeyId(chatJid, true, keyId)!.status
+
+		record(alice, 'delivery', now) // 1/2 delivered → sent
+		expect(status()).toBe(ANDROID_MESSAGE_STATUS.SERVER_ACK)
+		record(bob, 'delivery', now + 1) // 2/2 delivered → double tick
+		expect(status()).toBe(ANDROID_MESSAGE_STATUS.DELIVERY_ACK)
+		record(alice, 'read', now + 2) // 1/2 read → still delivered
+		expect(status()).toBe(ANDROID_MESSAGE_STATUS.DELIVERY_ACK)
+		record(bob, 'read', now + 3) // 2/2 read → blue
+		expect(status()).toBe(ANDROID_MESSAGE_STATUS.READ)
+		record(alice, 'played', now + 4) // 1/2 played → still read
+		expect(status()).toBe(ANDROID_MESSAGE_STATUS.READ)
+		record(bob, 'played', now + 5) // 2/2 played → played
+		expect(status()).toBe(ANDROID_MESSAGE_STATUS.PLAYED)
+		expect(receipts.listUserReceipts(messageStore.getMessageByKeyId(chatJid, true, keyId)!._id)).toHaveLength(2)
+	})
+
+	it('keeps a partial group aggregate at the lower status while recipient_count is not reached', () => {
+		const db = store.handle('msgstore.db')
+		const messageStore = new MessageStoreBackend(db, jidMap)
+		const receipts = new ReceiptBackend(db, jidMap, messageStore)
+		const chatJid = '120363000000000002@g.us'
+		const now = Math.floor(Date.now() / 1000)
+		const keyId = 'GROUP-PARTIAL'
+		messageStore.recordMessage({
+			chatJid,
+			fromMe: true,
+			keyId,
+			status: ANDROID_MESSAGE_STATUS.PENDING,
+			timestamp: now - 1,
+			recipientCount: 3
+		})
 
+		for (const index of [0, 1]) {
 			receipts.recordUserReceipt({
 				chatJid,
 				fromMe: true,
-				keyId: 'GROUP-ORPHAN',
-				receiptUserJid: participantJid,
+				keyId,
+				receiptUserJid: `55159777000${index}@s.whatsapp.net`,
 				kind: 'read',
-				timestamp: now
+				timestamp: now + index
 			})
-			const messageRowId = messageStore.recordMessage({
+		}
+
+		// 2/3 read (and delivered) — neither counter reaches 3.
+		expect(messageStore.getMessageByKeyId(chatJid, true, keyId)!.status).toBe(ANDROID_MESSAGE_STATUS.SERVER_ACK)
+	})
+
+	// The multi-participant path applies the aggregate whenever it differs from
+	// the current status, DOWNGRADES INCLUDED — the app only logs
+	// "MessageStatusStore/statusDowngrade" telemetry (X/C17C.java:856-891);
+	// the 1:1 single path (A07) is the one that refuses regressions.
+	it('applies a group aggregate downgrade like the app multi-participant path', () => {
+		const db = store.handle('msgstore.db')
+		const messageStore = new MessageStoreBackend(db, jidMap)
+		const receipts = new ReceiptBackend(db, jidMap, messageStore)
+		const chatJid = '120363000000000003@g.us'
+		const now = Math.floor(Date.now() / 1000)
+		const keyId = 'GROUP-DOWNGRADE'
+		const messageRowId = messageStore.recordMessage({
+			chatJid,
+			fromMe: true,
+			keyId,
+			timestamp: now - 1,
+			recipientCount: 2
+		})
+		// Message claims READ (e.g. imported from a device snapshot) but only
+		// one receipt exists: 1 read + 1 delivered → aggregate DELIVERY_ACK.
+		db.prepare('UPDATE message SET status = ? WHERE _id = ?').run(ANDROID_MESSAGE_STATUS.READ, messageRowId)
+		receipts.recordUserReceipt({
+			chatJid,
+			fromMe: true,
+			keyId,
+			receiptUserJid: '5515991426667@s.whatsapp.net',
+			kind: 'read',
+			timestamp: now
+		})
+		receipts.recordUserReceipt({
+			chatJid,
+			fromMe: true,
+			keyId,
+			receiptUserJid: '5515998888888@s.whatsapp.net',
+			kind: 'delivery',
+			timestamp: now
+		})
+
+		expect(messageStore.getMessageByKeyId(chatJid, true, keyId)!.status).toBe(ANDROID_MESSAGE_STATUS.DELIVERY_ACK)
+	})
+
+	it('promotes a group message from orphaned receipts through the aggregate once the message arrives', () => {
+		const db = store.handle('msgstore.db')
+		const messageStore = new MessageStoreBackend(db, jidMap)
+		const receipts = new ReceiptBackend(db, jidMap, messageStore)
+		const chatJid = '120363000000000004@g.us'
+		const now = Math.floor(Date.now() / 1000)
+		const keyId = 'GROUP-ORPHAN-AGGREGATE'
+		const alice = '551596660000@s.whatsapp.net'
+		const bob = '551596661000@s.whatsapp.net'
+		// Alice progressed delivery → read while the message was still
+		// missing (same user, two rows); Bob only read it.
+		const orphanReceipts = [
+			{ receiptUserJid: alice, kind: 'delivery' as const, timestamp: now },
+			{ receiptUserJid: alice, kind: 'read' as const, timestamp: now + 1 },
+			{ receiptUserJid: bob, kind: 'read' as const, timestamp: now + 2 }
+		]
+		for (const { receiptUserJid, kind, timestamp } of orphanReceipts) {
+			receipts.recordUserReceipt({ chatJid, fromMe: true, keyId, receiptUserJid, kind, timestamp })
+		}
+
+		const messageRowId = messageStore.recordMessage({
+			chatJid,
+			fromMe: true,
+			keyId,
+			status: ANDROID_MESSAGE_STATUS.SERVER_ACK,
+			timestamp: now - 1,
+			recipientCount: 2
+		})
+
+		expect(receipts.replayOrphaned(chatJid, true, keyId)).toBe(3)
+		// Two distinct readers reach recipient_count → READ, and Alice's two
+		// rows merged into one receipt_user row.
+		expect(messageStore.getMessageByKeyId(chatJid, true, keyId)!.status).toBe(ANDROID_MESSAGE_STATUS.READ)
+		const userRows = receipts.listUserReceipts(messageRowId)
+		expect(userRows).toHaveLength(2)
+		expect(userRows.find(row => row.receipt_timestamp !== null)).toMatchObject({
+			receipt_timestamp: now,
+			read_timestamp: now + 1
+		})
+	})
+
+	// R6: the orphan row stores the app's Android status integer — delivery 5,
+	// read 13, played 8 — with the recipient set on user rows and NULL on the
+	// device-level ack (MessageStatusUpdateHelper, X/C28106CSb.java:427-470).
+	it('writes receipt_orphaned rows with the app Android status integer', () => {
+		const db = store.handle('msgstore.db')
+		const messageStore = new MessageStoreBackend(db, jidMap)
+		const receipts = new ReceiptBackend(db, jidMap, messageStore)
+		const chatJid = 'unknown-group-orphans@g.us'
+		const now = Math.floor(Date.now() / 1000)
+
+		const kinds = ['delivery', 'read', 'played'] as const
+		for (const [index, kind] of kinds.entries()) {
+			receipts.recordUserReceipt({
 				chatJid,
 				fromMe: true,
-				keyId: 'GROUP-ORPHAN',
-				status: ANDROID_MESSAGE_STATUS.SERVER_ACK,
-				timestamp: now - 1
+				keyId: `ORPHAN-INT-${kind}`,
+				receiptUserJid: '5515991426667@s.whatsapp.net',
+				kind,
+				timestamp: now + index
 			})
-
-			expect(receipts.replayOrphaned(chatJid, true, 'GROUP-ORPHAN')).toBe(1)
-			expect(receipts.listUserReceipts(messageRowId)[0]).toMatchObject({ read_timestamp: now })
-			expect(messageStore.getMessageByKeyId(chatJid, true, 'GROUP-ORPHAN')?.status).toBe(
-				ANDROID_MESSAGE_STATUS.SERVER_ACK
-			)
+		}
+		receipts.recordDeviceReceipt({
+			chatJid,
+			fromMe: true,
+			keyId: 'ORPHAN-INT-DEVICE',
+			receiptDeviceJid: '5515991426667.0:5@s.whatsapp.net',
+			timestamp: now
 		})
 
+		const rows = db
+			.prepare('SELECT key_id, receipt_recipient_jid_row_id, status FROM receipt_orphaned ORDER BY _id')
+			.all() as Array<{ key_id: string; receipt_recipient_jid_row_id: number | null; status: number }>
+		expect(rows).toEqual([
+			{ key_id: 'ORPHAN-INT-delivery', receipt_recipient_jid_row_id: expect.any(Number), status: 5 },
+			{ key_id: 'ORPHAN-INT-read', receipt_recipient_jid_row_id: expect.any(Number), status: 13 },
+			{ key_id: 'ORPHAN-INT-played', receipt_recipient_jid_row_id: expect.any(Number), status: 8 },
+			{ key_id: 'ORPHAN-INT-DEVICE', receipt_recipient_jid_row_id: null, status: 5 }
+		])
+	})
+
 		it.each(['5515991426667@c.us', '120363000000000000@newsletter', 'updates@broadcast'])(
 			'promotes orphan receipt status for non-group chat %s like the live path',
 			chatJid => {
```
