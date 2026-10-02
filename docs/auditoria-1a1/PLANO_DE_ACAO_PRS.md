# Plano de ação em PRs — InfiniteAPI 1:1 com o app (sem quebrar interativos)

| Item | Valor |
|---|---|
| Base | `InfiniteZAP/InfiniteAPI` `develop` @ `0a97980` |
| Fontes | Auditorias das Fases 1–6, paridade F1+F2, `ESPECIFICACAO_1A1_MOTOR.md` (IDs S/R/E/C/G/N/W/M) e `MATRIZ_CONFORMIDADE_1A1.md` |
| Referência | APK 2.26.36.72 (`921a6e9`), cópia legível `study/06_deobf` |
| Regras | Tudo no motor. Nada fabrica token, sinal ou atestação. Yarn 4 (nunca `npm ci`). Testes: `node --experimental-vm-modules node_modules/.bin/jest` |
| Formato | **30 PRs (PR-00 a PR-29) em 7 ondas, mais ajustes campo a campo.** Cada PR é pequena, isolada, reversível e tem teste de aceite que prova o 1:1 |

---

## 0. Garantia: o envio de interativos não quebra

### 0.1 Zona congelada (nenhuma PR altera, só a PR-00 fixa em teste)

| Elemento | Onde | Por que fica congelado |
|---|---|---|
| `biz > interactive(type=native_flow, v=1) > native_flow(v=9, name=…)` | `messages-send.ts:2340-2380` | O app monta o mesmo formato (`NativeFlowMessageCustomizer`, `X/C30123DHh.java:86-151`) |
| `biz > list(type=product_list, v=2)` | `:2319-2333` | Formato validado em produção |
| `bot biz_bot=1` (botões legados/lista em chat 1:1, fora de native flow, carrossel e catálogo) | `:2405-2425` | É o formato que remetentes comerciais usam; o app só o recebe (`X/DHE.java:66-76`). Funciona hoje e **não muda** |
| `biz > quality_control(decision_id) > decision_source(value=df)` só no carrossel | `:2361-2378` | Mesmo motivo; o app só recebe (`X/C30141DHz.java:14-20`) |
| IQ `xmlns="bot"` (`getBotListV2`) | `chats.ts:814-830` | Lista de bots; mantido |
| DSM nos próprios dispositivos + `messageContextInfo` levantado do lottie no reenvio | `:2195-2230` | Correção de produção (#519/#521) |
| SKDM no reenvio de grupo | `:2170-2200` | O app faz o mesmo (`X/C1VN.java:32095`) |
| `device_fanout=false` no reenvio 1:1 | `:1758-1760` | Formato do reenvio |

### 0.2 Mecanismos de proteção (valem para todas as PRs)

1. **PR-00 vem primeiro:** testes "golden" que gravam a stanza de envio completa de **cada tipo interativo**, nos cenários 1:1 PN, 1:1 LID, grupo, reenvio e dispositivo próprio. O golden guarda a estrutura (atributos na ordem de escrita) **e os bytes do encoder**, com os valores aleatórios (`decision_id`, segredos) trocados por um marcador fixo. Qualquer diferença reprova o CI.
2. **Toda PR que toca `messages-send.ts`, `messages-recv.ts` ou `socket.ts`** precisa passar com os golden **sem atualizar o snapshot**. Mudar um snapshot de interativo exige justificativa explícita na PR.
3. **Mudanças de comportamento entram atrás de opção** (`SocketConfig`), com padrão por perfil. Isso permite canário por instância e rollback sem deploy.
4. **Sondas desta auditoria viram testes permanentes**: recibo × gravação, ordem por chat, vazamento em reconexão, USync na entrada e permissões de arquivo.

---

## Onda 0 — Rede de segurança

### PR-00 · `test(send): golden de stanzas dos tipos enviados pelo motor`
- **Escopo:** ampliar `src/__tests__/Socket/messages-send.stanza-assembly.test.ts` com snapshot da stanza final a partir de `relayMessage`: atributos na ordem de escrita, filhos `biz`/`bot`/`participants`/`enc`, bytes do encoder (valores aleatórios mascarados) e o payload decifrado de cada cifragem. Registra o comportamento **de hoje**, que é o que precisa ser protegido; não afirma conformidade com o app.
- **Tipos cobertos (32):**
  - botões legados, lista `SINGLE_SELECT`, lista `PRODUCT_LIST`, template;
  - native flow: `quick_reply`, `cta_url`, `cta_copy`, `cta_call`, misto, `single_select`, `otp`, `review_and_pay`, `payment_info`, `review_order`, `mpm`, `catalog_message`, `single_product`, `product_list`;
  - interativo simples, carrossel e carrossel em `viewOnceMessageV2`;
  - texto, resposta citada, imagem, vídeo, áudio PTT, documento, figurinha, localização, contato, enquete v3 e reação.
- **Cenários:** 1:1 PN, 1:1 LID, grupo, dispositivo próprio (DSM) e reenvio por retry (`participant`) para **todos** os tipos (160 entradas). Concorrência: 5 envios ao mesmo destino (texto e interativo) e um envio lento para um destino não pode segurar outro destino.
- **Fora do escopo (PR-00b):** geração no `sendMessage` (upload de mídia, `messageSecret`), edição e revogação, status/broadcast, newsletter, evento, álbum, figurinha lottie e mídia view once.
- **Converte em testes permanentes:** sondas F1.1 (recibo × gravação), F1.3 (ordem), F3.1 (ciclos sem vazamento), F4.3 (USync na entrada) e F5.2 (permissões). As que hoje falham entram como `it.failing`, e cada PR de correção as troca para `it`.
- **Muda comportamento:** não. **Risco:** nenhum.

---

## Onda 1 — Correções pequenas e isoladas (não tocam na montagem de stanza)

| PR | Título | Requisitos | Mudança | Aceite | Risco |
|---|---|---|---|---|---|
| **PR-01** | `fix(socket): cancelar limpeza de sessão no end(); remover handler global do VoIP` | C-01, G-04 | Guardar o timer de `socket.ts:2525` e cancelar no `end()`; não armar timer nem tracker com o socket fechado (inclusive no `open` síncrono); estado `scheduled` + geração + `unref` no `session-cleanup.ts`; `VoipClient` sem `process.on('uncaughtException')` | 8 ciclos com login e fechamento rápido: nenhum timer remanescente (sem a correção sobram 9). Cada ciclo deixava +1 timer que segurava o socket; o crescimento de memória é consequência desse timer, então não há asserção de heap no CI, que seria instável. Nenhum listener `uncaughtException` instalado; o 515 continua sendo tratado de novo via `connection.update` | Muito baixo |
| **PR-02** | `fix(security): sessão e temporários privados (0700/0600)` | S-01, G-03 | `mkdir` 0700 e `writeFile` 0600 nos 3 auth states; `.db` criado com 0600 antes do SQLite abrir; autocorreção na abertura; `mkdtemp` 0700 para mídia com `unlink` independente e varredura na inicialização | Sonda de permissões: 700/600; 0 temporários órfãos | Baixo |
| ~~**PR-03**~~ | ~~`fix(logging): sem PII no stdout por padrão`~~ | G-01, G-02 | **Descartada por decisão do operador**: o motor é de uso próprio, sem acesso de terceiros aos logs, e o console com o JID completo é intencional. Os logs ficam como estão | — | — |
| **PR-04** | `fix(sqlite): PRAGMAs do app` | S-02, S-05, S-12 | `secure_delete=1` com verificação; `DROP INDEX signal_kv_by_type`; `cache_size`: medido com 300 mil mensagens, 2000 KiB no `msgstore`/`axolotl` não trouxe ganho, então o multi-db fica em 512 KiB, configurável por arquivo; o SQLite de arquivo único passa de 16000 para 2000 KiB (valor do app, −13 MiB por sessão sem perda) | PRAGMA confere; `scripts/bench/sqlite-app-pragmas.ts` | Muito baixo |
| **PR-05** | `fix(recv): LID/PN da stanza sem USync` | R-02 | `messages-recv.ts:4119`: `getKnownLIDForPN` no lugar de `getLIDForPN`. O par da stanza **já é gravado hoje** (o teste R-02 confere); falta só não disparar o USync | Teste R-02: par persistido e 0 IQs `usync`, com um USync que nunca responde (antes, a entrega esperava o timeout da consulta) (aplicado na PR-05) | Muito baixo |
| **PR-06** | `fix(receipts): tabela de status do app` | R-09 | `sender`/`delivery` = 5, `read-self` = 17, `played-self` = 18, `inactive` = 15 no espelho `msgstore`. O evento ao consumidor mantém o contrato `WebMessageInfo.Status` (o formato Web não tem 15/17/18, e o operador depende de `read-self` → `READ`) | Teste R-09: `androidStatusFromReceiptType(tipo)` igual ao `ReceiptStanzaHelper.A00` nos 7 tipos; teste de socket confere o status **persistido** no `msgstore` para um recibo de cada tipo, o órfão com status exato quando a mensagem chega depois, e o evento `WebMessageInfo.Status` inalterado (aplicado na PR-06) | Baixo |
| **PR-07** | `fix(media): limites de upload` | G-05 | `maxContentLength` sem contagem dupla; `isLast` pelo índice real | Teste unitário: mídia remota exatamente no limite aceita (acima dele, recusada); com host customizado antes dos hosts do `media_conn`, só o último host real sai sem ", retrying..." (aplicado na PR-07) | Muito baixo |
| **PR-08** | `feat(socket): ping do servidor e ativação em 32 s` | C-03, C-02 | Handler `iq get urn:xmpp:ping` → `iq result`; IQ `active` sem resposta ou com falha em 32 s → `end(connectionLost)` | Ping recebe resposta; `active` sem resposta reconecta | Baixo (**confirmar formato da resposta no `A0t` do APK antes do merge**) |

---

## Onda 2 — Persistência (base das ondas seguintes)

| PR | Título | Requisitos | Mudança | Aceite | Risco |
|---|---|---|---|---|---|
| **PR-09** | `perf(keys): sessão só na tabela tipada` | S-03 | Parar a escrita no `signal_kv` para tipos com tabela tipada; fallback só de leitura com migração preguiçosa; `list`/`listIds` pela tipada | Benchmark: 12,4 → 8,2 KB de WAL por atualização; teste de restauração de sessão antiga | Médio (flag `signalKvDualWrite` para voltar) |
| **PR-10** | `perf(keys): registro de sessão binário` | S-04 | `record BLOB` em binário; leitor aceita os dois formatos | Tamanho < 50%; leitura antiga ok | Médio |
| **PR-11** | `perf(keys): travas por registro` | S-06 | Commit e leitura com `{type,id}` em vez de `__type__` | Teste de concorrência: N chats sem serializar | Médio |
| **PR-12** | `perf(msgstore): cache de jid e group commit` | S-07, S-08 | LRU `raw_string → _id`; buffer de gravação (≤ 5 ms / 50 msgs) com `recordMessages`, com callback pós-commit | Benchmark: 30,8 → 1,7 KB de WAL por mensagem; 10 statements a menos por mensagem | Médio |
| **PR-13** | `feat(store): payload enviado por 60 dias + retenção da quarentena` | S-09, S-11 | Tabela de payload enviado (proto, rota, lista de dispositivos destinatários), expurgo aos 60 dias, `getMessage` padrão = store; poda da quarentena cancelável no `end()` | Reenvio aos 59 dias funciona e aos 61 é recusado; quarentena podada | Médio |

---

## Onda 3 — Recebimento

| PR | Título | Requisitos | Mudança | Aceite | Risco |
|---|---|---|---|---|---|
| **PR-14** | `fix(recv): recibo só após gravar; ack após persistir` | R-01, R-05 | Recibo no callback pós-commit do PR-12; duplicata → recibo de duplicata; ack só após persistir/processar; NACK/sem ack em falha; preack em lote | Teste R-01: `MessageStoreBackend.recordMessage` (transação SQLite do `msgstore.db`) retorna antes do frame do recibo; falha simulada → reentrega | Médio (flag `receiptAfterPersist`) |
| **PR-15** | `perf(recv): fila FIFO por chat (ao vivo + offline)` | R-03, R-08 | Uma fila por chat para todos os nós, paralela entre chats; buffering offline como no app (AB 16214 = 1); buffer de eventos sem perder o `upsert` ao receber delete | Sonda F1.3: 0/500 ultrapassagens; 30 chats em paralelo | Médio |
| **PR-16** | `perf(recv): pedido de retry por remetente` | R-04 | Trava `retry-receipt-<jid>`; placeholder antes; sem `delay(1000)` fixo | Sonda F1.2: 30 chats ≈ tempo de 1 | Baixo |
| **PR-17** | `fix(events): isolar listener e marcar origem` | R-06, R-07 | Try/catch por listener; campo `source` (live/offline/history) | Sonda F1.1: processo segue; offline marcado | Baixo |
| **PR-30** | `fix(receipts): status agregado em grupo e órfão com inteiro do app` | R-09 (restante) | Grupo: promover `message.status` pelo agregado dos recebedores, com a recusa de regressão do app (`MessageStatusStore`, `X/C25971Db.java`; agregação `recipientCount`/`statuses` em `X/C29151Cpm.java`). Órfão: gravar em `receipt_orphaned.status` o inteiro Android, como o app (`X/C29303Csu.java`, `put("status", i)`), no lugar dos códigos 0-3 do motor | Recibos de N participantes promovem o status pelo agregado; órfão reaplicado com o inteiro gravado | Médio (migração de órfãos existentes) |

---

## Onda 4 — Envio e reenvio (máxima atenção aos interativos)

| PR | Título | Requisitos | Mudança | Aceite | Proteção dos interativos |
|---|---|---|---|---|---|
| **PR-18** | `fix(retry): regras de reenvio do app` | E-06..E-13 | Reenvio só a quem era destinatário; SKDM só ao dispositivo; sem reset do grupo inteiro; só o solicitante; não reenviar se entregue; `count > 4`; expiração de 24 h; pre-key só nos 3 casos; bundle condicionado; trava por dispositivo | Testes por regra; dispositivo adicionado depois não recebe conteúdo antigo | Golden do **reenvio de interativo** (DSM, lottie, carrossel) sem mudança; teste dedicado de retry de carrossel e native flow |
| **PR-19** | `feat(send): outbox persistente + vigia de ack de 45 s` | S-10, E-05 | Linha pendente (status 0) antes do `sendNode`; ack → 4; 45 s sem ack → `end(connectionLost)`; reconexão reenvia com o **mesmo id e a mesma stanza gravada** | Ack omitido → reconexão + reenvio idêntico | O reenvio usa a **stanza exatamente como foi gerada** (sem remontar), então o formato dos interativos não muda |
| **PR-20** | `perf(send): pista por destino (+ _retry)` | E-01, E-02 | Trava por destino no lugar de `meId`; reenvio em `<jid>_retry`; USync, metadata e pre-key antes da parte serial; remove o bypass interativo porque o novo modelo já dá paralelismo por destino | Sonda F2.1: 5 destinos ≈ 300 ms | Golden inalterados; teste de 5 interativos simultâneos; **vira `it` o `it.failing` de FIFO dos interativos no mesmo destino (F2-09)** |
| **PR-21** | `feat(groups): participantes locais + phash + sender key por dispositivo` | E-03, E-04 | Estado de participantes mantido por `w:gp2`; `phash` do estado local; `phash` divergente → atualizar e reenviar; `sent_sender_key` por dispositivo | 0 IQs de metadata no envio | Golden de interativo em grupo inalterados |
| **PR-29** | `fix(send): reporting_token sobre a mensagem sem padding` | E-14 | Calcular o token sobre `proto.Message.encode(msg).finish()`, não sobre `encodeWAMessage()` (F2-10) | Vira `it` o `it.failing` de token determinístico (64 envios → 1 token igual à referência) | Os golden atuais não levam `messageSecret`, então não mudam. Nos interativos com `messageSecret` o resultado passa a ser determinístico: **sem token** (a extração sem padding não gera token para `interactiveMessage`); hoje sai token em ~2 de 16 envios. Validar esse ponto antes do merge |
| **PR-31** | `feat(send): cstoken de primeiro contato (NCT)` | E-15 | Guardar o salt NCT da conta (bootstrap, `nct_salt_sync` SET, backfill único da `regular_high` sem reaplicar outras mutações); `<cstoken>` = HMAC(salt, LID do destinatário) quando não há tctoken utilizável; `csTokenMode` por perfil; AB props acompanhadas persistidas com o hash; trava de conta (timelock de reachout e cota de conversas novas) também com LID conhecido, só para destinatário sem privacy token, com estado em cache atualizado pelas notificações e renovado após 1 h (`C2DK.A00`, `C39781pK.A02`, `CappingGatingManager.A02`, `MessageCappingManager.A0N`, prop 20649) (aplicado na PR-31) | Testes de envio: HMAC igual à referência, envelope PN assina o LID conhecido, tctoken tem precedência, grupo nunca, prop 24941 no modo `ab-prop`, `off` desliga; salt lido só da mutação `nct_salt_sync` de um snapshot cifrado | Golden sem salt não mudam. Em 1:1 com salt, o `<cstoken>` entra no lugar do tctoken, antes do `biz`/`bot`, sem tocar nesses nós (teste dedicado com botões legados) |

---

## Onda 5 — Conexão e protocolo (matriz de conformidade)

| PR | Título | Requisitos | Mudança | Aceite | Perfil |
|---|---|---|---|---|---|
| **PR-22** | `feat(socket): supervisor de reconexão com o backoff do app` | C-06 | Fibonacci × 10 s, jitter de 50–150%, 1ª tentativa imediata, limite de ~15 min, para em `loggedOut` | Sequência de atrasos confere | Nativo: ligado; web: opt-in até migrar os consumidores |
| **PR-23** | `feat(native): cadência de ping do app; offline_batch só no web; fbip` | C-04, C-05, C-09 (`fbip`) | 15 s → 240 s, timeout de 32 s, sem ping duplicado; `offline_batch` só no `web`; IPs de `fbip` na sequência de conexão | Relógio falso confere; 0 `offline_batch` no nativo | Nativo |
| **PR-24** | `feat(protocol): notificações e ib do app` | R-10, C-09 | Ramos `contacts`, `disappearing_mode`, `status`, `business`, `hosted`, `username` legado, `feature_control_notify`, `psa`, `server`, `crsc_continuation`; `ib` `streamdebug(reconnect=1)`, `client_expiration`, `sonar`, `thread_metadata`, `recovery_nonce`, `account_sync` | Um teste por tipo com stanza do app | Ambos |
| **PR-25** | `feat(native): rotação de w:auth:key e notificação authkey_rotation` | N-01 | Tentativa a cada 24 h, com o controle de sucesso/falha do app | Relógio falso: IQ a cada 24 h | Nativo |
| **PR-26** | `perf(socket): mapa único de pendências; gate sem timer` | C-07, C-08 | Um listener de `close` + `Map`; timer do gate só havendo fila | 1.000 queries sem O(n²); contagem de timers | Ambos |

---

## Onda 6 — Cobertura restante e telemetria

| PR | Título | Requisitos | Pré-requisito (investigação) |
|---|---|---|---|
| **PR-27** | `feat(msgstore): todos os message_type do app` | M-01 | L3: extrair o registro do `FMessageDatabaseSubsystem` |
| **PR-28** | `feat(wam): telemetria só de operações reais` | W-01, W-02, W-03 | L6: cadência e formato do `wamsys` pelo Ghidra. Eventos 476/478/854/450/1588/1590/3112/3014 com campos medidos; `privatestats` só com credencial do servidor |
| **PR-29+** | Ajustes campo a campo | (a definir) | L1: 21 IQs em comum; L2: queries `w:mex`; L4: stanzas de `call`; L5: 22 usos de `urn:xmpp:whatsapp:account` |

---

## 1. Ordem e paralelismo

```text
PR-00 ──► Onda 1 (PR-01..08, em paralelo entre si)
      └─► Onda 2: PR-09 ─► PR-10 ─► PR-11 ;  PR-12 ;  PR-13
                     └──────────────┬──────────────┘
Onda 3: PR-14 (precisa do PR-12) ─► PR-15 ─► PR-16 ; PR-17
Onda 4: PR-18 (precisa do PR-13) ; PR-19 (precisa do PR-13) ─► PR-20 ─► PR-21 ; PR-29 (independente)
Onda 5: PR-22 (depois do PR-01 e PR-19) ; PR-23 ; PR-24 ; PR-25 ; PR-26
Onda 6: PR-27 (depois do L3) ; PR-28 (depois do L6)
```

## 2. Regras para cada PR

- **Checklist obrigatório:**
  - golden da PR-00 verdes sem atualizar snapshot;
  - suíte completa verde (`node --experimental-vm-modules node_modules/.bin/jest`);
  - lint e tipos;
  - teste de aceite do requisito;
  - referência do APK (`arquivo:linha` na cópia legível) na descrição da PR.
- **Comportamento novo atrás de flag** na primeira versão, com o padrão já 1:1 no `native_android` e canário no `web` quando o item muda algo visível ao consumidor (PR-14, PR-15, PR-19, PR-20, PR-22).
- **Rollback:** desligar a flag; as migrações de schema das PRs 04, 09, 10 e 13 são aditivas ou reversíveis.
- **Nada na platform:** todas as mudanças ficam no motor. A platform só pode *remover* código duplicado depois (ex.: reconexão própria, `getMessage`, `cachedGroupMetadata`).

## 3. Resultado esperado ao final

| Tema | Hoje | Depois |
|---|---|---|
| Perda de mensagem recebida | Possível (recibo antes de gravar) | Impossível: grava, depois recibo, depois ack |
| Ordem por chat | Mensagem ao vivo ultrapassa o backlog | FIFO por chat, como o app |
| Envio | 1 por vez por instância | Paralelo por destino, FIFO dentro do chat |
| Mensagem enviada sem ack | Perdida em silêncio | Outbox + vigia de 45 s + reenvio com o mesmo id |
| Reenvio por retry | 5 min / 512 msgs; sem checar destinatário | 60 dias; só a quem era destinatário |
| I/O de disco por mensagem | ~43 KB de WAL | ~10 KB |
| Vazamentos | Chaves e mensagens legíveis (644); PN no stdout | 0700/0600; sem PII por padrão |
| Interativos | Funcionando | **Idênticos ao golden**: estrutura e bytes do encoder, com valores aleatórios mascarados |
