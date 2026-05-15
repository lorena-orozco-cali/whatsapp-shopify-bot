# WhatsApp + Shopify Bot

Servidor Node.js que conecta Shopify con WhatsApp Business via Baileys.

## Flujos automáticos incluidos

| Evento | Qué envía |
|---|---|
| Pedido nuevo | Confirmación con productos y total |
| Pago confirmado | Recibo de pago |
| Envío despachado | Número de guía y link de rastreo |
| Carrito abandonado | Recordatorio con link de checkout |
| Post-entrega | Solicitud de reseña (se configura en Make) |
| Reporte diario | KPIs del día a los dueños (7am) |

---

## Deploy en Railway — paso a paso

### 1. Subir el código

```bash
git init
git add .
git commit -m "first commit"
```

Luego en [railway.app](https://railway.app):
- New Project → Deploy from GitHub → selecciona el repo

### 2. Configurar variables de entorno en Railway

En Railway → tu proyecto → Variables, agrega:

```
SHOPIFY_STORE=mi-tienda.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxx
SHOPIFY_WEBHOOK_SECRET=mi_secreto_123
OWNER_NUMBERS=573001234567,573009876543
API_SECRET=clave_secreta_para_make
REPORT_HOUR=7
REPORT_MINUTE=0
```

### 3. Escanear el QR

Una vez que Railway despliegue:
1. Abre `https://tu-app.up.railway.app/qr`
2. Abre WhatsApp en el celular del cliente
3. Menú → Dispositivos vinculados → Vincular dispositivo
4. Escanea el QR

Listo — el servidor queda conectado permanentemente.

### 4. Registrar webhooks en Shopify

En Shopify → Configuración → Notificaciones → Webhooks:

| Evento | URL |
|---|---|
| Creación de pedido | `https://tu-app.up.railway.app/webhook/orders/create` |
| Pago de pedido | `https://tu-app.up.railway.app/webhook/orders/paid` |
| Cumplimiento de pedido | `https://tu-app.up.railway.app/webhook/orders/fulfilled` |
| Pago de caja abandonada | `https://tu-app.up.railway.app/webhook/checkout/abandoned` |

Copia el "secreto del webhook" de Shopify y pégalo en `SHOPIFY_WEBHOOK_SECRET`.

### 5. Conectar con Make

En Make, usa el módulo HTTP → Make a request:
- URL: `https://tu-app.up.railway.app/api/send`
- Method: POST
- Headers: `x-api-secret: tu_API_SECRET`
- Body: `{ "phone": "573001234567", "message": "Hola!" }`

Para el reporte con datos de Meta:
- URL: `https://tu-app.up.railway.app/api/reporte`
- Body: `{ "roas": 3.4, "gastoAds": 680000 }`

---

## Endpoints disponibles

| Endpoint | Uso |
|---|---|
| `GET /` | Estado del bot |
| `GET /qr` | Código QR para escanear |
| `GET /health` | Health check Railway |
| `POST /webhook/orders/create` | Webhook Shopify pedido nuevo |
| `POST /webhook/orders/paid` | Webhook Shopify pago |
| `POST /webhook/orders/fulfilled` | Webhook Shopify envío |
| `POST /webhook/checkout/abandoned` | Webhook carrito abandonado |
| `POST /api/send` | Enviar mensaje desde Make |
| `POST /api/reporte` | Enviar reporte a dueños |
