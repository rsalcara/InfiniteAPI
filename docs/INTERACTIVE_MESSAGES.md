# Interactive Messages Guide

O InfiniteAPI envia mensagens interativas ricas — menus, botões, CTAs, listas,
enquetes e carrosséis. A apresentação pode variar conforme o cliente e a versão
do WhatsApp; não dependa de um layout inline específico em todos os dispositivos.

Os exemplos abaixo usam a interface REST em `POST /v1/messages/*`. Antes de
rodar:

- troque `SUA_API_KEY` pela sua chave (header `x-api-key`);
- ajuste `instance` (nome da sessão) e `to` (número no formato E.164 sem `+`).

---

## Visão geral

| # | Tipo | Endpoint | Limite |
|---|------|----------|--------|
| 1 | Menu de texto | `send_menu` | opções ilimitadas (lista numerada em texto) |
| 2 | Botões Quick Reply | `send_buttons_helpers` | **1–16** no envelope legado; **17–30** como lista |
| 3 | CTA misto (URL / Copy / Call) | `send_interactive_helpers` | tipos `url`, `copy`, `call` (combináveis) |
| 4 | Lista (dropdown) | `send_list_helpers` | até **10 seções × 3 rows = 30 rows** |
| 5 | Enquete (Poll) | `send_poll` | **2 a 12** opções |
| 6 | Apenas botões Reply | `send_buttons_helpers` | 2+ botões |
| 7 | Apenas CTAs | `send_interactive_helpers` | `url` / `call` |
| 8 | Carrossel | `send_carousel_helpers` | **2 a 10** cards (imagem por card) |

---

## 1. Menu de Texto (`send_menu`)

Mensagem de texto com as opções renderizadas como lista numerada. O usuário
responde com o número. É texto puro — funciona em qualquer cliente, sem
depender de recurso interativo.

**Campos:** `title`, `text`, `options[]`, `footer`.
**Limite:** sem limite rígido de opções (é texto).

```bash
curl -X POST http://localhost:8787/v1/messages/send_menu \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{
    "instance": "main",
    "to": "NUMERO_DE_ENVIO",
    "title": "Menu de Opções",
    "text": "Escolha uma opção:",
    "options": ["Opção 1", "Opção 2", "Opção 3"],
    "footer": "Responda com número"
  }'
```

---

## 2. Botões Quick Reply (`send_buttons_helpers`)

Botões de resposta rápida. De 1 a 16 opções, usa o `buttonsMessage` legado
validado em clientes móveis e vinculados. De 17 a 30 opções, converte o conjunto
em uma única `listMessage`, dividida em seções de até 10 itens e mantendo os IDs
de seleção.

**Campos:** `text`, `footer`, `buttons[{ id, text }]`, `headerTitle` e, para
Com `headerImage` ou `headerVideo`, até 10 opções usam `native_flow`; mídia de
cabeçalho não é aceita acima desse limite. `id` e `text` são obrigatórios e não
podem ser vazios. **Limite total:** até **30 opções**. Acima de 30, o envio é
rejeitado com erro de validação.

```bash
curl -X POST http://localhost:8787/v1/messages/send_buttons_helpers \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{
    "instance": "main",
    "to": "NUMERO_DE_ENVIO",
    "text": "👋 Olá! Como posso ajudar?",
    "footer": "Atendimento 24h",
    "buttons": [
      {"id": "vendas", "text": "🛒 Fazer Pedido"},
      {"id": "suporte", "text": "🔧 Suporte"},
      {"id": "financeiro", "text": "💰 Financeiro"},
      {"id": "comercial", "text": "🔧 Comercial"},
      {"id": "contabil", "text": "🔧 Contabil"},
      {"id": "rh", "text": "🔧 Recursos Humanos"},
      {"id": "secretaria", "text": "🔧 Secretaria"},
      {"id": "diplomas", "text": "🔧 Diplomas"},
      {"id": "diretoria", "text": "🔧 Diretoria"},
      {"id": "compliance", "text": "🔧 Compliance"},
      {"id": "juridico", "text": "🔧 Juridico"},
      {"id": "social", "text": "🔧 Ass. Social"},
      {"id": "contratos", "text": "🔧 Contratos"},
      {"id": "ti", "text": "🔧 Tecnologia da Informação"},
      {"id": "assessoria", "text": "🔧 Assessoria"},
      {"id": "voip", "text": "🔧 VOIP"}
    ]
  }'
```

---

