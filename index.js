require('dotenv').config()
const express = require('express')
const QRCode = require('qrcode')
const cron = require('node-cron')
const crypto = require('crypto')

const { connectToWhatsApp, sendMessage, sendButtons, sendImage, getStatus, setMessageHandler } = require('./whatsapp')
const { msgPedidoNuevo, msgPagoConfirmado, msgEnvioDespachado,
        msgCarritoAbandonado, msgPostventa, msgReporteDiario,
        msgMateriales, msgEnvios, msgOfertaCandado, msgSeleccionPago,
        msgPagosDinamicos, msgContraEntrega, msgPedirDatosEnvio, msgPedidoCompleto } = require('./messages')
const { limpiarTelefono, getStatsHoy } = require('./shopify')

const app = express()
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }))

// ─── Sesiones ──────────────────────────────────────────────────────────────────
const sessions = new Map()
const STATES = {
  INICIO: 'INICIO',
  ESPERANDO_MEDIDAS: 'ESPERANDO_MEDIDAS',
  ESPERANDO_PERSONALIZACION: 'ESPERANDO_PERSONALIZACION',
  OFERTA_CANDADO: 'OFERTA_CANDADO',
  SELECCION_PAGO: 'SELECCION_PAGO',
  ESPERANDO_CONFIRMACION_COD: 'ESPERANDO_CONFIRMACION_COD',
  ESPERANDO_COMPROBANTE: 'ESPERANDO_COMPROBANTE',
  ESPERANDO_DATOS_ENVIO: 'ESPERANDO_DATOS_ENVIO',
}
function getSession(jid) {
  if (!sessions.has(jid)) sessions.set(jid, { state: STATES.INICIO, pedido: { candado: false } })
  return sessions.get(jid)
}
function setSession(jid, data) {
  sessions.set(jid, { ...getSession(jid), ...data })
}

