# Especificação 1:1 do motor InfiniteAPI com o app WhatsApp (2.26.36.72)

| Item | Valor |
|---|---|
| Objetivo | O InfiniteAPI **reproduz exatamente o que o aplicativo faz**. Não é um plano de prioridades: **todo item abaixo é obrigatório** |
| Alvo | `InfiniteZAP/InfiniteAPI` `develop` @ `0a97980` |
| Referência | `InfiniteZAP/libwhatsapp_2.26.36.72` @ `921a6e9`; nomes recuperados em `study/06_deobf` (branch `deobf-evidence` @ `3689810`) |
| Fontes | Auditorias das Fases 1–6 e relatório de paridade F1+F2, todas com prova por sonda, benchmark ou leitura linha a linha |
| Regras fixas | (1) Toda correção fica **no motor**, nunca na platform. (2) Nada fabrica token, sinal ou material de atestação. (3) Yarn 4; testes com `node --experimental-vm-modules node_modules/.bin/jest` |

## 0. Escopo do "1:1" e decisões pendentes

1. **Perfil `native_android`:** o InfiniteAPI se passa pelo app Android, e **toda regra desta especificação vale 1:1**.
2. **Perfil `web` (padrão):** o dispositivo é companion. As regras de **dados, persistência, ordem, entrega, reenvio e segurança** valem igual, porque são comportamento de cliente WhatsApp e não de plataforma. As regras de **cadência de rede** que só existem no Android (ping de 240 s, ausência de `offline_batch`) **não** se aplicam: ali a referência 1:1 é o WA Web, cuja fonte não temos. Cada item marca o perfil.
3. **WAM/telemetria (F6-03), decidido:** emitir **só eventos de operações que o motor realmente executa, com valores medidos**. Campos de interface ou hardware ficam ausentes; nada é inventado. Requisitos W-01 a W-03 na seção 5b.
4. **Cobertura:** as 6 fases cobriram os caminhos críticos (recebimento, envio, reenvio, conexão, persistência, segurança, mídia). Para um **1:1 total**, falta a **matriz de conformidade por stanza** (seção 8): cada tipo de mensagem, IQ e notificação que o app trata, contra o que o motor trata.

---

## 1. Fundação de persistência (pré-requisito das demais)

