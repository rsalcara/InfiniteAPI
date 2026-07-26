# Guia de Localização

O InfiniteAPI suporta localização estática e implementa o ciclo de localização
ao vivo: geração do payload, sequência, distribuição da chave
`location@broadcast`, recepção, atualizações e persistência.

Os exemplos REST usam o adaptador Astra em `POST /v1/messages/*`. Troque
`SUA_API_KEY`, `instance` e `to` conforme o ambiente. O número deve estar em
E.164, sem `+`.

---

## Compatibilidade

| Recurso | Web | Native Android Business | Native Android Consumer |
|---|---:|---:|---:|
| Enviar localização estática | Sim | Sim | Sim |
| Receber localização estática | Sim | Sim | Sim |
| Receber/sincronizar localização ao vivo | Sim | Sim | Sim |
| Persistir localização ao vivo | Sim | Sim | Sim |
| Iniciar localização ao vivo como dispositivo vinculado | Limitado pelo WhatsApp | Limitado pelo WhatsApp | Limitado pelo WhatsApp |

O transporte e o armazenamento são independentes. As mensagens funcionam com:

- arquivos JSON (`useMultiFileAuthState`);
- SQLite único (`useSqliteAuthState`);
- SQLite multi-banco (`useMultiDbSqliteAuthState`).

No multi-banco também existem espelhos relacionais próprios em `msgstore.db` e
`location.db`.

---

## 1. Enviar localização estática

### REST

Endpoint: `POST /v1/messages/send_location`

```bash
curl -X POST http://localhost:8787/v1/messages/send_location \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{
    "instance": "main",
    "to": "5515999999999",
    "latitude": -23.55052,
    "longitude": -46.633308,
    "name": "Praça da Sé",
    "address": "Praça da Sé, São Paulo - SP",
    "url": "https://maps.google.com/?q=-23.55052,-46.633308"
  }'
```

Campos obrigatórios:

| Campo | Tipo | Regra |
|---|---|---|
| `instance` | string | sessão conectada |
| `to` | string | número E.164 sem `+` |
| `latitude` | number | `-90` a `90` |
| `longitude` | number | `-180` a `180` |

Campos opcionais: `name`, `address`, `url` e `jpegThumbnailBase64`.

### Biblioteca TypeScript

```ts
const sent = await sock.sendMessage('5515999999999@s.whatsapp.net', {
	location: {
		degreesLatitude: -23.55052,
		degreesLongitude: -46.633308,
		name: 'Praça da Sé',
		address: 'Praça da Sé, São Paulo - SP',
		url: 'https://maps.google.com/?q=-23.55052,-46.633308'
	}
})

console.log(sent.key.id)
```

---

## 2. Localização ao vivo

### Estado da implementação

O código está implementado e preservado:

- `LiveLocationMessage` com sequência monotônica em microssegundos;
- períodos oficiais de 15 minutos, 1 hora e 8 horas;
- comentário e miniatura;
- estado fast-ratchet persistente;
- distribuição de chave para `location@broadcast`;
- recepção, atualizações, encerramento e histórico;
- espelhos `from_me=0` e `from_me=1` no multi-banco.

Entretanto, o WhatsApp oficial restringe o início do compartilhamento ao
**telefone principal**. O próprio aplicativo Android, quando atua como
dispositivo vinculado, informa que o recurso não está disponível naquele
aparelho e orienta o usuário a iniciá-lo no telefone principal.

Isso continua verdadeiro quando o InfiniteAPI usa `native_android`: o perfil de
transporte não transforma o processo em telefone principal. Uma resposta local
com `messageId` prova que o payload foi montado/enfileirado; não prova que o
servidor o entregou ao destinatário.

Portanto:

- receber, sincronizar, atualizar e armazenar localização ao vivo é suportado;
- iniciar pelo socket vinculado deve ser tratado como experimental;
- para produção, use localização estática enquanto essa regra existir no
  servidor.

### REST experimental

Endpoint: `POST /v1/messages/send_live_location`

```bash
curl -X POST http://localhost:8787/v1/messages/send_live_location \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{
    "instance": "main",
    "to": "5515999999999",
    "latitude": -23.55052,
    "longitude": -46.633308,
    "durationSecs": 900,
    "accuracyInMeters": 8,
    "speedInMps": 0,
    "degreesClockwiseFromMagneticNorth": 0,
    "comment": "Acompanhe meu trajeto"
  }'
```

`durationSecs` aceita somente:

- `900` — 15 minutos;
- `3600` — 1 hora;
- `28800` — 8 horas.

### Biblioteca TypeScript

```ts
const sent = await sock.sendLiveLocation('5515999999999@s.whatsapp.net', {
	degreesLatitude: -23.55052,
	degreesLongitude: -46.633308,
	durationSecs: 900,
	accuracyInMeters: 8,
	speedInMps: 0,
	degreesClockwiseFromMagneticNorth: 0,
	comment: 'Acompanhe meu trajeto'
})
```

Esse método permanece exposto para compatibilidade, investigação e eventual
liberação futura do servidor. Não use apenas o retorno dessa chamada como
confirmação de entrega.

---

## 3. Receber localizações

As localizações chegam pelo evento normal de mensagens:

```ts
sock.ev.on('messages.upsert', ({ messages }) => {
	for (const item of messages) {
		const content = item.message
		if (!content) continue

		if (content.locationMessage) {
			console.log('localização estática', content.locationMessage)
		}

		if (content.liveLocationMessage) {
			console.log('localização ao vivo', {
				key: item.key,
				duration: item.duration,
				location: content.liveLocationMessage
			})
		}
	}
})
```

Aplicações que recebem wrappers como `ephemeralMessage` ou `viewOnceMessage`
devem usar `normalizeMessageContent(item.message)` antes de verificar os
campos.

Para consultar o último estado espelhado no multi-banco:

```ts
const current = sock.getLiveLocation('5515999999999@s.whatsapp.net')
```

Quando o backend não está disponível ou a leitura falha, o método retorna o
fallback legado e registra o motivo específico no log.

---

## 4. Persistência

| Backend | Persistência funcional | Espelho relacional de localização |
|---|---|---|
| JSON | credenciais e chaves em arquivos JSON | não |
| SQLite único | credenciais e chaves em um arquivo SQLite | não |
| Multi-DB SQLite | credenciais, chaves e bancos de domínio | sim |

No multi-banco:

- `msgstore.db.message` registra a mensagem;
- `msgstore.db.message_location` registra latitude, longitude e estado final;
- `location.db.location_cache` mantém a última posição conhecida;
- `location.db.location_sharer` mantém compartilhamentos, direção, recurso,
  mensagem e expiração;
- o estado `fast-ratchet-sender-key` fica no armazenamento de autenticação e
  sobrevive a reinício/reconexão.

Os bancos são espelhos internos. Para integrações em tempo real, prefira
`messages.upsert`; não escreva diretamente nas tabelas.

---

## 5. Checklist operacional

1. Valide latitude e longitude antes do envio.
2. Use localização estática quando precisar de entrega suportada.
3. Não interprete `ok: true` da rota ao vivo como recibo do destinatário.
4. Monitore `messages.update`/recibos para confirmar entrega.
5. Não troque o backend ou o transporte silenciosamente numa sessão existente.
6. Feche corretamente o auth state para garantir o flush dos espelhos.

Veja também:

- [STORAGE_AND_TRANSPORT.md](./STORAGE_AND_TRANSPORT.md)
- [NATIVE_ANDROID_TRANSPORT.md](./NATIVE_ANDROID_TRANSPORT.md)