## 3. Botões CTA Mistos — URL / Copy / Call (`send_interactive_helpers`)

Botões de ação (call-to-action). Tipos suportados, combináveis na mesma
mensagem:

- `url` — abre um link (`url`);
- `copy` — copia um código para a área de transferência (`copyCode`);
- `call` — inicia uma ligação (`phoneNumber`).

Não combine `reply` com `url`, `copy` ou `call` na mesma mensagem quando o
destinatário puder usar WhatsApp Web/Desktop. O cliente móvel aceita alguns
conjuntos heterogêneos, mas o Web atual os classifica como recurso disponível
somente no telefone. Envie replies e CTAs em mensagens separadas.

**Campos:** `text`, `footer`, `buttons[{ type, text, url | copyCode | phoneNumber }]`.

```bash
curl -X POST http://localhost:8787/v1/messages/send_interactive_helpers \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{
    "instance": "main",
    "to": "NUMERO_DE_ENVIO",
    "text": "💳 Pagamento via PIX\nValor: R$ 150,00\nPedido: #12345",
    "footer": "CTAs juntos funcionam no Web!",
    "buttons": [
      {"type": "call", "text": "Ligar Suporte", "phoneNumber": "NUMERO_PARA_LIGACAO"},
      {"type": "copy", "text": "Copiar PIX", "copyCode": "00020126580014br.gov.bcb.pix0136123e4567"},
      {"type": "url", "text": "Ver Pedido", "url": "https://infinitezap.com.br/pedido/12345"}
    ]
  }'
```

---

## 4. Lista Dropdown (`send_list_helpers`)

Um botão que abre uma lista seccionada. Ideal para catálogos/menus longos.

**Campos:** `text`, `footer`, `buttonText`, `sections[{ title, rows[{ id, title, description }] }]`.

**Limites (validados renderizando em Android, iOS e Web):**

- máximo **10 seções**;
- máximo **3 rows por seção** → **30 rows** no total;
- título da seção: **≤ 24** caracteres;
- título da row: **≤ 24** caracteres;
- descrição da row: **≤ 72** caracteres;
- `buttonText`: **≤ 20** caracteres.

