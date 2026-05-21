require('dotenv').config()

// ─────────────────────────────────────────────
//  Plantillas de mensajes — BlockBag Bot
// ─────────────────────────────────────────────

function msgPedidoNuevo(order) {
  const items = order.line_items
    .map(i => `  • ${i.name} x${i.quantity}`)
    .join('\n')
  return `🛍️ *¡Pedido confirmado!*
Hola *${order.billing_address?.first_name || 'Cliente'}*, tu pedido llegó con éxito.
📋 *Pedido:* #${order.order_number}
${items}
💰 *Total:* $${Number(order.total_price).toLocaleString('es-CO')} COP
Te avisamos en cuanto sea despachado. ¡Gracias por tu compra! 🎉`
}

function msgPagoConfirmado(order) {
  return `✅ *Pago recibido*
Hola *${order.billing_address?.first_name || 'Cliente'}*, confirmamos el pago de tu pedido *#${order.order_number}*.
💳 Total pagado: *$${Number(order.total_price).toLocaleString('es-CO')} COP*
Ya estamos preparando tu paquete 📦. En breve recibirás el número de guía.`
}

function msgEnvioDespachado(order, tracking) {
  return `🚚 *¡Tu pedido va en camino!*
Hola *${order.billing_address?.first_name || 'Cliente'}*, el pedido *#${order.order_number}* fue despachado hoy.
📍 *Guía:* ${tracking.number || 'En proceso'}
🏢 *Transportadora:* Coordinadora
🕐 *Entrega estimada:* 2–4 días hábiles
${tracking.url ? `Rastrea tu paquete aquí 👉 ${tracking.url}` : ''}
¿Tienes alguna pregunta? Responde este mensaje y te ayudamos.`
}

function msgCarritoAbandonado(checkout, intento) {
  const items = checkout.line_items
    ?.map(i => `  • ${i.title}`)
    .join('\n') || '  • Productos seleccionados'
  const extras = intento === 2
    ? '\n\n🎁 *Envío gratis* si completas tu compra en las próximas 2 horas.'
    : ''
  return `👀 *¿Olvidaste algo?*
Hola *${checkout.billing_address?.first_name || 'amigo/a'}*, dejaste estos productos en tu carrito:
${items}${extras}
¿Quieres completarla? 👇
${checkout.abandoned_checkout_url}`
}

function msgPostventa(order) {
  return `⭐ *¿Cómo te fue con tu pedido?*
Hola *${order.billing_address?.first_name || 'Cliente'}*, esperamos que hayas recibido tu pedido *#${order.order_number}* en perfectas condiciones.
Nos ayudaría mucho si nos dejas una reseña rápida. Solo toma 1 minuto 🙏
¡Gracias por confiar en nosotros! 💛`
}

function msgReporteDiario(stats) {
  const fecha = new Date().toLocaleDateString('es-CO', {
    weekday: 'long', day: 'numeric', month: 'long'
  })
  const roasEmoji = stats.roas >= 3 ? '🟢' : stats.roas >= 2 ? '🟡' : '🔴'
  return `📊 *Reporte del día — ${fecha}*
💰 *Ventas totales:* $${stats.ventas.toLocaleString('es-CO')} COP
📦 *Pedidos:* ${stats.pedidos}
🛒 *Ticket promedio:* $${stats.ticketPromedio.toLocaleString('es-CO')} COP
${roasEmoji} *ROAS Meta:* ${stats.roas}x
💸 *Gasto en ads:* $${stats.gastoAds.toLocaleString('es-CO')} COP
👥 *Clientes nuevos:* ${stats.clientesNuevos}
${stats.roas < 2 ? '⚠️ *Alerta:* ROAS por debajo de 2x — revisar campañas.' : ''}
${stats.pedidos > stats.pedidosAyer ? `📈 +${stats.pedidos - stats.pedidosAyer} pedidos vs ayer` : `📉 ${stats.pedidosAyer - stats.pedidos} pedidos menos que ayer`}
👉 Dashboard: ${process.env.DASHBOARD_URL || 'dashboard.mitienda.com'}`
}

function msgMenuPrincipal() {
  return `¡Hola! 👋 Bienvenido a *BlockBag* — Protectores para maletas 🧳

¿En qué te puedo ayudar hoy?

1️⃣ Ver productos / Forros
2️⃣ Medidas y tallas
3️⃣ Personalización
4️⃣ Envíos
5️⃣ Medios de pago
6️⃣ Materiales`
}

function msgMedidasGuia() {
  return `📏 *Guía de medidas — Forros BlockBag*

👉 https://cdn.shopify.com/s/files/1/0696/1053/7275/files/WhatsApp_Image_2026-05-20_at_5.21.01_PM.jpg?v=1779318089

Mide tu maleta *sin contar las ruedas* y dime:

↕️ *Alto* en cm
↔️ *Ancho* en cm

Con esas medidas te digo exactamente qué talla necesitas 👇`
}