// ─── Manejador de mensajes ─────────────────────────────────────────────────────
async function handleMessage(jid, texto, hasMedia) {
  const t = (texto || '').trim().toLowerCase()
  const session = getSession(jid)

  // Reiniciar con hola/menu
  if (['hola', 'menu', 'menú', 'inicio', 'start', '0', 'hi'].includes(t) || session.state === STATES.INICIO) {
    setSession(jid, { state: STATES.INICIO, pedido: { candado: false } })
    await sendButtons(jid,
      '¿En qué te puedo ayudar hoy? 🧳',
      [
        { id: 'tallas', title: '📐 Tallas y medidas' },
        { id: 'colores', title: '🎨 Personalización' },
        { id: 'materiales', title: '💎 Materiales' },
        { id: 'precios', title: '💰 Precios' },
        { id: 'envios', title: '🚚 Envíos' },
        { id: 'formas_pago', title: '💳 Formas de pago' },
        { id: 'asesor', title: '👤 Hablar con asesor' },
      ]
    )
    return
  }

  // ── Respuestas de botones o texto ──────────────────────────────────────────
  if (session.state === STATES.INICIO || t === 'tallas' || t === 'tallas y medidas') {
    setSession(jid, { state: STATES.ESPERANDO_MEDIDAS })
    await sendImage(jid,
      process.env.IMG_MEDIDAS_URL,
      '📏 *Guía de medidas — Forros BlockBag*\n\nMide tu maleta *sin contar las ruedas* y dime:\n\n↕️ *Alto* en cm\n↔️ *Ancho* en cm\n\nCon esas medidas te digo qué talla necesitas 👇'
    )
    return
  }

  if (t === 'colores' || t === 'personalización' || t === 'personalizacion') {
    setSession(jid, { state: STATES.ESPERANDO_PERSONALIZACION })
    await sendImage(jid,
      process.env.IMG_PERSONALIZACION_URL,
      '🎨 *Personalización BlockBag*\n\nCuéntanos:\n✏️ ¿Qué diseño quieres?\n📍 ¿En qué parte de la maleta?\n\nEscríbenos todos los detalles 👇'
    )
    return
  }

  if (t === 'materiales') {
    await sendMessage(jid, msgMateriales())
    await sendButtons(jid, '¿En qué más te puedo ayudar?', [
      { id: 'tallas', title: '📐 Tallas y medidas' },
      { id: 'formas_pago', title: '💳 Formas de pago' },
      { id: 'asesor', title: '👤 Hablar con asesor' },
    ])
    return
  }

  if (t === 'precios') {
    await sendMessage(jid, '💰 *Precios BlockBag*\n\nEscríbenos directamente para cotizar tu forro según la talla y personalización que necesites.')
    await sendButtons(jid, '¿Qué deseas hacer?', [
      { id: 'tallas', title: '📐 Ver tallas' },
      { id: 'asesor', title: '👤 Hablar con asesor' },
    ])
    return
  }

  if (t === 'envios' || t === 'envíos') {
    await sendMessage(jid, msgEnvios())
    await sendButtons(jid, '¿En qué más te ayudo?', [
      { id: 'formas_pago', title: '💳 Formas de pago' },
      { id: 'asesor', title: '👤 Hablar con asesor' },
    ])
    return
  }

  if (t === 'formas_pago' || t === 'formas de pago') {
    setSession(jid, { state: STATES.OFERTA_CANDADO })
    await sendMessage(jid, msgOfertaCandado())
    await sendButtons(jid, '¿Deseas el candado?', [
      { id: 'candado_si', title: '✅ Sí, incluirlo' },
      { id: 'candado_no', title: '❌ No, continuar' },
    ])
    return
  }

  if (t === 'asesor' || t === 'hablar con asesor' || t === 'por mayor') {
    await sendMessage(jid, '👤 *Conectando con un asesor...*\n\nEn breve alguien del equipo BlockBag te atenderá. ¡Gracias por tu paciencia! 🙏')
    const owners = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
    for (const num of owners) {
      await sendMessage(num.trim() + '@s.whatsapp.net',
        `👤 *Cliente solicita asesor*\nNúmero: ${jid.replace('@s.whatsapp.net', '')}`)
    }
    return
  }

  // ── OFERTA CANDADO ─────────────────────────────────────────────────────────
  if (session.state === STATES.OFERTA_CANDADO || t === 'candado_si' || t === 'candado_no') {
    const quiere = t === 'candado_si' || ['si', 'sí', 'claro', 'dale'].some(r => t.includes(r))
    setSession(jid, { state: STATES.SELECCION_PAGO, pedido: { ...session.pedido, candado: quiere } })
    const msg = quiere
      ? `✅ *Candado agregado* 🔒 +$${Number(process.env.CANDADO_PRECIO || 10000).toLocaleString('es-CO')}\n\n`
      : 'De acuerdo, sin candado.\n\n'
    await sendMessage(jid, msg + msgSeleccionPago())
    await sendButtons(jid, '¿Cómo deseas pagar?', [
      { id: 'pago_transferencia', title: '🏦 Transferencia' },
      { id: 'pago_cod', title: '💵 Contra entrega' },
    ])
    return
  }

  // ── SELECCIÓN PAGO ─────────────────────────────────────────────────────────
  if (session.state === STATES.SELECCION_PAGO || t === 'pago_transferencia' || t === 'pago_cod') {
    if (t === 'pago_transferencia' || t.includes('transfer') || t.includes('llave') || t.includes('nequi') || t === '1') {
      setSession(jid, { state: STATES.ESPERANDO_COMPROBANTE })
      await sendImage(jid, t <= 15 ? process.env.PAGO_Q1_IMAGEN_URL : process.env.PAGO_Q2_IMAGEN_URL, msgPagosDinamicos())
      return
    }
    if (t === 'pago_cod' || t.includes('contra') || t.includes('efectivo') || t === '2') {
      setSession(jid, { state: STATES.ESPERANDO_CONFIRMACION_COD })
      await sendMessage(jid, msgContraEntrega())
      await sendButtons(jid, '¿Confirmas las condiciones?', [
        { id: 'cod_confirma', title: '✅ Sí, confirmo' },
        { id: 'cod_no', title: '🔄 Elegir otro método' },
      ])
      return
    }
  }

  // ── CONTRA ENTREGA CONFIRMACIÓN ────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_CONFIRMACION_COD || t === 'cod_confirma' || t === 'cod_no') {
    if (t === 'cod_confirma' || ['si', 'sí', 'confirmo'].some(r => t.includes(r))) {
      setSession(jid, { state: STATES.ESPERANDO_DATOS_ENVIO })
      await sendMessage(jid, msgPedirDatosEnvio())
    } else {
      setSession(jid, { state: STATES.SELECCION_PAGO })
      await sendButtons(jid, '¿Cómo deseas pagar?', [
        { id: 'pago_transferencia', title: '🏦 Transferencia' },
        { id: 'pago_cod', title: '💵 Contra entrega' },
      ])
    }
    return
  }

  // ── ESPERANDO MEDIDAS ──────────────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_MEDIDAS) {
    setSession(jid, { state: STATES.OFERTA_CANDADO, pedido: { ...session.pedido, medidas: texto } })
    await sendMessage(jid, `✅ *Medidas registradas:* ${texto}\n\n¡Perfecto!`)
    await sendMessage(jid, msgOfertaCandado())
    await sendButtons(jid, '¿Deseas el candado?', [
      { id: 'candado_si', title: '✅ Sí, incluirlo' },
      { id: 'candado_no', title: '❌ No, continuar' },
    ])
    return
  }

  // ── ESPERANDO PERSONALIZACIÓN ──────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_PERSONALIZACION) {
    setSession(jid, { state: STATES.OFERTA_CANDADO, pedido: { ...session.pedido, personalizacion: texto } })
    await sendMessage(jid, `✅ *Personalización registrada:* ${texto}`)
    await sendMessage(jid, msgOfertaCandado())
    await sendButtons(jid, '¿Deseas el candado?', [
      { id: 'candado_si', title: '✅ Sí, incluirlo' },
      { id: 'candado_no', title: '❌ No, continuar' },
    ])
    return
  }

  // ── ESPERANDO COMPROBANTE ──────────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_COMPROBANTE) {
    if (hasMedia) {
      setSession(jid, { state: STATES.INICIO, pedido: { candado: false } })
      await sendMessage(jid, msgPedidoCompleto())
      const owners = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
      for (const num of owners) {
        await sendMessage(num.trim() + '@s.whatsapp.net',
          `📸 *Comprobante recibido*\nCliente: ${jid.replace('@s.whatsapp.net', '')}`)
      }
    } else {
      await sendMessage(jid, '📸 Por favor envía el *pantallazo del comprobante de pago* para proceder.')
    }
    return
  }

  // ── ESPERANDO DATOS ENVÍO ──────────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_DATOS_ENVIO) {
    setSession(jid, { state: STATES.INICIO, pedido: { candado: false } })
    await sendMessage(jid, msgPedidoCompleto())
    const owners = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
    for (const num of owners) {
      await sendMessage(num.trim() + '@s.whatsapp.net',
        `📦 *Pedido contra entrega*\nCliente: ${jid.replace('@s.whatsapp.net', '')}\nDatos: ${texto}`)
    }
    return
  }

  // Fallback
  await sendButtons(jid, '¿En qué te puedo ayudar? 🧳', [
    { id: 'tallas', title: '📐 Tallas y medidas' },
    { id: 'colores', title: '🎨 Personalización' },
    { id: 'materiales', title: '💎 Materiales' },
    { id: 'precios', title: '💰 Precios' },
    { id: 'envios', title: '🚚 Envíos' },
    { id: 'formas_pago', title: '💳 Formas de pago' },
    { id: 'asesor', title: '👤 Hablar con asesor' },
  ])
}

