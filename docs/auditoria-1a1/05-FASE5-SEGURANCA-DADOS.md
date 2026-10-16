# Auditoria completa — Fase 5: Segurança de dados (com paridade APK)

| Item | Valor |
|---|---|
| Alvo | `InfiniteZAP/InfiniteAPI` `develop` @ `0a97980` |
| Referência | APK `libwhatsapp_2.26.36.72` @ `921a6e9` (cópia legível `study/06_deobf`) |
| Escopo | Logs (logger e `console`), segredos e PII; dados em repouso (permissões, `secure_delete`, retenção); métricas, eventos e superfícies de rede |
| Método | Varredura estática de todas as chamadas de log e escrita em disco. **Sonda 1:** socket real com todos os níveis de log e todo o `console.*` capturados, uma mensagem com marcador no texto e CPF, procurando marcador, CPF, PN, LID e as 4 chaves privadas das credenciais. **Sonda 2:** permissões reais dos arquivos criados pelos 2 formatos de auth state com `umask 022`. Sondas removidas; `git status` vazio |
| Princípio | Toda correção fica **no motor**, 1:1 com o APK sempre que possível |

---

## 1. Resumo executivo

| # | Gravidade | Achado | Prova |
|---|---|---|---|
| **F5-01** | **Alto** | **Chaves privadas e mensagens ficam legíveis por qualquer usuário do host:** diretórios 755 e arquivos 644 em todos os formatos de auth state | Sonda: `creds.json`, `pre-key-*.json`, `session-*.json`, `creds.db`, `axolotl.db` e `msgstore.db` (+ `-wal`/`-shm`) = **644**; diretórios = **755** |
| **F5-02** | **Alto** | **`console.log` ligado por padrão imprime o PN do remetente a cada mensagem**, fora do logger do consumidor, sem controle de nível e sem redação | Sonda: 2 linhas por mensagem com `5511888880010@s.whatsapp.net` |
| **F5-03** | **Médio** | Sem `secure_delete`: conteúdo apagado (mensagens, sessões, tokens) continua no arquivo e no WAL. O APK liga no `msgstore` | Fase 4 (F4-04); custo medido de +3,5% |
| **F5-04** | **Médio** | Quarentena de stanzas **sem retenção**: `pruneOlderThan` existe mas nunca é chamado | Leitura (`quarantine-backend.ts:167`, 0 chamadores) |
| F5-05 | Baixo | Logs em `info` com o nó bruto: `offline_preview` (`socket.ts:2638`) e `received unknown sync` (`chats.ts:2297`) | Leitura |
| F5-06 | Info | Debug/trace contêm PN/LID e XML de recibos | Sonda (comportamento esperado de debug) |

**Verificado e correto:**
- **conteúdo de mensagem e dados pessoais do texto (CPF) não aparecem** em nenhum nível de log nem no `console`;
- **nenhuma chave privada** (Noise, identidade, signed pre-key, `advSecretKey`) aparece em logs;
- o logger padrão tem redação (`log-redaction.ts`, `DEFAULT_REDACT_FIELDS`);
- `logTcToken` registra só o **tamanho** do token;
- o servidor de métricas escuta em **127.0.0.1** por padrão, e nenhum label de métrica carrega JID;
- o event stream (`baileys-event-stream.ts`) fica só em memória e é opt-in;
- a atestação nativa já grava com `0o600`.

---

## 2. Achados com prova

### F5-01 — Permissões de arquivo (Alto)

**Sonda (`umask 022`, que é o padrão da maioria dos containers e servidores):**

```text
multifile dir=755 creds.json=644 pre-key-1.json=644 session-x.0.json=644
multidb   dir=755 axolotl.db=644 axolotl.db-shm=644 axolotl.db-wal=644 creds.db=644 creds.db-shm=644
               creds.db-wal=644 msgstore.db=644 msgstore.db-shm=644 msgstore.db-wal=644
```

**Onde:**
- `store.ts:617` (`fs.mkdirSync(sessionDir, { recursive: true })`, sem `mode`);
- `use-multi-file-auth-state.ts:186` (`writeFile` sem `mode`) e `:276` (`mkdir` sem `mode`);
- `app-state-sync-key-store.ts:129-134`;
- `history-sync-store.ts:213-218`.

A única exceção correta é `native-android-node-attestation.ts:267` (`mode: 0o600`).

**Impacto:** qualquer processo ou usuário do mesmo host, ou outro container com o volume montado, lê:
- `creds.json`/`creds.db`: chave Noise, chave de identidade e `advSecretKey`. Isso permite **sequestrar a conta**;
- `axolotl.db`: sessões Signal;
- `msgstore.db`: o espelho grava o **texto das mensagens** em `message.text_data` (`process-message.ts:363`, `:1289`, `:1696`).

**APK:** os bancos ficam em `/data/data/com.whatsapp/`, privados ao UID do app (sandbox) e cifrados pelo FBE do Android.

