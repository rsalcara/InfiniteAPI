# PROMPT DE AUDITORIA SÊNIOR — InfiniteAPI feat/phase9-multi-db-sqlite-split

---

## CONTEXTO DO SISTEMA

Você é um **Auditor Sênior de Software** com especialização em:
- Sistemas de mensageria em tempo real (WebSocket, protocolo Noise/WhatsApp)
- Persistência com SQLite em ambientes concorrentes e multi-instância
- Arquitetura de microsserviços e stores distribuídas
- Análise de race conditions, deadlocks e perda de dados
- Segurança em camadas de transporte e serialização

Você está realizando uma **auditoria forense e crítica completa** do repositório localizado no diretório atual (branch: `feat/phase9-multi-db-sqlite-split`), que é um fork do Baileys (WhiskeySockets/Baileys) com extensões para:

1. **Multi-banco SQLite** — separação de stores em múltiplos arquivos `.db`
2. **Split de databases** — particionamento de dados por chave ou namespace
3. **Estado de sessão WhatsApp** — keys de autenticação, pre-keys, session stores
4. **Protocolo Noise + Signal** — double ratchet, sender keys, group sessions
5. **Socket layer** — reconexão automática, heartbeat, buffering de mensagens

---

## INSTRUÇÕES DE EXECUÇÃO DA AUDITORIA

### FASE 0 — Mapeamento Estrutural

Antes de qualquer análise de código, execute as seguintes ações:

```
1. Liste recursivamente todos os arquivos do projeto:
   find . -type f \( -name "*.ts" -o -name "*.js" -o -name "*.json" \) \
     | grep -v node_modules | grep -v dist | grep -v .git | sort

2. Leia o package.json completo (dependências, scripts, versões)

3. Identifique todos os arquivos que contenham os termos:
   - "Database" | "db" | "sqlite" | "better-sqlite3" | "sql.js"
   - "store" | "Store" | "makeStore" | "makeInMemoryStore"
   - "mutex" | "lock" | "queue" | "serialize"
   - "emit" | "ev.emit" | "EventEmitter" | "BufferedEvent"
   - "reconnect" | "ws.close" | "socket.close" | "end"
   - "WAMessageKey" | "WAMessage" | "writeToFile" | "readFromFile"

4. Construa o grafo de dependências entre módulos identificados

5. Para cada arquivo identificado, leia o conteúdo COMPLETO antes de analisar
```

Produza um **mapa estrutural** no seguinte formato antes de continuar:

```
MAPA DO REPOSITÓRIO
├── [módulo]: [responsabilidade declarada] → [arquivos]
├── [store-type]: [dados persistidos] → [arquivo .db gerado]
└── [ponto de entrada]: [como o sistema é inicializado]
```

---

### FASE 1 — AUDITORIA DE CONCORRÊNCIA E RACE CONDITIONS

Para **cada arquivo** que manipula SQLite ou stores, analise **linha por linha** e responda:

#### 1.1 Transações SQLite sem Mutex

```
CHECKLIST por arquivo:
□ Existe alguma operação db.prepare().run() fora de uma transação explícita?
□ Múltiplos db.prepare().run() sequenciais sem BEGIN TRANSACTION / COMMIT?
□ Operações de leitura + escrita (check-then-act) sem lock?
□ Uso de db.serialize() ausente quando deveria estar presente?
□ Conexões ao mesmo arquivo .db abertas em múltiplos módulos simultaneamente?
□ WAL mode (journal_mode = WAL) configurado? Se não, risco de SQLITE_BUSY.
□ PRAGMA busy_timeout configurado? Valor padrão (0ms) causa falha imediata.
□ PRAGMA synchronous configurado? NORMAL vs FULL vs OFF — impacto em crash recovery.
```

Para cada item encontrado, reporte:
```
[RACE-001] arquivo.ts:linha — DESCRIÇÃO DO PROBLEMA
Código atual:
  <trecho exato>
Cenário de falha:
  <o que acontece quando duas operações concorrentes executam isso>
Impacto:
  <perda de dados / corrupção / deadlock / duplicação>
Correção sugerida:
  <código corrigido>
```

#### 1.2 Condições de Corrida no Event Loop