| ID | Requisito 1:1 | Regra do app (prova) | Hoje no motor | Mudança | Aceite | Perfil |
|---|---|---|---|---|---|---|
| S-01 | Dados de sessão privados | Sandbox Android: arquivos do app privados ao UID | Diretórios 755 e arquivos 644 (`store.ts:617`, `use-multi-file-auth-state.ts:186/276`, `app-state-sync-key-store.ts:129`, `history-sync-store.ts:213`); sonda F5 | `mkdir` com `0o700` e arquivos com `0o600`; criar o `.db` com `0600` antes do SQLite abrir (o `-wal`/`-shm` herdam); autocorreção na abertura | Sonda: todos os modos = 700/600 | ambos |
| S-02 | `secure_delete=1` | `MessagesDBHelper.onOpen` (`X/C0H0.java:1196`) com alarme se não aplicar | Ausente (`store.ts:510-539`) | Adicionar ao `DEFAULT_PRAGMAS` + verificação na abertura (**aplicado na PR-04**). Vale para o que for apagado dali em diante: não limpa páginas livres nem WAL anteriores, como no app | `PRAGMA secure_delete` = 1 em todos os arquivos | ambos |
| S-03 | Sessão Signal só na tabela `sessions` | `axolotl.db.sessions` (`X/C33041cT.java`), sem KV paralelo | Grava tabela tipada **e** `signal_kv` (`use-multi-db-sqlite-auth-state.ts:63`) | Parar a escrita no `signal_kv`; fallback só de leitura com migração preguiçosa | Benchmark: 12,4 → 8,2 KB de WAL por atualização | ambos |
| S-04 | `record` da sessão em binário | Protobuf `SessionRecord` no `record BLOB` | Texto BufferJSON (3,3 KB) | Serializar em binário | Tamanho < 50% e leitura equivalente | ambos |
| S-05 | Sem índice redundante | Schema do app | `signal_kv_by_type` duplica a PK | Migração `DROP INDEX` | −11% por escrita | ambos |
| S-06 | Trava por registro/dispositivo | `SignalLock` por `deviceJid` (`X/C1DR.java:152`) | Trava por **tipo** no commit e na leitura (`auth-utils.ts:409-418`, `:455`) | `withLocks` por `{type,id}` | Teste de concorrência: N chats em paralelo, sem serialização | ambos |
| S-07 | `JidStore` em memória | `jid` resolvido em cache | 10 statements de `jid` por mensagem | LRU `raw_string → _id` | Contagem de SQL por mensagem −10 | ambos |
| S-08 | Gravação em lote na transação | `QueueStoreCache/flushStanzasToDisk` numa transação (`X/AbstractC34761fe.java:90-175`) | 1 commit por mensagem (`message-store-backend.ts:569`) | Group commit (≤ 5 ms / 50 mensagens) via `recordMessages` | Benchmark: 30,8 → 1,7 KB de WAL por mensagem | ambos |
| S-09 | Payload enviado guardado no banco por 60 dias | `RetryReceiptHandler` lê do store; recusa se > `5184000000` ms (`X/C1VN.java:31979`) | LRU de 512 itens/5 min (`message-retry-manager.ts:183`) + `getMessage` undefined | Store durável do payload enviado + rota + destinatários; expurgo aos 60 dias; `getMessage` padrão = store | Reenvio de mensagem com 59 dias funciona; com 61 dias é recusado | ambos |
| S-10 | Outbox persistente | `SendE2EMessageJob` com `isPersistent` (`SendE2EMessageJob.java:9518`), status 0 → 4 | Não existe | Tabela de envio pendente (status 0) antes do `sendNode`; 4 no ack | Queda antes do ack → reenvio com o mesmo id na reconexão | ambos |
| S-11 | Quarentena com retenção | Sem acúmulo sem limite no app | `pruneOlderThan` sem chamador (`quarantine-backend.ts:167`) | Poda agendada, cancelada no `end()` | Linhas antigas removidas | ambos |
| S-12 | `cache_size` do app | AB 20777 = 0, ou seja, padrão do SQLite (2000 KiB) | −512 × 11 arquivos (multi-db); 16000 KiB, padrão dos drivers (arquivo único) | Multi-db: **mantém 512 KiB**, configurável por arquivo (`cacheSizeKiB`), porque 2000 KiB no `msgstore`/`axolotl` não trouxe ganho com 300 mil mensagens. Arquivo único: 2000 KiB (valor do app, −13 MiB por sessão sem perda) | PRAGMA confere; `scripts/bench/sqlite-app-pragmas.ts` | ambos |

## 2. Recebimento

