# Paridade 1:1 — Fluxo de registro/ativação por número (W4B 2.26.36.72 ↔ wizard "Nova Instância")

**Data:** 2026-10-08 · **Escopo:** telas/modais do app oficial de registro de número e o
segundo modo de ativação do wizard (além do QR). Repositório privado de auditoria —
código decompilado do WhatsApp Business 2.26.36.72, propriedade da Meta, não redistribuir.

**Linha de base:** `com.whatsapp.registration.app` (RegisterName, verifyphone/*) e
`com.whatsapp.registration.core.http.KotlinRegistrationBridge` do W4B 2.26.36.72.

---

## 1. Sequência oficial mapeada (do primeiro toque até o app abrir)

| # | Tela/modal oficial (classe / recurso) | Contraparte no wizard | Status |
|---|---|---|---|
| 1 | Entrada de número (país + telefone) | `reg-screen` telefone (país, DDD+numero, "Avançar") | 1:1 |
| 2 | Diálogo "O número está certo?" (Sim/Editar) | diálogo `confirm` (Sim/Editar) | 1:1 |
| 3 | Código de 6 dígitos + reenvio com prazo + "Ligar para meu telefone" | `reg-code-screen` (6 caixas, `Reenviar código (mm:ss)`, voz) | 1:1 |
| 4 | Tela/banner "não enviado (recente)" — cópia 0x7f12193f/0x7f121941 | banner `reg-blocked` na tela de código + "Número errado?" | 1:1 |
| 5 | Bottom sheet "Não recebeu um código?" → "Choose how to verify" (`RequestServerDrivenOtpCodeBottomSheetFragment`, layout 0x7f0e1568) | sheet `reg-sheet` "Escolha como verificar" guiado pelo servidor | 1:1 |
| 6 | RegisterName (nome 25 chars + foto) | `reg-name-screen` (input 25 + contador + foto) | 1:1 |
| 7 | `RegPermissionsExplainerActivity` (contatos + mídia) | `reg-perms-screen` (Contatos/Fotos/Notificações) | 1:1 |
| 8 | NotifyContactsSelector ("Diga aos seus contatos...") | `reg-notify-screen` (Avisar/Não avisar) | 1:1 **fail-closed** |
| 9 | Upsells condicionais pós-nome (codes 23 backup-token, 21 passkey, 22/14 email) | não renderizados — recursos da conta Meta, sem API pública equivalente | documentado |
| 10 | "CONNECTING" → app abre (main) | `reg-success` → `POST /profile` → connect do canal | 1:1 |

O APK só abre o WhatsApp depois de nome + permissões + escolha de notificação; o wizard
espelha isso com `deferConnect` no verify: o canal é criado registrado, mas o `connect`
só dispara no fim (`POST /:registrationId/profile`) — exatamente a ordem do app.

## 2. Cópias oficiais usadas (strings do APK)

- **too_recent (SMS):** `Can't send an SMS with your code because you've tried to register
  <b>%s</b> recently. Request a call or wait before requesting an SMS.` (0x7f12193f)
  → PT-BR: "Não foi possível enviar um SMS com seu código porque você tentou registrar
  **{numero}** recentemente. Peça uma ligação ou aguarde antes de pedir um SMS."
- **too_recent (voz):** `You've tried to register <b>%s</b> recently. Wait before
  requesting an SMS or a call with your code.` (0x7f121941)
- Variante 0x7f12533e/5343 traz `Wrong number?` (`edit-number`) → nosso link
  **"Número errado?"** volta à tela de telefone.
- **Sheet:** `Choose how to verify` (0x7f121f35) → "Escolha como verificar";
  `Didn't receive code?` (0x7f121910) → "Não recebeu um código?";
  opções: "Receive new SMS"→"Receber novo SMS", "Missed call"→"Ligação perdida",
  "Voice call"→"Ligação de voz", "Get code via email", "Use your finger, face or screen
  lock"→"Chave de acesso", "Mobile network provider"→"Operadora móvel", countdown
  "Try again in %s"→"Tente novamente em %s", botão `Continue`→"Continuar".
- **Observação de auditoria:** o texto pt-BR do registro NÃO vem no APK (language pack
  OTA). As traduções acima seguem a cópia EN do APK e as telas reais que você capturou.

## 3. Bottom sheet "Escolha como verificar" — contrato server-driven

O app NÃO tem lista fixa: a lista vem do `/v2/code`:

- `fallback_methods[]` — ex.: `["passkey","password","wa_old","email_otp","flash","sms","voice"]`
  (captura real de 2026-10-08 no 1541417008); default no app quando vazio: `["sms"]`.
- `recommended_method[]` — reordena/destaca as opções.
- Prazos absolutos por método (`EXTRA_SMS_RETRY_TIME`, `EXTRA_VOICE_RETRY_TIME`, …) —
  o app converte em "Tente novamente em %s"; usamos `sms_wait`/`voice_wait`/`flash_wait`
  da resposta com a mesma semântica (-1 = nunca, 0 = agora).
- Visibilidade: `pref_num_visible_dbs_methods` (default 3) → mostramos 3 + "Ver todos".
- Resultado da seleção: método escolhido ou `RESTART_REG` (voltar ao início).

**Fronteira de paridade documentada:** o motor hoje despacha `sms | voice`
(`NativeAndroidRequestCodeInput.method`). Os demais métodos aparecem no sheet com prazo e
descrição (1:1 visual), mas ao "Continuar" mostramos "Método indisponível" — nunca
fingimos um dispatch que o motor não executa.

## 4. Nome da conta (RegisterName) → `pushName`

No APK o nome é salvo **depois** do `/v2/register` e sai no `ClientPayload.pushName` do
login Noise. Implementado igual: `verify` semeia as creds (opcional `profileName`),
`POST /profile` grava `creds.me.name` e só então o `connect` é enfileirado.
Limite 25 chars = `InputFilter C1842186z(25)` do APK. Foto de perfil fica local na UI
(perfil só existe depois do login); emoji/checkmark blacklist do APK não replica ainda.

## 5. Permissões e avisar contatos

- Permissões: espelho do `RegPermissionsExplainerActivity` (contatos + mídia + notificações)
  com "Continuar"/"Agora não" — no web as permissões reais são do navegador/OS.
- **Avisar contatos é fail-closed pela regra de auditoria:** a tela existe por paridade,
  o default é "Não avisar", e mesmo escolhendo "Avisar" a API **apenas registra** a
  escolha (log) — **nenhuma mensagem é enviada a contatos** (cold outbound proibido).

## 6. Respostas reais do servidor já exercitadas (smoke 2026-10-08)

- `no_routes` (fixo + SMS): reason `no_routes`, `fallbackMethods` completos,
  `recommendedMethod`, `retryAfter` — wizard despacha `voice` direto para fixo
  (BR 8 dígitos começando 2–5) e a ação "Ligar para meu telefone".
- `too_recent` real no 1541417008: HTTP 422 `registration_too_recent`,
  `retryAfter: "277"`, `fallbackMethods: ["passkey","password","wa_old","email_otp",
  "flash","sms","voice"]` — alimenta o banner + o sheet (prazo contando ao vivo).
- Smoke de rotas: `POST /v1/instance-registrations` 201; `POST /:id/profile` antes do
  verify → 409 `registration_not_pending_profile` (proteção de ordem); typecheck limpo
  (api/worker/dashboard).

## 7. Pergunta: "dá para fazer tudo via Xiaomi sem bridge?"

Resposta curta: **para a ativação por número, sim** — o modo `relay` do motor faz o
Connector APK (o "APK do Xiaomi") assinar os desafios de atestação com o Keystore do
próprio aparelho ("signed-plaintext", igual à captura real que o servidor aceitou).
A bridge frida dentro do W4B oficial era ferramenta de laboratório para estudar/provar o
protocolo e capturar os campos `gpia/_gs` — não faz parte do caminho de produção.

Ressalva: a identidade de conta pós-login (ADV/device-identity) ainda é a lacuna real;
o teste de longo prazo decide. Se precisar evoluir: root + bridge in-device, ou
reimplementar o `wamsys-wrap` dentro do Connector (dias de trabalho).

## 8. Arquivos alterados (platform main — commit `8e842a6`)

- `apps/worker/src/phone-registration.ts` — `name` no verify + `setPhoneRegistrationProfileName`
- `apps/api/src/session-engine.ts` — tipo do novo método
- `apps/api/src/routes/instance-registration.ts` — `profileName`/`deferConnect` + `POST /:id/profile`
- `apps/dashboard/src/api.ts` — client + `retryAfter/fallbackMethods/recommendedMethod` no erro
- `apps/dashboard/src/InstanceRegistration.tsx` + `src/styles.css` — telas novas

Sem mudança no motor Baileys (PR #8): o nome via `creds.me.name` é gravado pelo worker,
logo nenhum commit novo na PR é necessário nesta rodada.