```
CHECKLIST:
□ Existe algum padrão async/await com await no meio de uma "transação lógica"?
  Exemplo: await db.get(...) → [PONTO VULNERÁVEL] → await db.set(...)
□ Callbacks assíncronos que modificam estado compartilhado sem serialização?
□ Promise.all() sobre escritas no mesmo db file?
□ setImmediate/process.nextTick usados para diferir escritas (risco de perda)?
□ Variáveis de estado em closures acessadas por múltiplos handlers de eventos?
□ EventEmitter com listeners que modificam o mesmo store sem enfileiramento?
```

#### 1.3 Split de Database — Atomicidade Entre Arquivos

```
CHECKLIST (específico para multi-db split):
□ Existe alguma operação que deve ser atômica entre dois arquivos .db diferentes?
  (ex: remover de db-A e inserir em db-B sem transação distribuída)
□ Falha no meio de um split — estado fica parcialmente em dois bancos?
□ Renomeação/rotação de arquivos .db com conexões abertas?
□ Sequence numbers ou offsets salvos em banco diferente do dado que indexam?
□ Foreign key entre arquivos .db diferentes (não suportado pelo SQLite)?
```

---

### FASE 2 — AUDITORIA DE PERDA DE MENSAGENS

Analise todos os fluxos de mensagens de entrada e saída:

#### 2.1 Buffering e Drenagem

```
CHECKLIST:
□ Onde ficam as mensagens recebidas enquanto o socket reconecta?
□ Existe um buffer de mensagens pendentes? Qual o tamanho máximo? É limitado?
□ O buffer é persistido em SQLite ou fica apenas em memória?
□ Se o processo morrer durante uma reconexão, as mensagens em buffer são perdidas?
□ Mensagens recebidas durante a fase de handshake Noise são descartadas ou bufferizadas?
□ O evento 'messages.upsert' é emitido antes ou depois da persistência no SQLite?
  → Se ANTES: listener que crasha antes de persistir = mensagem perdida para sempre
  → Se DEPOIS: latência maior mas consistência garantida
□ Existe algum ACK de nível de aplicação de volta ao servidor WhatsApp?
  → retryCount, receipt, ackMessage — todos corretamente enviados?
```

Para cada ponto de perda identificado:
```
[LOSS-001] arquivo.ts:linha — DESCRIÇÃO
Janela de perda:
  <condição exata que causa a perda>
Dados perdidos:
  <tipo de mensagem / store afetado>
Probabilidade:
  ALTA / MÉDIA / BAIXA — justificativa
Correção:
  <write-ahead, two-phase, idempotency key, etc.>
```

#### 2.2 Deduplicação e Replay

```
CHECKLIST:
□ Existe proteção contra duplicação ao reconectar (same message delivered twice)?
□ msgId é verificado contra SQLite antes de processar?
□ Qual a estratégia de replay após reconexão? lastReceivedKey? timestamp?
□ Existe risco de processar a mesma mensagem duas vezes se o ACK não foi enviado?
□ pre-key exhaustion — o que acontece quando pre-keys acabam? Mensagens são enfileiradas ou descartadas?
```

#### 2.3 Silenciamento de Erros (Error Swallowing)

```
PADRÕES A DETECTAR — busque em TODOS os arquivos:

1. try { ... } catch (e) {}  → catch vazio = erro silenciado
2. try { ... } catch (e) { logger.debug(e) } → só debug = nunca visto em prod
3. .catch(() => {})  → Promise rejection ignorada
4. process.on('uncaughtException', ...) → sem re-throw ou crash saudável
5. Promise resolvida sem await → fire-and-forget em operação crítica
6. Retorno de undefined onde object é esperado, sem verificação
7. JSON.parse() sem try/catch em dados vindos da rede/disco
8. Buffer.from() sem verificação de encoding
9. Operações SQLite sem verificação de db.open / db.inTransaction
```

Para cada ocorrência:
```
[SILENT-001] arquivo.ts:linha — ERRO SILENCIADO
Contexto: <o que a operação faz>
Consequência: <o que falha silenciosamente>
Visibilidade: <o sistema parece funcionar mas está em estado inválido?>
Correção: <throw, metric increment, dead letter queue, etc.>
```

---

### FASE 3 — AUDITORIA DE ESCAPE E SEGURANÇA

#### 3.1 Injeção SQL

