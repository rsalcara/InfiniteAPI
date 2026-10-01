# Auditoria completa — Fase 4: Persistência (com paridade APK)

| Item | Valor |
|---|---|
| Alvo | `InfiniteZAP/InfiniteAPI` `develop` @ `0a97980` |
| Referência | APK `libwhatsapp_2.26.36.72` @ `921a6e9` (cópia legível `study/06_deobf`, branch `deobf-evidence`) |
| Escopo | Key store (cache, transações, locks), multi-db SQLite (11 arquivos, PRAGMAs, WAL), espelho `msgstore`, tabelas Signal tipadas × `signal_kv`, custo de escrita por mensagem, LID/PN no caminho quente, durabilidade |
| Método | Leitura. **4 sondas/benchmarks** com o backend SQLite real: socket completo com multi-db e contagem de SQL por arquivo; `MessageStoreBackend` com 1 commit × lote; exclusão com e sem `secure_delete`; atualização de sessão Signal com gravação dupla × tabela tipada. Regras do APK tiradas da cópia desofuscada. Sondas removidas; `git status` vazio |
| Princípio | **Toda correção fica no motor InfiniteAPI, 1:1 com o APK sempre que possível** |

---

## 1. Resumo executivo

| # | Gravidade | Achado | Prova |
|---|---|---|---|
| **F4-01** | **Alto** | **A primeira mensagem de um contato novo espera um USync na entrada:** o motor busca na rede o LID de um PN que a própria stanza já trouxe | Sonda: `upsert` só depois de **30,4 s** (timeout do IQ); consulta `usync` `lid` com contexto `background` |
| **F4-02** | **Alto** (desempenho) | **Um commit por mensagem no `msgstore`:** ~31 KB de WAL por mensagem | Benchmark: 1 commit = **30,8 KB/msg, 159 µs**; lote de 50 = **1,7 KB/msg, 96 µs** (17,7× menos I/O) |
| **F4-03** | **Alto** (desempenho) | **Toda atualização de sessão Signal grava em dois lugares** (tabela tipada + `signal_kv`); o APK grava só em `sessions` | Benchmark: 12,4 KB e 533 µs → **8,2 KB e 409 µs** só com a tipada (−33% de WAL, −23% de tempo) |
| **F4-04** | **Médio** (vazamento de dados) | **Não liga `secure_delete`**: conteúdo apagado continua legível nas páginas livres e no WAL. O APK liga no `msgstore` | Leitura APK (`MessagesDBHelper.onOpen`); benchmark: custo **+3,5% de WAL na exclusão**, sem diferença de tempo |
| F4-05 | Médio | Travas por **tipo** (`__type__:session`) na leitura dentro de transação e no commit: todas as sessões de todos os chats passam por uma trava | Leitura (`auth-utils.ts:409-418`, `:455`) |
| F4-06 | Baixo | Índice redundante `signal_kv_by_type` (a PK `(type, id)` já cobre) | Benchmark: −11% de tempo por escrita sem o índice |
| F4-07 | Baixo | 5 upserts + 5 selects de `jid` e 3 de `chat` por mensagem (`DO NOTHING`: só CPU); sem cache `jid → _id` em memória | Contagem por SQL na sonda |
| F4-08 | Baixo | Registro de sessão em JSON/BufferJSON (3,3 KB); o APK grava o protobuf binário no mesmo `record BLOB` | Leitura + tamanho medido |
| F4-09 | Info | `cache_size = -512` (512 KiB/arquivo) × 11 arquivos; o APK usa o padrão do SQLite (~2 MiB, AB 20777 = 0) | Leitura (escolha consciente para multi-instância) |

