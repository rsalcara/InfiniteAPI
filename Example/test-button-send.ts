import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import makeWASocket, {
  CacheStore,
  DEFAULT_CONNECTION_CONFIG,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  WAMessageContent,
  WAMessageKey
} from '../src'
import P from 'pino'

// Configuração
const AUTH_FOLDER = process.env.AUTH_FOLDER || 'baileys_auth_info'
const DEST_NUMBER = process.env.DEST_NUMBER || '5515991426667' // Número destino

const logger = P({
  level: 'debug',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
})

const msgRetryCounterCache = new NodeCache() as CacheStore

const startSock = async () => {
  console.log('='.repeat(60))
  console.log('TESTE DE ENVIO DE BOTÕES WHATSAPP')
  console.log('='.repeat(60))
  console.log(`Pasta de autenticação: ${AUTH_FOLDER}`)
  console.log(`Número destino: ${DEST_NUMBER}`)
  console.log('='.repeat(60))

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)
  const { version, isLatest } = await fetchLatestBaileysVersion()

  console.log(`Versão WA Web: ${version.join('.')} (latest: ${isLatest})`)

  const sock = makeWASocket({
    version,
    logger,
    waWebSocketUrl: process.env.SOCKET_URL ?? DEFAULT_CONNECTION_CONFIG.waWebSocketUrl,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
    getMessage,
  })

  sock.ev.process(async (events) => {
    if (events['connection.update']) {
      const update = events['connection.update']
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        console.log('\n📱 QR Code gerado! Escaneie com o WhatsApp:')
        console.log('Use --use-pairing-code para usar código de pareamento')
      }

      if (connection === 'open') {
        console.log('\n✅ Conectado com sucesso!')
        console.log(`📞 Número conectado: ${sock.user?.id}`)

        // Aguarda 2 segundos para estabilizar
        await new Promise(r => setTimeout(r, 2000))

        // Envia a mensagem com botões
        await sendButtonMessage(sock)
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
        console.log('Conexão fechada:', lastDisconnect?.error)
        if (shouldReconnect) {
          console.log('Reconectando...')
          startSock()
        } else {
          console.log('❌ Logout detectado. Execute novamente para escanear QR Code.')
          process.exit(1)
        }
      }
    }

    if (events['creds.update']) {
      await saveCreds()
    }

    // Escuta respostas de botões
    if (events['messages.upsert']) {
      const { messages, type } = events['messages.upsert']

      for (const msg of messages) {
        // Resposta de botão simples
        if (msg.message?.buttonsResponseMessage) {
          const buttonId = msg.message.buttonsResponseMessage.selectedButtonId
          const displayText = msg.message.buttonsResponseMessage.selectedDisplayText
          console.log(`\n🔘 RESPOSTA DE BOTÃO RECEBIDA!`)
          console.log(`   ID: ${buttonId}`)
          console.log(`   Texto: ${displayText}`)
        }

        // Resposta de lista
        if (msg.message?.listResponseMessage) {
          const rowId = msg.message.listResponseMessage.singleSelectReply?.selectedRowId
          const title = msg.message.listResponseMessage.title
          console.log(`\n📋 RESPOSTA DE LISTA RECEBIDA!`)
          console.log(`   ID: ${rowId}`)
          console.log(`   Título: ${title}`)
        }

        // Resposta de template button
        if (msg.message?.templateButtonReplyMessage) {
          const selectedId = msg.message.templateButtonReplyMessage.selectedId
          const selectedText = msg.message.templateButtonReplyMessage.selectedDisplayText
          console.log(`\n🎯 RESPOSTA DE TEMPLATE BUTTON RECEBIDA!`)
          console.log(`   ID: ${selectedId}`)
          console.log(`   Texto: ${selectedText}`)
        }
      }
    }
  })

  return sock

  async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
    return proto.Message.create({ conversation: 'test' })
  }
}