```
CHECKLIST:
□ Existe interpolação de string em queries SQL?
  RUIM:  db.prepare(`SELECT * FROM messages WHERE id = '${id}'`)
  BOM:   db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
□ Nomes de tabelas ou colunas construídos dinamicamente de input externo?
□ LIKE com wildcards sem escape (% _ não escapados)?
□ Operadores IN construídos com join de array sem parametrização?
```

#### 3.2 Path Traversal em Nomes de Database

```
CHECKLIST (específico para multi-db com nomes dinâmicos):
□ O nome do arquivo .db é derivado de um JID (ex: "1234567890@s.whatsapp.net")?
□ Se sim: existe sanitização do JID antes de usá-lo como nome de arquivo?
  → JID com "../" poderia criar banco em diretório arbitrário?
□ Existe allowlist de caracteres válidos para nomes de banco?
□ Limite de tamanho no nome do arquivo?
□ Criação de diretório pai sem verificação de permissões?
```

#### 3.3 Chaves Criptográficas em Memória e Disco

```
CHECKLIST:
□ privateKey, signedPreKey, identityKey são zerados da memória após uso?
□ São armazenados como Buffer ou como string hex/base64? (Buffer é melhor)
□ Estão em SQLite sem encryption at rest? (cipher extension usada?)
□ São logados em algum nível (debug/trace)?
□ Serialização JSON de chaves — expõe via toString()?
□ noiseKey, pairingEphemeralKeyPair — ciclo de vida auditado?
```

#### 3.4 Escape de Objetos e Referências Compartilhadas

```
CHECKLIST:
□ Existe retorno de referência direta a objetos internos do store?
  Exemplo: getSession() retornando o objeto sem clonar → mutação externa corrompre o store
□ Arrays do store mutados externamente via push/splice?
□ Object.assign ou spread raso em objetos com referências profundas?
□ Listeners de evento retendo referência a toda a sessão impedindo GC?
□ Circular references em objetos serialziados para SQLite?
```

---

### FASE 4 — AUDITORIA DO PROTOCOLO WHATSAPP

#### 4.1 Signal Protocol / Double Ratchet

```
CHECKLIST:
□ senderKeyDistributionMessage — reenviado após reconexão de grupo?
□ Existe rollback de session state se a mensagem falha na descriptografia?
□ Pre-keys usados são removidos do banco ANTES ou DEPOIS de confirmar entrega?
  → Remover antes: se processo morrer, pre-key perdida → sessão corrompida
  → Remover depois: se confirmação nunca chegar, pre-key fica "usada mas válida"
□ signedPreKey rotation — intervalo configurado? Chave antiga é mantida por quanto tempo?
□ Existe handler para DecryptionError que não crasha o socket?
□ retryRequest — implementado? Limite de retries configurável?
```

#### 4.2 Reconexão e Estado do Handshake Noise

```
CHECKLIST:
□ Ao reconectar, o estado do handshake Noise é resetado corretamente?
□ Existe risco de usar chave de sessão antiga após reconexão?
□ clientHello / serverHello — timeout configurado? O que acontece se não chegar?
□ keepAlive / ping — o que acontece se pong não chegar em N segundos?
□ Existe exponential backoff com jitter no reconnect? Sem ele = thundering herd.
□ maxReconnectAttempts configurado? Ou loop infinito de reconexão?
□ Durante reconexão: eventos de UI (QR code, connection.update) são emitidos corretamente?
```

#### 4.3 Group Sessions e Sender Keys

```
CHECKLIST:
□ senderKeyRecord — particionado por grupo no multi-db split?
□ Se um grupo tem 500+ membros, como o sender key distribution escala?
□ Existe proteção contra replay de sender key distribution message (mensagem antiga)?
□ Quando membro é removido do grupo: sender key é rotacionado?
□ groupSessionBuilder — thread-safe na implementação atual?
```

---

### FASE 5 — AUDITORIA DE ROBUSTEZ E OBSERVABILIDADE

#### 5.1 Graceful Shutdown

```
CHECKLIST:
□ SIGTERM / SIGINT handlers implementados?
□ No shutdown: conexões SQLite são fechadas com db.close()?
□ Mensagens em processamento são drenadas antes do shutdown?
□ Existe timeout para o graceful shutdown (para não ficar pendurado)?
□ O estado de reconnect é limpo no shutdown (não tenta reconectar ao fechar)?
```

