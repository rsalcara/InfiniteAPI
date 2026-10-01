# Auditoria completa — Fase 3: Conexão (com paridade APK)

| Item | Valor |
|---|---|
| Alvo | `InfiniteZAP/InfiniteAPI` `develop` @ `0a97980` |
| Referência | `InfiniteZAP/libwhatsapp_2.26.36.72` @ `921a6e9`; cópia legível em `study/06_deobf` (branch `deobf-evidence` @ `3689810`) |
| Escopo | Handshake, login, ativação, keepalive, ping do servidor, detecção de queda, `end()`/limpeza, timers, vazamento entre reconexões, fluxo offline no nível de conexão e política de reconexão |
| Método | Leitura completa do ciclo de vida (`socket.ts`, `Client/*`, `keepalive-watchdog.ts`, `session-cleanup.ts`). **3 sondas** com o socket real sobre WebSocket falso (30 ciclos de conexão/fechamento, com e sem login). **1 mutação** para provar a causa raiz. Regras do APK tiradas da cópia desofuscada. Sondas removidas, arquivo mutado restaurado e `git status` vazio |

## Escopo da paridade: dois perfis

| Perfil | Papel | Referência de fidelidade |
|---|---|---|
| `web` (padrão) | Dispositivo **companion** | WA Web (fonte não disponível). O APK só vale para regras de protocolo comuns |
| `native_android` | Se passa pelo **app Android** via TCP | **O APK é a referência direta**: tudo nesta fase vale 1:1 |

---

## 1. Resumo executivo

| # | Gravidade | Achado | Perfil | Prova |
|---|---|---|---|---|
| **F3-01** | **Alto** | **Vazamento em reconexão:** cair nos 5 s após o login deixa um agendador de limpeza "zumbi", que prende o socket fechado na memória **para sempre** e roda `runCleanup` depois do fechamento | ambos | Sonda: **+1 timer e +3,5 MB por ciclo, nunca liberados**; a mutação elimina o efeito |
| **F3-02** | **Alto** | **Conexão "aberta" sem estar ativa:** se o IQ `active` falha, sai só um `warn` e a conexão fica sem receber mensagens ao vivo | ambos | Leitura; APK derruba e refaz em 32 s |
| **F3-03** | **Alto** | **Não há vigia de ack por mensagem:** o APK refaz a conexão se uma mensagem enviada não recebe ack em 45 s | ambos | Leitura (APK `TimeoutHandler`) |
| **F3-04** | **Alto** (`native_android`) | **Ping do servidor sem resposta:** não existe handler para `iq get urn:xmpp:ping` | ambos | Sonda: 0 listeners em todas as chaves de despacho, 0 respostas |
| F3-05 | Médio (`native_android`) | Cadência de keepalive fixa em 15 s; o APK faz o primeiro ping aos 15 s, depois **a cada 240 s**, com timeout de 32 s | `native_android` | Leitura + AB defaults |
| F3-06 | Médio (`native_android`) | `offline_batch` é enviado em todo perfil; o APK **nunca** monta esse nó | `native_android` | Leitura |
| F3-07 | Médio | A política de reconexão fica toda no consumidor; o motor não oferece o backoff do APK | ambos | Leitura |
| F3-08 | Baixo | 2 listeners `close`/`error` por query concorrente; `off()` O(n) leva a O(n²) sob carga | ambos | Leitura |
| F3-09 | Baixo | `liveChatOrderGate` cria um `setInterval` por mensagem ao vivo, mesmo sem espera | ambos | Leitura |

**O que está bom (medido):**
- construir + `end()` sem login não vaza (30 ciclos: timers de 6 para 2, heap estável);
- `end()` é rápido: **48 ms** com login e **3 ms** sem;
- `waitForMessage` limpa os listeners no `finally`;
- `query` converte timeout em erro tipado;
- os `Map`/`Set` por conexão têm remoção ou são locais;
- intervalos globais (`libsignal`, métricas, checagem de versão) têm `unref` e limpeza.

---

## 2. Achados com prova

### F3-01 — Agendador de limpeza "zumbi" após reconexão rápida (Alto, provado)

