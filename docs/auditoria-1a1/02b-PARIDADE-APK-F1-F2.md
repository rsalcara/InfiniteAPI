# Auditoria de paridade com o APK — Fases 1 (recebimento) e 2 (envio)

| Item | Valor |
|---|---|
| Referência | `InfiniteZAP/libwhatsapp_2.26.36.72` @ **`921a6e9`** (WhatsApp Messenger 2.26.36.72, jadx em `study/02_jadx/sources`) |
| Alvo | `InfiniteZAP/InfiniteAPI` `develop` @ `0a97980` |
| Critério | O InfiniteAPI precisa ser **1:1** (mesma regra) ou **equivalente** (mesmo efeito observável) ao APK. Divergência só é aceita quando é limitação de gateway e está documentada |
| Método | Para cada achado das Fases 1 e 2: localizar a regra no APK pelos logs internos (o código é ofuscado), ler o fluxo, comparar com o código do InfiniteAPI e reclassificar. Nenhum arquivo do repositório foi alterado; `git status` limpo |
| Legenda | ✅ 1:1 · 🟰 equivalente · ❌ divergente · ➖ sem equivalente no APK (qualidade interna do gateway) |

> As referências do APK usam o caminho relativo a `study/02_jadx/sources/`. As classes são ofuscadas, então cito a classe com o log que a identifica.

### Nomes recuperados das classes citadas (desofuscação por evidência)

O R8 remove os nomes e o `mapping.txt` não vem no APK, então **não existe desofuscação 1:1 total**. Os nomes abaixo foram recuperados do que sobrou no bytecode: tags de log `Classe/metodo`, `getTag()`, `toString()` de data classes, `@DebugMetadata` e literais de autorreferência. O mapa completo cobre 14.044 classes (10.508 com confiança alta) e 10.801 métodos (`class_index.tsv`).

| Arquivo jadx | Nome recuperado | Confiança | Papel nesta auditoria |
|---|---|---|---|
| `X/C247818k` | `CoreMessageStore` (fundida pelo R8 com `EphemeralSettingsPre/Postprocessor`) | fundida | Grava a mensagem → `DeliveryReceipt` (F1-01) |
| `X/C248318p` | `ReadReceipts` (`A0K` = `sendReceiptForIncomingMessage`) | alta | Envio de recibos |
| `X/C28T` | `DeliveryReceipt` | alta | Resultado da gravação que autoriza o recibo |
| `X/AbstractC26441Ex` | `FMessage` | alta | Mensagem como objeto do banco |
| `X/AbstractC29370CuA` | `DecryptMessageRunnable` | média | Pipeline de descriptografia |
| `X/C29284CsY` | `SharedMessageProcessor` | média | Processamento da mensagem recebida |
| `X/C29004Cn4` | `RetryRequest` | alta | Placeholder + pedido de retry (F1-03) |
| `X/C1VN` | fusão de `RetryReceiptHandler` com `MediaDownloadManager` e outras | fundida | Handler do retry recebido (F2-02, P-01) |
| `X/C1DR` | `RetryReceiptHandler` (regras de sessão) | alta | F2-06 |
| `X/C34751fd` | `StanzaQueue` | alta | Filas `ChatQueue`/`E2eeQueue`/`UnorderedQueue` (F1-02) |
| `X/C08690aY` | `StanzaReceiver` | alta | Modo "offline buffering" |
| `X/HandlerThreadC08660aV` | fusão de `ConnectionThread`, `StanzaReceiver` e `ReaderThread` | fundida | Leitura de stanzas / `offline_preview` |
| `X/AbstractC34761fe` | `QueueStoreCache` (ConnectionQueue) | alta | Persiste stanzas em lote → ack (F1-06/08) |
| `X/C39411oj` | `JobQueue` | alta | Serial por `groupId`, paralelo entre grupos (F2-01) |
| `X/C12890iO` / `X/C14460l8` | `ParticipantDeviceStore` / `ParticipantUserStore` | alta / baixa | `sent_sender_key` por dispositivo (F2-05) |

A cópia legível (`libwhatsapp_deobf`) usa `Nome__Ofuscado` nas referências e comentários `// [deobf] Tag/metodo` nos métodos, **sem mudar a numeração de linhas**. Assim as citações `arquivo:linha` deste relatório valem nas duas árvores.

---

## 1. Veredito

