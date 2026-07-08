import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import readline from 'readline'
import makeWASocket, { AnyMessageContent, BinaryInfo, CacheStore, DEFAULT_CONNECTION_CONFIG, decryptPollVote, delay, DisconnectReason, downloadAndProcessHistorySyncNotification, encodeWAM, fetchLatestBaileysVersion, generateMessageIDV2, getAggregateVotesInPollMessage, getHistoryMsg, getKeyAuthor, isJidNewsletter, jidDecode, jidNormalizedUser, makeCacheableSignalKeyStore, normalizeMessageContent, PatchedMessageWithRecipientJID, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey } from '../src'
//import MAIN_LOGGER from '../src/Utils/logger'
import open from 'open'
import fs from 'fs'
import P from 'pino'
import qrcodeTerminal from 'qrcode-terminal'

const logger = P({
  level: "trace",
  transport: {
    targets: [
      {
        target: "pino-pretty", // pretty-print for console
        options: { colorize: true },
        level: "trace",
      },
      {
        target: "pino/file", // raw file output
        options: { destination: './wa-logs.txt' },
        level: "trace",
      },
    ],
  },
})
logger.level = 'trace'

const doReplies = process.argv.includes('--do-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache() as CacheStore

const onDemandMap = new Map<string, string>()

// Minimal example-only message cache, keyed by chat+id. Backs both getMessage()
// (poll/event/retry lookups the socket asks for) and the poll-vote decryption
// below. A real app should persist this (DB/file), not keep it in memory only —
// this Map is empty again on every restart, so votes/retries referencing a
// message from a previous run won't resolve.
const messageStore = new Map<string, proto.IMessage>()
const messageStoreKey = (key: WAMessageKey) => `${key.remoteJid}:${key.id}`

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>((resolve) => rl.question(text, resolve))

// start a connection
const startSock = async() => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// NOTE: For unit testing purposes only
	if (process.env.ADV_SECRET_KEY) {
		state.creds.advSecretKey = process.env.ADV_SECRET_KEY
	}
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	logger.debug({version: version.join('.'), isLatest}, `using latest WA version`)

	const sock = makeWASocket({
		version,
		logger,
		waWebSocketUrl: process.env.SOCKET_URL ?? DEFAULT_CONNECTION_CONFIG.waWebSocketUrl,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger),
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		// shouldIgnoreJid: jid => isJidBroadcast(jid),
		// implement to handle retries & poll updates
		getMessage
	})

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async(events) => {
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if(events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect, qr } = update
				if(connection === 'close') {
					// reconnect if not logged out
					if((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
						startSock()
					} else {
						logger.fatal('Connection closed. You are logged out.')
					}
				}

				if (qr) {
					// Pairing code for Web clients
					if (usePairingCode && !sock.authState.creds.registered) {
						const phoneNumber = await question('Please enter your phone number:\n')
						const code = await sock.requestPairingCode(phoneNumber)
						console.log(`Pairing code: ${code}`)
					} else {
						// printQRInTerminal is deprecated by the socket itself — render it ourselves.
						qrcodeTerminal.generate(qr, { small: true })
					}
				}

				logger.debug(update, 'connection update')
			}

			// credentials updated -- save them
			if(events['creds.update']) {
				await saveCreds()
				logger.debug({}, 'creds save triggered')
			}

			if(events['labels.association']) {
				logger.debug(events['labels.association'], 'labels.association event fired')
			}


			if(events['labels.edit']) {
				logger.debug(events['labels.edit'], 'labels.edit event fired')
			}

			if(events['call']) {
				logger.debug(events['call'], 'call event fired')
			}

			// history received
			if(events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
				if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
					logger.debug(messages, 'received on-demand history sync')
				}
				logger.debug({contacts: contacts.length, chats: chats.length, messages: messages.length, isLatest, progress, syncType: syncType?.toString() }, 'messaging-history.set event fired')
			}

			// received a new message
      if (events['messages.upsert']) {
        const upsert = events['messages.upsert']
        logger.debug(upsert, 'messages.upsert fired')

        if (!!upsert.requestId) {
          logger.debug(upsert, 'placeholder request message received')
        }



        for (const msg of upsert.messages) {
          if (msg.message) {
            messageStore.set(messageStoreKey(msg.key), msg.message)
          }

          // Poll-vote decryption is the CONSUMER's responsibility (upstream commit
          // b7a9f7bd67 moved it out of the library) — the raw pollUpdateMessage
          // still arrives here via messages.upsert like any other message content,
          // just still encrypted. Look up the poll-creation message (the vote only
          // carries its key, not its content) and decrypt with decryptPollVote.
          if (msg.message?.pollUpdateMessage) {
            const { pollCreationMessageKey, vote, senderTimestampMs } = msg.message.pollUpdateMessage
            const pollCreation = pollCreationMessageKey && messageStore.get(messageStoreKey(pollCreationMessageKey))
            const pollEncKey = pollCreation?.messageContextInfo?.messageSecret
            if (pollCreationMessageKey && vote && pollEncKey) {
              // The poll-vote HMAC key is derived from the voter/creator's LID
              // identity, not PN — confirmed empirically against a real account
              // (live capture 2026-07-08): the PN form fails GCM auth, the LID
              // form authenticates correctly. Falls back to PN only if this
              // session has no LID yet (pre-migration creds). Device suffix
              // must be stripped either way ("user@server", not
              // "user:device@server") — see process-message.ts's meIdNormalised.
              const meId = jidNormalizedUser(sock.user!.lid || sock.user!.id)
              const pollCreatorJid = getKeyAuthor(pollCreationMessageKey, meId)
              const voterJid = getKeyAuthor(msg.key, meId)
              try {
                const voteMsg = decryptPollVote(vote, {
                  pollEncKey,
                  pollCreatorJid,
                  pollMsgId: pollCreationMessageKey.id!,
                  voterJid
                })
                logger.debug(
                  {
                    voterJid,
                    aggregate: getAggregateVotesInPollMessage({
                      message: pollCreation,
                      pollUpdates: [{ pollUpdateMessageKey: msg.key, vote: voteMsg, senderTimestampMs }]
                    })
                  },
                  'decrypted poll vote'
                )
              } catch (err) {
                logger.warn({ err, pollCreationMessageKey }, 'failed to decrypt poll vote')
              }
            } else {
              logger.debug(
                { pollCreationMessageKey },
                'poll creation message not in local store yet, cannot decrypt vote'
              )
            }
          }

          if (upsert.type === 'notify' && (msg.message?.conversation || msg.message?.extendedTextMessage?.text)) {
              const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
              if (text == "requestPlaceholder" && !upsert.requestId) {
                const messageId = await sock.requestPlaceholderResend(msg.key)
								logger.debug({ id: messageId }, 'requested placeholder resync')
              }

              // go to an old chat and send this
              if (text == "onDemandHistSync") {
                const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp ?? 0)
                logger.debug({ id: messageId }, 'requested on-demand history resync')
              }

              if (!msg.key.fromMe && doReplies && !isJidNewsletter(msg.key?.remoteJid ?? '')) {
              	const id = generateMessageIDV2(sock.user?.id)
              	logger.debug({id, orig_id: msg.key.id }, 'replying to message')
                await sock.sendMessage(msg.key.remoteJid!, { text: 'pong '+msg.key.id }, {messageId: id })
              }
            }
          }
      }

			// messages updated like status delivered, message deleted etc.
			// (poll-vote decryption/aggregation happens in the messages.upsert handler
			// above, not here — see the note there. update.pollUpdates is never
			// populated by the library itself.)
			if(events['messages.update']) {
				logger.debug(events['messages.update'], 'messages.update fired')
			}

			if(events['message-receipt.update']) {
				logger.debug(events['message-receipt.update'])
			}

			if (events['contacts.upsert']) {
				logger.debug(events['contacts.upsert'], 'contacts.upsert event fired')
			}

			if(events['messages.reaction']) {
				logger.debug(events['messages.reaction'])
			}

			if(events['presence.update']) {
				logger.debug(events['presence.update'])
			}

			if(events['chats.update']) {
				logger.debug(events['chats.update'])
			}

			if(events['contacts.update']) {
				for(const contact of events['contacts.update']) {
					if(typeof contact.imgUrl !== 'undefined') {
						const newUrl = contact.imgUrl === null
							? null
							: await sock.profilePictureUrl(contact.id ?? '').catch(() => null)
						logger.debug({id: contact.id, newUrl}, `contact has a new profile pic` )
					}
				}
			}

			if(events['chats.delete']) {
				logger.debug(events['chats.delete'], 'chats.delete event fired')
			}

			if(events['group.member-tag.update']) {
				logger.debug(events['group.member-tag.update'], 'group.member-tag.update event fired')
			}
		}
	)

	return sock

	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
		// Backed by the same in-memory messageStore populated in the messages.upsert
		// handler above. A real app should back this with persistent storage — this
		// only resolves messages seen earlier in the SAME process lifetime.
		return messageStore.get(messageStoreKey(key))
	}
}

startSock()
