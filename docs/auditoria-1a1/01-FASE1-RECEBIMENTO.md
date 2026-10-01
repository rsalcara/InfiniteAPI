# Auditoria completa — Fase 1: Recebimento de mensagens

| Item | Valor |
|---|---|
| Repositório | `InfiniteZAP/InfiniteAPI`, `develop` @ `0a97980` |
| Escopo | Do frame WebSocket até o evento `messages.upsert` para o consumidor: dispatch, fila offline, ordem, decrypt, retry, ack/NACK, recibos, notificações, buffer de eventos |
| Arquivos lidos | `src/Socket/messages-recv.ts` (5.427 linhas: dispatch, `handleMessage`, `handleReceipt`, `handleNotification`, `sendMessageAck`, `sendRetryRequest`), `src/Utils/offline-node-processor.ts`, `src/Utils/decode-wa-message.ts` (caminho de falha), `src/Utils/event-buffer.ts` (consolidação), `src/Socket/chats.ts` (`upsertMessage`, sync inicial), `src/Socket/socket.ts` (buffer offline) |
| Método | Leitura do código + **sondas no socket real** (cliente WebSocket falso, stanzas `<plaintext>` e `<enc>` com falha simulada) medindo o comportamento. Nenhum commit; sondas removidas; `git status` vazio |
| Critério | O melhor padrão possível para: **nenhuma perda**, **ordem correta**, **entrega imediata**, robustez e desempenho |

---

## 1. Resumo executivo

O recebimento está bem protegido contra os erros mais comuns: nenhuma mensagem fica sem ack, há NACK em erro inesperado, o teardown não confirma trabalho incompleto, existe gate de ordem por chat ao vivo e o retry é deduplicado por remetente. Mas há **quatro problemas estruturais que impedem o "sem perda, sem atraso e em ordem"**, todos **provados por medição**:

| # | Gravidade | Problema | Impacto |
|---|---|---|---|
| **F1-01** | **Crítico** | Recibo de entrega enviado **antes** de qualquer gravação | **Perda de mensagem** se o consumidor ou o processo falhar logo após o recibo |
| **F1-02** | **Alto** | Mensagem ao vivo **ultrapassa** mensagens offline mais antigas do mesmo chat | **Conversa fora de ordem** após cada reconexão |
| **F1-03** | **Alto** | `retryMutex` **global**, com delays, dentro do mutex do chat | **Atraso linear**: 30 chats com falha → 4,7 s; com erro de PreKey, > 30 s |
| **F1-04** | **Alto** | Mensagens novas recebidas offline chegam como `append`, não `notify` | Consumidor que filtra `notify` **descarta** mensagens da janela de desconexão |

Mais 8 achados de gravidade média ou baixa (seção 3).

---

## 2. Achados principais (com prova)

### F1-01 — Crítico: recibo de entrega antes da persistência (entrega "no máximo uma vez")

**Onde:** `src/Socket/messages-recv.ts:4447` (`sendReceipt`) roda **antes** de `:4508` (`upsertMessage`). O `upsertMessage` (`src/Socket/chats.ts:2114`) só emite o evento; o espelho do próprio motor (`msgstore.db`, via `processMessage`) grava depois.

**Prova (sonda no socket real):** no instante em que o consumidor recebe o `messages.upsert`, o fio já contém:
```text
snapshotAtUpsert: [ "receipt:LOSS-1:inactive" ], depois [ "upsert:LOSS-1" ]
```
O recibo sai antes de o consumidor ver a mensagem. Não existe hook, opção ou retorno que permita adiar o recibo até a gravação.

**Por que é crítico:** o recibo é o sinal para o servidor apagar a mensagem da fila. Qualquer falha entre o recibo e a gravação faz a mensagem sumir sem possibilidade de reenvio:
- queda do processo (deploy, OOM, kill);
- falha do banco da platform;
- listener do consumidor que lança exceção (F1-05).

**Melhor padrão (entrega "pelo menos uma vez"):**
1. Nova opção `inboundDurability?: (messages: WAMessage[]) => Promise<void>` no `SocketConfig`. O `handleMessage` a chama e **aguarda** depois do decrypt e **antes** do `sendReceipt`. O Rust tem o equivalente, `InboundDurabilityHook`.
2. Se o hook falhar ou estourar o timeout (ex.: 10 s): **não** enviar recibo. Enviar NACK (ou nada) para o servidor reentregar na reconexão.
3. O consumidor passa a ser idempotente pela chave da mensagem (`remoteJid + id + participant`). A duplicata de uma reentrega é tratada; a perda não tem como ser recuperada.
4. **No motor, por padrão (1:1 com o APK):** gravar a mensagem no `msgstore.db` **antes** do recibo, numa transação curta, e só então enviar o `DeliveryReceipt`. O APK faz exatamente isso (`CoreMessageStore/writeMessageToDatabase` → `DeliveryReceipt`, ver o relatório de paridade).
5. O hook do item 1 é **adicional**, para quem também quer confirmar no próprio banco. A durabilidade não depende dele, porque é responsabilidade do motor.

