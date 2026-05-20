require('dotenv').config()
const express = require('express')
const QRCode = require('qrcode')
const cron = require('node-cron')
const crypto = require('crypto')
const axios = require('axios')

const { connectToWhatsApp, sendMessage, sendImage, getStatus } = require('./whatsapp')
const {
  msgPedidoNuevo, msgPagoConfirmado, msgEnvioDespachado,
  msgCarritoAbandonado, msgPostventa, msgReporteDiario,
  msgMenuPrincipal, msgMedidasGuia, msgPersonalizacionGuia,
  msgMateriales, msgEnvios, msgOfertaCandado, msgSeleccionPago,
  msgPagosDinamicos, urlImagenPago, msgContraEntrega,
  msgPedirDatosEnvio, msgPedidoCompleto,
} = require('./messages')
const { limpiarTelefono, getStatsHoy } = require('./shopify')

const app = express()

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }))

// ─── Sesiones de conversación en memoria ──────────────────────────────────────
const sessions = new Map()

const STATES = {
  INICIO: 'INICIO',
  MENU: 'MENU',
  ESPERANDO_MEDIDAS: 'ESPERANDO_MEDIDAS',
  ESPERANDO_PERSONALIZACION: 'ESPERANDO_PERSONALIZACION',
  RESUMEN_PEDIDO: 'RESUMEN_PEDIDO',
  OFERTA_CANDADO: 'OFERTA_CANDADO',
  SELECCION_PAGO: 'SELECCION_PAGO',
  ESPERANDO_CONFIRMACION_COD: 'ESPERANDO_CONFIRMACION_COD',
  ESPERANDO_COMPROBANTE: 'ESPERANDO_COMPROBANTE',
  ESPERANDO_DATOS_ENVIO: 'ESPERANDO_DATOS_ENVIO',
}

function getSession(jid) {
  if (!sessions.has(jid)) {
    sessions.set(jid, { state: STATES.INICIO, pedido: { candado: false } })
  }
  return sessions.get(jid)
}

function setSession(jid, data) {
  sessions.set(jid, { ...getSession(jid), ...data })
}

