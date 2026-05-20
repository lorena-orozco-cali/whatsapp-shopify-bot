const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const pino = require('pino')
const path = require('path')

let sock = null
let qrCode = null
let connectionStatus = 'disconnected'
let messageHandler = null
const logger = pino({ level: 'silent' })

// Registrar el handler desde afuera (lo pasa index.js)
function setMessageHandler(fn) {
  messageHandler = fn
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'sessions'))
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger,
    auth: state,
    browser: ['BlockBagBot', 'Chrome', '120.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      qrCode = qr
      connectionStatus = 'qr_ready'
      console.log('📱 QR generado — visita /qr para escanearlo')
    }
    if (connection === 'open') {
      qrCode = null
      connectionStatus = 'connected'
      console.log('✅ WhatsApp conectado')
    }
    if (connection === 'close') {
      connectionStatus = 'disconnected'
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000)
      } else {
        connectionStatus = 'logged_out'
        console.log('❌ Sesión cerrada — escanea el QR de nuevo')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe || msg.key.remoteJid.includes('@g.us')) continue
      const jid = msg.key.remoteJid
      const texto = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || ''
      const hasMedia = !!(
        msg.message?.imageMessage ||
        msg.message?.documentMessage ||
        msg.message?.videoMessage
      )
      try {
        if (messageHandler) await messageHandler(jid, texto, hasMedia)
      } catch (e) {
        console.error('Error manejando mensaje:', e.message)
      }
    }
  })

  return sock
}

async function sendMessage(jid, text) {
  if (!sock || connectionStatus !== 'connected') return
  await sock.sendMessage(jid, { text })
  console.log(`📤 Mensaje enviado a ${jid}`)
}

async function sendImage(jid, imageUrl, caption) {
  if (!sock || connectionStatus !== 'connected') return
  try {
    await sock.sendMessage(jid, { image: { url: imageUrl }, caption: caption || '' })
    console.log(`🖼️ Imagen enviada a ${jid}`)
  } catch (err) {
    console.error('Error enviando imagen:', err.message)
    await sock.sendMessage(jid, { text: caption || '' })
  }
}

function getStatus() {
  return { status: connectionStatus, qr: qrCode }
}

module.exports = { connectToWhatsApp, sendMessage, sendImage, getStatus, setMessageHandler }