A comparação com o APK **confirmou todos os achados críticos e altos** das Fases 1 e 2. Para cada um deles, o APK mostra a **regra exata** que o InfiniteAPI deve seguir. A comparação também revelou **7 divergências novas**, que só aparecem quando se lê o APK. Uma delas é de **confidencialidade**: o reenvio de mensagem de grupo não verifica se o dispositivo era destinatário.

| Achado | APK (regra) | InfiniteAPI hoje | Paridade | Gravidade |
|---|---|---|---|---|
| **F1-01** recibo antes de gravar | Grava a mensagem no banco e **só se a gravação der certo** cria o `DeliveryReceipt` | Envia o recibo antes do `upsert` | ❌ | **Crítico** (confirmado) |
| **F1-02** mensagem ao vivo ultrapassa o backlog offline | `ChatQueue` por chat: stanza nova de um chat com itens pendentes entra **atrás** deles. Com o padrão, **qualquer** backlog offline ativa o "offline buffering" | Mensagens ao vivo vão por um caminho paralelo que ignora a fila offline | ❌ | **Alto** (confirmado) |
| **F1-03** `retryMutex` global | `SendRetryReceiptJob` com `groupId = "retry-receipt-<remetente>"`, ou seja, **serial por remetente** e paralelo entre remetentes, sem `delay(1000)` | Mutex global, com `uploadPreKeys` + `delay(1000)` dentro dele | ❌ | **Alto** (confirmado) |
| **F1-06 / F1-08** ack e durabilidade | Grava as stanzas **em lote numa transação** (`flushStanzasToDisk`) e só então faz o ack; se o processamento falhar, a stanza continua na fila | Ack no `finally` mesmo quando falha; preack com 2 escritas por ack | ❌ | **Alto** (sobe de Médio) |
| **F1-12 / F2-02** janela de reenvio | Busca a mensagem **no banco**; recusa só se tiver **mais de 60 dias** (`5184000000` ms) | LRU de 512 itens por 5 min + `getMessage` undefined | ❌ | **Alto** (confirmado; meta = 60 dias) |
| **F2-01** trava global de envio | JobQueue com `groupId` = **JID do destino**: serial por chat, paralelo entre chats; reenvios numa pista separada (`<jid>_retry`) | Trava única com a chave `meId` | ❌ | **Crítico** (confirmado) |
| **F2-03** sem outbox | `SendE2EMessageJob` **persistente** (`isPersistent`), com `expireTimeMs`, `already-acked-by-server` e reexecução após reconexão | Resolve na escrita do socket, sem persistência | ❌ | **Alto** (confirmado) |
| **F2-04** IQ de metadata por envio | Participantes vêm do **banco local** (`group_participant_user`/`_device`); o envio exige participant hash | IQ `w:g2` a cada envio sem cache | ❌ | **Alto** (confirmado) |
| **F2-05** `sender-key-memory` regravado | `UPDATE group_participant_device SET sent_sender_key` **por dispositivo** | Regrava o mapa inteiro do grupo a cada envio | ❌ | Médio (confirmado) |
| **F2-06** pre-keys forçadas no retry | Busca pre-key nova só se a sessão falta, o registration id mudou ou a base key se repete (tentativa > 2) | `assertSessions(..., true)` **sempre** que o retry vem sem bundle | ❌ | Médio (confirmado) |
| F2-07 falha de reenvio só logada | Job com requisitos, retentativas e expiração de 24 h no reenvio | Só log | ❌ | Médio |
| F2-08 bypass interativo | O APK tem um modelo único (JobQueue por destino) | Dois modelos | ❌ | Baixo |
| F1-04, F1-05, F1-09, F1-10, F1-11 | — | — | ➖ | Mantidos (qualidade/segurança do gateway) |

**Novas divergências encontradas pela paridade (seção 4):** P-01 (confidencialidade, **Alto**), P-02 (custo em grupos grandes, **Alto**), P-03, P-04, P-05, P-06 e P-07.

---

## 2. Recebimento (Fase 1) contra o APK

### F1-01 — O recibo de entrega só sai depois da gravação ❌ Crítico