```bash
curl -X POST http://localhost:8787/v1/messages/send_list_helpers \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{
    "instance": "main",
    "to": "NUMERO_DE_ENVIO",
    "text": "Cardápio completo do restaurante.\nEscolha uma categoria abaixo:",
    "footer": "Delivery grátis acima de R$ 50",
    "buttonText": "Ver Cardápio",
    "sections": [
      {
        "title": "Hambúrgueres",
        "rows": [
          {"id": "burger_1", "title": "Clássico", "description": "Pão, carne 180g, queijo, alface, tomate - R$ 28,90"},
          {"id": "burger_2", "title": "Bacon Lovers", "description": "Pão, carne 180g, bacon crocante, cheddar - R$ 34,90"},
          {"id": "burger_3", "title": "Veggie Burger", "description": "Pão, hambúrguer de grão de bico, rúcula - R$ 32,90"}
        ]
      },
      {
        "title": "Pizzas",
        "rows": [
          {"id": "pizza_1", "title": "Margherita", "description": "Molho de tomate, mussarela, manjericão - R$ 49,90"},
          {"id": "pizza_2", "title": "Pepperoni", "description": "Molho, mussarela, pepperoni fatiado - R$ 54,90"},
          {"id": "pizza_3", "title": "Quatro Queijos", "description": "Mussarela, gorgonzola, parmesão, brie - R$ 52,90"}
        ]
      },
      {
        "title": "Massas",
        "rows": [
          {"id": "massa_1", "title": "Espaguete Bolonhesa", "description": "Massa al dente com molho bolonhesa caseiro - R$ 38,90"},
          {"id": "massa_2", "title": "Fettuccine Alfredo", "description": "Fettuccine com molho branco cremoso - R$ 42,90"},
          {"id": "massa_3", "title": "Lasanha Especial", "description": "Camadas de massa, carne, presunto, queijo - R$ 45,90"}
        ]
      },
      {
        "title": "Saladas",
        "rows": [
          {"id": "salada_1", "title": "Caesar", "description": "Alface romana, croutons, parmesão, molho - R$ 32,90"},
          {"id": "salada_2", "title": "Tropical", "description": "Mix de folhas, manga, palmito, molho - R$ 29,90"},
          {"id": "salada_3", "title": "Caprese", "description": "Tomate, mussarela búfala, manjericão - R$ 34,90"}
        ]
      },
      {
        "title": "Frutos do Mar",
        "rows": [
          {"id": "mar_1", "title": "Camarão Grelhado", "description": "Camarões grelhados com manteiga e alho - R$ 62,90"},
          {"id": "mar_2", "title": "Filé de Salmão", "description": "Salmão grelhado com legumes no vapor - R$ 58,90"},
          {"id": "mar_3", "title": "Moqueca de Peixe", "description": "Peixe, leite de coco, dendê, pimentão - R$ 55,90"}
        ]
      },
      {
        "title": "Sobremesas",
        "rows": [
          {"id": "doce_1", "title": "Petit Gâteau", "description": "Bolo de chocolate com sorvete de creme - R$ 28,90"},
          {"id": "doce_2", "title": "Pudim", "description": "Pudim de leite condensado tradicional - R$ 18,90"},
          {"id": "doce_3", "title": "Açaí 500ml", "description": "Açaí com granola, banana e leite ninho - R$ 24,90"}
        ]
      },
      {
        "title": "Bebidas",
        "rows": [
          {"id": "bebida_1", "title": "Refrigerante 350ml", "description": "Coca-Cola, Guaraná, Sprite, Fanta - R$ 6,90"},
          {"id": "bebida_2", "title": "Suco Natural 500ml", "description": "Laranja, limão, maracujá, abacaxi - R$ 12,90"},
          {"id": "bebida_3", "title": "Água Mineral", "description": "Com ou sem gás 500ml - R$ 4,90"}
        ]
      },
      {
        "title": "Cervejas",
        "rows": [
          {"id": "cerveja_1", "title": "Pilsen 600ml", "description": "Brahma, Skol, Antarctica - R$ 12,90"},
          {"id": "cerveja_2", "title": "IPA 473ml", "description": "Colorado, Lagunitas, Goose Island - R$ 18,90"},
          {"id": "cerveja_3", "title": "Weiss 500ml", "description": "Erdinger, Paulaner, Blue Moon - R$ 22,90"}
        ]
      },
      {
        "title": "Vinhos",
        "rows": [
          {"id": "vinho_1", "title": "Tinto Seco", "description": "Cabernet Sauvignon, taça 150ml - R$ 25,90"},
          {"id": "vinho_2", "title": "Branco Suave", "description": "Chardonnay, taça 150ml - R$ 23,90"},
          {"id": "vinho_3", "title": "Rosé", "description": "Rosé Provence, taça 150ml - R$ 27,90"}
        ]
      },
      {
        "title": "Combos",
        "rows": [
          {"id": "combo_1", "title": "Combo Single", "description": "1 hambúrguer + batata + refri - R$ 39,90"},
          {"id": "combo_2", "title": "Combo Casal", "description": "2 hambúrgueres + batata grande + 2 refri - R$ 69,90"},
          {"id": "combo_3", "title": "Combo Família", "description": "4 hambúrgueres + 2 batatas + jarra - R$ 119,90"}
        ]
      }
    ]
  }'
```

---

## 5. Enquete / Poll (`send_poll`)

Enquete nativa do WhatsApp.

**Campos:** `name`, `options[]`, `selectableCount`.
**Limites:** **2 a 12** opções. `selectableCount` = quantas o usuário pode marcar
(`1` = escolha única; é limitado ao número de opções).

```bash
curl -X POST http://localhost:8787/v1/messages/send_poll \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{
    "instance": "main",
    "to": "NUMERO_DE_ENVIO",
    "name": "Qual sua linguagem favorita?",
    "options": ["JavaScript", "Python", "TypeScript", "Go"],
    "selectableCount": 1
  }'
```

---

## 6. Apenas Botões Reply (`send_buttons_helpers`)

Mesmo endpoint do item 2, com só alguns botões de resposta rápida.

```bash
curl -X POST http://localhost:8787/v1/messages/send_buttons_helpers \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{
    "instance": "main",
    "to": "NUMERO_DE_ENVIO",
    "text": "Confirma o pedido?",
    "footer": "Pedido #12345",
    "buttons": [
      {"id": "confirmar", "text": "Confirmar"},
      {"id": "cancelar", "text": "Cancelar"}
    ]
  }'
```

---

## 7. Apenas CTAs (`send_interactive_helpers`)

Mesmo endpoint do item 3, só com CTAs (`url` / `call`), sem quick reply.