| ID | Requisito 1:1 | Regra do app (prova) | Hoje no motor | Mudança | Aceite | Perfil |
|---|---|---|---|---|---|---|
| R-01 | Recibo **só depois** de gravar | `CoreMessageStore/writeMessageToDatabase` → `DeliveryReceipt` (`X/C247818k.java:5921-5960`); o tipo de recibo vem do resultado da gravação (`X/C248318p.java:59`) | `sendReceipt` (`messages-recv.ts:4447`) antes do `upsert` (`:4508`) | Gravar (S-08) → commit → recibo; duplicata → recibo de duplicata | Sonda F1.1: `upsert/commit` antes de `receipt` no fio | ambos |
| R-02 | Mapeamento LID/PN da stanza, sem rede | Atributos `sender_pn`/`peer_recipient_pn`: `LidMessageStanzaParser` (`X/DI6.java:38-45`) → `StanzaHandlerUtil.A04` (`X/C29263Cs8.java:355`) → `PrivacyPhoneNumberHidingHelper` (`X/C1F5.java:142-165`) → `WaJidMapRepository.setJidMapping` (`X/C09540c2.java:484`), só banco local, sem IQ | `getLIDForPN` com USync na entrada (`messages-recv.ts:4119`); sonda: 30,4 s | `getKnownLIDForPN` + gravar o par da stanza | Sonda F4: 0 IQs `usync`; `upsert` < 50 ms | ambos |
| R-03 | Fila FIFO por chat (ao vivo + offline) | `StanzaQueue` → `ChatQueue` (`X/C34751fd.java:137-176`); offline buffering com AB 16214 = 1 e 15572 = −1 (`X/C016407t.java:1864-1865`) | Offline sequencial; ao vivo em paralelo; gate exclui offline (`:3984`, `:5174-5178`) | Uma fila por chat para todos os nós; paralelo entre chats | Sonda F1.3: 0/500 ultrapassagens | ambos |
| R-04 | Pedido de retry por remetente, com placeholder antes | `RetryRequest` grava placeholder → `SendRetryReceiptJob` com `groupId = "retry-receipt-<jid>"` (`X/C29004Cn4.java:84-124`; `SendRetryReceiptJob.java:226`) | `retryMutex` global + `uploadPreKeys` + `delay(1000)` (`:296`, `:4362-4387`) | Trava por remetente; placeholder antes; sem delay fixo | Sonda F1.2: 30 chats ≈ tempo de 1 | ambos |
| R-05 | Ack após persistir; nada de ack no `finally` | `flushStanzasToDisk` → ack; em falha a stanza continua na fila | Ack no `finally` mesmo em falha (`:3953`); preack com 2 escritas por ack (`:1367`) | Ack só após persistir/processar; NACK/sem ack em falha; preack em lote | Falha simulada → reentrega | ambos |
| R-06 | Isolamento de exceção de listener | O processo do app não cai por erro de UI | Erro do consumidor vira rejeição não tratada (F1-05) | Capturar e registrar por listener | Sonda F1.1: processo segue | ambos |
| R-07 | Origem da mensagem explícita | O app notifica mensagens offline como novas | Offline chega como `append` (F1-04) | Campo `source` e política de notificação igual à do app | Mensagem offline aparece como nova | ambos |
| R-08 | Buffer de eventos sem perder o `upsert` | — | Delete absorve o upsert no buffer (F1-10) | Emitir os dois na ordem | Sonda F1.3 | ambos |

## 3. Envio e reenvio

