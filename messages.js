const axios = require('axios')

const shopify = axios.create({
  baseURL: `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01`,
  headers: {
    'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
    'Content-Type': 'application/json',
  },
})

// Obtener pedidos del día de hoy
async function getPedidosHoy() {
  const hoy = new Date()
  hoy.setHours(0, 0, 0, 0)

  const res = await shopify.get('/orders.json', {
    params: {
      created_at_min: hoy.toISOString(),
      status: 'any',
      limit: 250,
    },
  })
  return res.data.orders
}

// Obtener un pedido por ID
async function getPedido(orderId) {
  const res = await shopify.get(`/orders/${orderId}.json`)
  return res.data.order
}

// Obtener clientes con su teléfono
async function getClientes(limit = 250) {
  const res = await shopify.get('/customers.json', {
    params: { limit },
  })
  return res.data.customers
}

// Número de teléfono limpio para WhatsApp
function limpiarTelefono(phone) {
  if (!phone) return null
  let p = phone.replace(/\D/g, '')
  // Agregar código Colombia si no tiene código país
  if (p.length === 10 && p.startsWith('3')) p = '57' + p
  return p
}

// Stats consolidados del día para el reporte
async function getStatsHoy() {
  const pedidos = await getPedidosHoy()

  const pedidosPagados = pedidos.filter(o => o.financial_status === 'paid')
  const ventas = pedidosPagados.reduce((sum, o) => sum + parseFloat(o.total_price), 0)
  const ticketPromedio = pedidosPagados.length > 0 ? ventas / pedidosPagados.length : 0

  // Clientes nuevos hoy
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0)
  const clientesNuevos = pedidos.filter(o => {
    return o.customer?.orders_count === 1
  }).length

  return {
    ventas: Math.round(ventas),
    pedidos: pedidosPagados.length,
    ticketPromedio: Math.round(ticketPromedio),
    clientesNuevos,
    roas: 0,        // Se completa desde Make con datos de Meta
    gastoAds: 0,    // Se completa desde Make con datos de Meta
    pedidosAyer: 0, // Se completa comparando con día anterior
  }
}

module.exports = { getPedidosHoy, getPedido, getClientes, limpiarTelefono, getStatsHoy }