**Custo de latência:** o tempo de um insert no `msgstore.db` (sub-ms a poucos ms, em lote) antes do recibo. O remetente vê o "entregue" um pouco depois; a mensagem nunca some.

**Fidelidade:** o WhatsApp Android grava no `msgstore` antes de confirmar a entrega. O padrão atual vem do Baileys upstream, não do app oficial.

---

### F1-02 — Alto: mensagem ao vivo ultrapassa o backlog offline do mesmo chat

**Onde:** `src/Socket/messages-recv.ts:5174-5179`. Nós com `offline` vão para `offlineNodeProcessor.enqueue` (fila sequencial global, `src/Utils/offline-node-processor.ts`). Nós ao vivo vão direto para `processNodeWithBuffer`, em paralelo, sem esperar a fila. O gate de ordem ao vivo (`liveChatOrderGate`) **exclui** os nós offline de propósito (`:3984`).

**Prova (sonda):**

| Backlog offline | Posição da mensagem ao vivo | Mais antigas do mesmo chat entregues **depois** dela |
|---|---|---|
| 50 | 2ª de 51 | **5 de 5** |
| 500 | 2ª de 501 | **50 de 50** |

**Impacto:** a cada reconexão com backlog, a mensagem mais nova do chat chega ao consumidor **antes** das anteriores. Para o Chatwoot, que ordena por chegada, a conversa fica embaralhada.

**Melhor padrão:** uma única "pista" ordenada **por chat**, compartilhada entre offline e ao vivo, com paralelismo **entre** chats.
- **Opção A (simples):** enquanto houver nós offline pendentes para o chat X, um nó ao vivo de X entra no fim da fila offline, em vez de ser processado direto.
- **Opção B (melhor desempenho):** substituir a fila global sequencial por filas por chat (a mesma chave do `liveChatOrderKey`), com concorrência limitada entre chats (ex.: 8 a 16). Offline e ao vivo usam a mesma pista. O drain fica mais rápido (hoje é estritamente um nó por vez para todos os chats) e a ordem por chat fica garantida. É o modelo de "chat lanes" do cliente Rust.

---

### F1-03 — Alto: `retryMutex` global com delays dentro do mutex do chat

**Onde:** `src/Socket/messages-recv.ts:296` (`const retryMutex = makeMutex()`, sem chave), usado em `:4362` **dentro** do `messageMutex` do chat. Dentro dele:
- `uploadPreKeys(5)` (`:4375`) e **`delay(1000)` fixo** (`:4377`) em erro de PreKey;
- `delay(retryRequestDelayMs)` (padrão 150 ms, `:4387`).

A justificativa está no comentário de `:436-441`: o mutex foi mantido global para proteger o upload de pre-keys.

**Prova (sonda: N chats com falha de decrypt ao mesmo tempo, depois uma mensagem boa no último chat):**

| Chats com falha | Atraso da mensagem boa no **mesmo** chat | Atraso em chat **não relacionado** |
|---|---|---|
| 1 | 292 ms | 131 ms |
| 10 | 1.581 ms | 25 ms |
| 30 | **4.675 ms** | 24 ms |

Crescimento linear, de cerca de 155 ms por chat na fila. Com erro de PreKey, cada chat soma o round-trip do upload **e 1 s fixo**: com 30 chats, passa de **30 s**. É o cenário típico depois de uma troca de sessão em massa (migração LID, restauração de backup, reinstalação no celular do contato).

**Melhor padrão:**
1. Trocar o `retryMutex` global por **lock por remetente** (`retryDedupeJid`, que já existe em `:2103`). Remetentes diferentes fazem retry em paralelo.
2. Upload de pre-keys em **single-flight**: uma única promessa compartilhada, em que chamadas concorrentes aguardam o mesmo upload. Isso preserva a proteção que motivou o mutex global, sem serializar os retries.
3. **Tirar o `delay(1000)` fixo:** o `uploadPreKeys` já aguarda a resposta do IQ do servidor, então esperar mais 1 s é tempo morto.
4. **Soltar o `messageMutex` do chat antes do I/O do retry.** No caminho de falha a mensagem não é entregue ao consumidor (ela retorna com NACK), então não há ordem a proteger durante o envio do recibo de retry.