// ─── Verificaciones ───────────────────────────────────────────────────────────
function verificarShopify(req, res, next) {
  const hmac = req.headers['x-shopify-hmac-sha256']
  if (!hmac) return res.status(401).json({ error: 'Sin firma' })
  const digest = crypto.createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody).digest('base64')
  if (digest !== hmac) return res.status(401).json({ error: 'Firma inválida' })
  next()
}
function verificarApi(req, res, next) {
  if (req.headers['x-api-secret'] !== process.env.API_SECRET)
    return res.status(401).json({ error: 'No autorizado' })
  next()
}

// ─── QR ───────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const { status } = getStatus()
  res.send(`<html><head><title>BlockBag Bot</title><meta http-equiv="refresh" content="5">
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

app.get('/health', (req, res) => res.json({ ok: true, status: getStatus().status }))

const hora = process.env.REPORT_HOUR || '7'
const minuto = process.env.REPORT_MINUTE || '0'
cron.schedule(`${minuto} ${Number(hora) + 5} * * *`, async () => {
  try {
    const stats = await getStatsHoy()
    const numeros = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
    for (const num of numeros) await sendMessage(num.trim() + '@s.whatsapp.net', msgReporteDiario(stats))
  } catch (e) { console.error('Error reporte:', e.message) }
}, { timezone: 'UTC' })

const PORT = process.env.PORT || 3000
app.listen(PORT, async () => {
  console.log(`🚀 BlockBag Bot corriendo en puerto ${PORT}`)
  setMessageHandler(handleMessage)
  await connectToWhatsApp()
})
