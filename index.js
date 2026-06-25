require('dotenv').config()
const express = require('express')
const QRCode = require('qrcode')
const cron = require('node-cron')
const crypto = require('crypto')
const axios = require('axios')

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'blogbagshop'
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN
const CATALOGO_WA = 'https://wa.me/c/573157571157'

async function crearPedidoShopify(session, datosEnvio) {
  try {
    const lineItems = []
    if (session.pedido.variantId) {
      lineItems.push({ variant_id: session.pedido.variantId, quantity: 1 })
    }
    if (session.pedido.candado && session.pedido.numeroCandados) {
      const candadoRes = await axios.get(
        'https://' + SHOPIFY_STORE + '.myshopify.com/admin/api/2024-01/products.json',
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }, params: { title: 'candado', limit: 1 } }
      )
      if (candadoRes.data.products?.length > 0) {
        lineItems.push({ variant_id: candadoRes.data.products[0].variants[0].id, quantity: session.pedido.numeroCandados || 1 })
      }
    }
    if (lineItems.length === 0) return null
    const partes = datosEnvio.split(/\n|,/)
    const nombre = partes[0]?.trim() || 'Cliente'
    const telefono = (datosEnvio.match(/\d{7,}/g) || [])[0] || ''
    const order = {
      line_items: lineItems,
      shipping_address: { first_name: nombre, address1: partes[1]?.trim() || '', city: partes[2]?.trim() || '', phone: telefono, country: 'CO' },
      financial_status: 'pending',
      note: 'Pedido por WhatsApp. Datos: ' + datosEnvio
    }
    const res = await axios.post(
      'https://' + SHOPIFY_STORE + '.myshopify.com/admin/api/2024-01/orders.json',
      { order },
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' } }
    )
    return res.data.order
  } catch (err) {
    console.error('Error creando pedido:', err.response?.data || err.message)
    return null
  }
}

const { connectToWhatsApp, sendMessage, sendMenu, sendImage, sendVideo, getStatus, setMessageHandler } = require('./whatsapp')
const { msgPedidoNuevo, msgPagoConfirmado, msgEnvioDespachado,
        msgCarritoAbandonado, msgReporteDiario,
        msgMateriales, msgEnvios, msgPagosDinamicos,
        msgPedidoCompleto } = require('./messages')
const { limpiarTelefono, getStatsHoy } = require('./shopify')

const app = express()
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }))

const sessions = new Map()
const STATES = {
  MENU: 'MENU',
  ESPERANDO_DISENO: 'ESPERANDO_DISENO',
  ESPERANDO_PERSONALIZACION: 'ESPERANDO_PERSONALIZACION',
  OFERTA_CANDADO: 'OFERTA_CANDADO',
  ESPERANDO_CANTIDAD_CANDADOS: 'ESPERANDO_CANTIDAD_CANDADOS',
  ESPERANDO_COMPROBANTE: 'ESPERANDO_COMPROBANTE',
  ESPERANDO_DATOS_ENVIO: 'ESPERANDO_DATOS_ENVIO',
  ESPERANDO_NUMERO_ASESOR: 'ESPERANDO_NUMERO_ASESOR',
  EN_ASESOR: 'EN_ASESOR',
}

const MINUTOS_ASESOR = 20
const NAV = '\n\n_Escribe *opciones* para ver el menu o *asesor* para hablar con nosotros_'

function getSession(jid) {
  if (!sessions.has(jid)) sessions.set(jid, { state: STATES.MENU, pedido: { candado: false } })
  return sessions.get(jid)
}
function setSession(jid, data) { sessions.set(jid, { ...getSession(jid), ...data }) }

function msgPagosDinamicosLocal() {
  const day = new Date().getDate()
  if (day <= 15) {
    return '💳 *Medios de Pago BlockBag*\n\n🔑 *Llave:* ' + (process.env.PAGO_Q1_NUMERO_1 || '66986350') + '\n📱 *Nequi:* ' + (process.env.PAGO_Q1_NUMERO_2 || '3174232091') + '\n\n📸 Envíanos el pantallazo del comprobante para proceder.\n\n✅ Paga fácil | ⚡ Rápido | 🔒 Seguro'
  } else {
    return '💳 *Medios de Pago BlockBag*\n\n🔑 *Llave:* ' + (process.env.PAGO_Q2_ALIAS_1 || '@VCE626') + '\n👤 *Titular:* ' + (process.env.PAGO_Q2_TITULAR_1 || 'Valentina Cervino') + '\n\n📲 Desde la app de tu banco, sin costo y de forma inmediata.\n\n📸 Envíanos el pantallazo del comprobante para proceder.'
  }
}

