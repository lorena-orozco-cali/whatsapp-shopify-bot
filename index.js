require('dotenv').config()
const express = require('express')
const QRCode = require('qrcode')
const cron = require('node-cron')
const crypto = require('crypto')

const { connectToWhatsApp, sendMessage, sendMenu, sendImage, getStatus, setMessageHandler } = require('./whatsapp')
const { msgPedidoNuevo, msgPagoConfirmado, msgEnvioDespachado,
        msgCarritoAbandonado, msgPostventa, msgReporteDiario,
        msgMateriales, msgEnvios, msgOfertaCandado, msgPagosDinamicos,
        msgContraEntrega, msgPedirDatosEnvio, msgPedidoCompleto } = require('./messages')
const { limpiarTelefono, getStatsHoy } = require('./shopify')

const app = express()
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }))

// ─── Sesiones ──────────────────────────────────────────────────────────────────
const sessions = new Map()
const STATES = {
  MENU: 'MENU',
  ESPERANDO_MEDIDAS: 'ESPERANDO_MEDIDAS',
  ESPERANDO_DISENO: 'ESPERANDO_DISENO',
  ESPERANDO_PERSONALIZACION: 'ESPERANDO_PERSONALIZACION',
  ESPERANDO_DATOS_PEDIDO: 'ESPERANDO_DATOS_PEDIDO',
  OFERTA_CANDADO: 'OFERTA_CANDADO',
  SELECCION_PAGO: 'SELECCION_PAGO',
  CONFIRMACION_COD: 'CONFIRMACION_COD',
  ESPERANDO_COMPROBANTE: 'ESPERANDO_COMPROBANTE',
}

function getSession(jid) {
  if (!sessions.has(jid)) sessions.set(jid, { state: STATES.MENU, pedido: {} })
  return sessions.get(jid)
}
function setSession(jid, data) { sessions.set(jid, { ...getSession(jid), ...data }) }

// ─── Calcular talla ────────────────────────────────────────────────────────────
function calcularTalla(texto) {
  const nums = texto.match(/\d+/g)
  if (!nums || nums.length < 2) return null
  const alto = parseInt(nums[0])
  if (alto < 55) return 'S'
  if (alto < 66) return 'M'
  if (alto < 71) return 'L'
  return 'XL'
}

