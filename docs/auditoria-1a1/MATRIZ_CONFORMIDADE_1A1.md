# Matriz de conformidade 1:1 — InfiniteAPI × app WhatsApp 2.26.36.72

| Item | Valor |
|---|---|
| App | `libwhatsapp_2.26.36.72` @ `921a6e9`, cópia legível `study/06_deobf` (branch `deobf-evidence` @ `3689810`) |
| Motor | `InfiniteAPI` `develop` @ `0a97980` |
| Método | Inventários extraídos **por script** do app (atributos `xmlns`, despachantes de `notification`, `ib` e `receipt`, IDs de evento WAM) e do motor (`xmlns:`, `case`, `ws.on('CB:…')`, `STATUS_MAP`, `ANDROID_MESSAGE_TYPE`). Depois, cruzamento e leitura dos casos ambíguos |
| Legenda | **=** igual · **≠** tratado diferente · **∅** não tratado pelo motor · **R** restrito (reproduzir exigiria fabricar sinal/token; fica fora pela regra do projeto) |
| Exigência | **A** = automático no app (obrigatório no perfil indicado) · **U** = só com ação do usuário (obrigatório se o motor expuser o recurso) |

---

## 1. `receipt`: tipo → status gravado

App: `ReceiptStanzaHelper` (`X/C29301Csr.java:341-370`). Motor: `STATUS_MAP` (`src/Utils/generics.ts:349-366`) + `mapWebMessageStatusToAndroid`.

| Tipo | App (status Android) | Motor hoje | Situação |
|---|---|---|---|
| (sem tipo) = entregue | 5 | DELIVERY_ACK → 5 | **=** |
| `delivery` | 5 | sem mapeamento | **≠** |
| `sender` | **5** (entregue) | SERVER_ACK → 4 | **≠** |
| `read` | 13 | READ → 13 | **=** |
| `read-self` | **17** | READ → 13 | **≠** |
| `played` | 8 | PLAYED → 8 | **=** |
| `played-self` | **18** | não mapeado (ignorado) | **∅** |
| `inactive` | **15** | não mapeado (ignorado) | **∅** |
| `retry` | reenvio (Fase 2) | reenvio | **≠** (P-01..P-07) |
| `peer_msg` | pares próprios | tratado | **=** |

**Requisito R-09:** tabela de status idêntica à do app, incluindo 5/13/17/8/18/15, e evento para o consumidor com o status equivalente.

## 2. `notification`: tipos tratados

App: despachante `X/CJW.java` (36 tipos: 36 chaves em `:12-47`, recontado). Motor: `processNotification` (`messages-recv.ts:2927-3110`, 11 tipos). Tipos sem ramo no motor só recebem ack.

| Tipo | Motor | Situação | Exigência | Observação |
|---|---|---|---|---|
| `account_sync` | tratado | **=** | A | — |
| `devices` | tratado | **=** | A | — |
| `encrypt` | tratado | **=** | A | — |
| `link_code_companion_reg` | tratado | **=** | A | — |
| `mediaretry` | tratado | **=** | A | — |
| `mex` | tratado | **=** | A | inclui `username` |
| `newsletter` | tratado | **=** | A | — |
| `picture` | tratado | **=** | A | — |
| `privacy_token` | tratado | **=** | A | — |
| `server_sync` | tratado | **=** | A | — |
| `w:gp2` | tratado | **=** | A | base do E-03 |
| `contacts` | ∅ | **∅** | A (ambos) | Mudanças de contato; atualizar o estado de contatos |
| `disappearing_mode` | ∅ | **∅** | A (ambos) | Temporizador padrão do contato |
| `status` | ∅ | **∅** | A (ambos) | Recado ("about") do contato |
| `business` | ∅ | **∅** | A (ambos) | Perfil comercial do contato |
| `hosted` | ∅ | **∅** | A (ambos) | Dispositivos hospedados (Cloud API) |
| `username` (legado) | ∅ | **∅** | A (ambos) | O motor trata só pelo `mex` |
| `authkey_rotation` | ∅ | **∅** | A (`native_android`) | Liga com N-01 |
| `companion_reg_refresh` | ∅ | **∅** | A (`native_android`) | O primário renova o registro de companion |
| `registration` | ∅ | **∅** | A (`native_android`) | — |
| `encrypted_backup` | ∅ | **∅** | U | Backup |
| `feature_control_notify` | ∅ | **∅** | A | Flags de recurso: ler e aplicar |
| `psa` | ∅ | **∅** | A | Anúncios do serviço |
| `gdpr` | ∅ | **∅** | U | Relatório de dados |
| `server` | ∅ | **∅** | A | Genérico: confirmar o conteúdo no despachante |
| `crsc_continuation` | ∅ | **∅** | A | Confirmar a semântica |
| `location` | ∅ | **∅** | U | Localização ao vivo |
| `w:interop` | ∅ | **∅** | U | Interoperabilidade (DMA) |
| `pay`, `payment_reminder`, `digital_commerce_subscription` | ∅ | **∅** | U | Pagamentos |
| `passkey_prologue` | ∅ | **∅** | U | Passkey |
| `fb:update`, `waffle` | ∅ | **∅** | U | Integrações Meta |
| `integrity`, `ent:silent_nonce` | ∅ | **R** | — | Desafios de integridade/atestação: só com material genuíno |

