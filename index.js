require('dotenv').config()
const express = require('express')
const QRCode = require('qrcode')
const cron = require('node-cron')
const crypto = require('crypto')
const axios = require('axios')

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || 'blogbagshop'
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN

async function crearPedidoShopify(session, datosEnvio) {
  try {
    const lineItems = []
    if (session.pedido.variantId) {
      lineItems.push({ variant_id: session.pedido.variantId, quantity: 1 })
    }
    if (session.pedido.candado) {
      const candadoRes = await axios.get(
        'https://' + SHOPIFY_STORE + '.myshopify.com/admin/api/2024-01/products.json',
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }, params: { title: 'candado', limit: 1 } }
      )
      if (candadoRes.data.products?.length > 0) {
        lineItems.push({ variant_id: candadoRes.data.products[0].variants[0].id, quantity: 1 })
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

async function buscarProducto(nombre) {
  try {
    const res = await axios.get(
      'https://' + SHOPIFY_STORE + '.myshopify.com/admin/api/2024-01/products.json',
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }, params: { title: nombre, limit: 5 } }
    )
    const products = res.data.products
    if (products?.length > 0) {
      const product = products[0]
      const variant = product.variants[0]
      return { variantId: variant.id, title: product.title, price: variant.price, found: true }
    }
    return { found: false }
  } catch (err) {
    console.error('Error buscando producto:', err.message)
    return { found: false }
  }
}

const { connectToWhatsApp, sendMessage, sendMenu, sendImage, getStatus, setMessageHandler } = require('./whatsapp')
const { msgPedidoNuevo, msgPagoConfirmado, msgEnvioDespachado,
        msgCarritoAbandonado, msgPostventa, msgReporteDiario,
        msgMateriales, msgEnvios, msgOfertaCandado, msgPagosDinamicos,
        msgContraEntrega, msgPedirDatosEnvio, msgPedidoCompleto } = require('./messages')
const { limpiarTelefono, getStatsHoy } = require('./shopify')

const app = express()
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf } }))

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
  ESPERANDO_DATOS_ENVIO: 'ESPERANDO_DATOS_ENVIO',
  ESPERANDO_NUMERO_ASESOR: 'ESPERANDO_NUMERO_ASESOR',
}

const NAV = '\n\n_Escribe *opciones* para ver el menu o *asesor* para hablar con nosotros_'

function getSession(jid) {
  if (!sessions.has(jid)) sessions.set(jid, { state: STATES.MENU, pedido: { candado: false } })
  return sessions.get(jid)
}
function setSession(jid, data) { sessions.set(jid, { ...getSession(jid), ...data }) }

function calcularPrecioDiseno(diseno) {
  const d = diseno.toLowerCase()
  if (d.includes('basico') || d.includes('básico')) return 60000
  return 80000
}

async function notificarAsesor(numeroCliente) {
  const owners = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
  for (const num of owners) {
    await sendMessage(num.trim().replace(/[^0-9]/g, '') + '@s.whatsapp.net',
      '🔔 *ALERTA: Cliente solicita asesor*\n\nNumero: ' + numeroCliente + '\n\nBusca este contacto en el chat de BlockBag.')
  }
}

