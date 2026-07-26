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
INFINITEAPI_TRANSPORT=web
INFINITEAPI_AUTH_STORAGE=multi_db_sqlite
```

Ou seja: **Web + SQLite multi-banco**.

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
INFINITEAPI_AUTH_STORAGE=json
```

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
INFINITEAPI_AUTH_STORAGE=multi_db_sqlite
```

---

## 2. Transportes

### Web — padrão estável

```env
INFINITEAPI_TRANSPORT=web
```

Ou diretamente:

```ts
makeWASocket({
	transportProfile: 'web',
	auth: state
})
```

É o comportamento histórico, estável e o fallback de produção. Funciona com
JSON, SQLite único e multi-banco.

### Native Android — opt-in experimental

```env
INFINITEAPI_TRANSPORT=native_android
INFINITEAPI_ANDROID_PROVIDER_URL=http://android-provider-bridge:8788
```

Também podem ser usados:

```env
INFINITEAPI_ANDROID_PROVIDER_TOKEN=TOKEN_INTERNO
INFINITEAPI_ANDROID_PROVIDER_PACKAGE=com.whatsapp.w4b
```

O consumidor/orquestrador deve escolher a variante antes de criar uma sessão:

```env
NATIVE_ANDROID_APP_VARIANT=business
```

ou:

```env
NATIVE_ANDROID_APP_VARIANT=consumer
```

| Variante | Aplicativo primário | Package | Client app ID |
|---|---|---|---|
| `business` | WhatsApp Business | `com.whatsapp.w4b` | `473039703209605` |
| `consumer` | WhatsApp Messenger | `com.whatsapp` | `994766073959253` |

O QR é vinculado à identidade escolhida. Um QR Business não pode ser lido pelo
Consumer e vice-versa. A API não recebe um evento confiável dizendo que o
aplicativo errado tentou ler; para trocar a variante é preciso encerrar a
tentativa não registrada e emitir um novo QR.

Native Android funciona com os três backends, mas permanece experimental até
passar todo o ciclo de QR, reinício `515`, reconexão, mensagens, histórico e
restart em produção.

---

## 3. Matriz de combinações

| Transporte | JSON | SQLite único | Multi-DB SQLite |
|---|---:|---:|---:|
| Web | Sim | Sim | Sim |
| Native Android Business | Sim | Sim | Sim |
| Native Android Consumer | Sim | Sim | Sim |

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
	transport: profile.transportProfile,
	storage: profile.authStorage
})
```

Exemplos completos:

### Compatibilidade máxima — Web + JSON

```env
INFINITEAPI_TRANSPORT=web
INFINITEAPI_AUTH_STORAGE=json
```

### Web + mono-banco

```env
INFINITEAPI_TRANSPORT=web
INFINITEAPI_AUTH_STORAGE=sqlite
```

### Padrão — Web + multi-banco

```env
INFINITEAPI_TRANSPORT=web
INFINITEAPI_AUTH_STORAGE=multi_db_sqlite
```

### Native Android Business + multi-banco

```env
INFINITEAPI_TRANSPORT=native_android
INFINITEAPI_AUTH_STORAGE=multi_db_sqlite
NATIVE_ANDROID_APP_VARIANT=business
INFINITEAPI_ANDROID_PROVIDER_URL=http://android-provider-bridge:8788
INFINITEAPI_ANDROID_PROVIDER_PACKAGE=com.whatsapp.w4b
```

### Native Android Consumer + multi-banco

```env
INFINITEAPI_TRANSPORT=native_android
INFINITEAPI_AUTH_STORAGE=multi_db_sqlite
NATIVE_ANDROID_APP_VARIANT=consumer
INFINITEAPI_ANDROID_PROVIDER_URL=http://android-provider-bridge:8788
INFINITEAPI_ANDROID_PROVIDER_PACKAGE=com.whatsapp
```

Variáveis inválidas falham com erro de configuração acionável; não há fallback
silencioso de Native Android para Web.

---

## 5. Regras de sessão

1. Uma nova sessão escolhe transporte, variante e backend antes do QR.
2. A identidade completa é persistida.
3. Reinício ou reconexão reutiliza exatamente a identidade persistida.
4. Uma sessão Web nunca é convertida automaticamente para Native Android.
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
| produção conservadora | Web + multi-DB SQLite |
| compatibilidade com instalação antiga | Web + JSON |
| um único arquivo local | Web + SQLite único |
| testar identidade Business nativa | Native Android Business + multi-DB |
| testar identidade Consumer nativa | Native Android Consumer + multi-DB |
| consultas relacionais de mensagens/localização | multi-DB SQLite |

Veja também:

- [NATIVE_ANDROID_TRANSPORT.md](./NATIVE_ANDROID_TRANSPORT.md)
- [LOCATION_MESSAGES.md](./LOCATION_MESSAGES.md)
- [STICKER_PACKS.md](./STICKER_PACKS.md)
- [INTERACTIVE_MESSAGES.md](./INTERACTIVE_MESSAGES.md)