**Onde:**
- `src/Socket/socket.ts:2525`, dentro do `CB:success`: `const _cleanupStartTimer = setTimeout(() => sessionCleanup.start(), 5_000)`;
- o `end()` (`:1751-1930`) chama `sessionCleanup.stop()` (`:1856`), mas **não cancela** esse timer;
- se a conexão cai antes de 5 s, o timer dispara **depois** do `stop()`, e `start()` (`src/Signal/session-cleanup.ts:365-420`):
  1. roda `runCleanup()` na hora, porque `cleanupOnStartup` é **`true` por padrão** (`Defaults/index.ts:385`);
  2. agenda um `setTimeout` para a próxima hora de limpeza e depois um `setInterval` permanente, **sem `unref`**, que ninguém mais para.

**Prova (sonda com 30 ciclos de conexão, login e `end()`):**

| Cenário | Timers ativos | Heap (após GC) |
|---|---|---|
| Sem login | 6 → 2 | 696 → 690 MB (estável) |
| **Com login (código atual)** | **4 → 34 (+1/ciclo)** | **697 → 804 MB (+~3,5 MB/ciclo)** |
| Com login + mutação `if (!closed) sessionCleanup.start()` | 4 → 2 | 706 → 700 MB (estável) |

Efeito colateral observado: o processo do Jest **não termina** com o código atual, porque os timers zumbis não usam `unref`.

**Impacto em produção:**
- cada oscilação de rede, `connectionReplaced` ou `stream:error` nos primeiros 5 s após o login vaza o socket inteiro (~3,5 MB, mais caches e closures);
- em tempestade de reconexão isso vira crescimento de memória sem limite;
- o zumbi também roda `runCleanup` com o keystore da conexão fechada: conforme o backend, isso gera erro em log ou **apaga sessões em paralelo com a conexão nova** no mesmo armazenamento.

**Correção:**
1. Guardar o handle e fazer `clearTimeout` no `end()`.
2. Proteger o callback com `if (!closed)`.
3. Em `session-cleanup`, fazer `stop()` marcar `stopped = true`, fazer `start()` respeitar essa marca e dar `unref()` no `initialTimeout`.

**Teste:** a própria sonda (N ciclos, timers e heap constantes).

### F3-02 — Conexão aberta, mas não ativa (Alto)

**APK:**
- `X/HandlerThreadC08660aV.java:486` e `:14900`: ao mandar a mensagem de ativação (tipo 37) ou ao logar, arma `TimeoutHandler.A02()` = **32 s** (`X/C17A.java:14`);
- `onConnectionActiveSet` (`:15025`) desarma;
- se estourar, loga "connection active timeout fired" e chama `handleDisconnect(…, 10, true)`, que **refaz a conexão**.

**InfiniteAPI:**
- `socket.ts:2492`: emite `connection: 'open'` **antes** da ativação;
- `:2499-2504`: `sendPassiveIq('active')` em paralelo; se falhar, inclusive por timeout de 30 s, só faz `logger.warn('failed to send initial passive iq')`;
- a conexão fica "open" sem o servidor rotear mensagens ao vivo, e o problema dura até outra coisa derrubar a conexão.

**Correção fiel:**
1. Se o IQ `active` falhar ou não responder em 32 s, fazer `end(connectionLost)` para o consumidor reconectar.
2. Opcional: só emitir `open` depois da ativação, ou emitir um estado `active` separado.

### F3-03 — Vigia de ack por mensagem enviada (Alto)

**APK:**
- `X/C17I.java:11-13` e `:70-74` (`ConnectionThread/WriterThreadObserver`): cada mensagem escrita no socket chama `TimeoutHandler.A08(key)` = **45 s** (`X/C17A.java:40-42`);
- quando o prazo vence (`:88-107`), se a mensagem ainda não chegou ao status de ack do servidor, o app loga "message receipt timeout fired" e chama `handleDisconnect(0, 9, true)`, que **refaz a conexão**;
- depois disso, o `SendE2EMessageJob` persistente reenvia a mensagem (Fase 2).