```bash
curl -X POST http://localhost:8787/v1/messages/send_interactive_helpers \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{
    "instance": "main",
    "to": "NUMERO_DE_ENVIO",
    "text": "🏪 Loja Virtual\nConfira nossos canais:",
    "footer": "Atendimento 24h",
    "buttons": [
      {"type": "url", "text": "🌐 Site Oficial", "url": "https://www.infinitezap.com.br"},
      {"type": "url", "text": "📸 Instagram", "url": "https://instagram.com/infinitezap"},
      {"type": "call", "text": "WhatsApp Vendas", "phoneNumber": "NUMERO_PARA_LIGACAO"}
    ]
  }'
```

---

## 8. Carrossel com Imagens (`send_carousel_helpers`)

Cards roláveis com imagem, corpo e botões (quick reply e/ou CTA).

**Campos:** `text`, `footer`, `cards[{ title?, body, footer?, imageUrl, buttons[] }]`.

**Limites:** **mínimo 2, máximo 10 cards**. Cada card exige `imageUrl`. Até 2
botões por card. O protocolo suporta os 10 cards renderizando em Android, iOS e
Web.

### 8a. Até 3 cards

```bash
curl -X POST http://localhost:8787/v1/messages/send_carousel_helpers \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{
    "instance": "main",
    "to": "NUMERO_DE_ENVIO",
    "text": "🛍️ Ofertas Especiais",
    "footer": "Loja Virtual - Entrega em todo Brasil",
    "cards": [
      {
        "title": "📱 iPhone 15 Pro Max",
        "body": "256GB - Titânio Natural\n💰 R$ 9.999,00 à vista\n💳 12x R$ 833,25",
        "footer": "Frete Grátis",
        "imageUrl": "https://images.unsplash.com/photo-1592750475338-74b7b21085ab?w=400",
        "buttons": [
          {"id": "comprar_iphone", "text": "🛒 Comprar"},
          {"id": "info_iphone", "text": "📋 Detalhes"}
        ]
      },
      {
        "title": "💻 MacBook Air M3",
        "body": "8GB RAM - 256GB SSD\n💰 R$ 14.499,00 à vista",
        "footer": "Garantia 1 ano",
        "imageUrl": "https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=400",
        "buttons": [
          {"id": "comprar_macbook", "text": "🛒 Comprar"},
          {"id": "info_macbook", "text": "📋 Detalhes"}
        ]
      },
      {
        "title": "⌚ Apple Watch Series 9",
        "body": "GPS + Celular - 45mm\n💰 R$ 7.299,00 à vista",
        "footer": "Pronta Entrega",
        "imageUrl": "https://images.unsplash.com/photo-1546868871-7041f2a55e12?w=400",
        "buttons": [
          {"id": "comprar_watch", "text": "🛒 Comprar"},
          {"id": "info_watch", "text": "📋 Detalhes"}
        ]
      }
    ]
  }'
```

### 8b. Até 10 cards