**Requisito R-10:** um ramo por tipo **A**, com a mesma ação do app: atualizar o estado, emitir o evento e responder quando o app responde. Tipos **U** entram junto com o recurso. Tipos **R** ficam documentados como fora.

## 3. `ib`: filhos tratados

App: `X/C37411lJ.java` (despachante de `ib`). Motor: `ws.on('CB:ib,,…')` em `socket.ts`.

| Filho | App | Motor | Situação | Exigência |
|---|---|---|---|---|
| `dirty` | tratado | tratado | **=** | A |
| `edge_routing` | grava `routing_info` | grava | **=** | A |
| `gpia` | `request nonce` | tratado | **=** | A |
| `safetynet` | tratado | tratado | **=** (R no conteúdo) | A |
| `offline_preview` | métricas + buffering (F1-02) | responde `offline_batch` | **≠** (C-05, R-03) | A |
| `offline` | fim do buffering | tratado | **≠** (R-03) | A |
| `downgrade_webclient` | — | tratado | web | — |
| `client_expiration` | `t` → aviso de expiração do cliente (`:284-291`) | ∅ | **∅** | A |
| `fbip` | lista de IPs de fallback (`:275-282`) | ∅ | **∅** | A (`native_android`: sequência de conexão) |
| `streamdebug` | `ip`, `reconnect="1"` (reconectar), `stanzalogcount` (`:246-251`) | ∅ | **∅** | A |
| `sonar` | `url` (sondagem de rede) | ∅ | **∅** | A |
| `thread_metadata` | metadados de conversa | ∅ | **∅** | A |
| `recovery_nonce` | nonce de recuperação | ∅ | **∅** | A |
| `account_sync` | sincronização de conta | ∅ | **∅** | A |
| `location` | atualização de localização ao vivo | ∅ | **∅** | U |
| `integrity`, `age_experience`, `accept_paa_link` | integridade/idade/link | ∅ | **R**/U | — |

**Requisito C-09:**
- tratar todos os filhos **A**;
- obrigatório de imediato: `streamdebug reconnect="1"` (o servidor pedindo reconexão), `client_expiration` (virar evento de expiração) e `fbip` (usar como fallback no `native_android`).

## 4. IQs que o app envia (`xmlns`)

Extração estrita: 47 valores no app (2 falso-positivos) e 22 no motor.

**Em comum (21), comportamento a validar campo a campo na próxima rodada:**
- `abt`, `blocklist`, `disappearing_mode`, `encrypt`, `fb:thrift_iq`, `md`, `newsletter`, `passive`, `privacy`, `status`, `urn:xmpp:whatsapp:dirty`, `usync`;
- `w:biz`, `w:biz:catalog`, `w:g2`, `w:m`, `w:mex`, `w:p`, `w:profile:picture`, `w:stats`, `w:sync:app:state`.

**Só no app (23):**

| `xmlns` | Quem envia (app) | Exigência | Situação |
|---|---|---|---|
| `w:auth:key` | `AuthkeyRotationManager` (`X/C1FV.java:29`): tenta a cada **24 h** (`86400000`) | **A** (`native_android`) | **∅**, requisito **N-01** |
| `privatestats` | `ACSSender` (`X/C43121uq.java:31`): `sign_credential` com credencial cega para o canal privado do WAM | A (com WAM) | **∅**, requisito **W-02** |
| `urn:xmpp:whatsapp:account` | 22 usos (backup, conta, catálogo) | A/U misto | **∅**: detalhar por uso |
| `urn:xmpp:whatsapp:push` | `WriterThread`, `RemoveAccountActivity` (registro de push) | A | **R**: exigiria token de push |
| `key_transparency` | `X/C37714Gjf.java:399` | A? | **∅**: confirmar gatilho |
| `w:b` | `BroadcastXmppMethods` | U | **∅** (listas de transmissão) |
| `location` | `LocationSubscriptionSendMethods` | U | **∅** |
| `w:pay`, `w:qr` | Pagamentos | U | **∅** |
| `passkey`, `w:auth:backup:token` | Passkey/backup | U | **∅** |
| `w:account_defence` | aprovar logout de dispositivo (`X/DIT.java:19`) | U | **∅** |
| `w:biz:msg_feedback`, `w:biz:p2b_report` | Feedback/relatório comercial | U | **∅** |
| `spam`, `optoutlist` | Denúncia/opt-out | U | **∅** |
| `w:comms`, `w:comms:chat`, `w:interop` | Interop/comms | U | **∅** |
| `vesta`, `waffle`, `phoenix`, `ar`, `fb:graphql` | Integrações Meta | U | **∅** |