**APK:**
- `X/C247818k.java` (`CoreMessageStore`) `:5921-5960`: quando `writeMessageToDatabase` dá certo (`if (z5)`), cria `new C28T(...)` (`DeliveryReceipt(mode=…)`, `X/C28T.java`) e chama `this.A0m.A0K(msg, …)` = `ReadReceipts/sendReceiptForIncomingMessage` (`X/C248318p.java:166`).
- `X/C248318p.java:59` (`A0G`): o **tipo** de recibo (entrega, duplicada, erro 491 etc.) é decidido pelo **resultado da gravação** (`C28T`/`C28W`/`C28U`/`C28S`).
- O mesmo padrão aparece em `C247818k.A0Y` (`:6360-6395`): primeiro `A07(msg, 5)` (`FMessageDatabaseUpdateMethods/updateMessage` numa transação) e só depois `A0K`.

**InfiniteAPI:**
- `messages-recv.ts:4447`: `sendReceipt`;
- `:4508`: `upsertMessage`;
- a gravação no `msgstore` (mirror) acontece ainda depois, dentro de `processMessage` (`chats.ts:2195-2219`).

**Correção fiel:**
1. Gravar a mensagem (mirror `msgstore` e/ou o store do consumidor) e só **então** enviar o recibo.
2. Se a gravação falhar, não mandar o `DeliveryReceipt`. O servidor reentrega a mensagem.
3. Mensagem duplicada (a gravação detecta que a linha já existe) → recibo de duplicata, como o `ReadReceipts/sendReceiptForDuplicateMessage` do APK.

### F1-02 — Ordem por chat: `ChatQueue` e modo "offline buffering" ❌ Alto

**APK:**
- `X/C34751fd.java` (`StanzaQueue`) tem três filas: `X/C34901gV` = **`ChatQueue`**, `X/C34771ff` = `E2eeQueue` e `X/C34921gb` = `UnorderedQueue`.
- `C34751fd.java:137-176` (`A0E`): para `INCOMING_MESSAGE`, se o chat **já tem itens na `ChatQueue`** (`map.containsKey(chat)`), a stanza nova vai **para essa fila**, atrás dos pendentes.
- `X/HandlerThreadC08660aV.java:1555-1580` (`StanzaReceiver`): no `ib/offline_preview`, se a soma de `message + receipt + notification + call` for **≥ AB prop 16214**, o app entra em **"offline buffering mode"**. O padrão é **1** (`X/C016407t.java:1865`); o valor é limitado a [0, 100]. Sai no `ib/offline` e agenda o flush da fila.
- `X/C08690aY.java:85-104` (`shouldPersistStanza`): a AB prop 15572 tem padrão **−1** (`X/C016407t.java:1864`). Com ela, **toda stanza ao vivo é persistida na fila**, e qualquer stanza com `offline` liga o modo buffering. Ou seja, por padrão, ao vivo e offline passam pela mesma fila ordenada.

**InfiniteAPI:**
- mensagens offline vão para o `offlineNodeProcessor`, que é sequencial;
- mensagens ao vivo vão para `processNodeWithBuffer`, em paralelo (`messages-recv.ts:5174-5178`);
- o `liveChatOrderGate` **exclui** nós offline (`:3984`);
- a sonda da Fase 1 mostrou a mensagem ao vivo ultrapassando o backlog em 5/5 e 50/50 casos.

**Correção fiel:** uma fila FIFO **por chat** que atende ao vivo e offline juntos. Um nó ao vivo de um chat com backlog offline pendente entra atrás dele. Chats diferentes seguem em paralelo. Pelos padrões do APK (16214 = 1, 15572 = −1), essa regra vale **sempre**, não só em backlogs grandes.

### F1-03 — Pedido de retry por remetente, sem mutex global ❌ Alto

**APK:**
- `X/C29004Cn4.java` (`RetryRequest`) `:84-124`: primeiro **grava um placeholder local** ("recording local message placeholder for retry receipt", o "Aguardando esta mensagem") e depois cria o `SendRetryReceiptJob`.
- `com/whatsapp/jobqueue/job/SendRetryReceiptJob.java:226-229`: `groupId = "retry-receipt-" + <jid do remetente>`. A JobQueue (`X/C39411oj.java:55-97`) **não executa dois jobs do mesmo `groupId` ao mesmo tempo**, mas executa grupos diferentes em paralelo. O grupo é liberado no fim do job (`X/RunnableC40131pv.java:93-100`).
- Não há `delay(1000)` nem mutex global nesse caminho.

**InfiniteAPI:**
- `messages-recv.ts:296`: `retryMutex` global;
- `:4362-4387`: `uploadPreKeys(5)`, `delay(1000)` e `delay(retryRequestDelayMs)` dentro do mutex. Com 30 chats, a sonda mediu 4,7 s.

