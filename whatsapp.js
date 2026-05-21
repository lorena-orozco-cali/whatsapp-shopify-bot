const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const pino = require('pino')
const path = require('path')
const https = require('https')
const http = require('http')

let sock = null
let qrCode = null
let connectionStatus = 'disconnected'
let messageHandler = null
const logger = pino({ level: 'silent' })

function setMessageHandler(fn) { messageHandler = fn }

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'sessions'))
  const { version } = await fetchLatestBaileysVersion()
  sock = makeWASocket({
    version, logger, auth: state,
    browser: ['BlockBagBot', 'Chrome', '120.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
  })
  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) { qrCode = qr; connectionStatus = 'qr_ready'; console.log('📱 QR listo') }
    if (connection === 'open') { qrCode = null; connectionStatus = 'connected'; console.log('✅ WhatsApp conectado') }
    if (connection === 'close') {
      connectionStatus = 'disconnected'
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) setTimeout(connectToWhatsApp, 5000)
      else { connectionStatus = 'logged_out'; console.log('❌ Sesión cerrada') }
    }
  })
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe || msg.key.remoteJid.includes('@g.us')) continue
      const jid = msg.key.remoteJid
      const texto = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.buttonsResponseMessage?.selectedButtonId
        || msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId
        || ''
      const hasMedia = !!(msg.message?.imageMessage || msg.message?.documentMessage || msg.message?.videoMessage)
      try { if (messageHandler) await messageHandler(jid, texto, hasMedia) }
      catch (e) { console.error('Error:', e.message) }
    }
  })
  return sock
}

async function sendMessage(jid, text) {
  if (!sock || connectionStatus !== 'connected') return
  await sock.sendMessage(jid, { text })
}

// Menú con lista interactiva (soportada por Baileys sin API oficial)
async function sendMenu(jid) {
  if (!sock || connectionStatus !== 'connected') return
  try {
    await sock.sendMessage(jid, {
      listMessage: {
        title: '🧳 BlockBag — Protectores para maletas',
        text: '¿En qué te puedo ayudar hoy?',
        footerText: 'Selecciona una opción',
        buttonText: 'Ver opciones',
        sections: [
          {
            title: 'Productos',
            rows: [
              { rowId: 'tallas', title: '📐 Tallas y medidas', description: 'Guía de medidas para tu maleta' },
              { rowId: 'colores', title: '🎨 Personalización', description: 'Diseños y colores disponibles' },
              { rowId: 'materiales', title: '💎 Materiales', description: 'Calidad de nuestros forros' },
              { rowId: 'precios', title: '💰 Precios', description: 'Costos y promociones' },
            ]
          },
          {
            title: 'Compra',
            rows: [
              { rowId: 'envios', title: '🚚 Envíos', description: 'Nacionales e internacionales' },
              { rowId: 'formas_pago', title: '💳 Formas de pago', description: 'Llave, Nequi, contra entrega' },
              { rowId: 'asesor', title: '👤 Hablar con asesor', description: 'Atención personalizada' },
            ]
          }
        ]
      }
    })
  } catch (err) {
    console.error('Error menú lista:', err.message)
    // Fallback texto
    await sock.sendMessage(jid, {
      text: `🧳 *BlockBag — Protectores para maletas*\n\n¿En qué te puedo ayudar?\n\n📐 Escribe *medidas*\n🎨 Escribe *diseño*\n💎 Escribe *materiales*\n💰 Escribe *precios*\n🚚 Escribe *envios*\n💳 Escribe *pago*\n👤 Escribe *asesor*`
    })
  }
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    client.get(url, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

async function sendImage(jid, imageUrl, caption) {
  if (!sock || connectionStatus !== 'connected') return
  try {
    const buffer = await downloadImage(imageUrl)
    await sock.sendMessage(jid, { image: buffer, mimetype: 'image/jpeg', caption: caption || '' })
    console.log(`🖼️ Imagen enviada a ${jid}`)
  } catch (err) {
    console.error('Error imagen:', err.message)
    await sock.sendMessage(jid, { text: (caption || '') + '\n\n👉 ' + imageUrl })
  }
}

function getStatus() { return { status: connectionStatus, qr: qrCode } }

module.exports = { connectToWhatsApp, sendMessage, sendMenu, sendImage, getStatus, setMessageHandler }
