# Auditoria completa — Fase 6: Mídia, grupos/newsletter, VoIP e WAM

| Item | Valor |
|---|---|
| Alvo | `InfiniteZAP/InfiniteAPI` `develop` @ `0a97980` |
| Referência | APK `libwhatsapp_2.26.36.72` @ `921a6e9` (cópia legível `study/06_deobf`) |
| Método | Leitura completa do pipeline de mídia (`messages-media.ts`, `messages.ts`), do envio de WAM e do ciclo de conexão do `VoipClient`. Grupos e newsletter foram cobertos na Fase 2 (F2-04). `git status` vazio |
| Critério | **Reprodução 1:1 do app** |

## 1. Resumo

| # | Tipo | Achado | Onde |
|---|---|---|---|
| **F6-01** | Divergência + vazamento | A mídia **decifrada** (original) e a cifrada vão para o `tmpdir()` do sistema com permissão padrão (644). A limpeza divide um único `try` (se o primeiro `unlink` falha, o original em texto claro fica) e não há varredura após queda do processo | `messages-media.ts:41`, `:640-650`; `messages.ts:358-369` |
| **F6-02** | Qualidade | A checagem de `maxContentLength` soma o chunk duas vezes (`fileLength + data.length` depois de já somar) e recusa antes do limite; o `isLast` do upload usa o índice de `uploadInfo.hosts` num array que também contém os hosts customizados | `messages-media.ts:672-676`, `:1353` |
| **F6-03** | Divergência de comportamento | **WAM:** o motor tem `sendWAMBuffer` (`socket.ts:2236`), mas **nunca envia telemetria**. O app envia `fieldstats` continuamente | Leitura (0 chamadores) |
| **F6-04** | Robustez | O `VoipClient` instala um `process.on('uncaughtException')` durante a conexão. Enquanto ele existe, qualquer exceção não tratada **do processo inteiro** deixa de derrubar o Node | `Voip/index.ts:459-470` |

**Correto (manter):**
- cifragem de upload em streaming com backpressure;
- **download verifica o HMAC** (10 bytes) em downloads completos;
- fallback de hosts no upload;
- `media_conn` com cache por TTL e single-flight;
- `mediaretry` implementado;
- o handler do VoIP é removido de forma pontual (não usa `removeAllListeners`).

## 2. Correções 1:1

- **F6-01:**
  - usar um diretório temporário **privado** (`mkdtemp` com `0o700`, dentro do diretório da sessão);
  - gravar com `0o600`;
  - fazer `unlink` independente para cada arquivo;
  - varrer órfãos na inicialização.

  No app, a mídia fica no sandbox privado (equivalente a 0700/0600).
- **F6-02:** comparar `fileLength > max` depois de somar o chunk; calcular `isLast` pelo índice no próprio array `hosts`.
- **F6-03:** reproduzir o WAM 1:1 significa enviar os mesmos eventos que o app envia. Muitos deles descrevem ações de interface que não existem no motor, e emiti-los seria **fabricar sinal**, o que a restrição permanente do projeto proíbe. **Decisão do dono do projeto** (ver `ESPECIFICACAO_1A1_MOTOR.md`, seção 0).
- **F6-04:** remover o handler global e tratar o 515 só pelo `connection.update`, que já existe logo abaixo (`:471-495`).
