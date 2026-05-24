const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const pino = require('pino')
const path = require('path')
const https = require('https')
const http = require('http')

let sock = null
let qrCode = null
let connectionStatus = 'disconnected'
let messageHandler = null
let procesando = new Set()
const logger = pino({ level: 'silent' })

function setMessageHandler(fn) { messageHandler = fn }

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(process.env.SESSION_PATH || path.join(__dirname, 'sessions'))
  const { version } = await fetchLatestBaileysVersion()
  sock = makeWASocket({
    version, logger, auth: state,
    browser: ['BlockBagBot', 'Chrome', '120.0.0'],
    connectTimeoutMs: 60000, defaultQueryTimeoutMs: 60000, keepAliveIntervalMs: 25000,
  })
  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) { qrCode = qr; connectionStatus = 'qr_ready'; console.log('QR listo') }
    if (connection === 'open') { qrCode = null; connectionStatus = 'connected'; console.log('WhatsApp conectado') }
    if (connection === 'close') {
      connectionStatus = 'disconnected'
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) setTimeout(connectToWhatsApp, 5000)
      else { connectionStatus = 'logged_out'; console.log('Sesion cerrada') }
    }
  })
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe || msg.key.remoteJid.includes('@g.us')) continue
      const msgId = msg.key.id
      if (procesando.has(msgId)) continue
      procesando.add(msgId)
      setTimeout(() => procesando.delete(msgId), 30000)
      const jid = msg.key.remoteJid
      const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
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

async function sendMenu(jid) {
  await sendMessage(jid,
`🧳 *BlockBag — Protectores para maletas*

En que te puedo ayudar hoy?

1 Tallas y medidas
2 Materiales
3 Precios
4 Envios
5 Formas de pago
6 Hablar con asesor

Responde con el numero 👇`)
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
    console.log('Imagen enviada a ' + jid)
  } catch (err) {
    console.error('Error imagen:', err.message)
    await sock.sendMessage(jid, { text: (caption || '') + '\n\n' + imageUrl })
  }
}

function getStatus() { return { status: connectionStatus, qr: qrCode } }
module.exports = { connectToWhatsApp, sendMessage, sendMenu, sendImage, getStatus, setMessageHandler }
