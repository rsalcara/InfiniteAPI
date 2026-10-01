# Auditoria 1:1 — InfiniteAPI × app WhatsApp 2.26.36.72

Auditoria completa do motor, do início ao fim de cada processo, comparada com o app oficial (APK 2.26.36.72, material de estudo privado em `InfiniteZAP/libwhatsapp_2.26.36.72` @ `921a6e9`).

**Rastreabilidade das citações do app.** Os caminhos `X/Arquivo.java:linha` vêm da cópia legível `study/06_deobf`, que **não está no commit `921a6e9`**: fica na branch `deobf-evidence` (`93c8486` e `3689810`) do mesmo repositório privado. A cópia só troca nomes (classes e membros identificados por evidência) e **preserva a numeração de linhas**. Para conferir sem a branch, abra o mesmo arquivo em `study/02_jadx/sources/X/` do `921a6e9`, na mesma linha; o nome da classe ali é o ofuscado.

**Critério:** o InfiniteAPI reproduz **exatamente** o que o aplicativo faz. Toda correção fica no motor; nada fabrica token, sinal ou material de atestação.

## Documentos

| Arquivo | Conteúdo |
|---|---|
| [`PLANO_DE_ACAO_PRS.md`](PLANO_DE_ACAO_PRS.md) | **Plano de ação:** 30 PRs em 7 ondas, com proteção dos interativos |
| [`ESPECIFICACAO_1A1_MOTOR.md`](ESPECIFICACAO_1A1_MOTOR.md) | Requisitos 1:1 (S/R/E/C/G/N/W/M) com regra do app, estado atual, mudança e teste de aceite |
| [`MATRIZ_CONFORMIDADE_1A1.md`](MATRIZ_CONFORMIDADE_1A1.md) | Cruzamento por stanza: recibos, notificações, `ib`, IQs, WAM e `message_type` |
| [`01-FASE1-RECEBIMENTO.md`](01-FASE1-RECEBIMENTO.md) | Pipeline de recebimento |
| [`02-FASE2-ENVIO.md`](02-FASE2-ENVIO.md) | Pipeline de envio e reenvio |
| [`02b-PARIDADE-APK-F1-F2.md`](02b-PARIDADE-APK-F1-F2.md) | Fases 1 e 2 refeitas contra o código do app |
| [`03-FASE3-CONEXAO.md`](03-FASE3-CONEXAO.md) | Conexão, keepalive, reconexão, vazamentos |
| [`04-FASE4-PERSISTENCIA.md`](04-FASE4-PERSISTENCIA.md) | Persistência, SQLite, WAL, travas |
| [`05-FASE5-SEGURANCA-DADOS.md`](05-FASE5-SEGURANCA-DADOS.md) | Logs, PII, dados em repouso |
| [`06-FASE6-RESTANTE.md`](06-FASE6-RESTANTE.md) | Mídia, VoIP, grupos, WAM |

## Testes que acompanham a auditoria (PR-00)

**`src/__tests__/Socket/messages-send.stanza-assembly.test.ts`: golden das stanzas de envio** (160 entradas em `__fixtures__/send-stanzas.golden.json`).

- **O que é:** snapshot estrutural completo da stanza que `relayMessage` entrega ao socket, mais os bytes do encoder binário. Registra o comportamento **de hoje**, que é o que precisa ser protegido. Não afirma conformidade com o app.
- **O que é comparado:**
  - tag, atributos **na ordem de escrita** e filhos (`participants`, `enc`, `device-identity`, `biz`, `bot`, `quality_control`, `reporting`);
  - bytes de `encodeBinaryNode` de cada stanza;
  - payload decifrado de cada cifragem, incluindo o DSM.