```bash
curl -X POST http://localhost:8787/v1/messages/send_carousel_helpers \
  -H "Content-Type: application/json" \
  -H "x-api-key: SUA_API_KEY" \
  -d '{
    "instance": "main",
    "to": "NUMERO_DE_ENVIO",
    "text": "🛍️ Ofertas Especiais - Produtos",
    "footer": "Loja Virtual - Entrega Gratis",
    "cards": [
      {
        "body": "iPhone 15 Pro Max 256GB\nR$ 8.999,00 a vista\n12x R$ 833,25",
        "footer": "Frete Gratis",
        "imageUrl": "https://images.unsplash.com/photo-1592750475338-74b7b21085ab?w=400",
        "buttons": [{"id": "buy_1", "text": "Comprar"}, {"id": "info_1", "text": "Detalhes"}]
      },
      {
        "body": "MacBook Air M3 8GB 256GB\nR$ 12.499,00 a vista\n12x R$ 1.166,58",
        "footer": "Garantia 1 ano",
        "imageUrl": "https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=400",
        "buttons": [{"id": "buy_2", "text": "Comprar"}, {"id": "info_2", "text": "Detalhes"}]
      },
      {
        "body": "Apple Watch Series 9 45mm\nR$ 5.299,00 a vista\n12x R$ 491,58",
        "footer": "Pronta Entrega",
        "imageUrl": "https://images.unsplash.com/photo-1546868871-7041f2a55e12?w=400",
        "buttons": [{"id": "buy_3", "text": "Comprar"}, {"id": "info_3", "text": "Detalhes"}]
      },
      {
        "body": "AirPods Pro 2a Geracao\nR$ 2.499,00 a vista\n12x R$ 233,25",
        "footer": "Cancelamento de Ruido",
        "imageUrl": "https://images.unsplash.com/photo-1600294037681-c80b4cb5b434?w=400",
        "buttons": [{"id": "buy_4", "text": "Comprar"}, {"id": "info_4", "text": "Detalhes"}]
      },
      {
        "body": "iPad Pro M2 11pol 128GB\nR$ 9.999,00 a vista\n12x R$ 916,58",
        "footer": "Chip M2",
        "imageUrl": "https://images.unsplash.com/photo-1544244015-0df4b3ffc6b0?w=400",
        "buttons": [{"id": "buy_5", "text": "Comprar"}, {"id": "info_5", "text": "Detalhes"}]
      },
      {
        "body": "Samsung Galaxy S24 Ultra\nR$ 7.499,00 a vista\n12x R$ 691,58",
        "footer": "Camera 200MP",
        "imageUrl": "https://images.unsplash.com/photo-1610945265064-0e34e5519bbf?w=400",
        "buttons": [{"id": "buy_6", "text": "Comprar"}, {"id": "info_6", "text": "Detalhes"}]
      },
      {
        "body": "Sony WH-1000XM5\nR$ 2.299,00 a vista\n12x R$ 208,25",
        "footer": "Melhor ANC",
        "imageUrl": "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400",
        "buttons": [{"id": "buy_7", "text": "Comprar"}, {"id": "info_7", "text": "Detalhes"}]
      },
      {
        "body": "Nintendo Switch OLED\nR$ 2.699,00 a vista\n12x R$ 249,92",
        "footer": "Com Joy-Con",
        "imageUrl": "https://images.unsplash.com/photo-1578303512597-81e6cc155b3e?w=400",
        "buttons": [{"id": "buy_8", "text": "Comprar"}, {"id": "info_8", "text": "Detalhes"}]
      },
      {
        "body": "PlayStation 5 Slim\nR$ 4.499,00 a vista\n12x R$ 416,58",
        "footer": "1TB SSD",
        "imageUrl": "https://images.unsplash.com/photo-1606144042614-b2417e99c4e3?w=400",
        "buttons": [{"id": "buy_9", "text": "Comprar"}, {"id": "info_9", "text": "Detalhes"}]
      },
      {
        "body": "DJI Mini 4 Pro Drone\nR$ 6.999,00 a vista\n12x R$ 641,58",
        "footer": "4K 60fps",
        "imageUrl": "https://images.unsplash.com/photo-1473968512647-3e447244af8f?w=400",
        "buttons": [{"id": "buy_10", "text": "Comprar"}, {"id": "info_10", "text": "Detalhes"}]
      }
    ]
  }'
```

---

## Recebendo as respostas

Quando o usuário clica num botão, seleciona um item da lista ou vota na enquete,
a resposta chega no fluxo de eventos. Estrutura por tipo:

```typescript
sock.ev.on('messages.upsert', async ({ messages }) => {
  const msg = messages[0]

  // Botão de resposta rápida / template
  const btn = msg.message?.buttonsResponseMessage
  if (btn) {
    console.log('Botão:', btn.selectedButtonId, '-', btn.selectedDisplayText)
  }

  const tmpl = msg.message?.templateButtonReplyMessage
  if (tmpl) {
    console.log('Template:', tmpl.selectedId, '-', tmpl.selectedDisplayText)
  }

  // Item selecionado na lista
  const list = msg.message?.listResponseMessage
  if (list) {
    console.log('Lista:', list.singleSelectReply?.selectedRowId, '-', list.title)
  }

  // Clique em botão interativo (native_flow: quick reply / CTA)
  const nf = msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage
  if (nf) {
    console.log('Native flow:', nf.name, nf.paramsJson)
  }
})
```

Votos de enquete são entregues via `pollUpdateMessage` e agregados pelo
consumidor (ver `getAggregateVotesInPollMessage`).

---

## Notas de renderização

- A renderização depende da versão e do cliente. Homologue os fluxos nas
  versões de Android, iOS e WhatsApp Web/Desktop usadas pelo seu público.
- Quick replies sem mídia usam o envelope legado até 16 opções. De 17 a 30,
  usam uma lista; CTAs continuam usando `native_flow`.
- Carrossel: o protocolo suporta até **10 cards**; cada card precisa de imagem.
- Respeite os limites de caracteres da lista (título ≤ 24, descrição ≤ 72,
  `buttonText` ≤ 20) — textos maiores podem ser truncados na renderização.