**Correção fiel:** trava por remetente (`retry-receipt-<jid>`), sem delay fixo dentro da trava. Também gravar o placeholder, que já existe como `placeholderResendCache`/orphan, antes de enviar o pedido.

### F1-06 / F1-08 — Ack depois de persistir a stanza, em lote ❌ Alto

**APK:**
- `X/AbstractC34761fe.java:90-175` (`ConnectionQueue`/`QueueStoreCache`): `flushStanzasToDisk` grava **N stanzas numa única transação** (`/insertStanzas`) e devolve a lista das que podem receber ack;
- stanzas com ack adiado são tratadas em `onDuplicateStanza/draining deferred ack` (`:744-820`);
- o processamento sai da fila persistida. Se falhar, a stanza continua na fila e é reprocessada.

**InfiniteAPI:**
- notificação recebe ack no `finally` mesmo quando falha (`:3953`), e aí a notificação se perde;
- o espelho de preack faz 2 escritas SQLite **por ack** (`:1367`).

**Correção fiel:**
1. Ack só depois de persistir a stanza, ou depois de processá-la com sucesso quando não houver fila persistida.
2. Se o processamento falhar, fazer **NACK/sem ack** para o servidor reentregar, em vez de ack no `finally`.
3. Gravar os preacks **em lote** numa transação, como o `flushStanzasToDisk`.

---

## 3. Envio e reenvio (Fase 2) contra o APK

### F2-01 — Pista por destino, não trava global ❌ Crítico

**APK:**
- `com/whatsapp/jobqueue/job/SendE2EMessageJob.java:9512-9518`: `groupId = <JID do destino>`; em **reenvio**, `groupId = <JID>_retry`, que é uma pista separada e não espera atrás dos envios normais;
- `ChatConnectionRequirement` (`X/B4T.java:286`) e `isPersistent = true` para quase todos os tipos;
- `org/whispersystems/jobqueue/JobParameters.java`: `groupId`, `isPersistent`, `requirements` e `retryCount` (padrão 100, `X/C39111oC.java`);
- a JobQueue executa jobs de `groupId` diferentes **em paralelo** num pool de threads (`X/C39461oo.java`, `JobConsumer`) e serializa os do mesmo `groupId` em ordem determinística (`X/C39411oj.java`, `DeterministicJobSelection`);
- os **requisitos** (`AxolotlSessionRequirement`, `AxolotlMultiDeviceSenderKeyRequirement` e similares, `:9545-9569`) resolvem sessão e pre-keys **antes** de o job rodar, ou seja, a rede fica fora da parte serial.

**InfiniteAPI:** `messages-send.ts:2821`, `transaction(runSendBody, meId)`, com uma chave para **todos** os destinos e IQs dentro dela.

**Correção fiel (1:1 com a JobQueue):**
1. Chave da trava = JID do destino normalizado (usuário ou grupo).
2. Reenvio usa a chave `<jid>_retry`.
3. Resolver sessões e dispositivos **antes** de pegar a trava.
4. Paralelismo limitado por pool.

O bypass interativo (F2-08) deixa de existir.

### F2-02 / F1-12 — Payload do reenvio vem do banco, com janela de 60 dias ❌ Alto

**APK:**
- `X/C1VN.java` (`RetryReceiptHandler`) `:31924`: a mensagem é **carregada do store** (`CWH.A00(key, true)`);
- `:31979-31980`: se `timestamp < agora − 5.184.000.000 ms` (**60 dias**), loga "cannot send retry to older message";
- `:32038`: se a mensagem foi apagada, loga "original message has been deleted" e não reenvia.

**InfiniteAPI:**
- `message-retry-manager.ts:183-186`: LRU de 512 itens com TTL de 5 min;
- `Defaults/index.ts:184`: `getMessage` undefined;
- `messages-recv.ts:3436`: descarta o pedido;
- `store.ts:192`: "Payload protos are intentionally not retained in msgstore.db".

**Correção equivalente:**
1. Persistir o payload das mensagens **enviadas** (proto codificado + rota), com expurgo após **60 dias**.
2. `getMessage` padrão = esse store quando o multi-db estiver ativo.
3. Mensagem revogada/apagada → sem reenvio, como no APK.

A tabela é própria do gateway, porque o `msgstore` real guarda o conteúdo em colunas e satélites. O efeito observável fica igual.

