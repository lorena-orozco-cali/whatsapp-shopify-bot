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
    connectTimeoutMs: 60000, defaultQueryTimeoutMs: 60000, keepAliveIntervalMs: 25000,
  })
  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) { qrCode = qr; connectionStatus = 'qr_ready'; console.log('📱 QR listo — visita /qr') }
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
      // Texto normal o respuesta de botón
      const texto = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.buttonsResponseMessage?.selectedButtonId
        || msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
        || ''
      const hasMedia = !!(msg.message?.imageMessage || msg.message?.documentMessage || msg.message?.videoMessage)
      try { if (messageHandler) await messageHandler(jid, texto, hasMedia) }
      catch (e) { console.error('Error mensaje:', e.message) }
    }
  })
  return sock
}

async function sendMessage(jid, text) {
  if (!sock || connectionStatus !== 'connected') return
  await sock.sendMessage(jid, { text })
}

// Enviar botones interactivos (cajones)
async function sendButtons(jid, bodyText, buttons) {
  if (!sock || connectionStatus !== 'connected') return
  try {
    // Baileys botones — máx 3 por mensaje, dividir si hay más
    const chunks = []
    for (let i = 0; i < buttons.length; i += 3) chunks.push(buttons.slice(i, i + 3))
    for (const chunk of chunks) {
      await sock.sendMessage(jid, {
        buttons: chunk.map(b => ({ buttonId: b.id, buttonText: { displayText: b.title }, type: 1 })),
        text: chunks.indexOf(chunk) === 0 ? bodyText : '',
        headerType: 1,
      })
      await new Promise(r => setTimeout(r, 500))
    }
  } catch (err) {
    // Fallback a lista de texto si botones fallan
    console.log('Botones no soportados, enviando texto:', err.message)
    const lista = buttons.map(b => `• ${b.title}`).join('\n')
    await sock.sendMessage(jid, { text: `${bodyText}\n\n${lista}` })
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
    await sock.sendMessage(jid, { text: caption || '' })
  }
}

function getStatus() { return { status: connectionStatus, qr: qrCode } }

module.exports = { connectToWhatsApp, sendMessage, sendButtons, sendImage, getStatus, setMessageHandler }
