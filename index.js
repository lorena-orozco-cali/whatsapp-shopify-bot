require('dotenv').config()
const express = require('express')
const QRCode = require('qrcode')
const cron = require('node-cron')
const crypto = require('crypto')

const { connectToWhatsApp, sendMessage, getStatus } = require('./whatsapp')
const { msgPedidoNuevo, msgPagoConfirmado, msgEnvioDespachado,
        msgCarritoAbandonado, msgPostventa, msgReporteDiario } = require('./messages')
const { limpiarTelefono, getStatsHoy } = require('./shopify')

const app = express()

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf }
}))

// Verificar firma de Shopify en webhooks
function verificarShopify(req, res, next) {
  const hmac = req.headers['x-shopify-hmac-sha256']
  if (!hmac) return res.status(401).json({ error: 'Sin firma' })
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('base64')
  if (digest !== hmac) return res.status(401).json({ error: 'Firma inválida' })
  next()
}

// Verificar API secret para llamadas de Make
function verificarApi(req, res, next) {
  const secret = req.headers['x-api-secret']
  if (secret !== process.env.API_SECRET) return res.status(401).json({ error: 'No autorizado' })
  next()
}

// ─── Página QR ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const { status } = getStatus()
  res.send(`
    <html><head><title>WhatsApp Bot</title>
    <meta http-equiv="refresh" content="5">
    <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f0f2f5}
    h1{color:#075E54} .status{padding:12px 24px;border-radius:20px;display:inline-block;font-weight:bold}
    .connected{background:#d4edda;color:#155724} .disconnected{background:#fff3cd;color:#856404}</style>
    </head><body>
    <h1>🤖 WhatsApp Shopify Bot</h1>
    <p class="status ${status === 'connected' ? 'connected' : 'disconnected'}">
      ${status === 'connected' ? '✅ Conectado' : status === 'qr_ready' ? '📱 Escanea el QR en /qr' : '⏳ Conectando...'}
    </p>
    ${status !== 'connected' ? '<p><a href="/qr">👉 Ver código QR</a></p>' : ''}
    <p style="color:#666;font-size:14px">Estado actualiza cada 5 segundos</p>
    </body></html>
  `)
})

app.get('/qr', async (req, res) => {
  const { status, qr } = getStatus()
  if (status === 'connected') {
    return res.send('<h2 style="font-family:sans-serif;color:green;text-align:center">✅ Ya conectado</h2>')
  }
  if (!qr) {
    return res.send('<h2 style="font-family:sans-serif;text-align:center">⏳ Generando QR... recarga en 5 seg</h2><meta http-equiv="refresh" content="5">')
  }
  const img = await QRCode.toDataURL(qr, { width: 300 })
  res.send(`
    <html><head><title>QR WhatsApp</title><meta http-equiv="refresh" content="30"></head>
    <body style="font-family:sans-serif;text-align:center;padding:40px">
    <h2>📱 Escanea con WhatsApp</h2>
    <p style="color:#666">Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
    <img src="${img}" style="border:4px solid #075E54;border-radius:12px"/>
    <p style="color:#999;font-size:13px">Se actualiza cada 30 seg</p>
    </body></html>
  `)
})

// ─── Webhooks de Shopify ───────────────────────────────────────────────────────

// Pedido nuevo
app.post('/webhook/orders/create', verificarShopify, async (req, res) => {
  res.sendStatus(200)
  try {
    const order = req.body
    const phone = limpiarTelefono(order.billing_address?.phone || order.phone)
    if (!phone) return console.log('Pedido sin teléfono:', order.order_number)
    await sendMessage(phone, msgPedidoNuevo(order))
    console.log(`✅ Confirmación enviada — pedido #${order.order_number}`)
  } catch (e) { console.error('Error webhook create:', e.message) }
})

// Pago confirmado
app.post('/webhook/orders/paid', verificarShopify, async (req, res) => {
  res.sendStatus(200)
  try {
    const order = req.body
    const phone = limpiarTelefono(order.billing_address?.phone || order.phone)
    if (!phone) return
    await sendMessage(phone, msgPagoConfirmado(order))
    console.log(`✅ Pago confirmado enviado — pedido #${order.order_number}`)
  } catch (e) { console.error('Error webhook paid:', e.message) }
})

// Envío despachado
app.post('/webhook/orders/fulfilled', verificarShopify, async (req, res) => {
  res.sendStatus(200)
  try {
    const order = req.body
    const phone = limpiarTelefono(order.billing_address?.phone || order.phone)
    if (!phone) return
    const tracking = order.fulfillments?.[0] || {}
    await sendMessage(phone, msgEnvioDespachado(order, {
      number: tracking.tracking_number,
      company: tracking.tracking_company,
      url: tracking.tracking_url,
    }))
    console.log(`✅ Guía enviada — pedido #${order.order_number}`)
  } catch (e) { console.error('Error webhook fulfilled:', e.message) }
})

// Carrito abandonado (viene de Make/Shopify flows)
app.post('/webhook/checkout/abandoned', verificarShopify, async (req, res) => {
  res.sendStatus(200)
  try {
    const checkout = req.body
    const phone = limpiarTelefono(checkout.billing_address?.phone || checkout.phone)
    if (!phone) return
    await sendMessage(phone, msgCarritoAbandonado(checkout, 1))
    console.log(`✅ Carrito abandonado enviado — ${phone}`)
  } catch (e) { console.error('Error webhook abandoned:', e.message) }
})

// ─── API para Make ─────────────────────────────────────────────────────────────

// Enviar mensaje personalizado desde Make
app.post('/api/send', verificarApi, async (req, res) => {
  try {
    const { phone, message } = req.body
    if (!phone || !message) return res.status(400).json({ error: 'Falta phone o message' })
    await sendMessage(limpiarTelefono(phone) || phone, message)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Enviar reporte a dueños (Make lo llama a las 7am con datos de Meta)
app.post('/api/reporte', verificarApi, async (req, res) => {
  try {
    const statsBase = await getStatsHoy()
    // Make puede pasar roas y gastoAds desde Meta
    const stats = { ...statsBase, ...req.body }
    const numeros = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
    for (const num of numeros) {
      await sendMessage(num.trim(), msgReporteDiario(stats))
    }
    res.json({ ok: true, enviado_a: numeros.length })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Health check para Railway
app.get('/health', (req, res) => {
  res.json({ ok: true, status: getStatus().status, ts: new Date().toISOString() })
})

// ─── Cron: reporte automático diario ──────────────────────────────────────────
const hora = process.env.REPORT_HOUR || '7'
const minuto = process.env.REPORT_MINUTE || '0'
// Cron en UTC — Colombia es UTC-5, así que 7am COL = 12pm UTC
cron.schedule(`${minuto} ${Number(hora) + 5} * * *`, async () => {
  console.log('⏰ Ejecutando reporte diario automático...')
  try {
    const stats = await getStatsHoy()
    const numeros = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
    for (const num of numeros) {
      await sendMessage(num.trim(), msgReporteDiario(stats))
    }
    console.log(`✅ Reporte enviado a ${numeros.length} dueño(s)`)
  } catch (e) { console.error('Error reporte cron:', e.message) }
}, { timezone: 'UTC' })

// ─── Arrancar ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000
app.listen(PORT, async () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`)
  console.log(`📱 Abre https://tu-app.railway.app/qr para escanear el QR`)
  await connectToWhatsApp()
})
