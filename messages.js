// ─────────────────────────────────────────────
//  Plantillas de mensajes para cada evento
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
🏢 *Transportadora:* ${tracking.company || 'Por confirmar'}
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

👉 [Dejar reseña aquí]

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

module.exports = {
  msgPedidoNuevo,
  msgPagoConfirmado,
  msgEnvioDespachado,
  msgCarritoAbandonado,
  msgPostventa,
  msgReporteDiario,
}
