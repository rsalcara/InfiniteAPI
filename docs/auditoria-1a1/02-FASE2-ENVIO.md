# Auditoria completa — Fase 2: Envio de mensagens

| Item | Valor |
|---|---|
| Repositório | `InfiniteZAP/InfiniteAPI`, `develop` @ `0a97980` |
| Escopo | `sendMessage` → `relayMessage` → resolução de destinatário (LID/PN) → dispositivos (USync) → sessões (pre-keys) → cifragem Signal/sender key → `sendNode` → ack do servidor; reenvio por recibo de retry; envio a grupos |
| Arquivos lidos | `src/Socket/messages-send.ts` (3.710 linhas: `relayMessageUnsafe` 1492–2825, `getUSyncDevices`, `assertSessions`, caminho de grupo), `src/Socket/messages-recv.ts` (`sendMessagesAgain` 3275–3589, ack do servidor 4853+), `src/Utils/auth-utils.ts` (transação por chave), `src/Signal/libsignal.ts` (locks por registro), `src/Utils/message-retry-manager.ts`, `src/Defaults/index.ts` |
| Método | Leitura + **sonda** sobre o `messages-send` real, com a camada de transação real do motor (`addTransactionCapability`) e latência de rede simulada. Nenhum commit; sonda removida; `git status` vazio |
| Critério | Melhor padrão: envio imediato, sem fila global, sem perda, entrega confirmada |

---

## 1. Resumo executivo

A cifragem e a resolução de dispositivos estão corretas e bem protegidas: lock por sessão Signal, consulta de dispositivos em lote, pre-keys e LID/PN tratados. Mas **o envio inteiro da instância passa por uma fila única**, e o envio não tem garantia de entrega nem janela de reenvio adequada:

| # | Gravidade | Problema | Impacto |
|---|---|---|---|
| **F2-01** | **Crítico** | **Todos os envios da instância são serializados** por um lock com a chave da própria conta, com I/O de rede dentro | Vazão de **1 envio por vez**; um IQ lento (até **30 s**) congela todos os envios |
| **F2-02** | **Alto** | Reenvio pedido pelo destinatário só funciona por **5 min / 512 mensagens**; depois é descartado em silêncio | **Mensagem enviada nunca chega** a quem ficou offline ou trocou de aparelho |
| **F2-03** | **Alto** | `sendMessage` resolve na **escrita do socket**, sem fila de saída nem timeout de ack | Queda entre escrita e ack = **mensagem perdida** sem nenhum aviso |
| **F2-04** | **Alto** | Todo envio a grupo faz um **IQ de metadata** quando o consumidor não fornece cache (padrão) | +1 round-trip por mensagem de grupo, dentro da fila global |

Mais 4 achados de gravidade média ou baixa (seção 3).

---

## 2. Achados principais (com prova)

### F2-01 — Crítico: fila única para todos os envios da instância

**Onde:** `src/Socket/messages-send.ts:2821`, `await authState.keys.transaction(runSendBody, meId)`. A implementação (`src/Utils/auth-utils.ts:595` → `locks.withLock({ namespace: '__legacy__', id: key })`) é um **lock exclusivo por chave**, e a chave é sempre o ID da conta. Dentro do lock rodam chamadas de rede:
- `groupMetadata` (IQ), linha ~1829;
- `getUSyncDevices` (IQ, em cache miss), ~1902;
- `assertSessions` (IQ de pre-keys), ~1957 e ~2110;
- `sendNode`.

A única exceção é o bypass para mensagens interativas 1:1 (`:1775`).

**Prova (sonda: 5 envios simultâneos, destinos diferentes):**

| Cenário | Tempo total medido | Ideal paralelo | Ideal serial |
|---|---|---|---|
| 5 grupos diferentes, IQ de metadata de 300 ms | **1.603 ms** | 300 ms | 1.500 ms |
| 5 grupos diferentes, escrita no socket de 300 ms | **1.535 ms** | 300 ms | 1.500 ms |
| 5 mensagens diretas, escrita de 300 ms | **1.523 ms** | 300 ms | 1.500 ms |

O resultado é **exatamente serial**: a primeira mensagem sai em cerca de 300 ms, e a quinta em cerca de 1.500 ms.