**Só no motor (1):** `bot`. É o IQ `getBotListV2` (`chats.ts:814-830`). **Mantido.**

**Interativos (botões, lista, native flow, carrossel):**
- o motor monta `biz > interactive(type=native_flow) > native_flow(v, name)`, **o mesmo formato que o app monta** (`NativeFlowMessageCustomizer`, `X/C30123DHh.java:86-151`);
- `bot biz_bot=1` e `biz > quality_control` (carrossel) são o formato de remetente comercial, que o app só **recebe** (`X/DHE.java:66-76`, `X/C30141DHz.java:14-20`). Funcionam em produção e ficam **congelados** (ver `PLANO_DE_ACAO_PRS.md`, seção 0).

**Requisito N-01 (`native_android`):** rotação de `w:auth:key` a cada 24 h, com os mesmos gatilhos e o mesmo tratamento de falha (`last_succeeded/failed_auth_key_rotation_attempt`), mais o ramo `authkey_rotation` da notificação.

## 5. WAM (decisão: só eventos de operações reais, com valores medidos)

O app emite **os mesmos IDs** que o catálogo do motor (`src/WAM/constants.ts`); confirmado pela classe e pelos campos no app:

| ID | Evento | Classe no app | Operação real do motor | Campos medíveis |
|---|---|---|---|---|
| 476 | `E2eMessageSend` | `X/C26656BnD` | Cifrar e enviar | tipo de cifra, `encRetryCount`, estado de grupo, resultado |
| 478 | `E2eMessageRecv` | `X/C26655BnC` | Decifrar | `offline`, tipo de cifra, resultado/falha |
| 854 | `MessageSend` | `X/C26658BnF` | Envio (até o ack) | tipo de mídia, `deviceCount`, duração até o ack, resultado |
| 450 | `MessageReceive` | `X/C26751Bok` | Recebimento | tipo, `deviceCount`, `offline` |
| 1588 | `MediaUpload2` | `X/C1605774h` | Upload | tamanho, duração, host, resultado, `connectionType` |
| 1590 | `MediaDownload2` | `X/C1603673l` | Download | tamanho, duração, resultado |
| 3112 | `OfflineResume` | `X/C461020d` | Retomada offline | contagens esperadas e reais, tempos (`offline_preview_t`, `offline_processing_t`) |
| 3014 | `PrekeysDepletion` | `X/C26679Bna` | Busca de pre-keys | `prekeysFetchReason` |

**Requisitos:**
- **W-01:** emitir **somente** esses eventos, com os campos que o motor **mede de fato**. Campos de interface ou hardware (ex.: `afterReadDuration`, `chatSessionId`, `deviceSizeBucket`) ficam **ausentes**, nunca inventados.
- **W-02:** canal privado (`privatestats`) só com credencial assinada pelo servidor (`sign_credential`), sem gerar material local falso.
- **W-03:** o buffer, a cadência de envio e o formato do `w:stats` ficam na biblioteca nativa do app (`wamsys`, via `com/whatsapp/wamsys/JniBridge`). Fixar pelo Ghidra (`study/05_ghidra_libwhatsapp`) ou por captura antes de ligar. Até lá, desligado.
- **Perfil:** no `native_android`, IDs do app. No `web`, o equivalente do WA Web (ex.: `WebcMessageSend`, ID 2072, que o app não emite).

## 6. `message_type` gravado no `msgstore`

- Motor: **32 tipos confirmados** (`ANDROID_MESSAGE_TYPE`, `message-store-backend.ts:44-78`): 0, 1, 2, 3, 4, 5, 9, 13, 15, 16, 20, 23, 25, 26, 27, 32, 42, 43, 45, 46, 49, 55, 57, 63, 66, 81, 82, 92, 94, 99, 105, 124.
- App: registro de tipos do `FMessageDatabaseSubsystem` (`C1UV`, citado em `AnonymousClass170.A07`), com dezenas de tipos a mais (sistema, pagamentos, chamadas, avisos de grupo…).
- **Requisito M-01:** extrair o registro completo de `message_type` do app com o satélite de cada tipo e cobrir um por um no espelho. Hoje o motor grava `NULL` quando o tipo não está confirmado. É a próxima extração da matriz.

## 7. Próximas camadas da matriz (para fechar o 1:1 total)

1. **Campo a campo dos 21 IQs em comum:** atributos, filhos, `type`, timeouts e tratamento de erro, contra o builder do app.
2. **IDs de query `w:mex`** (GraphQL): lista do app × lista do motor.
3. **Registro completo de `message_type`** (M-01).
4. **`call`/VoIP:** tipos de stanza de chamada e respostas.
5. **`urn:xmpp:whatsapp:account`:** os 22 usos, separados entre automáticos e de usuário.