**InfiniteAPI:** não tem esse vigia. Um socket "meio morto", em que as escritas passam e nenhum ack volta, só é detectado pelo keepalive, e **só se nenhum outro frame chegar**.

**Correção fiel:** um mapa `id → timer de 45 s` armado no `sendNode` de `<message>` e desarmado no ack do servidor. Se estourar: `end(connectionLost)`. Junto com a outbox (F2-03), isso fecha o ciclo "sem perda".

### F3-04 — Ping do servidor sem resposta (Alto em `native_android`)

**APK:**
- `X/AbstractC37331lB.java:384`: `iq type=get` com `xmlns="urn:xmpp:ping"` vai para `ConnectionThreadRequestsImpl/onServerPingReceived` (`X/C36161il.java:329`), que processa e responde.

**InfiniteAPI:**
- não existe `ws.on('CB:iq,…urn:xmpp:ping…')`;
- a sonda disparou o ping em todas as chaves de despacho (`CB:iq,type:get,xmlns:urn:xmpp:ping`, `CB:iq,type:get`, `CB:iq,xmlns:…`, `CB:iq,id:…`, `CB:iq`): **nenhum listener, 0 respostas**.

**Correção:** responder `<iq type="result" to="s.whatsapp.net" id="{id}"/>` e atualizar o "último frame recebido". Confirmar o formato exato da resposta no fluxo do `A0t` do APK ou numa captura antes do merge.

### F3-05 — Cadência de keepalive no perfil `native_android` (Médio)

**APK:**
- `ClientPingManager` (`X/C26551Fi.java`):
  - primeiro ping após **15 s** (AB 15270);
  - depois a cada **240 s** (AB 15183);
  - timeout de **32 s** (AB 15103, limitado a [8, 32] s, `:204`); ao estourar, notifica a queda (`:112-127`);
  - não envia um ping novo se já há um pendente (`:137-139`);
- os padrões estão em `X/C016407t.java:1978-1980`;
- o keepalive TCP do APK é controlado pela AB 7831, que vem **desligada por padrão** (`X/AbstractC35041gt.java:6-9`). Isso **não** é divergência.

**InfiniteAPI:** ping fixo a cada **15 s** em todos os perfis (`Defaults/index.ts:127`, `socket.ts:2001-2053`); queda detectada com ociosidade acima de 20 s.

**Correção:**
- em `native_android`, usar a cadência do APK (15 s → 240 s; timeout 32 s por ping; sem ping duplicado). Isso reduz o tráfego de ping em ~16× e remove uma assinatura de comportamento;
- no perfil `web`, manter até ter a referência do WA Web.

### F3-06 — `offline_batch` no perfil `native_android` (Médio)

**APK:**
- `offline_batch` aparece **só** no dicionário de tokens (`X/AbstractC37721lo.java:11`); nenhum código monta esse nó;
- o `offline-preview` só alimenta métricas (`X/C36161il.java:A0q`) e o modo de buffering (Fase 1).

**InfiniteAPI:**
- `socket.ts:2637-2644` sempre responde `<ib><offline_batch count="100"/></ib>`, qualquer que seja o perfil;
- também loga o nó inteiro em `info` (F1-11).

**Correção:** enviar `offline_batch` **só** no perfil `web`.

### F3-07 — Política de reconexão (Médio)

**APK:**
- `MessageHandler/scheduleReconnect` (`X/C08270Zs.java:860-905`), com `new C08340Zz(1, 17280)` (`:119`), que é uma **sequência de Fibonacci**;
- atraso = `fib × 10 s`, com **jitter uniforme entre 50% e 150%**: 0 (imediato), 10, 10, 20, 30, 50, 80, 130 s…;
- em certas condições, limitado a **~15 min ± 30 ms** (`A1J`);
- a sequência zera quando a conexão dá certo.

**InfiniteAPI:** não reconecta sozinho; cada consumidor inventa o seu backoff. Reconexão agressiva amplia o F3-01 e o risco de limite de taxa no servidor.