async function enviarGuiaMedidas(jid) {
  await sendVideo(jid, process.env.VIDEO_MEDIDAS_URL, '')
  await sendImage(jid, process.env.IMG_MEDIDAS_URL,
    '📏 *Guía de tallas BlockBag*\n\nMide tu maleta *sin contar las ruedas*.\n\nTeniendo en cuenta la información anterior, elige tu producto en nuestro catálogo:\n\n' + CATALOGO_WA + NAV)
}

async function notificarSandra(msg) {
  const owners = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
  for (const num of owners) {
    const limpio = num.trim().replace(/[^0-9]/g, '')
    if (!limpio) continue
    await sendMessage(limpio + '@s.whatsapp.net', msg)
  }
}

async function handleMessage(jid, texto, hasMedia, ordenMsg) {
  const t = (texto || '').trim().toLowerCase()
  const session = getSession(jid)

  // ── FIX PAUTA: mensaje vacío O primer contacto desde anuncio Meta ─
  const esPrimerContacto = !texto && !hasMedia && !ordenMsg
  const esSaludoPauta = t.includes('quiero') || t.includes('informacion') ||
    t.includes('información') || t.includes('más info') || t.includes('mas info') ||
    t.includes('buen') || t.includes('buenas') || t.includes('hola') ||
    t.includes('hi') || t.includes('hello') || t.includes('info') ||
    t === 'menu' || t === 'opciones' || t === 'inicio' || t === 'start'

  if (esPrimerContacto || (session.state === STATES.MENU && esSaludoPauta)) {
    setSession(jid, { state: STATES.MENU, pedido: { candado: false } })
    await sendMenu(jid)
    return
  }

  // ── COMANDOS GLOBALES: rompen cualquier estado incluyendo EN_ASESOR ──
  const esComandoGlobal = t === 'menu' || t === 'opciones' || t === 'inicio' ||
    t === 'start' || t.includes('menu') || t.includes('opcion')

  // ── EN ASESOR ─────────────────────────────────────────────────
  if (session.state === STATES.EN_ASESOR) {
    if (esComandoGlobal) {
      setSession(jid, { state: STATES.MENU, pedido: { candado: false }, asesorDesde: null })
      await sendMenu(jid)
      return
    }
    const ahora = Date.now()
    const tiempoAsesor = session.asesorDesde || ahora
    const minutosTranscurridos = (ahora - tiempoAsesor) / 60000
    if (minutosTranscurridos < MINUTOS_ASESOR) return
    setSession(jid, { state: STATES.MENU, pedido: { candado: false }, asesorDesde: null })
  }

  // ── CARRITO DE WHATSAPP ───────────────────────────────────────
  if (texto === '__CARRITO__' && ordenMsg) {
    const items = ordenMsg.products || []
    const cantidadItems = ordenMsg.itemCount || items.length || 1
    let precioTotal = 0
    if (ordenMsg.totalAmount1000) {
      precioTotal = Math.round(parseInt(ordenMsg.totalAmount1000) / 1000)
    } else {
      precioTotal = items.reduce((acc, item) => acc + (item.price ? parseFloat(item.price) : 0), 0)
      if (precioTotal === 0) precioTotal = 80000
    }
    const nombresProductos = items.length > 0 ? items.map(i => i.name || 'Producto').join(', ') : 'Productos seleccionados'
    const precioCandados = 22000 * cantidadItems
    const totalSinCandado = precioTotal + 15000
    const totalConCandado = precioTotal + 15000 + precioCandados
    setSession(jid, {
      state: STATES.OFERTA_CANDADO,
      pedido: { ...session.pedido, diseno: nombresProductos, precioTotal, cantidadItems, variantId: items[0]?.productId || null }
    })
    const msgCandado = cantidadItems > 1
      ? '🔒 ¿Deseas incluir *' + cantidadItems + ' candados* de seguridad ($22.000 c/u = $' + precioCandados.toLocaleString('es-CO') + ')?\n\nResponde *si*, *no*, o el número que deseas (ej: *2*)'
      : '🔒 ¿Deseas incluir el candado de seguridad ($22.000)?\n\nResponde *si* o *no*'
    await sendMessage(jid,
      '🛒 *¡Recibimos tu pedido!*\n\n📦 *' + nombresProductos + '*\n🔢 Cantidad: ' + cantidadItems + '\n\n💰 *Resumen:*\nProductos: $' + precioTotal.toLocaleString('es-CO') + '\nEnvío: $15.000\nCandado' + (cantidadItems > 1 ? 's' : '') + ' (opcional): $' + precioCandados.toLocaleString('es-CO') + '\n\n*Total sin candado: $' + totalSinCandado.toLocaleString('es-CO') + '*\n*Total con candado: $' + totalConCandado.toLocaleString('es-CO') + '*\n\n' + msgCandado + NAV)
    return
  }

  // ── MENU Y SALUDO ─────────────────────────────────────────────
  if (esComandoGlobal) {
    setSession(jid, { state: STATES.MENU, pedido: { candado: false } })
    await sendMenu(jid)
    return
  }

  // ── ASESOR ────────────────────────────────────────────────────
  if (t === '7' || t === 'asesor' || t.includes('asesor') || t.includes('hablar con')) {
    setSession(jid, { state: STATES.ESPERANDO_NUMERO_ASESOR })
    await sendMessage(jid, '👤 *Hablar con un asesor*\n\nPor favor escríbenos tu número de celular.\n\nEjemplo: *3001234567*')
    return
  }

  if (session.state === STATES.ESPERANDO_NUMERO_ASESOR) {
    const nums = texto.match(/\d+/g)
    if (!nums || nums.join('').length < 7) {
      await sendMessage(jid, 'Por favor escríbenos tu número de celular.\n\nEjemplo: *3001234567*')
      return
    }
    setSession(jid, { state: STATES.EN_ASESOR, asesorDesde: Date.now(), pedido: { candado: false } })
    await sendMessage(jid, '✅ Un asesor te contactará pronto. Gracias 🙏')
    await notificarSandra('🔔 *ALERTA: Cliente solicita asesor*\n\nNumero: ' + nums.join('') + '\n\nBusca este contacto en el chat de BlockBag.')
    return
  }

  // ── DIMENSIONES ───────────────────────────────────────────────
  const esDimension = t.includes('kilo') || t.includes('peso') || t.includes('pesa') ||
    t.includes('maleta grande') || t.includes('maleta pequeña') || t.includes('maleta peque') ||
    t.includes('qué talla') || t.includes('que talla') || t.includes('tamaño') ||
    t.includes('dimensi') || (t.includes('medida') && !session.state.includes('ESPERANDO'))
  if (esDimension) {
    if (t.includes('cabina') || t.includes('carry')) {
      await sendImage(jid, process.env.IMG_MEDIDAS_URL, '🧳 Las maletas de cabina siempre corresponden a la talla *S* en BlockBag.\n\nElige tu forro en el catálogo:\n\n' + CATALOGO_WA + NAV)
    } else {
      await enviarGuiaMedidas(jid)
    }
    return
  }

  if (t.includes('cabina') || t.includes('carry on') || t.includes('carry-on')) {
    await sendImage(jid, process.env.IMG_MEDIDAS_URL, '🧳 Las maletas de cabina siempre corresponden a la talla *S* en BlockBag.\n\nElige tu forro en el catálogo:\n\n' + CATALOGO_WA + NAV)
    return
  }

  // ── UBICACIÓN ─────────────────────────────────────────────────
  if (t.includes('ubicad') || t.includes('donde estan') || t.includes('dónde están') ||
      t.includes('donde quedan') || t.includes('donde est') || t.includes('dónde est')) {
    await sendMessage(jid, '📍 Despachamos desde *Cali, Colombia* a todo el país y al exterior.\n\nEl envío nacional tiene un costo de $15.000 🚚' + NAV)
    return
  }

  // ── CONTRA ENTREGA ────────────────────────────────────────────
  if (t.includes('contra entrega') || t.includes('contraentrega') || t.includes('contra-entrega') ||
      (t.includes('contra') && t.includes('entrega')) || t.includes('efectivo')) {
    await sendMessage(jid, '💳 Por el momento solo manejamos pago por *transferencia bancaria* (Llave / Nequi).\n\nCuando tengas tu pedido listo te enviamos los datos de pago.' + NAV)
    return
  }

  // ── PERSONALIZACION ───────────────────────────────────────────
  if (t.includes('personaliz')) {
    setSession(jid, { state: STATES.ESPERANDO_PERSONALIZACION })
    await sendImage(jid, process.env.IMG_PERSONALIZACION_URL, '🎨 *Personalización BlockBag*\n\nTiempo de entrega: *8 a 10 días hábiles*.\n\nIndícanos qué diseño quieres y en qué parte de la maleta.\n\nEscríbenos todos los detalles 👇' + NAV)
    return
  }

  if (session.state === STATES.ESPERANDO_PERSONALIZACION) {
    setSession(jid, { state: STATES.MENU })
    await sendMessage(jid, 'Personalización registrada ✅\n\nUn asesor te contactará para coordinar los detalles.' + NAV)
    await notificarSandra('🎨 *Solicitud de personalización*\nCliente: ' + jid.replace('@s.whatsapp.net', '') + '\nDetalle: ' + texto)
    return
  }

  // ── OFERTA CANDADO ────────────────────────────────────────────
  if (session.state === STATES.OFERTA_CANDADO) {
    const numWords = {'uno':1,'dos':2,'tres':3,'cuatro':4,'cinco':5,'seis':6,'siete':7,'ocho':8,'nueve':9,'diez':10}
    let candadosN = null
    const mNum = t.match(/\d+/)
    if (mNum) candadosN = parseInt(mNum[0])
    else { for (const [w, n] of Object.entries(numWords)) { if (t.includes(w)) { candadosN = n; break } } }
    const quiere = ['si', 'sí', 'claro', 'dale', 'yes'].some(r => t === r || t.startsWith(r))
    const noQuiere = t === 'no' || t === 'no gracias'
    if (candadosN !== null && !quiere && !noQuiere) {
      const pc = 22000 * candadosN
      const tot = (session.pedido.precioTotal || 0) + 15000 + pc
      setSession(jid, { state: STATES.ESPERANDO_COMPROBANTE, pedido: { ...session.pedido, candado: true, numeroCandados: candadosN } })
      const day = new Date().getDate()
      const imgUrl = day <= 15 ? process.env.PAGO_Q1_IMAGEN_URL : process.env.PAGO_Q2_IMAGEN_URL
      await sendMessage(jid, '🔒 *' + candadosN + ' candado' + (candadosN > 1 ? 's' : '') + ' agregado' + (candadosN > 1 ? 's' : '') + '* ($' + pc.toLocaleString('es-CO') + ')\n\n💰 *Total: $' + tot.toLocaleString('es-CO') + '*\n\n📸 Realiza tu pago y envíanos el comprobante:')
      await sendImage(jid, imgUrl, msgPagosDinamicosLocal())
      return
    }
    if (quiere || noQuiere) {
      const numeroCandados = quiere ? (session.pedido.cantidadItems || 1) : 0
      const pc = 22000 * numeroCandados
      const tot = (session.pedido.precioTotal || 0) + 15000 + (quiere ? pc : 0)
      setSession(jid, { state: STATES.ESPERANDO_COMPROBANTE, pedido: { ...session.pedido, candado: quiere, numeroCandados } })
      const msg = quiere ? '🔒 Candado' + (numeroCandados > 1 ? 's' : '') + ' agregado' + (numeroCandados > 1 ? 's' : '') + ' ($' + pc.toLocaleString('es-CO') + ')\n\n' : 'Sin candado.\n\n'
      const day = new Date().getDate()
      const imgUrl = day <= 15 ? process.env.PAGO_Q1_IMAGEN_URL : process.env.PAGO_Q2_IMAGEN_URL
      await sendMessage(jid, msg + '💰 *Total: $' + tot.toLocaleString('es-CO') + '*\n\n📸 Realiza tu pago y envíanos el comprobante:')
      await sendImage(jid, imgUrl, msgPagosDinamicosLocal())
      return
    }
    await sendMessage(jid, '¿Deseas incluir el candado de seguridad?\n\nResponde *si*, *no*, o el número que deseas (ej: *2*)' + NAV)
    return
  }

  // ── COMPROBANTE ───────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_COMPROBANTE) {
    if (hasMedia) {
      setSession(jid, { state: STATES.ESPERANDO_DATOS_ENVIO })
      await sendMessage(jid, '✅ Comprobante recibido.\n\nAhora envíanos tus datos de envío en un mensaje:\n\n👤 Nombre completo\n🏠 Dirección de entrega\n🏙️ Ciudad\n📱 Teléfono de contacto')
    } else {
      await sendMessage(jid, '📸 Por favor envíanos el pantallazo del comprobante de pago para proceder.' + NAV)
    }
    return
  }

  // ── DATOS DE ENVIO ────────────────────────────────────────────
  if (session.state === STATES.ESPERANDO_DATOS_ENVIO) {
    if (!texto || texto.trim().length < 5) {
      await sendMessage(jid, 'Por favor envíanos tus datos completos:\n\n👤 Nombre completo\n🏠 Dirección\n🏙️ Ciudad\n📱 Teléfono' + NAV)
      return
    }
    const orden = await crearPedidoShopify(session, texto)
    setSession(jid, { state: STATES.MENU, pedido: { candado: false } })
    if (orden) {
      await sendMessage(jid, '✅ *¡Pedido creado!*\n\n📦 Orden #' + orden.order_number + '\n\nSandra se pondrá en contacto contigo para coordinar el despacho.\n\n¡Gracias por tu compra en BlockBag! 🧳❤️')
      await notificarSandra('📦 *NUEVO PEDIDO CONFIRMADO*\n\nOrden #' + orden.order_number + '\nProducto: ' + session.pedido.diseno + '\nDatos: ' + texto + '\nTotal: $' + ((session.pedido.precioTotal || 0) + 15000 + (session.pedido.candado ? 22000 * (session.pedido.numeroCandados || 1) : 0)).toLocaleString('es-CO'))
    } else {
      await sendMessage(jid, '✅ Pedido recibido.\n\nSandra se pondrá en contacto contigo para coordinar el despacho.\n\n¡Gracias por tu compra en BlockBag! 🧳❤️')
      await notificarSandra('📦 *NUEVO PEDIDO*\nProducto: ' + session.pedido.diseno + '\nDatos: ' + texto)
    }
    return
  }

  // ── OPCIONES DEL MENU ─────────────────────────────────────────
  if (t === '1' || t.includes('medida') || t.includes('talla')) { await enviarGuiaMedidas(jid); return }
  if (t === '2' || t.includes('material')) { await sendMessage(jid, msgMateriales() + NAV); return }
  if (t === '3' || t.includes('precio') || t.includes('valor') || t.includes('costo')) {
    await sendMessage(jid, '💰 *Precios BlockBag*\n\n🛍️ Ver catálogo con todos los precios y productos:\n' + CATALOGO_WA + NAV)
    return
  }
  if (t === '4' || t.includes('envio') || t.includes('envío') || t.includes('despacho')) { await sendMessage(jid, msgEnvios() + NAV); return }
  if (t === '5' || t.includes('forma de pago') || t.includes('como pago') || t.includes('cómo pago')) {
    const day = new Date().getDate()
    const imgUrl = day <= 15 ? process.env.PAGO_Q1_IMAGEN_URL : process.env.PAGO_Q2_IMAGEN_URL
    await sendImage(jid, imgUrl, msgPagosDinamicosLocal() + NAV)
    return
  }
  if (t === '6' || t.includes('catalogo') || t.includes('catálogo')) {
    await sendMessage(jid, '🛍️ *Catálogo BlockBag*\n\nVe todos nuestros productos con fotos y precios:\n\n' + CATALOGO_WA + '\n\nAgrega lo que quieras al carrito y envíanoslo directamente desde el catálogo 👇' + NAV)
    return
  }

  // ── CATCH-ALL: pausa 20 min ───────────────────────────────────
  setSession(jid, { state: STATES.EN_ASESOR, asesorDesde: Date.now() })
  await sendMessage(jid, '👤 Enseguida te derivamos con un asesor que te ayudará.\n\n_Escribe *opciones* si deseas ver el menú_')
}