async function sendButtonMessage(sock: ReturnType<typeof makeWASocket>) {
  const jid = DEST_NUMBER.includes('@s.whatsapp.net')
    ? DEST_NUMBER
    : `${DEST_NUMBER}@s.whatsapp.net`

  console.log('\n' + '='.repeat(60))
  console.log('ENVIANDO MENSAGENS DE TESTE')
  console.log('='.repeat(60))
  console.log(`Para: ${jid}`)
  console.log('')

  try {
    // 1. BOTÕES SIMPLES
    console.log('1️⃣ Enviando botões simples...')
    const buttonMsg = await sock.sendMessage(jid, {
      text: '🧪 *TESTE DE BOTÕES*\n\nEscolha uma opção abaixo:',
      buttons: [
        { buttonId: 'btn_opcao1', buttonText: { displayText: '✅ Opção 1' } },
        { buttonId: 'btn_opcao2', buttonText: { displayText: '❌ Opção 2' } },
        { buttonId: 'btn_opcao3', buttonText: { displayText: '📞 Opção 3' } },
      ],
      footerText: 'Teste InfiniteAPI - Baileys',
    })
    console.log(`   ✅ Enviado! ID: ${buttonMsg?.key?.id}`)

    await new Promise(r => setTimeout(r, 1500))

    // 2. LISTA DE MENSAGENS
    console.log('2️⃣ Enviando lista de mensagens...')
    const listMsg = await sock.sendMessage(jid, {
      text: '📋 *TESTE DE LISTA*\n\nSelecione um item:',
      title: 'Catálogo de Teste',
      buttonText: '📂 Ver Opções',
      sections: [
        {
          title: '🍔 Categoria 1 - Comidas',
          rows: [
            { rowId: 'pizza', title: '🍕 Pizza', description: 'Pizza de queijo' },
            { rowId: 'hamburguer', title: '🍔 Hambúrguer', description: 'Hambúrguer artesanal' },
            { rowId: 'sushi', title: '🍣 Sushi', description: 'Combo 20 peças' },
          ],
        },
        {
          title: '🥤 Categoria 2 - Bebidas',
          rows: [
            { rowId: 'refrigerante', title: '🥤 Refrigerante', description: 'Coca, Pepsi, Guaraná' },
            { rowId: 'suco', title: '🧃 Suco Natural', description: 'Laranja, Limão, Abacaxi' },
          ],
        },
      ],
      footerText: 'Teste InfiniteAPI',
    })
    console.log(`   ✅ Enviado! ID: ${listMsg?.key?.id}`)

    await new Promise(r => setTimeout(r, 1500))

    // 3. TEMPLATE BUTTONS
    console.log('3️⃣ Enviando template buttons (URL, Telefone, Quick Reply)...')
    const templateMsg = await sock.sendMessage(jid, {
      text: '🔗 *TESTE DE TEMPLATE BUTTONS*\n\nAções disponíveis:',
      templateButtons: [
        {
          index: 1,
          quickReplyButton: {
            displayText: '💬 Resposta Rápida',
            id: 'quick_reply_test',
          },
        },
        {
          index: 2,
          urlButton: {
            displayText: '🌐 Visitar Site',
            url: 'https://github.com/WhiskeySockets/Baileys',
          },
        },
        {
          index: 3,
          callButton: {
            displayText: '📞 Ligar',
            phoneNumber: '+5515981907008',
          },
        },
      ],
      footer: 'Teste InfiniteAPI - Template Buttons',
    })
    console.log(`   ✅ Enviado! ID: ${templateMsg?.key?.id}`)

    console.log('\n' + '='.repeat(60))
    console.log('✅ TODOS OS TESTES ENVIADOS COM SUCESSO!')
    console.log('='.repeat(60))
    console.log('\n⏳ Aguardando respostas dos botões...')
    console.log('   (Pressione Ctrl+C para sair)\n')

  } catch (error) {
    console.error('❌ Erro ao enviar mensagem:', error)
  }
}

// Inicia
startSock().catch(console.error)