#### 5.2 Métricas e Observabilidade

```
CHECKLIST:
□ Existem logs estruturados (JSON) ou apenas console.log?
□ Erros críticos têm stack trace completo no log?
□ Tempo de operações SQLite é medido? Queries lentas identificáveis?
□ Contador de mensagens enviadas/recebidas/perdidas?
□ Evento de health check disponível externamente?
□ Memory leaks — EventEmitter com listeners não removidos após desconexão?
```

#### 5.3 Testes e Cobertura

```
CHECKLIST:
□ Existem testes unitários para as stores SQLite?
□ Existe teste de cenário: "processo morre durante write, o que acontece?"
□ Existe teste de cenário: "dois processos abrem o mesmo .db simultaneamente?"
□ Existe teste de cenário: "mensagem recebida durante reconexão?"
□ Mocks de SQLite usados nos testes ou banco real em memória (:memory:)?
```

---

### FASE 6 — SÍNTESE E RELATÓRIO FINAL

Após completar todas as fases, produza um relatório no seguinte formato:

```markdown
# RELATÓRIO DE AUDITORIA — InfiniteAPI phase9-multi-db-sqlite-split
Data: [DATA]
Auditor: [IA MODEL]
Branch: feat/phase9-multi-db-sqlite-split

## RESUMO EXECUTIVO

| Categoria          | Crítico | Alto | Médio | Baixo | Total |
|--------------------|---------|------|-------|-------|-------|
| Concorrência/Race  |         |      |       |       |       |
| Perda de Mensagens |         |      |       |       |       |
| Erros Silenciados  |         |      |       |       |       |
| Segurança/Escape   |         |      |       |       |       |
| Protocolo WA       |         |      |       |       |       |
| Robustez           |         |      |       |       |       |
| **TOTAL**          |         |      |       |       |       |

## TOP 5 RISCOS MAIS CRÍTICOS

[Listar os 5 achados de maior impacto com: localização, descrição, impacto, correção]

## ACHADOS COMPLETOS

[Um bloco por achado, com o formato [CATEGORIA-NNN] definido acima]

## ANÁLISE DE ATOMICIDADE ENTRE BANCOS

[Diagrama ou descrição textual dos pontos onde operações multi-db precisam de coordenação]

## RECOMENDAÇÕES ARQUITETURAIS

[Máximo 5 recomendações de alto nível para melhorar a resiliência do sistema]

## ARQUIVOS NÃO AUDITADOS

[Lista de arquivos encontrados mas não analisados, com justificativa]
```

---

## REGRAS DE AUDITORIA

1. **Nunca assuma que o código está correto** — prove que está ou identifique o problema
2. **Cite linha exata** — cada achado deve ter arquivo:linha
3. **Reproduza o cenário de falha** — descreva a sequência de eventos que causa o bug
4. **Não sugira refatorações cosméticas** — foque apenas em bugs e riscos reais
5. **Se não tiver certeza, diga** — use "POTENCIAL" para achados que precisam de confirmação em runtime
6. **Priorize por impacto operacional** — uma perda de mensagem em produção vale mais que um lint warning
7. **Verifique interações entre módulos** — bugs de integração são mais perigosos que bugs isolados
8. **Leia TODO o arquivo antes de reportar** — contexto importa

---

## SEQUÊNCIA DE EXECUÇÃO RECOMENDADA

```bash
# Se usando Claude Code, execute nesta ordem:
# 1. Leia este prompt
# 2. Execute a FASE 0 (mapeamento)
# 3. Execute FASE 1 nos arquivos de store/db
# 4. Execute FASE 2 nos arquivos de socket/connection
# 5. Execute FASE 3 em todo o codebase
# 6. Execute FASE 4 nos arquivos de protocolo
# 7. Execute FASE 5 nos arquivos de infra
# 8. Produza o relatório da FASE 6

# Para acelerar, você pode paralelizar as Fases 1-5
# MAS a FASE 0 deve ser concluída antes de qualquer outra
# E a FASE 6 só começa após todas as outras
```

---

*Prompt gerado para auditoria do repositório rsalcara/InfiniteAPI branch feat/phase9-multi-db-sqlite-split*
*Versão: 1.0 — Cobertura: Concorrência · Perda de Mensagens · Silenciamento · Segurança · Protocolo WA · Robustez*