**Correção (no motor, 1:1):**
1. Um supervisor de conexão no próprio motor que reconecta sozinho com a política do APK: Fibonacci × 10 s, jitter de 50–150%, primeira tentativa imediata, zera quando conecta e para em `loggedOut`/`badSession`.
2. Consumidores que já reconectam por conta própria desligam o supervisor com uma opção. Para `native_android`, ligado por padrão; para `web`, ligado por padrão depois de um ciclo de depreciação, para não abrir sockets em dobro.

### F3-08 / F3-09 — Custos menores (Baixo)

- **F3-08:** `waitForMessage` (`socket.ts:452-497`) registra `close`/`error` por query; com centenas de IQs concorrentes, cada `off()` percorre a lista. Padrão melhor: **um** listener de `close` que rejeita um `Map<id, pending>`.
- **F3-09:** `messages-recv.ts:3997` cria e destrói um `setInterval` por mensagem ao vivo. Padrão melhor: tentar `acquire` sem esperar e criar o timer só se houver fila.

---

## 3. Plano de correção (ordem por risco × custo)

| # | PR | Achados | Esforço | Risco |
|---|---|---|---|---|
| 1 | `fix(socket): cancelar início da limpeza de sessão no end()` | **F3-01** | Muito baixo (3 linhas + teste de N ciclos) | Muito baixo |
| 2 | `fix(socket): responder ping do servidor` | **F3-04** | Baixo | Baixo (confirmar o formato) |
| 3 | `fix(socket): reconectar se a ativação falhar (32 s)` | **F3-02** | Baixo | Baixo |
| 4 | `feat(socket): vigia de ack de 45 s por mensagem` | **F3-03** (+ F2-03) | Médio | Médio |
| 5 | `feat(native): cadência de ping do APK e offline_batch só no web` | F3-05, F3-06 | Baixo | Baixo (só `native_android`) |
| 6 | `feat(socket): supervisor de reconexão no motor (backoff do APK)` | F3-07 | Médio | Médio (coordenar com quem já reconecta) |
| 7 | `perf(socket): mapa de pendentes único; gate sem timer` | F3-08, F3-09 | Baixo | Baixo |

**Princípio:** toda correção fica **no motor InfiniteAPI**, 1:1 com o APK. A PR 1 (3 linhas) elimina o F3-01 no próprio motor, e a reconexão com backoff do APK passa a ser do motor (PR 6).

---

## 4. Referências APK desta fase (cópia legível `study/06_deobf`)

| Classe | Nome recuperado | Regra |
|---|---|---|
| `X/C26551Fi` | `ClientPingManager` | Ping 15 s → 240 s, timeout 32 s, sem duplicar |
| `X/C016407t` | Registro de defaults das AB props | 15270 = 15000, 15183 = 240000, 15103 = 32000, 16214 = 1, 15572 = −1 |
| `X/C17A` | `ConnectionThread/TimeoutHandler` | Ativação 32 s; ack de mensagem 45 s; logout |
| `X/C17I` | `ConnectionThread/WriterThreadObserver` | Arma os 45 s por mensagem escrita |
| `X/AbstractC37331lB` + `X/C36161il` | Parser de IQ + `ConnectionThreadRequestsImpl` | Ping do servidor → `onServerPingReceived` |
| `X/C08270Zs` + `X/C08340Zz` | `MessageHandler` + sequência de backoff | Fibonacci × 10 s, jitter 50–150%, limite de ~15 min |
| `X/AbstractC35041gt` | AB props de conexão | Keepalive TCP desligado por padrão (7831 = false; 2/10/10) |

## 5. Correção incorporada ao relatório de paridade F1+F2

Os defaults do APK mostram que o "offline buffering" usa limiar **1** (AB 16214), e não 100, e que a AB 15572 = −1 persiste **toda** stanza ao vivo na fila. Ou seja, a fila ordenada por chat (F1-02) vale **sempre**. `02b-PARIDADE-APK-F1-F2.md` foi atualizado.

**Próximo passo:** Fase 4 (persistência: auth states, multi-db SQLite, caches, locks, tuning), já com paridade de schema e transações contra o APK.