// ─── Manejador de mensajes entrantes ──────────────────────────────────────────
async function handleMessage(jid, texto, hasMedia) {
  const t = (texto || '').trim().toLowerCase()
  const session = getSession(jid)

  // Palabras clave que reinician el menú
  if (['hola', 'menu', 'menú', 'inicio', 'start', '0'].includes(t)) {
    setSession(jid, { state: STATES.MENU, pedido: { candado: false } })
    await sendMessage(jid, msgMenuPrincipal())
    return
  }

  // ── MENÚ PRINCIPAL ─────────────────────────────────────────────────────────
  if (session.state === STATES.MENU || session.state === STATES.INICIO) {
    if (t === '1' || t.includes('forro') || t.includes('producto')) {
      setSession(jid, { state: STATES.ESPERANDO_MEDIDAS })
      await sendImage(jid, process.env.IMG_MEDIDAS_URL, msgMedidasGuia())
      return
    }
    if (t === '2' || t.includes('medida') || t.includes('talla')) {
      setSession(jid, { state: STATES.ESPERANDO_MEDIDAS })
      await sendImage(jid, process.env.IMG_MEDIDAS_URL, msgMedidasGuia())
      return
    }
    if (t === '3' || t.includes('personaliz')) {
      setSession(jid, { state: STATES.ESPERANDO_PERSONALIZACION })
      await sendImage(jid, process.env.IMG_PERSONALIZACION_URL, msgPersonalizacionGuia())
      return
    }
    if (t === '4' || t.includes('envío') || t.includes('envio')) {
      await sendMessage(jid, msgEnvios())
      return
    }
    if (t === '5' || t.includes('pago')) {
      setSession(jid, { state: STATES.OFERTA_CANDADO })
      await sendMessage(jid, msgOfertaCandado())
      return
    }
    if (t === '6' || t.includes('material') || t.includes('tela')) {
      await sendMessage(jid, msgMateriales())
      return
    }
    setSession(jid, { state: STATES.MENU })
    await sendMessage(jid, msgMenuPrincipal())
    return
  }

  // ── ESPERANDO MEDIDAS ──────────────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_MEDIDAS) {
    setSession(jid, {
      state: STATES.RESUMEN_PEDIDO,
      pedido: { ...session.pedido, medidas: texto }
    })
    await sendMessage(jid, `✅ *Medidas registradas:* ${texto}\n\n¡Perfecto! ¿Deseas continuar con la compra o agregar personalización?\n\n1️⃣ Continuar con la compra\n2️⃣ Agregar personalización`)
    return
  }

  // ── ESPERANDO PERSONALIZACIÓN ──────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_PERSONALIZACION) {
    setSession(jid, {
      state: STATES.RESUMEN_PEDIDO,
      pedido: { ...session.pedido, personalizacion: texto }
    })
    await sendMessage(jid, `✅ *Personalización registrada:*\n_${texto}_\n\n¿Continuamos con la compra?\n\n1️⃣ Sí, continuar\n2️⃣ Modificar diseño`)
    return
  }

  // ── RESUMEN PEDIDO ─────────────────────────────────────────────────────────
  if (session.state === STATES.RESUMEN_PEDIDO) {
    if (t === '1' || t.includes('continuar') || t.includes('compra') || t.includes('si') || t.includes('sí')) {
      setSession(jid, { state: STATES.OFERTA_CANDADO })
      await sendMessage(jid, msgOfertaCandado())
      return
    }
    if (t === '2' || t.includes('personaliz')) {
      setSession(jid, { state: STATES.ESPERANDO_PERSONALIZACION })
      await sendImage(jid, process.env.IMG_PERSONALIZACION_URL, msgPersonalizacionGuia())
      return
    }
  }

  // ── OFERTA CANDADO ─────────────────────────────────────────────────────────
  if (session.state === STATES.OFERTA_CANDADO) {
    const quiere = ['si', 'sí', 's', 'yes', 'claro', 'dale', '1'].some(r => t.includes(r))
    setSession(jid, {
      state: STATES.SELECCION_PAGO,
      pedido: { ...session.pedido, candado: quiere }
    })
    const respuesta = quiere
      ? `✅ *Candado agregado* 🔒 +$${Number(process.env.CANDADO_PRECIO || 10000).toLocaleString('es-CO')}\n\n`
      : `De acuerdo, continuamos sin candado.\n\n`
    await sendMessage(jid, respuesta + msgSeleccionPago())
    return
  }

  // ── SELECCIÓN DE PAGO ──────────────────────────────────────────────────────
  if (session.state === STATES.SELECCION_PAGO) {
    if (t === '1' || t.includes('transfer') || t.includes('llave') || t.includes('nequi')) {
      setSession(jid, { state: STATES.ESPERANDO_COMPROBANTE })
      // Enviar imagen de pago según quincena automáticamente
      await sendImage(jid, urlImagenPago(), msgPagosDinamicos())
      return
    }
    if (t === '2' || t.includes('contra') || t.includes('efectivo')) {
      setSession(jid, { state: STATES.ESPERANDO_CONFIRMACION_COD })
      // Recordatorio automático obligatorio
      await sendMessage(jid, msgContraEntrega())
      return
    }
  }

  // ── CONFIRMACIÓN CONTRA ENTREGA ────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_CONFIRMACION_COD) {
    const confirma = ['si', 'sí', 'confirmo', 'acepto', 'ok', 'dale', 'claro'].some(r => t.includes(r))
    if (confirma) {
      setSession(jid, { state: STATES.ESPERANDO_DATOS_ENVIO })
      await sendMessage(jid, msgPedirDatosEnvio())
    } else {
      setSession(jid, { state: STATES.SELECCION_PAGO })
      await sendMessage(jid, msgSeleccionPago())
    }
    return
  }

  // ── ESPERANDO COMPROBANTE ──────────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_COMPROBANTE) {
    if (hasMedia) {
      setSession(jid, { state: STATES.INICIO, pedido: { candado: false } })
      await sendMessage(jid, msgPedidoCompleto())
      // Notificar dueños
      const owners = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
      for (const num of owners) {
        await sendMessage(num.trim() + '@s.whatsapp.net',
          `📸 *Comprobante recibido*\nCliente: ${jid}\nRevisar y confirmar pedido.`)
      }
    } else {
      await sendMessage(jid, `📸 Por favor envía el *pantallazo del comprobante de pago* para proceder con tu pedido.`)
    }
    return
  }

  // ── ESPERANDO DATOS DE ENVÍO ───────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_DATOS_ENVIO) {
    setSession(jid, { state: STATES.INICIO, pedido: { candado: false } })
    await sendMessage(jid, msgPedidoCompleto())
    const owners = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
    for (const num of owners) {
      await sendMessage(num.trim() + '@s.whatsapp.net',
        `📦 *Pedido contra entrega*\nCliente: ${jid}\nDatos: ${texto}`)
    }
    return
  }

  // Fallback
  await sendMessage(jid, `No entendí tu mensaje 😅\n\nEscribe *Hola* para ver el menú.`)
}

// ─── Exportar manejador para whatsapp.js ──────────────────────────────────────
module.exports.handleMessage = handleMessage

// ─── Verificaciones ───────────────────────────────────────────────────────────
function verificarShopify(req, res, next) {
  const hmac = req.headers['x-shopify-hmac-sha256']
  if (!hmac) return res.status(401).json({ error: 'Sin firma' })
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody).digest('base64')
  if (digest !== hmac) return res.status(401).json({ error: 'Firma inválida' })
  next()
}

function verificarApi(req, res, next) {
  const secret = req.headers['x-api-secret']
  if (secret !== process.env.API_SECRET) return res.status(401).json({ error: 'No autorizado' })
  next()
}