**Impacto real:**
- disparo de campanha: 100 mensagens com 200 ms de rede cada levam **20 s**, contra cerca de 0,2 s em paralelo;
- um único IQ que estoura o timeout (`defaultQueryTimeoutMs: 30_000`, `Defaults:130`) **congela todos os envios por 30 s**;
- os reenvios pedidos por retry (F2-02) também entram nessa fila, atrás dos envios normais;
- a exclusão de sessão no retry (`deleteCanonicalSession`, `messages-recv.ts:~3320`) usa o mesmo lock.

**Por que o lock global não é necessário (verificado):**
- a cifragem Signal **já tem lock próprio por registro**: `transactWith` por sessão (`src/Signal/libsignal.ts:692`) e por sender key (`:705`);
- o próprio código já envia interativos 1:1 **sem** o lock global (`:1775`), com base na mesma premissa;
- o que o lock ainda protege é: (a) a leitura-modificação-escrita do `sender-key-memory` de **um grupo**; (b) a ordem de envio dentro do **mesmo chat**. As duas coisas precisam só de um lock **por destino**.

**Melhor padrão:**
1. Trocar a chave `meId` pela **chave do destino** (`destinationJid` normalizado). Chats diferentes enviam em paralelo; o mesmo chat mantém a ordem FIFO.
2. Tirar a I/O de rede de dentro da seção crítica: resolver metadata, dispositivos e sessões **antes** do lock (são operações idempotentes e com cache) e deixar dentro do lock só a cifragem, a atualização do `sender-key-memory` e o `sendNode`.
3. Limitar a concorrência global (ex.: 32 envios em voo) para proteger o servidor e o limite de taxa, sem fila única.
4. Timeout de IQ **dentro do envio** menor que 30 s (ex.: 10 s), com erro claro.

---

### F2-02 — Alto: janela de reenvio de 5 min / 512 mensagens

**Onde:**
- o cache de reenvio é um LRU de **512 entradas com TTL de 5 min** (`message-retry-manager.ts:183-186`), alimentado no envio por `transmitWithRetryPayload` → `stageRecentMessage` (`:692`);
- o fallback é `getMessage`, cujo **padrão é `async () => undefined`** (`Defaults/index.ts:184`), e o motor não o liga ao `msgstore.db` quando o multi-db está ativo;
- sem conteúdo disponível, `sendMessagesAgain` só loga (`messages-recv.ts:3436`, "retry receipt ignored because the outbound message payload is unavailable") e retorna. O recibo de retry é confirmado.

**Cenário de perda:** o destinatário recebe a mensagem num aparelho sem sessão válida (celular reinstalado, troca de aparelho, sessão corrompida, aparelho desligado por horas). Quando ele pede o reenvio (recibo de retry), já se passaram mais de 5 minutos ou mais de 512 envios. O motor descarta o pedido e a pessoa fica para sempre com "Aguardando esta mensagem". Em disparo em massa, 512 mensagens enchem o cache em segundos.

**Melhor padrão:**
1. **Persistir no motor o conteúdo de cada mensagem enviada** num store durável (junto do `msgstore.db`), por **60 dias**, que é o limite exato que o APK aceita para reenvio (`RetryReceiptHandler`, `5184000000` ms).
2. `getMessage` **ligado por padrão** a esse store quando o multi-db estiver ativo. O LRU em memória continua como cache L1.
3. Dimensionar o LRU por memória, não só por 512 itens, e medir a taxa de acerto (métrica de retry sem conteúdo).
4. O `getMessage` do consumidor vira só um fallback opcional. O caminho padrão é o store do motor.

---

### F2-03 — Alto: envio sem confirmação de entrega ao servidor

**Onde:** o `relayMessage` retorna `msgId` (`messages-send.ts:2824`) logo depois de `sendNode(stanza)`, ou seja, da **escrita no socket**. O ack do servidor só emite um evento de estado (`messages-recv.ts:4869`, `state: 'server_ack'`). Não há fila de saída, nem reenvio na reconexão, nem evento de falha por timeout. Busca por `outbox`, `unacked`, `pendingAck` e `ackTimeout`: nada no envio.

**Cenário de perda:** a conexão cai (troca de rede, restart do servidor do WhatsApp) entre a escrita e o ack. O `sendMessage` já devolveu sucesso ao consumidor, a mensagem não chegou ao servidor e nunca mais é tentada. O consumidor só percebe se medir por conta própria a ausência do `server_ack`.