// ─── Manejador principal ───────────────────────────────────────────────────────
async function handleMessage(jid, texto, hasMedia) {
  const t = (texto || '').trim().toLowerCase()
  const session = getSession(jid)

  // Asesor — siempre disponible en cualquier estado
  if (t === '6' || t === 'asesor' || t.includes('asesor') || t.includes('humano')) {
    await sendMessage(jid, '👤 *Conectando con un asesor...*\n\nEn breve alguien del equipo BlockBag te atenderá. ¡Gracias por tu paciencia! 🙏')
    const owners = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
    for (const num of owners) {
      await sendMessage(`${num.trim()}@s.whatsapp.net`,
        `👤 *Cliente solicita asesor*\nNúmero: ${jid.replace('@s.whatsapp.net', '')}`)
    }
    return
  }

  // Personalización — solo si el cliente la pide explícitamente
  if (t.includes('personaliz')) {
    setSession(jid, { state: STATES.ESPERANDO_PERSONALIZACION })
    await sendImage(jid, process.env.IMG_PERSONALIZACION_URL,
      '🎨 *Personalización BlockBag*\n\nIndícanos qué diseño quieres y en qué parte de la maleta.\n\nEscríbenos todos los detalles 👇')
    return
  }

  // Reiniciar con hola/menu
  const esMenuTrigger = ['hola', 'menu', 'menú', 'inicio', 'start', 'hi', 'buenas'].some(w => t.includes(w))
  if (esMenuTrigger) {
    setSession(jid, { state: STATES.MENU, pedido: {} })
    await sendMenu(jid)
    return
  }

  // ── ESTADO MENU — procesar opciones numéricas ──────────────────────────────
  if (session.state === STATES.MENU) {
    if (t === '1' || t.includes('medida') || t.includes('talla')) {
      setSession(jid, { state: STATES.ESPERANDO_MEDIDAS })
      await sendImage(jid, process.env.IMG_MEDIDAS_URL,
        '📏 *Guía de medidas — Forros BlockBag*\n\nMide tu maleta *sin contar las ruedas* y envíame:\n\n↕️ *Alto* en cm\n↔️ *Ancho* en cm\n\nEjemplo: _65 45_')
      return
    }
    if (t === '2' || t.includes('material')) {
      await sendMessage(jid, msgMateriales())
      await sendMessage(jid, '¿Te puedo ayudar con algo más?\n\n1️⃣ Tallas y medidas\n5️⃣ Formas de pago\n6️⃣ Hablar con asesor')
      return
    }
    if (t === '3' || t.includes('precio')) {
      await sendMessage(jid, '💰 *Precios BlockBag*\n\nEscríbenos para cotizar. Un asesor te responde de inmediato.\n\nEscribe *asesor* para hablar con nosotros.')
      return
    }
    if (t === '4' || t.includes('envío') || t.includes('envio')) {
      await sendMessage(jid, msgEnvios())
      await sendMessage(jid, '¿Deseas continuar?\n\n1️⃣ Ver tallas\n5️⃣ Formas de pago\n6️⃣ Hablar con asesor')
      return
    }
    if (t === '5' || t.includes('pago') || t.includes('forma')) {
      setSession(jid, { state: STATES.OFERTA_CANDADO })
      await sendMessage(jid, msgOfertaCandado())
      return
    }
    // Si escribe algo que no reconocemos en el menú
    await sendMenu(jid)
    return
  }

  // ── ESPERANDO MEDIDAS ──────────────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_MEDIDAS) {
    const talla = calcularTalla(texto)
    setSession(jid, { state: STATES.ESPERANDO_DISENO, pedido: { ...session.pedido, medidas: texto, talla } })
    const tallaMsg = talla
      ? `✅ Con esas medidas, tu talla recomendada es *${talla}*.\n\n`
      : `✅ Medidas registradas: ${texto}\n\n`
    await sendMessage(jid, tallaMsg + '¿Qué diseño deseas para tu forro?\n\nEscribe el diseño que tienes en mente o escribe *catalogo* para ver opciones disponibles.')
    return
  }

  // ── ESPERANDO DISEÑO ───────────────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_DISENO) {
    setSession(jid, { state: STATES.ESPERANDO_DATOS_PEDIDO, pedido: { ...session.pedido, diseno: texto } })
    await sendMessage(jid,
      `✅ *Diseño registrado:* ${texto}\n\n📝 Para finalizar tu solicitud, por favor envíanos:\n\n👤 *Nombre completo*\n🏠 *Dirección de entrega*\n🏙️ *Ciudad*\n📱 *Teléfono de contacto*\n\nEnvíalos en un solo mensaje 👇`)
    return
  }

  // ── ESPERANDO PERSONALIZACIÓN ──────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_PERSONALIZACION) {
    setSession(jid, { state: STATES.ESPERANDO_DATOS_PEDIDO, pedido: { ...session.pedido, personalizacion: texto } })
    await sendMessage(jid,
      `✅ *Personalización registrada:* ${texto}\n\n📝 Para finalizar tu solicitud, por favor envíanos:\n\n👤 *Nombre completo*\n🏠 *Dirección de entrega*\n🏙️ *Ciudad*\n📱 *Teléfono de contacto*\n\nEnvíalos en un solo mensaje 👇`)
    return
  }

  // ── ESPERANDO DATOS DEL PEDIDO ─────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_DATOS_PEDIDO) {
    setSession(jid, { state: STATES.OFERTA_CANDADO, pedido: { ...session.pedido, datosPedido: texto } })
    await sendMessage(jid, msgOfertaCandado())
    return
  }

  // ── OFERTA CANDADO ─────────────────────────────────────────────────────────
  if (session.state === STATES.OFERTA_CANDADO) {
    const quiere = ['si', 'sí', 'claro', 'dale', 'yes'].some(r => t.includes(r))
    const noQuiere = t === 'no' || t.startsWith('no ')
    if (quiere || noQuiere) {
      setSession(jid, { state: STATES.SELECCION_PAGO, pedido: { ...session.pedido, candado: quiere } })
      const msg = quiere
        ? `✅ *Candado agregado* 🔒 +$${Number(process.env.CANDADO_PRECIO || 10000).toLocaleString('es-CO')}\n\n`
        : 'De acuerdo, sin candado.\n\n'
      await sendMessage(jid, msg + '💳 ¿Cómo deseas pagar?\n\n1️⃣ Transferencia (Llave / Nequi)\n2️⃣ Pago contra entrega')
      return
    }
    await sendMessage(jid, msgOfertaCandado())
    return
  }

  // ── SELECCIÓN PAGO ─────────────────────────────────────────────────────────
  if (session.state === STATES.SELECCION_PAGO) {
    if (t === '1' || t.includes('transfer') || t.includes('llave') || t.includes('nequi')) {
      setSession(jid, { state: STATES.ESPERANDO_COMPROBANTE })
      const day = new Date().getDate()
      const imgUrl = day <= 15 ? process.env.PAGO_Q1_IMAGEN_URL : process.env.PAGO_Q2_IMAGEN_URL
      await sendImage(jid, imgUrl, msgPagosDinamicos())
      return
    }
    if (t === '2' || t.includes('contra') || t.includes('efectivo')) {
      setSession(jid, { state: STATES.CONFIRMACION_COD })
      await sendMessage(jid, msgContraEntrega())
      return
    }
    await sendMessage(jid, '💳 Responde *1* para transferencia o *2* para contra entrega.')
    return
  }

  // ── CONFIRMACIÓN CONTRA ENTREGA ────────────────────────────────────────────
  if (session.state === STATES.CONFIRMACION_COD) {
    if (['si', 'sí', 'confirmo', 'acepto', 'ok', 'dale'].some(r => t.includes(r))) {
      setSession(jid, { state: STATES.MENU, pedido: {} })
      await sendMessage(jid, msgPedidoCompleto())
      const owners = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
      for (const num of owners) {
        await sendMessage(`${num.trim()}@s.whatsapp.net`,
          `📦 *Pedido contra entrega*\nCliente: ${jid.replace('@s.whatsapp.net', '')}\nDatos: ${JSON.stringify(session.pedido)}`)
      }
    } else {
      setSession(jid, { state: STATES.SELECCION_PAGO })
      await sendMessage(jid, '💳 Responde *1* para transferencia o *2* para contra entrega.')
    }
    return
  }

  // ── ESPERANDO COMPROBANTE ──────────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_COMPROBANTE) {
    if (hasMedia) {
      setSession(jid, { state: STATES.MENU, pedido: {} })
      await sendMessage(jid, msgPedidoCompleto())
      const owners = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
      for (const num of owners) {
        await sendMessage(`${num.trim()}@s.whatsapp.net`,
          `📸 *Comprobante recibido*\nCliente: ${jid.replace('@s.whatsapp.net', '')}\nPedido: ${JSON.stringify(session.pedido)}`)
      }
    } else {
      await sendMessage(jid, '📸 Por favor envía el *pantallazo del comprobante* para proceder.')
    }
    return
  }

  // Fallback
  await sendMenu(jid)
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
