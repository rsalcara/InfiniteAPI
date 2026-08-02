# Armazenamento e Formas de Conexão

O InfiniteAPI separa dois conceitos:

1. **armazenamento de autenticação** — onde credenciais, chaves e estados são
   persistidos;
2. **transporte** — como a sessão se apresenta e negocia a conexão.

Escolher Native Android não cria um quarto banco. Escolher multi-banco não
obriga usar Native Android.

---

## Padrão atual

Sem variáveis de ambiente, o resolvedor da biblioteca usa:

```env
INFINITEAPI_CONNECTION_PRESET=web_windows_hybrid
INFINITEAPI_AUTH_STORAGE=multi_db_sqlite
```

Ou seja: **Web Windows híbrido + SQLite multi-banco**. A identidade observada
no cliente oficial é `WEB / WIN_HYBRID / UWP`, com QR usando UWP `8` e Pair
Code usando EDGE `2`.

Esse padrão preserva compatibilidade. Native Android só é ativado
explicitamente e nunca converte uma sessão Web já registrada.

---

## 1. Backends de armazenamento

### JSON — legado multi-arquivo

```ts
const { state, saveCreds } = await useMultiFileAuthState('./sessions/main')
```

Características:

- um conjunto de arquivos JSON por sessão;
- formato histórico e fácil de inspecionar;
- adequado para compatibilidade e ambientes pequenos;
- não possui espelhos relacionais por domínio;
- exige cuidado com grande quantidade de arquivos e atomicidade do filesystem.

Configuração:

```env
INFINITEAPI_AUTH_STORAGE=multifile
```

O alias histórico `json` continua aceito.

### SQLite único — mono-banco

```ts
const { state, saveCreds, close } = await useSqliteAuthState({
	dbPath: './sessions/main/auth.db'
})
```

Características:

- credenciais e chaves em um único arquivo SQLite;
- menos arquivos e transações locais;
- mantém o mesmo contrato público de auth state;
- não cria os bancos relacionais de domínio do multi-banco.

Configuração:

```env
INFINITEAPI_AUTH_STORAGE=sqlite
```

### SQLite multi-banco

```ts
const { state, saveCreds, close, store } = await useMultiDbSqliteAuthState({
	sessionDir: './sessions/main'
})
```

Características:

- separa credenciais, Signal, mensagens e domínios;
- permite transações e consultas específicas;
- mantém `signal_kv` como fallback de compatibilidade quando aplicável;
- inclui bancos como `creds.db`, `axolotl.db`, `msgstore.db`,
  `location.db`, `stickers.db` e outros;
- é o backend padrão do resolvedor atual.

Configuração:

```env
INFINITEAPI_AUTH_STORAGE=multidb-sqlite
```

Os aliases históricos `multi_db_sqlite` e `multidb` continuam aceitos.

---

## 2. Perfis de conexão

O perfil define a identidade apresentada ao WhatsApp. O backend define somente
onde credenciais e estado são persistidos. São seletores independentes:

| Preset | Transporte | Identidade |
|---|---|---|
| `web_legacy` | Web | navegador Web genérico, histórico reduzido |
| `web_windows_hybrid` | Web | Windows Desktop, WIN_HYBRID e histórico completo |
| `native_android_consumer` | Android nativo | WhatsApp Messenger / ANDROID |
| `native_android_business` | Android nativo | WhatsApp Business / SMB_ANDROID |

Configuração preferencial:

```env
INFINITEAPI_CONNECTION_PRESET=web_windows_hybrid
```

`INFINITEAPI_TRANSPORT` e `NATIVE_ANDROID_APP_VARIANT` continuam aceitos para
compatibilidade. Se forem usados junto com um preset contraditório, a aplicação
falha com erro explícito em vez de escolher uma identidade silenciosamente.

### Web legado

```env
INFINITEAPI_CONNECTION_PRESET=web_legacy
```

Mantém o formato Web genérico e não anuncia os recursos exclusivos do Windows
híbrido. Pode usar qualquer um dos três backends.

### Web Windows híbrido — padrão

```env
INFINITEAPI_CONNECTION_PRESET=web_windows_hybrid
```

Ou diretamente:

```ts
makeWASocket({
	transportProfile: 'web',
	browser: ['Windows', 'Desktop', '10'],
	syncFullHistory: true,
	auth: state
})
```

Novas sessões usam a identidade capturada do WhatsApp Desktop. Sessões Web
existentes não são convertidas: o browser, o modo de sync e o preset escolhidos
são persistidos nas credenciais e reutilizados em cada reconexão.

No QR, o quinto campo anuncia UWP `8`. No Pair Code, a mesma sessão usa EDGE
`2` em `companion_hello`, pois o servidor rejeita UWP nesse call site. Essa
diferença é intencional e não altera o backend.

### Native Android — suportado e opt-in

```env
INFINITEAPI_CONNECTION_PRESET=native_android_business
```

O provider Node interno é carregado automaticamente. Opcionalmente, o diretório
da cadeia persistente pode ser definido:

```env
INFINITEAPI_NATIVE_ANDROID_STATE_DIR=./sessions/native-android-attestation
```

O consumidor/orquestrador deve escolher a variante antes de criar uma sessão:

```env
INFINITEAPI_CONNECTION_PRESET=native_android_business
```

ou:

```env
INFINITEAPI_CONNECTION_PRESET=native_android_consumer
```

