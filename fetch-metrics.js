// Requires SHOPIFY_STORE and SHOPIFY_TOKEN as env vars. Run with Node 18+.
const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;

if (!STORE || !TOKEN) {
  console.error("Faltan SHOPIFY_STORE o SHOPIFY_TOKEN en el entorno.");
  process.exit(1);
}

const API_VERSION = "2024-01";
const DIAS_HISTORIAL = 30;

function bogotaDateParts(date) {
  const bogota = new Date(date.toLocaleString("en-US", { timeZone: "America/Bogota" }));
  const y = bogota.getFullYear();
  const m = String(bogota.getMonth() + 1).padStart(2, "0");
  const d = String(bogota.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function bogotaDayStartISO(date) {
  return `${bogotaDateParts(date)}T00:00:00-05:00`;
}

async function shopifyGet(path) {
  const res = await fetch(`https://${STORE}/admin/api/${API_VERSION}/${path}`, {
    headers: { "X-Shopify-Access-Token": TOKEN },
  });
  if (!res.ok) {
    throw new Error(`Shopify API ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function main() {
  const historyStart = new Date(Date.now() - DIAS_HISTORIAL * 24 * 60 * 60 * 1000);
  const historyStartISO = bogotaDayStartISO(historyStart);

  const { orders = [] } = await shopifyGet(
    `orders.json?status=any&created_at_min=${encodeURIComponent(historyStartISO)}&limit=250`
  );
  const { checkouts = [] } = await shopifyGet(
    `checkouts.json?created_at_min=${encodeURIComponent(historyStartISO)}&limit=250`
  );

  const paidOrders = orders.filter((o) => o.cancelled_at === null);

  // Build the last DIAS_HISTORIAL day buckets (oldest -> newest), Bogotá calendar days.
  const dias = [];
  for (let i = DIAS_HISTORIAL - 1; i >= 0; i--) {
    const fecha = bogotaDateParts(new Date(Date.now() - i * 24 * 60 * 60 * 1000));
    dias.push({
      fecha,
      ventas: 0,
      pedidos: 0,
      carritosAbandonados: 0,
      productos: {},
    });
  }
  const porFecha = Object.fromEntries(dias.map((d) => [d.fecha, d]));

  for (const order of paidOrders) {
    const fecha = bogotaDateParts(new Date(order.created_at));
    const bucket = porFecha[fecha];
    if (!bucket) continue;
    bucket.ventas += parseFloat(order.current_total_price || order.total_price || 0);
    bucket.pedidos += 1;
    for (const item of order.line_items || []) {
      bucket.productos[item.title] = (bucket.productos[item.title] || 0) + item.quantity;
    }
  }

  for (const checkout of checkouts) {
    const fecha = bogotaDateParts(new Date(checkout.created_at));
    const bucket = porFecha[fecha];
    if (!bucket) continue;
    bucket.carritosAbandonados += 1;
  }

  const moneda = paidOrders[0]?.currency || "COP";

  const ESTADOS_PAGO = {
    pending: "Pendiente",
    authorized: "Autorizado",
    partially_paid: "Pago parcial",
    paid: "Pagado",
    partially_refunded: "Reembolso parcial",
    refunded: "Reembolsado",
    voided: "Anulado",
  };
  const ESTADOS_ENVIO = {
    fulfilled: "Enviado",
    partial: "Envío parcial",
    restocked: "Reabastecido",
  };

  const pedidosRecientes = [...orders]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 15)
    .map((o) => {
      const cliente = o.customer
        ? `${o.customer.first_name || ""} ${o.customer.last_name || ""}`.trim() || o.customer.email
        : o.email || o.contact_email || "Cliente sin nombre";
      return {
        numero: o.name,
        cliente,
        total: parseFloat(o.current_total_price || o.total_price || 0),
        estadoPago: o.cancelled_at ? "Anulado" : (ESTADOS_PAGO[o.financial_status] || o.financial_status || "—"),
        estadoEnvio: o.cancelled_at ? "Cancelado" : (ESTADOS_ENVIO[o.fulfillment_status] || "Sin enviar"),
        fecha: o.created_at,
      };
    });

  const diasFinal = dias.map((d) => {
    let productoTop = null;
    let maxQty = 0;
    for (const [titulo, cantidad] of Object.entries(d.productos)) {
      if (cantidad > maxQty) {
        maxQty = cantidad;
        productoTop = titulo;
      }
    }
    return {
      fecha: d.fecha,
      ventas: d.ventas,
      pedidos: d.pedidos,
      ticketPromedio: d.pedidos > 0 ? d.ventas / d.pedidos : 0,
      carritosAbandonados: d.carritosAbandonados,
      productoTop: productoTop ? { titulo: productoTop, cantidad: maxQty } : null,
    };
  });

  const data = {
    updatedAt: new Date().toISOString(),
    timezone: "America/Bogota",
    moneda,
    dias: diasFinal,
    pedidosRecientes,
  };

  console.log(JSON.stringify(data, null, 2));
  require("fs").writeFileSync("data.json", JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
