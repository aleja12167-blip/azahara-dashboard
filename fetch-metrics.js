// Requires SHOPIFY_STORE and SHOPIFY_TOKEN as env vars. Run with Node 18+.
const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;

if (!STORE || !TOKEN) {
  console.error("Faltan SHOPIFY_STORE o SHOPIFY_TOKEN en el entorno.");
  process.exit(1);
}

const API_VERSION = "2024-01";

function bogotaDayStartISO() {
  // Bogotá is fixed UTC-5, no DST.
  const now = new Date();
  const bogota = new Date(now.toLocaleString("en-US", { timeZone: "America/Bogota" }));
  const y = bogota.getFullYear();
  const m = String(bogota.getMonth() + 1).padStart(2, "0");
  const d = String(bogota.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}T00:00:00-05:00`;
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
  const dayStart = bogotaDayStartISO();

  const { orders = [] } = await shopifyGet(
    `orders.json?status=any&created_at_min=${encodeURIComponent(dayStart)}&limit=250`
  );

  const paidOrders = orders.filter((o) => o.cancelled_at === null);

  const ventas = paidOrders.reduce((sum, o) => sum + parseFloat(o.current_total_price || o.total_price || 0), 0);
  const pedidos = paidOrders.length;
  const ticketPromedio = pedidos > 0 ? ventas / pedidos : 0;

  const productCounts = {};
  for (const order of paidOrders) {
    for (const item of order.line_items || []) {
      productCounts[item.title] = (productCounts[item.title] || 0) + item.quantity;
    }
  }
  let productoTop = null;
  let maxQty = 0;
  for (const [title, qty] of Object.entries(productCounts)) {
    if (qty > maxQty) {
      maxQty = qty;
      productoTop = title;
    }
  }

  const { checkouts = [] } = await shopifyGet(
    `checkouts.json?created_at_min=${encodeURIComponent(dayStart)}&limit=250`
  );

  const data = {
    updatedAt: new Date().toISOString(),
    fecha: dayStart.slice(0, 10),
    ventas,
    pedidos,
    ticketPromedio,
    productoTop: productoTop ? { titulo: productoTop, cantidad: maxQty } : null,
    carritosAbandonados: checkouts.length,
    moneda: paidOrders[0]?.currency || "COP",
  };

  console.log(JSON.stringify(data, null, 2));
  require("fs").writeFileSync("data.json", JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