**Já está 1:1 (não mexer):**
- schema `sessions` **idêntico** ao APK (`X/C33041cT.java`);
- `synchronous = NORMAL` e WAL, iguais ao `MessagesDBHelper`/`BaseSQLiteOpenHelper` do APK;
- `foreign_keys = ON`, como no APK;
- `recordMessages` em lote já existe (hoje só no histórico);
- trava de sessão entre processos (`SESSION_LOCK_FILE`);
- `PRAGMA optimize` no fechamento e `journal_size_limit` (PR #17).

---

## 2. Achados com prova

### F4-01 — USync de LID no caminho quente de entrada (Alto)

**Onde:** `src/Socket/messages-recv.ts:4117-4128`, no ramo em que o `alt` é PN (`sender_pn`/`participant_pn`):

```ts
const existingLid = await signalRepository.lidMapping.getLIDForPN(alt)   // ← vai à rede (USync) quando não conhece
if (existingLid !== primaryJid) await storeLIDPNMappings([{ lid: primaryJid, pn: alt }])
```

- `getLIDForPN` → `getLIDsForPNs`, que dispara `usyncFetch` (`src/Signal/lid-mapping.ts:639-657`, `:743+`);
- **o LID já está na mão** (`primaryJid` = `from` da stanza), e o código só quer **comparar**;
- tudo isso roda sob o `lidMigrationLocks` e antes da normalização, com o `liveChatOrderGate` segurando o resto do chat.

**Prova (sonda: socket real com multi-db, mensagem 1:1 de um LID com `sender_pn`):**

```text
[warmup] upsert after 30440 ms; sent=["iq:usync","presence:","receipt:"]
usync=[{"ctx":"background","mode":"query","query":["lid"],"users":["5511888880010@s.whatsapp.net"]}]
```

Com o servidor real, o custo mínimo é **um round-trip de USync na primeira mensagem de cada contato novo** (100–400 ms). Se o IQ se perder, são **30 s** com o chat parado. Isso também gera **tráfego que o app não produz**. O próprio `lid-mapping.ts:660-671` avisa: *"USync-on-look-up is a behavioral fingerprint WA Web / whatsmeow don't emit … may serve as a ban signal"*.

**APK:** aprende o mapeamento a partir dos **atributos da stanza** (`peer_recipient_pn`/`sender_pn`, citado em `messages-recv.ts:179-181` a partir de `EWH.java`/`C177487uK.java`), sem consultar a rede na entrada.

**Correção (1 linha, fiel):** usar `getKnownLIDForPN(alt)` (só cache e disco, `lid-mapping.ts:679`) e gravar o par da stanza quando for diferente ou ausente.

**Teste:** a mesma sonda deve dar `upsert` em < 50 ms e 0 IQs `usync`.

### F4-02 — Um commit por mensagem no `msgstore` (Alto, desempenho)

**Contagem real por mensagem recebida (sonda com socket + multi-db):**

| Arquivo | Escritas | Leituras | Principais |
|---|---|---|---|
| `msgstore.db` | 11 | 13 | 5× `INSERT jid … DO NOTHING`, 3× `INSERT chat … DO NOTHING`, `message`, `message_details`, `UPDATE chat` |
| `axolotl.db` | 1 | — | `DELETE FROM unordered_stanza_queue` (preack, F1-08) |

`recordMessage` (`message-store-backend.ts:569`) abre **uma transação por mensagem**. No WAL, cada commit grava as páginas sujas inteiras de `message` (4 índices), `chat` e `message_details`.

**Benchmark (backend real, 2.000 mensagens em 20 chats, autocheckpoint desligado):**

| Modo | µs/msg | WAL/msg |
|---|---|---|
| 1 commit por mensagem (hoje) | 159 | **30.832 B** |
| **Lote de 50 (`recordMessages`, que já existe)** | **96** | **1.743 B** |

**Impacto:** a 50 msg/s por instância × 100 instâncias, são **~150 MB/s** de WAL só no `msgstore` contra ~9 MB/s em lote. Disco e checkpoint viram gargalo e degradam a latência de todas as instâncias.

**Correção (no motor, mantendo F1-01):** *group commit* com prazo curto. As mensagens decifradas entram num buffer e são gravadas com `recordMessages` a cada **≤ 5 ms ou 50 mensagens**, o que vier antes. **Os recibos saem depois do commit do lote**, preservando a regra do APK (gravar e só então recibo), com no máximo 5 ms de atraso. O APK já grava em lote numa transação no nível de stanza (`QueueStoreCache/flushStanzasToDisk`, `X/AbstractC34761fe.java:90-175`), e é o mesmo princípio. O buffer do motor também serve de ponto único para o F1-01.

### F4-03 — Gravação dupla das chaves Signal (Alto, desempenho; divergente do APK)

**Onde:** `use-multi-db-sqlite-auth-state.ts:51-83`: *"`signal_kv` is ALWAYS written in the SAME transaction (both tables…)"*. Toda atualização de `session`/`sender-key`/`pre-key`/`identity` grava a tabela tipada **e** o `signal_kv`.

**APK:** só `axolotl.db.sessions` (`X/C33041cT.java`), sem tabela KV paralela.

**Benchmark (2.000 atualizações de sessão de 3,3 KB em 200 contatos):**

| Configuração | µs/atualização | WAL/atualização |
|---|---|---|
| Hoje (dupla + índice redundante) | 533 | 12.360 B |
| Sem `signal_kv_by_type` | 472 | 12.360 B |
| **Só tipada (1:1 APK)** | **409** | **8.240 B** |

Cada mensagem cifrada ou decifrada atualiza a sessão, então esse custo se soma ao do F4-02: **~43 KB de WAL por mensagem hoje**, contra **~10 KB** com as correções F4-02 e F4-03.

**Correção (no motor, segura):**
1. Parar de gravar no `signal_kv` os tipos cuja tabela tipada é autoritativa (`signalSourceOfTruth`, que já é o padrão).
2. Manter o `signal_kv` **só para leitura** como fallback de linhas antigas, com migração preguiçosa que move para a tipada e apaga do KV na primeira leitura.
3. O `keys.list`/`listIds` passa a ler da tipada.
4. Remover `signal_kv_by_type` (F4-06).

### F4-04 — `secure_delete` (Médio; privacidade, 1:1 APK)

**APK:** `X/C0H0.java` (`MessagesDBHelper.onOpen`) `:1186-1220` executa `PRAGMA synchronous=NORMAL;`, `PRAGMA cache_size=<AB 20777>` (padrão 0 = não altera) e **`PRAGMA secure_delete=1`**, com alarme de integridade se não pegar (`db-integrity/enable-secure-delete/error/not-enabled`).

**InfiniteAPI:** `store.ts:510-539` não tem `secure_delete`. Mensagens, sessões e tokens apagados ficam legíveis nas páginas livres e no WAL até serem sobrescritos. Um backup ou cópia do diretório de sessão vaza esse conteúdo.

**Benchmark (exclusão de 2.000 mensagens em lotes de 500):** WAL de 684 → 708 KB (**+3,5%**); tempo de 5–6 ms nos dois casos.

**Correção:** `'secure_delete = 1'` no `DEFAULT_PRAGMAS` (ou pelo menos em `msgstore`, `axolotl`, `creds` e `wa`), mais checagem na abertura como no APK. Isso também vale para a Fase 5.

### F4-05 — Travas por tipo nas transações de chave (Médio)

**Onde:**
- `auth-utils.ts:409-418`: o commit trava `{ namespace: '__type__', id: <tipo> }` para **cada** tipo alterado;
- `:455`: a leitura de chave ausente dentro de transação também trava por tipo.

**Efeito:** todas as leituras-com-miss e commits de `session` de **todos** os chats são serializados. Com SQLite síncrono o custo é pequeno (a seção crítica dura microssegundos). Com backend assíncrono (Redis/Postgres/rede), a vazão vira `1 / latência` por tipo.

**APK:** trava **por dispositivo/endereço** (`C09410bp.A05(deviceJid)` no `RetryReceiptHandler`, `X/C1DR.java:152`); o SQLite serializa só a escrita física.

**Correção:** travar por registro (`{ type, id }`) no commit e na leitura. O `LockManager.withLocks` já ordena e deduplica, então não há risco de deadlock. A trava por tipo fica só em operações de tipo inteiro (`clear`, `list`).

### F4-06 a F4-09 (Baixo/Info)

| # | Achado | Correção |
|---|---|---|
| F4-06 | `CREATE INDEX signal_kv_by_type ON signal_kv(type)` redundante com a PK `(type, id)` (`schemas/axolotl.ts:212`) | Migração `DROP INDEX` (−11% por escrita) |
| F4-07 | 10 statements de `jid` e 3 de `chat` por mensagem, todos `DO NOTHING` | LRU `raw_string → _id` no `JidMapBackend` (o APK mantém o `JidStore` em memória) |
| F4-08 | Sessão gravada como texto BufferJSON (3,3 KB) no `record BLOB` | Gravar o binário do registro, como o APK grava o protobuf; reduz tamanho e parse |
| F4-09 | `cache_size = -512` × 11 arquivos | Manter para multi-instância, mas expor o ajuste por arquivo (ex.: `msgstore`/`axolotl` = −2000, como o padrão do APK) |

---

## 3. Plano de correção (ordem por risco × custo)

| # | PR | Achados | Esforço | Risco |
|---|---|---|---|---|
| 1 | `fix(recv): mapeamento LID/PN local na entrada (sem USync)` | **F4-01** | Muito baixo (1 linha + teste) | Muito baixo |
| 2 | `fix(sqlite): secure_delete como o APK` | **F4-04** | Muito baixo | Muito baixo |
| 3 | `perf(sqlite): remover índice redundante do signal_kv` | F4-06 | Muito baixo (migração) | Muito baixo |
| 4 | `perf(keys): gravar só a tabela tipada; signal_kv como fallback de leitura` | **F4-03**, F4-08 | Médio | Médio (migração preguiçosa + testes de restauração) |
| 5 | `perf(msgstore): group commit (≤ 5 ms / 50 msgs) com recibo após o commit` | **F4-02** + F1-01 | Médio | Médio (junto com a PR de F1-01) |
| 6 | `perf(keys): travas por registro no commit e na leitura` | F4-05 | Médio | Médio (testes de concorrência) |
| 7 | `perf(msgstore): cache jid → _id` | F4-07 | Baixo | Baixo |

**Ganho estimado com 4 + 5:** WAL por mensagem de ~43 KB → ~10 KB (**~4× menos I/O de disco**) e ~30–40% menos CPU de persistência por mensagem.

---

## 4. Referências APK desta fase

| Classe | Nome recuperado | Regra |
|---|---|---|
| `X/C0H0` | `MessagesDBHelper` | `synchronous=NORMAL`, `cache_size` (AB 20777, padrão 0), **`secure_delete=1`** |
| `X/AbstractC10370dR` | `BaseSQLiteOpenHelper` | WAL sempre ligado; `wal_checkpoint(FULL)` |
| `X/C33041cT` | Schema do `axolotl.db` | `sessions (…, record BLOB, …)`, idêntico ao InfiniteAPI |
| `X/AbstractC34761fe` | `QueueStoreCache` | Várias stanzas numa transação (`flushStanzasToDisk`) |
| `X/C016407t` | Defaults das AB props | 20777 = 0 |

**Próximo passo:** Fase 5 (segurança de dados: logs com PII e chaves, dados em repouso, `secure_delete`, permissões de arquivo e exposição em métricas/eventos), já com paridade APK.