| ID | Requisito 1:1 | Regra do app (prova) | Hoje no motor | Mudança | Aceite | Perfil |
|---|---|---|---|---|---|---|
| E-01 | Pista por destino; reenvio em pista separada | `groupId = jid` / `jid_retry` (`SendE2EMessageJob.java:9512-9513`); JobQueue serial por grupo e paralela entre grupos (`X/C39411oj.java`, `X/RunnableC40131pv.java`) | Trava global `meId` (`messages-send.ts:2821`); **interativos 1:1 pulam a trava e saem fora de ordem no mesmo destino (F2-09, teste `it.failing` na PR-00)** | Trava por destino + `_retry`; rede antes da parte serial; modelo único (sem bypass) | Sonda F2.1: 5 destinos ≈ 300 ms | ambos |
| E-02 | Requisitos antes da execução | `AxolotlSessionRequirement`/`SenderKeyRequirement` (`:9545-9569`) | IQs dentro da trava | Resolver sessões, dispositivos e participantes antes | IQ lento não bloqueia outro chat | ambos |
| E-03 | Participantes do grupo locais + `phash` obrigatório | `group_participant_user/_device` (`X/C12940iT.java`); "cannot send … without a participant hash" (`:673`) | IQ `groupMetadata` por envio sem cache | Estado interno mantido por `w:gp2`; `phash` divergente → atualizar e reenviar | 0 IQs de metadata no envio | ambos |
| E-04 | `sent_sender_key` por dispositivo | `UPDATE group_participant_device …` por dispositivo (`X/C14460l8.java`) | Regrava o mapa inteiro (`:1971`) | Gravar só o que mudou | Contagem de escritas | ambos |
| E-05 | Vigia de ack de 45 s → reconexão | `WriterThreadObserver` arma 45 s por mensagem; sem ack → `handleDisconnect(9)` (`X/C17I.java`, `X/C17A.java:40-107`) | Não existe | Timer por id; estourou → `end(connectionLost)`; outbox (S-10) reenvia | Sonda: ack omitido → reconexão aos 45 s + reenvio com o mesmo id | ambos |
| E-06 | Reenvio só a quem era destinatário | `wasInGroupAtTimeOfMessage`/`isCurrentlyInGroup` (`X/C1VN.java:32025-32073`, `:32269`) | Sem verificação (P-01) | Exigir que o dispositivo estivesse entre os destinatários (S-09) | Dispositivo adicionado depois não recebe conteúdo antigo | ambos |
| E-07 | SKDM só para o dispositivo do retry | `:32095-32110` | Zera o `sender-key-memory` do grupo inteiro (P-02) | Remover o reset global | Próxima mensagem sem redistribuição geral | ambos |
| E-08 | Reenvio só ao dispositivo solicitante | `SendE2EMessageJob(…, deviceJid, …)` | `sendToAll` no primário (P-03) | Só o dispositivo | Contagem de destinatários = 1 | ambos |
| E-09 | Não reenviar se já entregue | "already marked delivered" (`:32042`) | Sem checagem (P-04) | Consultar `receipt_device` | Sem reenvio após entrega | ambos |
| E-10 | Limite de tentativas = `count` > 4 | `if (i7 > 4)` (`:31952`) | `maxMsgRetryCount` 5 local (P-05) | Regra do app | 5º pedido recusado | ambos |
| E-11 | Reenvio expira em 24 h | `j2 = agora + 86400000` (`:32231`) | Sem expiração (P-06) | Expiração no job de reenvio | Job > 24 h descartado | ambos |
| E-12 | Regras de sessão no retry | `C1DR.A00`: registration id mudou → nova; `count == 2` grava base key; `> 2` com mesma base key → pre-key nova; senão reaproveita (`X/C1DR.java:98-140`) | `assertSessions(…, true)` sempre sem bundle (`:3533`); trava `me.id` | Buscar pre-key só nos 3 casos; trava por dispositivo | 0 IQs de pre-key num retry comum | ambos |
| E-13 | Bundle `<keys>` do recibo só com sessão compatível | `C1DR.java:145-250` | Injeta sempre | Mesmas condições (sessão existente + registration id igual quando exigido) | Teste unitário das condições | ambos |
| E-14 | `reporting_token` é função da mensagem | `ReportingToken` deriva do `messageSecret` e da mensagem (`X/C29252Crs.java:25-95`); o padding é da camada de cifragem | Calculado sobre a mensagem com padding aleatório: presença e valor variam por envio (F2-10) | Calcular sobre a mensagem serializada sem padding | 64 envios da mesma mensagem → 1 token, igual à referência sem padding | ambos |

## 4. Conexão