| Variante | Aplicativo primário | Package | Client app ID |
|---|---|---|---|
| `business` | WhatsApp Business | `com.whatsapp.w4b` | `473039703209605` |
| `consumer` | WhatsApp Messenger | `com.whatsapp` | `994766073959253` |

O QR é vinculado à identidade escolhida. Um QR Business não pode ser lido pelo
Consumer e vice-versa. A API não recebe um evento confiável dizendo que o
aplicativo errado tentou ler; para trocar a variante é preciso encerrar a
tentativa não registrada e emitir um novo QR.

Native Android funciona com os três backends. O ciclo validado inclui QR,
reinício `515`, reconexão, mensagens, histórico, persistência e restart.

---

## 3. Matriz de combinações

| Perfil | Multifile | SQLite único | Multi-DB SQLite |
|---|---:|---:|---:|
| `web_legacy` | Sim | Sim | Sim |
| `web_windows_hybrid` | Sim | Sim | Sim |
| `native_android_business` | Sim | Sim | Sim |
| `native_android_consumer` | Sim | Sim | Sim |

As rotas públicas de envio e os eventos não mudam por causa dessa combinação.
Uma aplicação chama `sendMessage`, `messages.upsert`, recibos e demais APIs da
mesma forma.

O que muda:

- local e formato da persistência;
- identidade/negociação do transporte;
- recursos que o servidor permite a cada papel de dispositivo.

---

## 4. Resolver por ambiente

```ts
import { resolveInfiniteApiRuntimeProfile } from 'baileys'

const profile = resolveInfiniteApiRuntimeProfile(process.env)

console.log({
	preset: profile.connectionPreset,
	transport: profile.transportProfile,
	storage: profile.authStorage,
	browser: profile.browser,
	syncFullHistory: profile.syncFullHistory,
	appVariant: profile.nativeAndroidAppVariant
})
```

Exemplos completos:

### Compatibilidade máxima — Web + JSON

```env
INFINITEAPI_CONNECTION_PRESET=web_legacy
INFINITEAPI_AUTH_STORAGE=multifile
```

### Web + mono-banco

```env
INFINITEAPI_CONNECTION_PRESET=web_windows_hybrid
INFINITEAPI_AUTH_STORAGE=sqlite
```

### Padrão — Web + multi-banco

```env
INFINITEAPI_CONNECTION_PRESET=web_windows_hybrid
INFINITEAPI_AUTH_STORAGE=multidb-sqlite
```

### Native Android Business + multi-banco

```env
INFINITEAPI_CONNECTION_PRESET=native_android_business
INFINITEAPI_AUTH_STORAGE=multidb-sqlite
```

### Native Android Consumer + multi-banco

```env
INFINITEAPI_CONNECTION_PRESET=native_android_consumer
INFINITEAPI_AUTH_STORAGE=multidb-sqlite
```

Variáveis inválidas falham com erro de configuração acionável; não há fallback
silencioso de Native Android para Web.

---

## 5. Regras de sessão

1. Uma nova sessão escolhe preset e backend antes do QR.
2. A identidade completa é persistida.
3. Reinício ou reconexão reutiliza exatamente a identidade persistida.
4. Uma sessão Web nunca é convertida automaticamente para outro preset ou Native Android.
5. Business nunca muda silenciosamente para Consumer, nem o contrário.
6. O perfil de aparelho não é sorteado novamente enquanto a sessão existir.
7. Para mudar transporte ou variante, crie uma sessão nova.
8. Não abra o mesmo diretório de sessão em dois processos.

---

## 6. Migração e fallback

O utilitário de migração permite copiar o estado entre backends suportados, mas
a migração deve ocorrer com a sessão parada e ser validada antes de remover a
origem.

No multi-banco:

- tabelas tipadas são usadas quando a operação possui mapeamento seguro;
- `signal_kv` preserva compatibilidade, migração e fallback;
- um fallback registra o motivo específico, em vez de apenas “erro genérico”;
- falha no espelho opcional não deve bloquear o caminho crítico.

Fallback de armazenamento não significa fallback de transporte. Se o provider
Native Android estiver ausente ou inválido, a configuração falha; ela não cria
uma sessão Web com identidade diferente.

---

## 7. Como escolher

| Necessidade | Recomendação |
|---|---|
| produção conservadora | `web_windows_hybrid` + multi-DB SQLite |
| compatibilidade com instalação antiga | `web_legacy` + multifile |
| um único arquivo local | `web_windows_hybrid` + SQLite único |
| usar identidade Business nativa | Native Android Business + multi-DB |
| usar identidade Consumer nativa | Native Android Consumer + multi-DB |
| consultas relacionais de mensagens/localização | multi-DB SQLite |

Veja também:

- [NATIVE_ANDROID_TRANSPORT.md](./NATIVE_ANDROID_TRANSPORT.md)
- [NATIVE_ANDROID_NODE_ATTESTATION.md](./NATIVE_ANDROID_NODE_ATTESTATION.md)
- [LOCATION_MESSAGES.md](./LOCATION_MESSAGES.md)
- [STICKER_PACKS.md](./STICKER_PACKS.md)
- [INTERACTIVE_MESSAGES.md](./INTERACTIVE_MESSAGES.md)
- [VIEW_ONCE_MESSAGES.md](./VIEW_ONCE_MESSAGES.md)