### F2-03 — Envio persistente ("outbox") ❌ Alto

**APK:** o `SendE2EMessageJob` é **persistente** (serializável, `readObject`) e registra estas situações:
- "e2e message send job added/created";
- "already-acked-by-server" (`:2138`): não reenvia o que o servidor já confirmou;
- "e2e message send job expired" (`:2317`);
- "e2e message was deleted from message store";
- "aborting … due to high retry count".

O status da mensagem no banco começa em `0` (pending) e passa a `4` quando chega o ack do servidor. Esse mapa já está em `message-store-backend.ts:102`.

**InfiniteAPI:** resolve em `messages-send.ts:2824`, logo depois do `sendNode`. Sem ack, a mensagem se perde.

**Correção fiel:**
1. Gravar o envio como pendente (status 0) **antes** de mandar.
2. O ack do servidor passa a mensagem a 4.
3. Na reconexão, reenviar com o **mesmo id** tudo que ainda estiver em 0 e não tiver expirado. Pular o que já recebeu ack.
4. Expirar com evento de falha para o consumidor.

### F2-04 — Participantes do grupo vêm do banco local ❌ Alto

**APK:**
- o `SendE2EMessageJob` usa o `groupParticipantsManager` e **exige** o participant hash: "cannot send e2e message to a group without a participant hash" (`:673`); há também `useOneOneEncryptionOnPHashMismatch`;
- a lista de participantes vem de `group_participant_user`/`group_participant_device` (`X/C12940iT.java`), mantidas pelas notificações do grupo.

**InfiniteAPI:** `messages-send.ts:~1824-1830` faz IQ de `groupMetadata` quando não há `cachedGroupMetadata`, que é o padrão.

**Correção fiel:** manter o estado local de participantes e dispositivos atualizado pelas notificações `w:gp2` (add/remove/promote/`addressing_mode`) e usar esse estado no envio. O `phash` já é gerado (`:2155-2157`). Se o servidor recusar por `phash` divergente, atualizar os participantes e reenviar.

### F2-05 — Status da sender key por dispositivo ❌ Médio

**APK:**
- `X/C14460l8.java`: `UPDATE group_participant_device SET sent_sender_key = ?, sent_sender_key_bucket = ? WHERE device_jid_row_id = ? AND …`, ou seja, **uma linha por dispositivo**;
- `X/C12890iO.java`: reset do grupo inteiro só em eventos específicos (ex.: `sent_sender_key = 0 … WHERE sent_sender_key_bucket = ?`).

**InfiniteAPI:** `messages-send.ts:1971` regrava o mapa inteiro a cada envio.

**Correção fiel:** gravar só os dispositivos que receberam SKDM agora (`senderKeyRecipients`), sem tocar nos demais.

### F2-06 — Regras de sessão no retry ❌ Médio

**APK:** `X/C1DR.java`, com trava **por dispositivo** (`A0W.A05(deviceJid)`).
- `:98-140` (`A00`):
  - se o registration id mudou → apaga a sessão e exige uma nova;
  - `count == 2` → **grava a base key**;
  - `count > 2` e mesma base key → "will wait to send … until a new prekey has been fetched";
  - fora desses casos → **reaproveita a sessão atual**, sem buscar pre-key.
- `:145-250`: processa o bundle `<keys>` do recibo **só se** a sessão existir e o registration id bater, quando o modo exige. Com pre-key legada, apaga a sessão PQ.

**InfiniteAPI:**
- ✅ equivalente: registration id divergente → apaga (`messages-recv.ts:3486-3498`); base key gravada na tentativa 2 e colisão depois disso (`:3503-3520`);
- ❌ divergente: `assertSessions([participant], true)` **sempre** que não há bundle (`:3533`), o que força um IQ de pre-key em todo retry;
- ❌ divergente: `deleteCanonicalSession` usa a trava `me.id`, não uma trava por dispositivo.

**Correção fiel:** buscar pre-key só nos 3 casos do APK e fazer a operação de sessão sob a trava do dispositivo.

---

## 4. Divergências novas reveladas pela paridade

### P-01 — Reenvio em grupo não verifica se o dispositivo era destinatário ❌ **Alto (confidencialidade)**