| ID | Requisito 1:1 | Regra do app (prova) | Hoje no motor | Mudança | Aceite | Perfil |
|---|---|---|---|---|---|---|
| C-01 | Sem agendador zumbi após fechar | — | Timer do `sessionCleanup.start()` não é cancelado (`socket.ts:2525`); sonda: +1 timer e +3,5 MB por ciclo | Cancelar no `end()` + `if (!closed)` + `stopped` no cleanup | Sonda F3: 30 ciclos sem crescer | ambos |
| C-02 | Ativação em até 32 s ou reconecta | `TimeoutHandler.A02()` 32 s; `onConnectionActiveSet` desarma (`X/C17A.java:14`; `X/HandlerThreadC08660aV.java:486`, `:15025`) | Falha do `active` só gera `warn` (`socket.ts:2499-2504`) | Falhou ou passou de 32 s → `end(connectionLost)` | IQ `active` sem resposta → reconexão | ambos |
| C-03 | Responder o ping do servidor | `iq get urn:xmpp:ping` → `onServerPingReceived` (`X/AbstractC37331lB.java:384`, `X/C36161il.java:329`) | Sem handler (sonda: 0 listeners) | `iq result` com o mesmo id (confirmar o formato no fluxo `A0t`) | Ping → resposta | ambos |
| C-04 | Cadência de ping do app | `ClientPingManager`: 15 s → 240 s; timeout 32 s; sem ping duplicado (`X/C26551Fi.java`; AB 15270/15183/15103) | Fixo em 15 s | Cadência do app | Relógio falso: pings em 15 s, 255 s, 495 s… | `native_android` |
| C-05 | Sem `offline_batch` | Não existe no app (só no dicionário de tokens) | Sempre enviado (`socket.ts:2637-2644`) | Enviar só no `web` | 0 `offline_batch` em `native_android` | `native_android` |
| C-06 | Reconexão própria com backoff do app | `MessageHandler/scheduleReconnect`: Fibonacci × 10 s, jitter 50–150%, 1ª imediata, limite de ~15 min (`X/C08270Zs.java:860-905`, `X/C08340Zz.java`) | Não existe (fica com o consumidor) | Supervisor de reconexão no motor | Sequência de atrasos confere | ambos |
| C-07 | Pendências de query num único mapa | — | 2 listeners por query (`socket.ts:452-497`) | Um listener de `close` + `Map` | Sem O(n²) com 1.000 queries | ambos |
| C-08 | Gate sem timer por mensagem | — | `setInterval` por mensagem (`messages-recv.ts:3997`) | Timer só havendo fila | Contagem de timers | ambos |

## 5. Segurança e logs

| ID | Requisito 1:1 | Hoje no motor | Mudança | Aceite |
|---|---|---|---|---|
| G-01 | ~~Sem PII no stdout por padrão~~ | `console.log` ligado com o PN de toda mensagem (`baileys-logger.ts:537-541`, `:749-791`) | **Descartado por decisão do operador**: motor de uso próprio, console com JID completo é intencional; nada muda | — |
| G-02 | ~~Sem nó bruto em `info`~~ | `socket.ts:2638`, `chats.ts:2297` | **Descartado por decisão do operador** (mesma decisão do G-01); nada muda | — |
| G-03 | Mídia temporária privada | `tmpdir()` com 644; limpeza frágil (`messages-media.ts:41`; `messages.ts:358-369`) | `mkdtemp` 0700 na sessão; 0600; `unlink` independente; varredura na inicialização | Sonda: modos e 0 órfãos |
| G-04 | Sem handler global de exceção | `VoipClient` instala `uncaughtException` (`Voip/index.ts:459-470`) | Usar só `connection.update` | Exceção do host derruba o processo normalmente |
| G-05 | Upload com limites corretos | Contagem dupla do `maxContentLength`; `isLast` errado (`messages-media.ts:672-676`, `:1353`) | Corrigir as duas contas | Teste unitário |

## 5b. Requisitos vindos da matriz de conformidade (`MATRIZ_CONFORMIDADE_1A1.md`)

