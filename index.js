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
}

const NAV = '\n\n_Escribe *opciones* para ver el menu o *asesor* para hablar con nosotros_'

function getSession(jid) {
  if (!sessions.has(jid)) sessions.set(jid, { state: STATES.MENU, pedido: { candado: false } })
  return sessions.get(jid)
}
function setSession(jid, data) { sessions.set(jid, { ...getSession(jid), ...data }) }

function calcularTalla(texto) {
  const t = texto.toLowerCase()
  let alto = null
  const altoMatch = t.match(/alto[\s:]*(\d+)/)
  if (altoMatch) alto = parseInt(altoMatch[1])
  if (!alto) {
    const nums = texto.match(/\d+/g)
    if (nums) alto = parseInt(nums[0])
  }
  if (!alto) return null
  if (alto >= 48 && alto <= 57) return 'S'
  if (alto >= 58 && alto <= 66) return 'M'
  if (alto >= 67 && alto <= 70) return 'L'
  if (alto >= 71) return 'XL'
  return null
}


function calcularPrecioDiseno(diseno) {
  const d = diseno.toLowerCase()
  if (d.includes('basico') || d.includes('básico')) return 60000
  return 80000
}

function formatPrecio(n) {
  return '$' + n.toLocaleString('es-CO')
}

async function notificarAsesor(jid) {
  const owners = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
  for (const num of owners) {
    await sendMessage(num.trim() + '@s.whatsapp.net',
      '🔔 *ALERTA: Cliente solicita asesor*\nNumero: ' + jid.replace('@s.whatsapp.net', ''))
  }
}