// ─── Páginas QR ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const { status } = getStatus()
  res.send(`<html><head><title>WhatsApp Bot</title><meta http-equiv="refresh" content="5">
    <style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f0f2f5}
    h1{color:#075E54}.status{padding:12px 24px;border-radius:20px;display:inline-block;font-weight:bold}
    .connected{background:#d4edda;color:#155724}.disconnected{background:#fff3cd;color:#856404}</style>
    </head><body><h1>🤖 BlockBag WhatsApp Bot</h1>
    <p class="status ${status === 'connected' ? 'connected' : 'disconnected'}">
    ${status === 'connected' ? '✅ Conectado' : status === 'qr_ready' ? '📱 Escanea el QR en /qr' : '⏳ Conectando...'}</p>
    ${status !== 'connected' ? '<p><a href="/qr">👉 Ver código QR</a></p>' : ''}
    </body></html>`)
})

app.get('/qr', async (req, res) => {
  const { status, qr } = getStatus()
  if (status === 'connected') return res.send('<h2 style="font-family:sans-serif;color:green;text-align:center">✅ Ya conectado</h2>')
  if (!qr) return res.send('<h2 style="font-family:sans-serif;text-align:center">⏳ Generando QR... recarga en 5 seg</h2><meta http-equiv="refresh" content="5">')
  const img = await QRCode.toDataURL(qr, { width: 300 })
  res.send(`<html><head><title>QR</title><meta http-equiv="refresh" content="30"></head>
    <body style="font-family:sans-serif;text-align:center;padding:40px">
    <h2>📱 Escanea con WhatsApp</h2>
    <img src="${img}" style="border:4px solid #075E54;border-radius:12px"/>
    </body></html>`)
})

// ─── Webhooks Shopify ──────────────────────────────────────────────────────────
app.post('/webhook/orders/create', verificarShopify, async (req, res) => {
  res.sendStatus(200)
  try {
    const order = req.body
    const phone = limpiarTelefono(order.billing_address?.phone || order.phone)
    if (!phone) return
    await sendMessage(phone + '@s.whatsapp.net', msgPedidoNuevo(order))
  } catch (e) { console.error('Error webhook create:', e.message) }
})

app.post('/webhook/orders/paid', verificarShopify, async (req, res) => {
  res.sendStatus(200)
  try {
    const order = req.body
    const phone = limpiarTelefono(order.billing_address?.phone || order.phone)
    if (!phone) return
    await sendMessage(phone + '@s.whatsapp.net', msgPagoConfirmado(order))
  } catch (e) { console.error('Error webhook paid:', e.message) }
})

app.post('/webhook/orders/fulfilled', verificarShopify, async (req, res) => {
  res.sendStatus(200)
  try {
    const order = req.body
    const phone = limpiarTelefono(order.billing_address?.phone || order.phone)
    if (!phone) return
    const tracking = order.fulfillments?.[0] || {}
    await sendMessage(phone + '@s.whatsapp.net', msgEnvioDespachado(order, {
      number: tracking.tracking_number,
      company: tracking.tracking_company,
      url: tracking.tracking_url,
    }))
  } catch (e) { console.error('Error webhook fulfilled:', e.message) }
})

app.post('/webhook/checkout/abandoned', verificarShopify, async (req, res) => {
  res.sendStatus(200)
  try {
    const checkout = req.body
    const phone = limpiarTelefono(checkout.billing_address?.phone || checkout.phone)
    if (!phone) return
    await sendMessage(phone + '@s.whatsapp.net', msgCarritoAbandonado(checkout, 1))
  } catch (e) { console.error('Error webhook abandoned:', e.message) }
})

// ─── API para Make ─────────────────────────────────────────────────────────────
app.post('/api/send', verificarApi, async (req, res) => {
  try {
    const { phone, message } = req.body
    if (!phone || !message) return res.status(400).json({ error: 'Falta phone o message' })
    await sendMessage(limpiarTelefono(phone) + '@s.whatsapp.net', message)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/reporte', verificarApi, async (req, res) => {
  try {
    const statsBase = await getStatsHoy()
    const stats = { ...statsBase, ...req.body }
    const numeros = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
    for (const num of numeros) {
      await sendMessage(num.trim() + '@s.whatsapp.net', msgReporteDiario(stats))
    }
    res.json({ ok: true, enviado_a: numeros.length })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/health', (req, res) => {
  res.json({ ok: true, status: getStatus().status, ts: new Date().toISOString() })
})

// ─── Cron reporte diario ───────────────────────────────────────────────────────
const hora = process.env.REPORT_HOUR || '7'
const minuto = process.env.REPORT_MINUTE || '0'
cron.schedule(`${minuto} ${Number(hora) + 5} * * *`, async () => {
  try {
    const stats = await getStatsHoy()
    const numeros = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
    for (const num of numeros) {
      await sendMessage(num.trim() + '@s.whatsapp.net', msgReporteDiario(stats))
    }
  } catch (e) { console.error('Error reporte cron:', e.message) }
}, { timezone: 'UTC' })

// ─── Arrancar ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000
app.listen(PORT, async () => {
  console.log(`🚀 BlockBag Bot corriendo en puerto ${PORT}`)
  await connectToWhatsApp()
})