function verificarShopify(req, res, next) {
  const hmac = req.headers['x-shopify-hmac-sha256']
  if (!hmac) return res.status(401).json({ error: 'Sin firma' })
  const digest = crypto.createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET).update(req.rawBody).digest('base64')
  if (digest !== hmac) return res.status(401).json({ error: 'Firma invalida' })
  next()
}
function verificarApi(req, res, next) {
  if (req.headers['x-api-secret'] !== process.env.API_SECRET) return res.status(401).json({ error: 'No autorizado' })
  next()
}

app.get('/', (req, res) => {
  const { status } = getStatus()
  res.send('<html><head><title>BlockBag Bot</title><meta http-equiv="refresh" content="5"><style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f0f2f5}h1{color:#075E54}.status{padding:12px 24px;border-radius:20px;display:inline-block;font-weight:bold}.connected{background:#d4edda;color:#155724}.disconnected{background:#fff3cd;color:#856404}</style></head><body><h1>BlockBag WhatsApp Bot</h1><p class="status ' + (status === 'connected' ? 'connected' : 'disconnected') + '">' + (status === 'connected' ? 'Conectado' : status === 'qr_ready' ? 'Escanea el QR en /qr' : 'Conectando...') + '</p>' + (status !== 'connected' ? '<p><a href="/qr">Ver codigo QR</a></p>' : '') + '</body></html>')
})
app.get('/qr', async (req, res) => {
  const { status, qr } = getStatus()
  if (status === 'connected') return res.send('<h2 style="font-family:sans-serif;color:green;text-align:center">Ya conectado</h2>')
  if (!qr) return res.send('<h2 style="font-family:sans-serif;text-align:center">Generando QR... recarga en 5 seg</h2><meta http-equiv="refresh" content="5">')
  const img = await QRCode.toDataURL(qr, { width: 300 })
  res.send('<html><head><title>QR</title><meta http-equiv="refresh" content="30"></head><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Escanea con WhatsApp</h2><img src="' + img + '" style="border:4px solid #075E54;border-radius:12px"/></body></html>')
})
app.post('/webhook/orders/create', verificarShopify, async (req, res) => { res.sendStatus(200); try { const order = req.body; const phone = limpiarTelefono(order.billing_address?.phone || order.phone); if (!phone) return; await sendMessage(phone + '@s.whatsapp.net', msgPedidoNuevo(order)) } catch (e) { console.error(e.message) } })
app.post('/webhook/orders/paid', verificarShopify, async (req, res) => { res.sendStatus(200); try { const order = req.body; const phone = limpiarTelefono(order.billing_address?.phone || order.phone); if (!phone) return; await sendMessage(phone + '@s.whatsapp.net', msgPagoConfirmado(order)) } catch (e) { console.error(e.message) } })
app.post('/webhook/orders/fulfilled', verificarShopify, async (req, res) => { res.sendStatus(200); try { const order = req.body; const phone = limpiarTelefono(order.billing_address?.phone || order.phone); if (!phone) return; const tr = order.fulfillments?.[0] || {}; await sendMessage(phone + '@s.whatsapp.net', msgEnvioDespachado(order, { number: tr.tracking_number, company: tr.tracking_company, url: tr.tracking_url })) } catch (e) { console.error(e.message) } })
app.post('/webhook/checkout/abandoned', verificarShopify, async (req, res) => { res.sendStatus(200); try { const checkout = req.body; const phone = limpiarTelefono(checkout.billing_address?.phone || checkout.phone); if (!phone) return; await sendMessage(phone + '@s.whatsapp.net', msgCarritoAbandonado(checkout, 1)) } catch (e) { console.error(e.message) } })
app.post('/api/send', verificarApi, async (req, res) => { try { const { phone, message } = req.body; if (!phone || !message) return res.status(400).json({ error: 'Falta phone o message' }); await sendMessage(limpiarTelefono(phone) + '@s.whatsapp.net', message); res.json({ ok: true }) } catch (e) { res.status(500).json({ error: e.message }) } })
app.post('/api/reporte', verificarApi, async (req, res) => { try { const statsBase = await getStatsHoy(); const stats = { ...statsBase, ...req.body }; const numeros = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean); for (const num of numeros) await sendMessage(num.trim().replace(/[^0-9]/g, '') + '@s.whatsapp.net', msgReporteDiario(stats)); res.json({ ok: true }) } catch (e) { res.status(500).json({ error: e.message }) } })
app.get('/health', (req, res) => res.json({ ok: true, status: getStatus().status }))

const hora = process.env.REPORT_HOUR || '7'
const minuto = process.env.REPORT_MINUTE || '0'
cron.schedule(minuto + ' ' + (Number(hora) + 5) + ' * * *', async () => { try { const stats = await getStatsHoy(); const numeros = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean); for (const num of numeros) await sendMessage(num.trim().replace(/[^0-9]/g, '') + '@s.whatsapp.net', msgReporteDiario(stats)) } catch (e) { console.error(e.message) } }, { timezone: 'UTC' })

const PORT = process.env.PORT || 3000
app.listen(PORT, async () => {
  console.log('BlockBag Bot corriendo en puerto ' + PORT)
  setMessageHandler(handleMessage)
  await connectToWhatsApp()
})