**APK** (`X/C1VN.java`):
- `:32025-32060`: calcula `isCurrentlyInGroup` (membro atual) e `wasInGroupAtTimeOfMessage` (o dispositivo estava entre os destinatários registrados da mensagem: `C15M…A0P(device, msg)`);
- `:32073`: só entra no caminho de reenvio em `if (!z3 || zA0P || z4)`;
- `:32269-32300`, no `else`: dispositivo **está** no grupo mas **não era** destinatário quando a mensagem saiu → **não reenvia**, só registra;
- `:32095`: a SKDM só é anexada se o dispositivo está no grupo agora.

**InfiniteAPI:** `sendMessagesAgain` (`messages-recv.ts:3275-3589`) e `relayMessage` com `participant` (`messages-send.ts:2162-2244`) **não verificam** se o dispositivo era destinatário. Qualquer dispositivo que peça retry de uma mensagem de grupo ainda disponível recebe o conteúdo cifrado para ele, **inclusive um participante adicionado depois do envio**.

**Correção:** antes de reenviar em grupo, exigir que o dispositivo esteja entre os destinatários daquela mensagem. Guardar a lista de dispositivos destinatários junto com o payload de F2-02; o APK usa `receipt_device` e os destinatários da mensagem. Se o dispositivo não era destinatário, não reenviar e registrar.

> Prova por leitura completa das duas funções. Recomendo uma sonda de confirmação na PR da correção.

### P-02 — Retry em grupo zera a distribuição de sender key do grupo inteiro ❌ **Alto (desempenho)**

**APK:** a SKDM vai **só** no reenvio individual para o dispositivo que pediu (`:32095-32110`), e o status é atualizado por dispositivo (`C14460l8`).

**InfiniteAPI:** `messages-recv.ts:3537-3539`, `sender-key-memory[grupo] = null`. Na **próxima** mensagem normal do grupo, a SKDM é redistribuída para **todos** os dispositivos: num grupo de 1.000 membros são milhares de `pkmsg`/`msg` extras, e isso acontece a cada retry recebido.

**Correção:** remover o reset do grupo inteiro; marcar como "precisa de SKDM" apenas o dispositivo do retry, ou nada, já que o reenvio individual já leva a SKDM.

### P-03 — Retry vindo do dispositivo primário reenvia para todos ❌ Médio

**InfiniteAPI:** `messages-recv.ts:3462`, `sendToAll = !jidDecode(participant)?.device`, com reenvio para todos os dispositivos (`useUserDevicesCache = false`).

**APK:** o reenvio vai sempre para o `deviceJid` que pediu (`SendE2EMessageJob(…, deviceJidA02, …)`, `:32238`).

**Correção:** reenviar só para o dispositivo solicitante.

### P-04 — Não verifica "já entregue" antes de reenviar ❌ Médio

**APK:** `:32042-32047`: se aquele dispositivo **já confirmou a entrega**, loga "original message already marked delivered" e só registra. Existe uma exceção para o `count` do recibo "7".

**InfiniteAPI:** não faz essa verificação. O `receipt_device` do mirror tem o dado para isso.

**Correção:** consultar o recibo por dispositivo antes de reenviar.

### P-05 — Limite de tentativas ❌ Baixo

**APK:** `:31952`, `if (i7 > 4)` → "skipping retry", ou seja, atende no máximo o `count` 4 **do recibo**.

**InfiniteAPI:** `maxMsgRetryCount: 5` com contador local por (id, participante) (`retry-receipt.ts:79`, `current < maximum`), que permite um quinto reenvio.

**Correção:** usar a regra do APK (`count` do recibo > 4 → não reenvia), mantendo o contador local só como proteção extra.

### P-06 — Reenvio sem expiração ❌ Baixo

**APK:** o job de reenvio expira em **24 h** (`j2 = agora + 86400000`, `:32231`).

**InfiniteAPI:** o reenvio é imediato e não tem expiração. Com a outbox de F2-03, aplicar a mesma expiração.

### P-07 — Reenvio compete com envios normais ❌ Médio

**APK:** pista `_retry` separada (`SendE2EMessageJob.java:9513`).

**InfiniteAPI:** o reenvio passa pela mesma trava global de F2-01. Corrigido junto com F2-01.

---

## 5. Itens sem equivalente no APK (➖), mantidos por qualidade do gateway