**Melhor padrão (entrega "pelo menos uma vez" no envio):**
1. **Registro de mensagens aguardando ack**, com payload e destino, persistido junto com o cache de F2-02.
2. Na reconexão, **reenviar com o mesmo `id`** o que não recebeu ack (o servidor deduplica por ID). É o comportamento do cliente oficial.
3. Timeout (ex.: 30 s) → evento `failed` com motivo `ack-timeout` e nova tentativa limitada.
4. Opção `sendMessage(..., { waitForServerAck: true })` que resolve só no ack, para quem precisa da confirmação.

---

### F2-04 — Alto: IQ de metadata em todo envio a grupo

**Onde:** `messages-send.ts:~1824-1830`: sem `cachedGroupMetadata`, o envio chama `groupMetadata(jid)`, que faz uma consulta `w:g2` completa. O padrão é `cachedGroupMetadata: async () => undefined` (`Defaults/index.ts:185`). Com a F2-01, esse round-trip acontece **dentro da fila global**.

**Impacto:** cada mensagem de grupo paga um round-trip extra (200–400 ms). Com a fila única, o teto fica em cerca de 3 mensagens de grupo por segundo **para a instância inteira**, além da carga desnecessária no servidor, que pode causar limite de taxa.

**Melhor padrão:** manter a metadata dos participantes atualizada **por evento** (as notificações `w:gp2` já chegam: add, remove, promote, alteração de `addressing_mode`, `ephemeral`) num cache interno do motor com invalidação por notificação e dirty bit. Não é um cache por TTL: é um estado mantido pelos próprios eventos do servidor, como as tabelas `group_participant_user`/`_device` do APK. O `cachedGroupMetadata` do consumidor vira fallback opcional; o padrão é o estado interno do motor.

---

## 3. Demais achados

| # | Gravidade | Achado | Onde | Melhor padrão |
|---|---|---|---|---|
| **F2-05** | Médio | `sender-key-memory` do grupo (mapa com **todos** os dispositivos de todos os participantes) é **regravado inteiro a cada mensagem**, mesmo sem dispositivo novo. Num grupo de 1.000 membros são dezenas de KB serializados e gravados por envio | `messages-send.ts:1971` | Gravar só quando `senderKeyRecipients.length > 0` (mudou alguma coisa). Correção de uma linha |
| **F2-06** | Médio | Reenvio força busca de pre-keys (`assertSessions([participant], true)`, IQ) em **todo** retry sem bundle, dentro do handler do recibo | `messages-recv.ts:3533` | Forçar só quando a sessão está ausente ou inválida (a validação já é feita acima); caso contrário, usar a sessão existente |
| **F2-07** | Médio | Falha no reenvio é só logada e o recibo de retry é confirmado (é o F1-12 da Fase 1) | `handleReceipt` → `sendMessagesAgain` | Com F2-02 e F2-03: tentativa limitada com backoff e evento `failed` explícito para o consumidor |
| **F2-09** | **Médio** | **Interativos para o mesmo destino saem fora de ordem.** O bypass de interativos 1:1 (`_isInteractiveSendBypass`) pula a trava de envio. Com 5 envios concorrentes de native flow para o mesmo chat, a ordem no fio foi `4, 5, 1, 2, 3`; o mesmo teste com texto sai `1, 2, 3, 4, 5`. Encontrado pela PR-00 com a camada de transação real (`addTransactionCapability`) | `messages-send.ts:1775` | Pista por destino (PR-20), que preserva o FIFO para todos os tipos. O teste `it.failing` fica em `messages-send.stanza-assembly.test.ts` |
| **F2-10** | **Alto** | **`reporting_token` depende do padding aleatório.** O token é calculado sobre `encodeWAMessage()`, que já inclui o padding de 1 a 16 bytes; o extrator lê o padding como campos protobuf. Com a mesma mensagem (enquete com `messageSecret`) em 64 envios saíram 4 resultados: sem token, o token correto e 2 tokens errados. Medido por tamanho de padding: só 4 de 16 geram token (3 valores distintos); sem padding, o token sai sempre. Como o `sendMessage` põe `messageSecret` em toda mensagem elegível (`Utils/messages.ts:2187-2192`), ~75% dos envios saem sem token e parte do resto com valor errado. Nos interativos, hoje sai token em ~2 de 16 envios. Encontrado pela PR-00 (golden de enquete instável) | `messages-send.ts:2517-2543`, `Utils/generics.ts:86`, `Utils/reporting-utils.ts:312-345` | Calcular sobre `proto.Message.encode(msg).finish()` sem padding (o app deriva o token da mensagem e do segredo: `ReportingToken`, `X/C29252Crs.java:25-95`). PR-29. Teste `it.failing` em `messages-send.stanza-assembly.test.ts` |
| **F2-08** | Baixo | O bypass interativo 1:1 (`:1775`) cria **dois modelos de concorrência** diferentes no mesmo caminho de envio | `messages-send.ts:1775` | Com a F2-01 corrigida (lock por destino), o bypass deixa de ser necessário e o caminho fica único |