function msgPersonalizacionGuia() {
  return `🎨 *Personalización BlockBag*

👉 https://cdn.shopify.com/s/files/1/0696/1053/7275/files/WhatsApp_Image_2026-05-20_at_5.24.49_PM.jpg?v=1779318073

Cuéntanos:
✏️ ¿Qué quieres que diga o qué diseño quieres?
📍 ¿En qué parte de la maleta lo quieres?

Escríbenos todos los detalles 👇`
}

function msgMateriales() {
  return `🧵 *Nuestros materiales*

Nuestros forros son elaborados en *tela industrial de Pat Primo* — una tela gruesa y resistente, con interior peludito para proteger tu maleta de golpes y rayones.

¡Calidad garantizada! 💪`
}

function msgEnvios() {
  return `🚚 *Envíos BlockBag*

✅ Realizamos envíos *nacionales* a todo Colombia
✅ Realizamos envíos *internacionales*

Tu pedido llega seguro a donde estés 📦`
}

function msgOfertaCandado() {
  return `🔒 *¿Deseas incluir tu candado de seguridad?*

Es un accesorio adicional para *reforzar la protección* de tu maleta durante el transporte — especialmente útil en vuelos y envíos largos.

💰 Valor adicional: *$${Number(process.env.CANDADO_PRECIO || 10000).toLocaleString('es-CO')}*

Responde:
✅ *Sí* — lo incluyo
❌ *No* — continuar sin candado`
}

function msgSeleccionPago() {
  return `💳 ¿Cómo deseas pagar?

1️⃣ Transferencia bancaria (Llave / Nequi)
2️⃣ Pago contra entrega`
}

function msgPagosDinamicos() {
  const day = new Date().getDate()
  if (day <= 15) {
    return `💳 *Medios de Pago BlockBag*

👉 https://cdn.shopify.com/s/files/1/0696/1053/7275/files/WhatsApp_Image_2026-05-20_at_5.19.11_PM_1.jpg?v=1779318117

🔑 *Llave:* ${process.env.PAGO_Q1_NUMERO_1 || '66986350'}
📱 *Nequi:* ${process.env.PAGO_Q1_NUMERO_2 || '3174232091'}

📸 Después de pagar, envíanos el *pantallazo del comprobante* para proceder con tu pedido.

✅ Paga fácil | ⚡ Rápido | 🔒 Seguro`
  } else {
    return `💳 *Medios de Pago BlockBag*

👉 https://cdn.shopify.com/s/files/1/0696/1053/7275/files/WhatsApp_Image_2026-05-20_at_5.19.11_PM.jpg?v=1779318117

🔑 *Llave:* ${process.env.PAGO_Q2_ALIAS_1 || '@VCE626'}
👤 *Titular:* ${process.env.PAGO_Q2_TITULAR_1 || 'Valentina Cervino'}

📲 Desde la app de tu banco, sin costo y de forma inmediata.

📸 Después de pagar, envíanos el *pantallazo del comprobante* para proceder con tu pedido.

✅ Paga fácil | ⚡ Rápido | 🔒 Seguro`
  }
}

function urlImagenPago() {
  const day = new Date().getDate()
  return day <= 15
    ? process.env.PAGO_Q1_IMAGEN_URL
    : process.env.PAGO_Q2_IMAGEN_URL
}

function msgContraEntrega() {
  return `✅ *Pago contra entrega seleccionado.*

⚠️ *IMPORTANTE — Lee antes de confirmar:*

La persona que recibe el pedido debe estar *presente en el lugar de entrega con el dinero disponible* al momento de recibir el paquete.

Si el mensajero llega y:
❌ No hay nadie en la dirección
❌ No tiene el efectivo completo

El pedido será devuelto y se generarán *cargos adicionales de reenvío*.

¿Confirmas que entiendes y aceptas?

✅ *Sí, confirmo* — continuar
🔄 *No* — elegir otro método de pago`
}

function msgPedirDatosEnvio() {
  return `📝 Para procesar tu pedido necesitamos tus datos de envío:

1️⃣ *Nombre completo*
2️⃣ *Dirección de entrega*
3️⃣ *Ciudad*
4️⃣ *Teléfono de contacto*

Envíalos todos juntos 👇`
}

function msgPedidoCompleto() {
  return `✅ *¡Pedido registrado con éxito!*

En breve un asesor confirmará tu orden y te dará más detalles.

¡Gracias por tu compra en *BlockBag*! 🧳❤️`
}

module.exports = {
  msgPedidoNuevo,
  msgPagoConfirmado,
  msgEnvioDespachado,
  msgCarritoAbandonado,
  msgPostventa,
  msgReporteDiario,
  msgMenuPrincipal,
  msgMedidasGuia,
  msgPersonalizacionGuia,
  msgMateriales,
  msgEnvios,
  msgOfertaCandado,
  msgSeleccionPago,
  msgPagosDinamicos,
  urlImagenPago,
  msgContraEntrega,
  msgPedirDatosEnvio,
  msgPedidoCompleto,
}