| Achado | Por que continua |
|---|---|
| F1-04 offline vira `append` | Semântica da API Baileys: o app notifica mensagens recebidas offline, e o consumidor precisa saber que é mensagem nova. Recomendação mantida |
| F1-05 exceção de listener derruba o processo | Robustez do gateway |
| F1-09 `console.log` com PII ligado por padrão | Vazamento de dados; o APK não expõe isso |
| F1-10 delete absorve o upsert no buffer | Consistência de eventos do gateway |
| F1-11 logs de `offline_preview`/batch | Ruído e custo |

---

## 6. O que já está 1:1 ou equivalente (não mexer)

- ✅ **Registration id divergente no retry → apaga a sessão** (`C1DR:103-116` ↔ `messages-recv.ts:3486-3498`).
- ✅ **Base key gravada no `count == 2` e colisão com `count > 2`** (`C1DR:118-137` ↔ `:3503-3520`).
- 🟰 **SKDM anexada no reenvio individual de grupo** (`C1VN:32095-32110` ↔ `messages-send.ts:2170-2200`), faltando a condição de P-01.
- 🟰 **Mapa de status do `msgstore`** (0/4/5/13/8) e a ordem de promoção (`message-store-backend.ts:102-143`).
- 🟰 **Cifragem Signal com trava por registro**, equivalente à trava por dispositivo do APK (`C09410bp.A05(deviceJid)`).
- 🟰 **Participant hash** gerado no envio a grupo (`phash`).

---

## 7. Plano de correção revisado (ordem por risco × custo, com a regra do APK)

| # | PR | Achados | Regra do APK a seguir | Esforço |
|---|---|---|---|---|
| 1 | `fix(retry): reenvio só para quem era destinatário` | **P-01**, P-03, P-04, P-05 | `wasInGroupAtTimeOfMessage`, reenvio só ao dispositivo, "already delivered", `count > 4` | Médio |
| 2 | `perf(retry): não zerar sender-key-memory do grupo` | **P-02**, F2-05 | Status de SKDM por dispositivo | Baixo |
| 3 | `fix(recv): recibo só após gravar` | **F1-01** | `writeMessageToDatabase` → `DeliveryReceipt` | Médio |
| 4 | `feat(send): payload durável de 60 dias + getMessage padrão` | **F2-02**, F1-12 | Busca no store, limite de 60 dias, apagada → não reenvia | Médio |
| 5 | `perf(send): pista por destino (+ _retry)` | **F2-01**, P-07, F2-08 | `groupId = jid` / `jid_retry`, requisitos antes da execução | Alto |
| 6 | `feat(send): outbox persistente` | **F2-03**, F2-07, P-06 | Job persistente, status 0→4, mesmo id na reconexão, expiração | Alto |
| 7 | `perf(recv): fila por chat unificando ao vivo e offline` | **F1-02** | `ChatQueue` + offline buffering (padrão: qualquer backlog) | Alto |
| 8 | `perf(recv): retry por remetente, sem delay global` | **F1-03** | `retry-receipt-<jid>` + placeholder antes | Médio |
| 9 | `fix(recv): ack após persistir/processar; preack em lote` | **F1-06, F1-08** | `flushStanzasToDisk` numa transação → ack | Médio |
| 10 | `perf(retry): pre-key só nos 3 casos do APK, trava por dispositivo` | F2-06 | `C1DR.A00` | Baixo |
| 11 | `feat(groups): participantes locais mantidos por notificação` | F2-04 | `group_participant_*` + `phash` | Médio/Alto |

Os itens ➖ da seção 5 entram como PRs pequenas de qualidade, em paralelo.

---

## 8. Limites desta rodada

- O código é **ofuscado** e o jadx marca blocos com "Code duplicated". Por isso as regras foram confirmadas **pelos logs internos e pelas condições**, não por nome de método. Onde o fluxo tem ramos duplicados (`C1VN`), citei o primeiro bloco.
- **P-01** e o modo "offline buffering" (F1-02) merecem uma **sonda de confirmação** no InfiniteAPI na própria PR da correção. Os padrões locais das AB props foram lidos em `X/C016407t.java` (16214 = 1, 15572 = −1). O servidor pode sobrescrevê-los via `abprops`; uma captura Frida confirma o valor em produção.
- O valor de `expireTimeMs` dos envios normais (não reenvio) não foi fixado nesta rodada. Fica para a PR de outbox.

**Próximo passo:** Fase 3 (conexão), já comparando cada ponto com o APK `921a6e9` desde o início (keepalive, reconexão, `offline_batch`, timers).