- **Mascarados** (trocados por um marcador fixo antes da comparação e da codificação): só valores aleatórios, ou seja, `decision_id` e segredos. O ciphertext do teste é determinístico.
- **Tipos (32):**
  - botões legados, lista `SINGLE_SELECT`, lista `PRODUCT_LIST`, template;
  - native flow: `quick_reply`, `cta_url`, `cta_copy`, `cta_call`, misto, `single_select`, `otp`, `review_and_pay`, `payment_info`, `review_order`, `mpm`, `catalog_message`, `single_product`, `product_list`;
  - interativo simples, carrossel e carrossel em `viewOnceMessageV2`;
  - texto, resposta citada, imagem, vídeo, áudio PTT, documento, figurinha, localização, contato, enquete v3 e reação.
- **Rotas (5), para todos os tipos:** 1:1 PN, 1:1 LID, grupo, reenvio a dispositivo remoto e reenvio ao próprio dispositivo (DSM).
- **Fora do escopo (PR-00b):**
  - geração no `sendMessage`: upload de mídia e `messageSecret` (a enquete do golden vai sem segredo por causa do F2-10);
  - edição e revogação;
  - status/broadcast e newsletter;
  - evento, álbum, figurinha lottie e mídia view once.
- **Guarda de PII:** toda entrada, ao comparar e ao gravar, só pode conter as identidades sintéticas e os timestamps fixos da suíte. Reprova o teste, inclusive com `UPDATE_GOLDEN=1`, qualquer sequência de 10 ou mais dígitos fora dessa lista e qualquer usuário de JID com 5 ou mais dígitos fora dela, o que cobre números nacionais curtos. Isso vale para JID, telefone com ou sem `+` e números dentro de JSON como `buttonParamsJson`; os payloads em base64 e os bytes do encoder ficam de fora.
- **Sem entradas órfãs:** o fixture tem exatamente uma entrada por tipo e rota. Ao regravar, as entradas de casos removidos são descartadas.
- **Regravar** exige `UPDATE_GOLDEN=1` e justificativa por entrada no diff da PR.

**Regressões da auditoria** em `src/__tests__/Socket/audit-1a1-regressions.test.ts`, `src/__tests__/Utils/audit-1a1-regressions.test.ts` e no arquivo de stanza.

Cada defeito comprovado é um `it.failing`, verificado rodando-o como `it`: falha pela asserção esperada. A PR que corrige troca para `it`. Se o defeito sumir sem essa troca, o CI fica vermelho.

| Teste | O que prova hoje | Requisito | PR |
|---|---|---|---|
| Recibo só após o commit | `MessageStoreBackend.recordMessage` (transação do `msgstore.db`) termina **depois** do frame do recibo, medido num relógio único | R-01 | PR-14 |
| Ao vivo não ultrapassa o backlog offline | A mensagem ao vivo entra antes de 50 offline do mesmo chat | R-03 | PR-15 |
| LID↔PN da stanza sem USync | O par do `sender_pn` **já é persistido**; o defeito é o IQ `usync` extra | R-02 | PR-05 |
| Resposta ao ping do servidor | 0 respostas | C-03 | PR-08 |
| Sem timer zumbi após reconexão rápida | Timers acumulam em 8 ciclos | C-01 | PR-01 |
| Diretórios 0700 / arquivos 0600 | 755/644 | S-01 | PR-02 |
| Status de recibo igual ao app | 5 dos 7 tipos divergem do `ReceiptStanzaHelper.A00`: `sender` 4 (app 5), `read-self` 13 (app 17); `delivery`, `inactive` e `played-self` sem status (app 5, 15, 18) | R-09 | PR-06 |
| Sem telefone no console por padrão | PN completo impresso | G-01 | Descartado (decisão do operador: logs mantidos) |
| FIFO de interativos no mesmo destino | Ordem `4, 5, 1, 2, 3` (F2-09) | E-01 | PR-20 |
| Destino lento não segura outro destino | O envio ao grupo espera o 1:1 travado (trava global); sem a trava de produção o teste passa | E-01 | PR-20 |
| `reporting_token` igual em todo envio da mesma mensagem | 64 envios → 4 resultados (sem token, correto e 2 errados) (F2-10) | E-14 | PR-29 |

Controles que passam hoje, para impedir regressão: texto em FIFO no mesmo destino, interativos simultâneos idênticos entre si e os status de recibo que já batem (sem tipo, `read`, `played`).