async function handleMessage(jid, texto, hasMedia) {
  const t = (texto || '').trim().toLowerCase()
  const session = getSession(jid)

  // SIEMPRE disponible: menu/opciones y asesor
  if (t === 'menu' || t === 'opciones' || t === 'inicio' || t === 'start' ||
      t === 'hola' || t === 'hi' || t === 'buenas' || t.includes('menu') || t.includes('opcion')) {
    setSession(jid, { state: STATES.MENU, pedido: { candado: false } })
    await sendMenu(jid)
    return
  }

  if (t === 'asesor' || t === '7' || t.includes('asesor') || t.includes('hablar')) {
    await sendMessage(jid, '👤 *Un asesor te atenderá en breve.*\n\nGracias por tu paciencia 🙏' + NAV)
    await notificarAsesor(jid)
    return
  }

  // Personalizacion solo si el cliente la pide explicitamente
  if (t.includes('personaliz')) {
    setSession(jid, { state: STATES.ESPERANDO_PERSONALIZACION })
    await sendImage(jid, process.env.IMG_PERSONALIZACION_URL,
      '🎨 *Personalizacion BlockBag*\n\nIndicanos que diseno quieres y en que parte de la maleta lo deseas.\n\nEscribenos todos los detalles 👇' + NAV)
    return
  }

  // ESTADOS ACTIVOS DEL FLUJO
  if (session.state === STATES.ESPERANDO_MEDIDAS) {
    const talla = calcularTalla(texto)
    setSession(jid, { state: STATES.ESPERANDO_DISENO, pedido: { ...session.pedido, medidas: texto, talla } })
    const msg = talla ? 'Con esas medidas tu talla recomendada es *' + talla + '*.\n\n' : 'Medidas registradas.\n\n'
    await sendMessage(jid, msg + 'Que diseno deseas para tu forro?\n\nVisita nuestro catalogo:\nhttps://blockbag.co/collections/all\n\nEscribenos la referencia o mandanos la foto del producto que quieres 👇' + NAV)
    return
  }

  if (session.state === STATES.ESPERANDO_DISENO) {
    const diseno = hasMedia ? 'Foto enviada por el cliente' : texto
    const precioForro = calcularPrecioDiseno(diseno)
    const precioEnvio = 15000
    const totalSinCandado = precioForro + precioEnvio
    const totalConCandado = precioForro + precioEnvio + 22000
    setSession(jid, { state: STATES.ESPERANDO_DATOS_PEDIDO, pedido: { ...session.pedido, diseno, precioForro } })
    await sendMessage(jid, 'Diseno registrado 👍\n\n💰 *Resumen de tu pedido:*\n\nForro: $' + precioForro.toLocaleString('es-CO') + '\nEnvio: $15.000\nCandado (opcional): $22.000\n\n*Total sin candado: $' + totalSinCandado.toLocaleString('es-CO') + '*\n*Total con candado: $' + totalConCandado.toLocaleString('es-CO') + '*\n\nPara finalizar envianos:\n\n👤 Nombre completo\n🏠 Direccion de entrega\n🏙️ Ciudad\n📱 Telefono de contacto\n\nTodo en un solo mensaje 👇' + NAV)
    return
  }

  if (session.state === STATES.ESPERANDO_PERSONALIZACION) {
    setSession(jid, { state: STATES.ESPERANDO_DATOS_PEDIDO, pedido: { ...session.pedido, personalizacion: texto } })
    await sendMessage(jid, 'Personalizacion registrada 👍\n\nPara finalizar tu solicitud envianos:\n\n👤 Nombre completo\n🏠 Direccion de entrega\n🏙️ Ciudad\n📱 Telefono de contacto\n\nTodo en un solo mensaje 👇' + NAV)
    return
  }

  if (session.state === STATES.ESPERANDO_DATOS_PEDIDO) {
    setSession(jid, { state: STATES.OFERTA_CANDADO, pedido: { ...session.pedido, datos: texto } })
    await sendMessage(jid, msgOfertaCandado() + NAV)
    return
  }

  if (session.state === STATES.OFERTA_CANDADO) {
    const quiere = ['si', 'si quiero', 'claro', 'dale', 'yes', 'sí'].some(r => t === r || t.startsWith(r))
    const noQuiere = t === 'no' || t === 'no gracias'
    if (quiere || noQuiere) {
      setSession(jid, { state: STATES.SELECCION_PAGO, pedido: { ...session.pedido, candado: quiere } })
      const msg = quiere ? 'Candado agregado 🔒 +$' + Number(process.env.CANDADO_PRECIO || 22000).toLocaleString('es-CO') + '\n\n' : 'De acuerdo, sin candado.\n\n'
      await sendMessage(jid, msg + 'Como deseas pagar?\n\n1️⃣ Transferencia (Llave / Nequi)\n2️⃣ Pago contra entrega' + NAV)
      return
    }
    await sendMessage(jid, msgOfertaCandado() + NAV)
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
    await sendMessage(jid, 'Responde *1* para transferencia o *2* para contra entrega.' + NAV)
    return
  }

  if (session.state === STATES.CONFIRMACION_COD) {
    if (['si', 'si confirmo', 'confirmo', 'acepto', 'ok', 'dale', 'si acepto'].some(r => t.includes(r))) {
      setSession(jid, { state: STATES.ESPERANDO_DATOS_ENVIO })
      await sendMessage(jid, msgPedirDatosEnvio() + NAV)
    } else {
      setSession(jid, { state: STATES.SELECCION_PAGO })
      await sendMessage(jid, 'Como deseas pagar?\n\n1️⃣ Transferencia (Llave / Nequi)\n2️⃣ Pago contra entrega' + NAV)
    }
    return
  }

  if (session.state === STATES.ESPERANDO_COMPROBANTE) {
    if (hasMedia) {
      setSession(jid, { state: STATES.MENU, pedido: { candado: false } })
      await sendMessage(jid, msgPedidoCompleto())
      const owners = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
      for (const num of owners) {
        await sendMessage(num.trim() + '@s.whatsapp.net',
          '📸 Comprobante recibido\nCliente: ' + jid.replace('@s.whatsapp.net', '') + '\nPedido: ' + JSON.stringify(session.pedido))
      }
    } else {
      await sendMessage(jid, 'Por favor envia el pantallazo del comprobante de pago para proceder.' + NAV)
    }
    return
  }

  if (session.state === STATES.ESPERANDO_DATOS_ENVIO) {
    setSession(jid, { state: STATES.MENU, pedido: { candado: false } })
    await sendMessage(jid, msgPedidoCompleto())
    const owners = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean)
    for (const num of owners) {
      await sendMessage(num.trim() + '@s.whatsapp.net',
        '📦 Pedido contra entrega\nCliente: ' + jid.replace('@s.whatsapp.net', '') + '\nDatos: ' + texto + '\nPedido: ' + JSON.stringify(session.pedido))
    }
    return
  }

  // OPCIONES DEL MENU — sin condicion de estado
  if (t === '1' || t.includes('medida') || t.includes('talla')) {
    setSession(jid, { state: STATES.ESPERANDO_MEDIDAS })
    await sendImage(jid, process.env.IMG_MEDIDAS_URL,
      'Guia de medidas BlockBag\n\nMide tu maleta sin contar las ruedas y enviame:\n\nAlto en cm\nAncho en cm\n\nEjemplo: alto 65 ancho 45' + NAV)
    return
  }

  if (t === '2' || t.includes('material')) {
    await sendMessage(jid, msgMateriales() + NAV)
    return
  }

  if (t === '3' || t.includes('precio') || t.includes('valor') || t.includes('costo')) {
    await sendMessage(jid, '💰 *Precios BlockBag*\n\nEscribenos para cotizar segun la talla y personalizacion que necesites.\n\nUn asesor te responde de inmediato.' + NAV)
    return
  }

  if (t === '4' || t.includes('envio') || t.includes('envío') || t.includes('despacho') || t.includes('entrega')) {
    await sendMessage(jid, msgEnvios() + NAV)
    return
  }

  if (t === '5' || t.includes('pago') || t.includes('forma de pago') || t.includes('transferencia') || t.includes('nequi')) {
    setSession(jid, { state: STATES.OFERTA_CANDADO })
    await sendMessage(jid, msgOfertaCandado() + NAV)
    return
  }

  if (t === '6' || t.includes('catalogo') || t.includes('catálogo')) {
    await sendMessage(jid, '🛍️ *Catalogo BlockBag*\n\nhttps://blockbag.co/collections/all\n\nElige tu diseno y envianos la referencia o la foto del producto.' + NAV)
    return
  }

  // Fallback
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
app.post('/api/reporte', verificarApi, async (req, res) => { try { const statsBase = await getStatsHoy(); const stats = { ...statsBase, ...req.body }; const numeros = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean); for (const num of numeros) await sendMessage(num.trim() + '@s.whatsapp.net', msgReporteDiario(stats)); res.json({ ok: true }) } catch (e) { res.status(500).json({ error: e.message }) } })
app.get('/health', (req, res) => res.json({ ok: true, status: getStatus().status }))

const hora = process.env.REPORT_HOUR || '7'
const minuto = process.env.REPORT_MINUTE || '0'
cron.schedule(minuto + ' ' + (Number(hora) + 5) + ' * * *', async () => { try { const stats = await getStatsHoy(); const numeros = (process.env.OWNER_NUMBERS || '').split(',').filter(Boolean); for (const num of numeros) await sendMessage(num.trim() + '@s.whatsapp.net', msgReporteDiario(stats)) } catch (e) { console.error(e.message) } }, { timezone: 'UTC' })

const PORT = process.env.PORT || 3000
app.listen(PORT, async () => {
  console.log('BlockBag Bot corriendo en puerto ' + PORT)
  setMessageHandler(handleMessage)
  await connectToWhatsApp()
})