| ID | Requisito 1:1 | Regra do app (prova) | Hoje no motor | Perfil |
|---|---|---|---|---|
| R-09 | Tabela de status de recibo idêntica | `sender`/`delivery` = 5, `read` = 13, `read-self` = 17, `played` = 8, `played-self` = 18, `inactive` = 15 (`X/C29301Csr.java:341-370`) | `sender` → SERVER_ACK; `read-self` = READ; `played-self`/`inactive` ignorados (`generics.ts:349`) | ambos |
| R-10 | Um ramo por tipo de notificação automática | Despachante com 36 tipos (`X/CJW.java:12-47`, uma chave por linha) | 11 tipos; faltam `contacts`, `disappearing_mode`, `status`, `business`, `hosted`, `username` legado, `feature_control_notify`, `psa`, `server`, `crsc_continuation` e, no nativo, `authkey_rotation`, `companion_reg_refresh`, `registration` | ambos / nativo |
| C-09 | Filhos de `ib` do app | `streamdebug` (`reconnect="1"`), `client_expiration`, `fbip`, `sonar`, `thread_metadata`, `recovery_nonce`, `account_sync` (`X/C37411lJ.java:236-345`) | Sem tratamento | ambos (`fbip`: nativo) |
| N-01 | Rotação de `w:auth:key` a cada 24 h | `AuthkeyRotationManager` (`X/C1FV.java:29`) | Não existe | nativo |
| W-01 | WAM só de operações reais | IDs 476/478/854/450/1588/1590/3112/3014, iguais no app e no catálogo do motor | `sendWAMBuffer` sem uso | nativo (web: IDs do WA Web) |
| W-02 | Canal `privatestats` com credencial assinada pelo servidor | `ACSSender` `sign_credential` (`X/C43121uq.java:31`) | Não existe | nativo |
| W-03 | Cadência e formato do `w:stats` iguais aos do app | Biblioteca nativa `wamsys` (`JniBridge`) | Não existe | nativo; fixar pelo Ghidra antes de ligar |
| M-01 | Todos os `message_type` do app no espelho | Registro do `FMessageDatabaseSubsystem` | 32 tipos confirmados | ambos |

## 6. Ordem de implementação (dependências técnicas, não prioridade)

1. **S-01, S-02, S-05, C-01, R-02, G-04, G-05**: independentes e pequenas (G-01 e G-02 descartados por decisão do operador).
2. **S-03, S-04, S-06, S-07, S-12**: base de chaves e cache.
3. **S-08 → R-01 → R-05**: group commit, depois recibo após o commit, depois ack após persistir.
4. **S-09 → E-06..E-13**: o store de payload habilita as regras de reenvio do app.
5. **S-10 → E-05 → C-02, C-03, C-06**: outbox, vigia de 45 s e ciclo de conexão do app.
6. **E-01, E-02, E-03, E-04**: pista por destino e estado local de grupo.
7. **R-03, R-04, R-06, R-07, R-08**: pipeline de entrada por chat.
8. **C-04, C-05** (perfil nativo), **C-07, C-08, S-11, G-03**.
9. **R-09, R-10, C-09, N-01, M-01** (matriz de conformidade).
10. **W-01 → W-02 → W-03**: WAM só depois de fixar a cadência nativa.

Cada item entra com o **teste de aceite** da tabela, que é a prova de 1:1.

## 7. O que já está 1:1 (não mexer)

- Schema `sessions`.
- `synchronous = NORMAL` + WAL.
- `foreign_keys = ON`.
- Apagar a sessão quando o registration id do retry muda.
- Base key gravada na 2ª tentativa e colisão da 3ª em diante.
- SKDM no reenvio individual (faltando só a condição E-06).
- Mapa de status do `msgstore` (0/4/5/13/8) e ordem de promoção.
- Verificação do HMAC no download.
- Keepalive TCP desligado por padrão (AB 7831).

## 8. Para fechar o 1:1 total: matriz de conformidade por stanza

As fases cobriram os caminhos críticos, mas o critério "reproduz exatamente o app" exige cobertura **exaustiva**. O próximo passo é gerar, a partir da cópia desofuscada, a lista completa de:
1. todo `xmlns` de IQ que o app **envia**, com atributos e filhos;
2. todo tipo de `notification`, `receipt`, `ib`, `call` e `message` que o app **trata**, com a ação e a resposta;
3. todo tipo de conteúdo de mensagem (`message_type` do `msgstore`) com os campos gravados.

Depois cruzar cada linha com o motor: **tratado igual / tratado diferente / não tratado**. O resultado é um backlog fechado e verificável, e o 1:1 fica comprovado quando todas as linhas estiverem "igual".
