const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const pino = require('pino')
const path = require('path')

let sock = null
let qrCode = null
let connectionStatus = 'disconnected'
const logger = pino({ level: 'silent' })

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, '../sessions'))
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: true,
    browser: ['ShopifyBot', 'Chrome', '120.0.0'],
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
      console.log('📱 QR generado — visita /qr en el servidor para escanearlo')
    }

    if (connection === 'open') {
      qrCode = null
      connectionStatus = 'connected'
      console.log('✅ WhatsApp conectado exitosamente')
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected'
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('⚠️ Conexión cerrada. Reconectando:', shouldReconnect)
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000)
      } else {
        console.log('❌ Sesión cerrada — debes escanear el QR de nuevo')
        connectionStatus = 'logged_out'
      }
    }
  })

  return sock
}

async function sendMessage(phone, message) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp no está conectado')
  }
  const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`
  await sock.sendMessage(jid, { text: message })
  console.log(`📤 Mensaje enviado a ${phone}`)
}

function getStatus() {
  return { status: connectionStatus, qr: qrCode }
}

module.exports = { connectToWhatsApp, sendMessage, getStatus }