**Correção fiel (no motor):**
1. Criar todo diretório de sessão com `mode: 0o700` e aplicar `chmod 0o700` em diretórios que já existem.
2. Gravar todo arquivo sensível com `mode: 0o600`. No SQLite, criar o `.db` com `0o600` **antes** do `better-sqlite3` abri-lo: o SQLite cria `-wal`/`-shm` com as mesmas permissões do banco.
3. Na abertura, se o diretório ou o arquivo estiver mais aberto que isso, corrigir e registrar um `warn` (autocorreção de sessões existentes).
4. Documentar que o equivalente ao FBE é a criptografia de disco do host.

### F5-02 — `console.log` com PN por padrão (Alto)

**Sonda (1 mensagem):**

```text
[console.log] [BAILEYS] 🧭 Sender source → 5511888880010@s.whatsapp.net { msgId: LEAK-1, … }
[console.log] [BAILEYS] 📥 Message received [type=text📝]: LEAK-1 ← 5511888880010@s.whatsapp.net
```

**Onde:**
- `baileys-logger.ts:537-541`: `BAILEYS_LOG !== 'false'`, ou seja, **ligado por padrão**;
- `logMessageReceived` (`:772`), `logMessageSent` (`:749`) e `logMessageSenderSource` (`:791`) imprimem o JID bruto;
- o módulo **importa** `obfuscateJid` (`:16`), mas não o usa nesses helpers.

**Impacto:** o telefone de todo contato de toda instância vai para o stdout do servidor, e daí para os logs do container e agregadores (Loki/ELK/CloudWatch), com a retenção deles. Não há como controlar por nível nem redigir pelo logger do consumidor.

**Correção:**
1. Padrão **desligado** (`BAILEYS_LOG === 'true'` para ligar).
2. Quando ligado, passar `obfuscateJid` nos JIDs.
3. De preferência, rotear pelo logger injetado (`config.logger`) em vez de `console`.

### F5-03 — `secure_delete` (Médio; 1:1 APK)

Mesmo achado da Fase 4 (F4-04). O APK executa `PRAGMA secure_delete=1` no `MessagesDBHelper.onOpen` (`X/C0H0.java:1196`) e dispara um alarme se o comando não surtir efeito. Custo medido: +3,5% de WAL ao apagar. **Correção:** adicionar ao `DEFAULT_PRAGMAS`, pelo menos em `msgstore`, `axolotl`, `creds` e `wa`.

### F5-04 — Quarentena sem retenção (Médio)

**Onde:** `message_quarantine` (`schemas/msgstore.ts:170`) guarda `serialized_stanza` e `original_protobuf` de cada falha de decrypt. O `pruneOlderThan` (`quarantine-backend.ts:167`) **não tem chamador**.

**Impacto:**
- a tabela cresce sem limite em contas com muitas falhas (Bad MAC em massa após restauração);
- ciphertext e metadados (chat, remetente) ficam guardados para sempre.

**Correção:** poda agendada no motor (ex.: 14 dias ou após reprocessamento bem-sucedido), junto do agendador de limpeza já existente. Atenção à lição do F3-01: cancelar no `end()`.

### F5-05 — Nós brutos em `info` (Baixo)

- `socket.ts:2638`: `logger.info('offline preview received', JSON.stringify(node))` (só contagens, mas sai a cada conexão; F1-11);
- `chats.ts:2297`: `logger.info({ node }, 'received unknown sync')`.

**Correção:** rebaixar para `debug` e registrar só os atributos.

---

## 3. Plano de correção

| # | PR | Achados | Esforço | Risco |
|---|---|---|---|---|
| 1 | `fix(security): diretórios 0700 e arquivos 0600 (com autocorreção)` | **F5-01** | Baixo | Baixo (atenção a quem roda o consumidor com outro usuário) |
| 2 | `fix(logging): console desligado por padrão; JIDs ofuscados` | **F5-02**, F5-05 | Muito baixo | Muito baixo (mudança de padrão, documentar no CHANGELOG) |
| 3 | `fix(sqlite): secure_delete` | F5-03 (= F4-04) | Muito baixo | Muito baixo |
| 4 | `feat(msgstore): retenção da quarentena` | F5-04 | Baixo | Baixo |

---

## 4. Referências APK desta fase

| Classe | Nome recuperado | Regra |
|---|---|---|
| `X/C0H0` | `MessagesDBHelper` | `secure_delete=1` com alarme de integridade |
| — | Sandbox Android | Bancos privados ao UID do app e cifrados por FBE; o equivalente no servidor é 0700/0600 mais criptografia de disco |

**Próximo passo:** Fase 6 (restante: mídia, VoIP, grupos, newsletter, WAM), com o mesmo método e a paridade APK. Depois dela, entrego o **plano único consolidado de correções no motor** (todas as fases, ordenado por risco × custo).