async function handleMessage(jid, texto, hasMedia) {
  const t = (texto || '').trim().toLowerCase()
  const session = getSession(jid)

  if (t === 'menu' || t === 'opciones' || t === 'inicio' || t === 'start' ||
      t === 'hola' || t === 'hi' || t === 'buenas' || t.includes('menu') || t.includes('opcion')) {
    setSession(jid, { state: STATES.MENU, pedido: { candado: false } })
    await sendMenu(jid)
    return
  }

  if (t === '7' || t === 'asesor' || t.includes('asesor') || t.includes('hablar con')) {
    setSession(jid, { state: STATES.ESPERANDO_NUMERO_ASESOR })
    await sendMessage(jid, '👤 *Hablar con un asesor*\n\nPor favor escríbenos tu número de celular.\n\nEjemplo: *3001234567*')
    return
  }

  if (t.includes('personaliz')) {
    setSession(jid, { state: STATES.ESPERANDO_PERSONALIZACION })
    await sendImage(jid, process.env.IMG_PERSONALIZACION_URL,
      '🎨 *Personalizacion BlockBag*\n\nTiempo de entrega: *8 a 10 dias habiles*.\n\nIndicanos que diseno quieres y en que parte de la maleta.\n\nEscribenos todos los detalles 👇' + NAV)
    return
  }

  if (session.state === STATES.ESPERANDO_NUMERO_ASESOR) {
    const nums = texto.match(/\d+/g)
    if (!nums || nums.join('').length < 7) {
      await sendMessage(jid, 'Por favor escríbenos tu número de celular.\n\nEjemplo: *3001234567*')
      return
    }
    setSession(jid, { state: STATES.MENU })
    await sendMessage(jid, '✅ Un asesor te contactará pronto. Gracias 🙏')
    await notificarAsesor(nums.join(''))
    return
  }

  if (session.state === STATES.ESPERANDO_MEDIDAS) {
    const nums = texto.match(/\d+/g)
    const esTalla = /^(xs|s|m|l|xl|talla)$/i.test(texto.trim())
    if (!texto || texto.trim().length < 2 || !nums || esTalla) {
      await sendMessage(jid, 'Necesito las medidas en centimetros.\n\nEjemplo: *alto 65 ancho 45*\n\n(sin contar las ruedas)\n\n_Si tienes dudas escribe *asesor*_' + NAV)
      return
    }
    setSession(jid, { state: STATES.ESPERANDO_DISENO, pedido: { ...session.pedido, medidas: texto } })
    await sendMessage(jid, 'Medidas registradas ✅\n\nQue diseno deseas para tu forro?\n\nVisita nuestra tienda:\nhttps://blockbag.co\n\nEscribenos el nombre del producto o mandanos la foto 👇\n\n_Si tienes dudas con las medidas, escribe *asesor*_' + NAV)
    return
  }

  if (session.state === STATES.ESPERANDO_DISENO) {
    if (!hasMedia && (!texto || texto.trim().length < 2)) {
      await sendMessage(jid, 'Por favor escríbenos el nombre del producto o mandanos la foto.' + NAV)
      return
    }
    const diseno = hasMedia ? 'Foto enviada por el cliente' : texto
    await sendMessage(jid, '🔍 Buscando tu producto...')
    const producto = await buscarProducto(diseno)
    if (producto.found) {
      const precioForro = parseFloat(producto.price)
      const totalSinCandado = precioForro + 15000
      const totalConCandado = precioForro + 15000 + 22000
      setSession(jid, { state: STATES.OFERTA_CANDADO, pedido: { ...session.pedido, diseno: producto.title, precioForro, variantId: producto.variantId } })
      await sendMessage(jid, '✅ *' + producto.title + '*\n\n💰 *Resumen:*\nForro: $' + precioForro.toLocaleString('es-CO') + '\nEnvio: $15.000\nCandado (opcional): $22.000\n\n*Total sin candado: $' + totalSinCandado.toLocaleString('es-CO') + '*\n*Total con candado: $' + totalConCandado.toLocaleString('es-CO') + '*\n\n¿Deseas incluir el candado?\n\nResponde *si* o *no*' + NAV)
    } else {
      const precioForro = calcularPrecioDiseno(diseno)
      const totalSinCandado = precioForro + 15000
      const totalConCandado = precioForro + 15000 + 22000
      setSession(jid, { state: STATES.OFERTA_CANDADO, pedido: { ...session.pedido, diseno, precioForro } })
      await sendMessage(jid, 'Diseno registrado ✅\n\n💰 *Resumen:*\nForro: $' + precioForro.toLocaleString('es-CO') + '\nEnvio: $15.000\nCandado (opcional): $22.000\n\n*Total sin candado: $' + totalSinCandado.toLocaleString('es-CO') + '*\n*Total con candado: $' + totalConCandado.toLocaleString('es-CO') + '*\n\n¿Deseas incluir el candado?\n\nResponde *si* o *no*' + NAV)
    }
    return
  }

  if (session.state === STATES.ESPERANDO_PERSONALIZACION) {
    setSession(jid, { state: STATES.ESPERANDO_DATOS_PEDIDO, pedido: { ...session.pedido, personalizacion: texto } })
    await sendMessage(jid, 'Personalizacion registrada ✅\n\nPara finalizar envianos:\n\n👤 Nombre completo\n🏠 Direccion\n🏙️ Ciudad\n📱 Telefono\n\nTodo en un mensaje 👇' + NAV)
    return
  }

  if (session.state === STATES.OFERTA_CANDADO) {
    const quiere = ['si', 'si quiero', 'claro', 'dale', 'yes', 'sí'].some(r => t === r || t.startsWith(r))
    const noQuiere = t === 'no' || t === 'no gracias'
    if (quiere || noQuiere) {
      setSession(jid, { state: STATES.ESPERANDO_DATOS_PEDIDO, pedido: { ...session.pedido, candado: quiere } })
      const msg = quiere ? 'Candado agregado 🔒 +$22.000\n\n' : 'Sin candado.\n\n'
      await sendMessage(jid, msg + 'Para finalizar envianos tus datos en un solo mensaje:\n\n👤 Nombre completo\n🏠 Direccion de entrega\n🏙️ Ciudad\n📱 Telefono de contacto' + NAV)
      return
    }
    await sendMessage(jid, '¿Deseas incluir el candado de seguridad por $22.000?\n\nResponde *si* o *no*' + NAV)
    return
  }

  if (session.state === STATES.ESPERANDO_DATOS_PEDIDO) {
    if (!texto || texto.trim().length < 5) {
      await sendMessage(jid, 'Por favor envianos tus datos completos:\n\n👤 Nombre completo\n🏠 Direccion\n🏙️ Ciudad\n📱 Telefono' + NAV)
      return
    }
    setSession(jid, { state: STATES.SELECCION_PAGO, pedido: { ...session.pedido, datos: texto } })
    await sendMessage(jid, '✅ Datos registrados.\n\n💳 ¿Como deseas pagar?\n\n1️⃣ Transferencia (Llave / Nequi)\n2️⃣ Pago contra entrega' + NAV)
    return
  }

  if (session.state === STATES.SELECCION_PAGO) {
    if (t === '1' || t.includes('transfer') || t.includes('llave') || t.includes('nequi')) {
      setSession(jid, { state: STATES.ESPERANDO_COMPROBANTE })
      const day = new Date().getDate()
      const imgUrl = day <= 15 ? process.env.PAGO_Q1_IMAGEN_URL : process.env.PAGO_Q2_IMAGEN_URL
      await sendImage(jid, imgUrl, msgPagosDinamicos() + NAV)
      return
    }
    if (t === '2' || t.includes('contra') || t.includes('efectivo')) {
      setSession(jid, { state: STATES.CONFIRMACION_COD })
      await sendMessage(jid, msgContraEntrega() + NAV)
      return
    }
    await sendMessage(jid, 'Responde *1* transferencia o *2* contra entrega.' + NAV)
    return
  }

  if (session.state === STATES.CONFIRMACION_COD) {
    if (['si', 'confirmo', 'acepto', 'ok', 'dale'].some(r => t.includes(r))) {
      await sendMessage(jid, '⏳ Procesando tu pedido...')
      const orden = await crearPedidoShopify(session, session.pedido.datos || '')
      setSession(jid, { state: STATES.MENU, pedido: { candado: false } })
      if (orden) {
        await sendMessage(jid, '✅ *¡Pedido creado!*\n\n📦 Orden #' + orden.order_number + '\n\nMuy pronto recibirás tu guia de despacho.\n\n¡Gracias por tu compra en BlockBag! 🧳❤️')
        const owners = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
        for (const num of owners) {
          await sendMessage(num.trim().replace(/[^0-9]/g, '') + '@s.whatsapp.net',
            '📦 *Nuevo pedido contra entrega*\nOrden #' + orden.order_number + '\nProducto: ' + session.pedido.diseno + '\nDatos: ' + session.pedido.datos)
        }
      } else {
        await sendMessage(jid, msgPedidoCompleto())
      }
    } else {
      setSession(jid, { state: STATES.SELECCION_PAGO })
      await sendMessage(jid, '💳 ¿Como deseas pagar?\n\n1️⃣ Transferencia\n2️⃣ Contra entrega' + NAV)
    }
    return
  }

  if (session.state === STATES.ESPERANDO_COMPROBANTE) {
    if (hasMedia) {
      await sendMessage(jid, '⏳ Verificando y creando tu pedido...')
      const orden = await crearPedidoShopify(session, session.pedido.datos || '')
      setSession(jid, { state: STATES.MENU, pedido: { candado: false } })
      if (orden) {
        await sendMessage(jid, '✅ *¡Pago recibido y pedido creado!*\n\n📦 Orden #' + orden.order_number + '\n\nMuy pronto recibirás tu guia de despacho.\n\n¡Gracias por tu compra en BlockBag! 🧳❤️')
        const owners = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
        for (const num of owners) {
          await sendMessage(num.trim().replace(/[^0-9]/g, '') + '@s.whatsapp.net',
            '📸 *Comprobante + Pedido*\nOrden #' + orden.order_number + '\nProducto: ' + session.pedido.diseno + '\nDatos: ' + session.pedido.datos)
        }
      } else {
        await sendMessage(jid, msgPedidoCompleto())
      }
    } else {
      await sendMessage(jid, '📸 Por favor envia el pantallazo del comprobante para proceder.' + NAV)
    }
    return
  }

  if (session.state === STATES.ESPERANDO_DATOS_ENVIO) {
    setSession(jid, { state: STATES.MENU, pedido: { candado: false } })
    await sendMessage(jid, msgPedidoCompleto())
    const owners = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
    for (const num of owners) {
      await sendMessage(num.trim().replace(/[^0-9]/g, '') + '@s.whatsapp.net', '📦 Contra entrega\nDatos: ' + texto)
    }
    return
  }

  if (t === '1' || t.includes('medida') || t.includes('talla')) {
    setSession(jid, { state: STATES.ESPERANDO_MEDIDAS })
    await sendImage(jid, process.env.IMG_MEDIDAS_URL,
      'Guia de medidas BlockBag\n\nMide tu maleta sin contar las ruedas:\n\nAlto en cm\nAncho en cm\n\nEjemplo: alto 65 ancho 45\n\n_Si tienes dudas escribe *asesor*_' + NAV)
    return
  }
  if (t === '2' || t.includes('material')) {
    await sendMessage(jid, msgMateriales() + NAV)
    return
  }
  if (t === '3' || t.includes('precio') || t.includes('valor') || t.includes('costo')) {
    await sendMessage(jid, '💰 *Precios BlockBag*\n\n🛍️ Ver tienda:\nhttps://blockbag.co\n\n*Forros con diseno:* desde $80.000\n*Forros basicos:* desde $60.000\n*Envio nacional:* $15.000\n*Candado de seguridad:* $22.000\n\n*Combos x2:*\nTalla S x2: $100.000\nTalla M x2: $110.000\nTalla L x2: $120.000\n\n*Accesorios:*\nBascula: $25.000\nPortapasaporte RFID: $40.000\nPortapasaporte basico: $20.000\nEtiqueta maleta: $12.000\nProtector ruedas: $25.000' + NAV)
    return
  }
  if (t === '4' || t.includes('envio') || t.includes('envío') || t.includes('despacho') || t.includes('entrega')) {
    await sendMessage(jid, msgEnvios() + NAV)
    return
  }
  if (t === '5' || t.includes('forma de pago')) {
    const day = new Date().getDate()
    const imgUrl = day <= 15 ? process.env.PAGO_Q1_IMAGEN_URL : process.env.PAGO_Q2_IMAGEN_URL
    await sendImage(jid, imgUrl, msgPagosDinamicos() + NAV)
    return
  }
  if (t === '6' || t.includes('catalogo') || t.includes('catálogo')) {
    setSession(jid, { state: STATES.ESPERANDO_PERSONALIZACION })
    await sendImage(jid, process.env.IMG_PERSONALIZACION_URL,
      '🎨 *Personalizacion BlockBag*\n\nTiempo de entrega: *8 a 10 dias habiles*.\n\nIndicanos que diseno quieres y en que parte de la maleta.\n\nEscribenos todos los detalles 👇' + NAV)
    return
  }

  await sendMenu(jid)
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