---

## 4. O que já está correto (não mexer)

- **Lock por registro Signal** (`transactWith` por sessão e por sender key): a cifragem é segura sob concorrência.
- **Dispositivos em lote**: `getUSyncDevices` usa `mget` no cache.
- **LID/PN**: preflight do destinatário, canonicalização e mapeamento consistentes.
- **Distribuição de sender key** só para dispositivos novos (`senderKeyRecipients`), exceto carrossel.
- **Bloqueio em grupo "somente admins"** antes de cifrar, com evento de segurança.
- **Integridade nativa**: egress bloqueado sem bloquear retry e peer.
- **Ack de servidor** correlacionado pelo cache de rota (inclusive LID↔PN).

---

## 5. Arquitetura-alvo do envio (o "melhor padrão")

```text
sendMessage(jid, conteúdo)
  1. gerar mensagem + mídia                         (fora de qualquer lock)
  2. resolver destino, metadata (cache por eventos),
     dispositivos (cache) e sessões                  (fora do lock; IQs com timeout curto)
  3. LOCK POR DESTINO (FIFO por chat; chats diferentes em paralelo; teto global de N em voo)
       cifrar (locks Signal por registro)  →  atualizar sender-key-memory só se mudou  →  sendNode
  4. registrar "aguardando ack" (durável, com payload)        (F2-03 + F2-02)
  5. ack do servidor → 'server_ack' e remove da fila; sem ack em 30 s ou queda → reenviar com o mesmo id
  6. recibo de retry do destinatário → payload do store durável (60 dias, como o `RetryReceiptHandler` do app) → reenvio pela mesma pista
```

**Resultado esperado:**
- vazão proporcional ao número de chats, e não uma mensagem por vez;
- nenhuma mensagem "enviada" que não chegou;
- reenvio funcionando horas ou dias depois;
- grupos sem round-trip extra.

---

## 6. Plano de correção sugerido (PRs separadas)

| Ordem | PR | Achados | Esforço | Risco |
|---|---|---|---|---|
| 1 | `perf(send): gravar sender-key-memory só quando mudar` | F2-05 | Muito baixo | Muito baixo |
| 2 | `feat(send): payload de envio durável + getMessage padrão no msgstore` | F2-02 | Médio | Baixo (aditivo) |
| 3 | `feat(send): fila de ack pendente com reenvio na reconexão e timeout` | F2-03, F2-07 | Médio/Alto | Médio (precisa confirmar deduplicação por ID no servidor) |
| 4 | `perf(send): lock por destino e I/O fora da seção crítica` | F2-01, F2-08 | Alto | Médio/Alto (núcleo do envio; exige testes de concorrência e ordem por chat) |
| 5 | `feat(groups): estado de participantes mantido por notificações` | F2-04 | Médio | Médio (fidelidade a `w:gp2`) |
| 6 | `perf(retry): pre-keys só quando a sessão estiver ausente` | F2-06 | Baixo | Baixo |

**Princípio:** toda correção fica **no motor InfiniteAPI**, 1:1 com o APK:
- estado de participantes interno, mantido por notificação (F2-04);
- payload de reenvio durável por 60 dias, com `getMessage` padrão do motor (F2-02);
- outbox persistente, vigia de ack de 45 s e reenvio com o mesmo id na reconexão (F2-03, F3-03). A falha chega ao consumidor como evento, e ele não precisa implementar nada.

---

## 7. Perguntas para o APK (fidelidade)
1. O cliente reenvia na reconexão mensagens sem ack **com o mesmo ID**? O servidor deduplica (F2-03)?
2. Por quanto tempo o app atende um recibo de retry de uma mensagem enviada (F2-02)?
3. O app consulta a metadata do grupo a cada envio ou usa o estado local mantido por notificações (F2-04)?
4. Concorrência de envio entre chats diferentes no app (F2-01).

---

**Próxima fase:** Fase 3 (conexão): socket, keepalive, reconexão, sincronização offline, timers e vazamento de memória.