---

### F1-04 — Alto: mensagens novas recebidas offline chegam como `append`

**Onde:** `src/Socket/messages-recv.ts:4508`, `upsertMessage(msg, node.attrs.offline ? 'append' : 'notify')`. As notificações também usam `append` (`:3949`).

**Prova (sonda):** `offlineUpsertType: "append"`, `liveUpsertType: "notify"`.

**Impacto:** na convenção do Baileys, `notify` significa "mensagem nova" e `append` significa "histórico/sincronização". Mensagens que o usuário recebeu **enquanto a instância estava desconectada** são novas, mas chegam como `append`. Um consumidor que só processa `notify` (o padrão mais comum nas integrações) as **descarta**. Na prática, a janela de desconexão vira perda.

**Melhor padrão (sem quebrar contrato):**
- adicionar um sinal explícito em cada mensagem, por exemplo `msg.deliveredOffline = true`, ou um campo `source: 'live' | 'offline' | 'history' | 'notification'` no evento;
- documentar que `append` sem `source: 'history'` é mensagem nova;
- avaliar uma opção `offlineUpsertType: 'notify'` para quem quer tratar tudo como novo;
- a deduplicação fica **no motor**: a chave natural do `msgstore` (`chat, from_me, key_id, sender`) detecta a reentrega e responde com recibo de duplicata, como o APK (`ReadReceipts/sendReceiptForDuplicateMessage`), sem emitir o evento de novo.

---

## 3. Demais achados

| # | Gravidade | Achado | Onde | Melhor padrão |
|---|---|---|---|---|
| **F1-05** | Médio | Listener `async` do consumidor que rejeita vira **rejeição não tratada**; no Node ≥ 15 isso **derruba o processo** por padrão. Provado: na primeira sonda, o listener que lançou foi reportado como rejeição não tratada | `ev.emit` (sem observar a promessa do listener) | O emitter captura a promessa do listener: `.catch(err => logger.error + métrica)`. Nunca derrubar o motor por erro do consumidor |
| **F1-06** | Médio | **Notificação confirmada mesmo quando o processamento falha** (`finally` → ack). Falha transitória (banco ocupado) em notificação de grupo, dispositivo ou criptografia vira **perda de estado** sem reentrega | `messages-recv.ts:3953` | Falha transitória → NACK (`UnhandledError`) para o servidor reentregar, com limite de tentativas; falha permanente ou de parse → ack. Confirmar a semântica no APK |
| **F1-07** | Médio | **Um recibo por mensagem no drain offline** (10 mil mensagens = 10 mil stanzas). O WA Web agrega os recibos offline (`sendAggregateOfflineReceipts`) | `handleMessage` → `sendReceipt` por mensagem; agregação já existe em `messages-send.ts:597` (`sendReceipts`) | Acumular os recibos durante o drain por (chat, participante, tipo) e enviar em lista. Formato a confirmar no APK/Web |
| **F1-08** | Baixo/Médio | **2 escritas SQLite por ack** (`enqueuePreack` e `deletePreack`) no caminho quente de toda mensagem com multi-db | `messages-recv.ts:1367` e seguintes | Medir; se relevante, agrupar ou tornar o espelho opcional (é best-effort) |
| **F1-09** | Médio | Log por mensagem ligado por padrão: 2× `console.log` `[BAILEYS]` com **ID e JID/telefone** (`BAILEYS_LOG !== 'false'`) mais `logger.info` "message sender source classified" em toda mensagem. Custo de I/O e **dado pessoal em log** | `baileys-logger.ts:540`, `chats.ts:2112-2113` | Desligado por padrão em produção, nível `debug`, JID mascarado. Detalhe na Fase 5 |
| **F1-10** | Baixo | Um `messages.delete` que chega na mesma janela do buffer **apaga o `upsert`** da mensagem original; o consumidor recebe a exclusão de uma mensagem que nunca viu | `event-buffer.ts:1300` | Manter o `upsert` e emitir o delete depois (ou marcar a mensagem como revogada) |
| **F1-11** | Baixo | `offline_preview` é logado em `info` com o nó inteiro em JSON; `offline_batch count=100` é pedido **uma única vez** | `socket.ts:2638`, `:2642` | Log em `debug`. Confirmar no APK se o cliente deve pedir novos lotes |
| **F1-12** | (Fase 2) | Falha no reenvio pedido por um recibo de retry é **só logada** e o recibo é confirmado: o destinatário nunca recebe a mensagem | `handleReceipt` → `sendMessagesAgain` | Será auditado na Fase 2 (envio), junto com o cache de reenvio |

