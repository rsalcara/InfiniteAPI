# Guia de Pacotes de Figurinhas

O InfiniteAPI suporta figurinhas individuais e mensagens completas de pacote
de figurinhas. Um pacote é processado, compactado, criptografado, enviado e
representado por `StickerPackMessage`.

---

## Visão geral

| Recurso | Suporte |
|---|---:|
| Enviar figurinha individual | Sim |
| Enviar pacote completo | Sim |
| Receber pacote | Sim |
| WebP estático | Sim |
| Lottie/WAS animado | Sim |
| JSON, SQLite único e multi-banco | Sim |
| Web e Native Android | Sim |

Regras do pacote:

- mínimo de 3 e máximo de 30 figurinhas;
- `name` e `publisher` com até 128 caracteres;
- até 3 emojis por figurinha é recomendado;
- WebP é convertido/redimensionado para 512 × 512 quando necessário;
- tamanho recomendado: 100 KB por figurinha estática e 500 KB por animada;
- capa/tray icon é processada e o thumbnail enviado em JPEG 252 × 252;
- o `packId` é gerado quando não for informado.

O processamento usa `fflate`; conversões de imagem dependem de `sharp`.

---

## 1. Enviar uma figurinha individual

O adaptador Astra expõe `POST /v1/messages/send_sticker`:

```bash
curl -X POST http://localhost:8787/v1/messages/send_sticker \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{
    "instance": "main",
    "to": "5515999999999",
    "stickerUrl": "https://example.com/sticker.webp"
  }'
```

Também é possível usar `stickerBase64` em vez de `stickerUrl`.

Na biblioteca:

```ts
await sock.sendMessage('5515999999999@s.whatsapp.net', {
	sticker: { url: 'https://example.com/sticker.webp' }
})
```

---

## 2. Enviar um pacote completo

### Biblioteca TypeScript

```ts
import { readFileSync } from 'node:fs'

const sent = await sock.sendMessage('5515999999999@s.whatsapp.net', {
	stickerPack: {
		name: 'Minha coleção',
		publisher: 'InfiniteAPI',
		description: 'Pacote de demonstração',
		cover: readFileSync('./stickers/cover.png'),
		stickers: [
			{ data: readFileSync('./stickers/01.webp'), emojis: ['😀'] },
			{ data: { url: 'https://example.com/02.webp' }, emojis: ['😎'] },
			{ data: readFileSync('./stickers/03.webp'), emojis: ['🚀'] }
		]
	}
})

console.log(sent.key.id)
```

Cada `data` e a `cover` aceitam:

- `Buffer`;
- `{ url: string | URL }`;
- `{ stream: Readable }`.

Uma figurinha pode incluir:

```ts
{
	data,
	emojis: ['😀', '🚀'],
	accessibilityLabel: 'Personagem comemorando',
	isLottie: false
}
```

### Contrato REST recomendado para um consumidor

O InfiniteAPI fornece o método de biblioteca. Se a aplicação REST ainda não
expõe uma rota de pacote, ela pode implementar, por exemplo,
`POST /v1/messages/send_sticker_pack` com este corpo:

```json
{
  "instance": "main",
  "to": "5515999999999",
  "name": "Minha coleção",
  "publisher": "InfiniteAPI",
  "description": "Pacote de demonstração",
  "coverUrl": "https://example.com/cover.png",
  "stickers": [
    {
      "url": "https://example.com/01.webp",
      "emojis": ["😀"]
    },
    {
      "url": "https://example.com/02.webp",
      "emojis": ["😎"]
    },
    {
      "base64": "UklGR...",
      "emojis": ["🚀"],
      "accessibilityLabel": "Foguete"
    }
  ]
}
```

Esse endpoint é um contrato de integração sugerido, não uma rota criada
automaticamente pela biblioteca. O adaptador deve converter URL/base64 em
`WAMediaUpload` e chamar `sock.sendMessage({ stickerPack: ... })`.

---

## 3. O que acontece no envio

O pipeline:

1. valida 3–30 itens e os campos obrigatórios;
2. converte/processa as imagens;
3. cria um ZIP com capa e figurinhas;
4. deduplica conteúdos idênticos por hash;
5. criptografa o ZIP com AES-256-CBC e HMAC-SHA256;
6. gera o thumbnail da capa;
7. envia ZIP e thumbnail com a mesma `mediaKey`;
8. monta e envia `StickerPackMessage`.

Arquivos temporários criptografados são removidos em `finally`, inclusive
quando o upload falha.

---

## 4. Receber e consumir um pacote

```ts
import { normalizeMessageContent } from 'baileys'

sock.ev.on('messages.upsert', ({ messages }) => {
	for (const item of messages) {
		const content = normalizeMessageContent(item.message)
		const pack = content?.stickerPackMessage
		if (!pack) continue

		console.log({
			messageId: item.key.id,
			name: pack.name,
			publisher: pack.publisher,
			description: pack.description,
			stickerCount: pack.stickers?.length ?? 0,
			directPath: pack.directPath
		})
	}
})
```

O objeto recebido contém metadados e referências criptografadas da mídia. Para
baixar o ZIP, use o helper de mídia com o tipo específico `sticker-pack`; não
tente montar URLs a partir de `directPath`:

```ts
import { downloadContentFromMessage } from 'baileys'

const stream = await downloadContentFromMessage(
	{
		directPath: pack.directPath,
		mediaKey: pack.mediaKey
	},
	'sticker-pack'
)
```

Para a capa enviada separadamente, use `thumbnailDirectPath`, a mesma
`mediaKey` e o tipo `thumbnail-sticker-pack`.

Não confunda:

- `stickerMessage`: uma figurinha individual;
- `stickerPackMessage`: pacote distribuível;
- `stickers.db`: catálogo/estado de figurinhas recentes e favoritas no
  multi-banco.

---

## 5. Persistência no multi-banco

Além da mensagem principal, `msgstore.db` espelha:

- `message_sticker_pack`: metadados do pacote;
- `message_sticker_pack_stickers`: itens do pacote na ordem recebida.

O espelho preserva nome, publicador, descrição, identificadores e a ordem dos
itens. JSON e SQLite único continuam recebendo/enviando normalmente, mas não
expõem essas tabelas de domínio.

Consuma os eventos da biblioteca como fonte em tempo real. Use os bancos para
consulta, auditoria e recuperação; não altere as tabelas diretamente.

---

## 6. Erros comuns

| Erro | Causa provável |
|---|---|
| menos de 3 ou mais de 30 itens | pacote fora do limite |
| imagem não processada | `sharp` ausente ou formato inválido |
| upload interrompido | rede, timeout ou media connection |
| pacote sem capa | `cover` ausente/inválida |
| animação inconsistente | mistura ou identificação incorreta de formatos |

Veja também [STORAGE_AND_TRANSPORT.md](./STORAGE_AND_TRANSPORT.md).