---

## 4. O que já está correto (não mexer)

- **Nenhuma mensagem sem resposta:** `acked` e o NACK `UnhandledError` no `catch` geral (`handleMessage`).
- **Teardown seguro:** `sendMessageAck` não confirma com o socket fechando, e o servidor reentrega.
- **Drenagem na saída:** `inboundTaskAdmission` e `offlineNodeProcessor.stopAndDrain` antes de fechar os stores.
- **Ordem ao vivo por chat** (`liveChatOrderGate` + `messageMutex` normalizado), com paralelismo entre chats. Provado na F1-03: chat não relacionado com atraso de cerca de 25 ms.
- **Retry deduplicado por remetente** (`retryRequestActiveJids`) e limitado (`maxMsgRetryCount`).
- **NACK 496 em sender-key obsoleta** de grupo, que evita loop de retry inútil.
- **Buffer offline limitado** a 2 s na primeira conexão e **pulado na reconexão**; espera de sync inicial de 4 s só no primeiro login.
- **Drain offline resistente a erro por nó** (`.catch` por nó, a flag é sempre liberada).

---

## 5. Arquitetura-alvo do recebimento (o "melhor padrão")

```text
frame WS
  └─ dispatch (message/receipt/notification/call)
       └─ PISTA POR CHAT (mesma chave para offline e ao vivo; N pistas em paralelo, limite configurável)
            1. decode + decrypt
               └─ falha → retry fora da pista (lock por remetente, pre-keys single-flight) → NACK
            2. inboundDurability(msgs)  ← aguardado, com timeout (F1-01)
            3. recibo (agregado durante o drain offline, F1-07)
            4. messages.upsert com "source" explícito (F1-04)
            5. processMessage / espelhos best-effort
  └─ listeners do consumidor isolados (erro capturado e medido, F1-05)
```

**Resultado esperado:**
- **sem perda:** recibo só depois da gravação;
- **em ordem:** pista única por chat;
- **sem atraso por falha de outro chat:** retry fora da pista e sem mutex global;
- **drain offline mais rápido:** paralelismo entre chats e recibos agregados.

---

## 6. Plano de correção sugerido (em PRs separadas)

| Ordem | PR | Achados | Esforço | Risco |
|---|---|---|---|---|
| 1 | `feat(recv): inboundDurability hook antes do recibo` | F1-01 | Médio | Baixo (opt-in) |
| 2 | `fix(recv): retry por remetente, pre-keys single-flight e sem delay fixo` | F1-03 | Médio | Médio (caminho de recuperação de sessão; exige testes de retry) |
| 3 | `fix(recv): pista por chat compartilhada entre offline e ao vivo` | F1-02 (e F1-07) | Alto | Médio (núcleo do dispatch) |
| 4 | `feat(recv): origem explícita no upsert (offline/histórico/notificação)` | F1-04 | Baixo | Baixo (aditivo) |
| 5 | `fix(events): isolar erros de listener do consumidor` | F1-05 | Baixo | Baixo |
| 6 | `fix(recv): NACK em falha transitória de notificação` | F1-06 | Baixo | Médio (confirmar no APK) |
| 7 | Tuning: logs por mensagem e espelho de preack | F1-08, F1-09, F1-11 | Baixo | Baixo |

**Princípio:** toda correção fica **no motor InfiniteAPI**, 1:1 com o APK sempre que possível; nada depende da platform:
- o motor marca a origem de cada mensagem (F1-04);
- o motor deduplica pela chave natural do `msgstore` (F1-01/F1-04);
- o motor isola exceções de listener para que não derrubem o pipeline (F1-05).

---

## 7. Perguntas para o APK (fidelidade)
1. Em que momento o app grava a mensagem recebida em relação ao envio do recibo de entrega (F1-01)?
2. Formato e momento dos recibos agregados no drain offline (F1-07).
3. O cliente pede novos `offline_batch` depois do primeiro? Com qual `count` (F1-11)?
4. Notificação cujo processamento falha: o app confirma, NACKa ou deixa sem resposta (F1-06)?
5. Depois de um recibo de retry, o app aguarda algum tempo fixo ou upload de pre-keys antes de seguir (F1-03)?

---

**Próxima fase:** Fase 2 (envio), que cobre relay, fan-out por dispositivo, LID/PN, cache de reenvio e F1-12.
