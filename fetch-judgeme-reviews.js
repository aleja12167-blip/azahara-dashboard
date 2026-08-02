// Requires SHOPIFY_STORE and SHOPIFY_TOKEN as env vars. Run with Node 18+.
// Lee las reseñas de Judge.me directamente de los metafields de Shopify
// (Judge.me las escribe ahí solo; no hace falta su propia API).
const { execSync } = require("child_process");
const fs = require("fs");

const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;

if (!STORE || !TOKEN) {
  console.error("Faltan SHOPIFY_STORE o SHOPIFY_TOKEN en el entorno.");
  process.exit(1);
}

const API_VERSION = "2024-01";

async function shopifyGet(path) {
  const res = await fetch(`https://${STORE}/admin/api/${API_VERSION}/${path}`, {
    headers: { "X-Shopify-Access-Token": TOKEN },
  });
  if (!res.ok) {
    throw new Error(`Shopify API ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function previousReviewUuids() {
  try {
    const previo = execSync("git show HEAD:data.json", { encoding: "utf8" });
    const data = JSON.parse(previo);
    const items = data?.resenas?.items || [];
    return new Set(items.map((r) => r.uuid));
  } catch (e) {
    // Primera corrida, o data.json todavía no existía en el commit anterior.
    return new Set();
  }
}

async function main() {
  const yaConocidas = previousReviewUuids();

  const { products = [] } = await shopifyGet("products.json?limit=250&fields=id,title,handle");

  const todasLasResenas = [];

  for (const product of products) {
    const { metafields = [] } = await shopifyGet(
      `products/${product.id}/metafields.json?namespace=judgeme&key=review_widget_data`
    );
    const metafield = metafields[0];
    if (!metafield) continue;

    let widgetData;
    try {
      widgetData = JSON.parse(metafield.value);
    } catch (e) {
      continue;
    }

    for (const r of widgetData.reviews || []) {
      todasLasResenas.push({
        uuid: r.uuid,
        producto: product.title,
        productoHandle: product.handle,
        calificacion: r.rating,
        texto: r.body || "",
        autor: r.is_anonymous_reviewer ? "Anónimo" : r.reviewer_name,
        fecha: r.created_at,
      });
    }
  }

  todasLasResenas.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

  const nuevas = todasLasResenas.filter((r) => !yaConocidas.has(r.uuid));

  const data = JSON.parse(fs.readFileSync("data.json", "utf8"));
  data.resenas = {
    updatedAt: new Date().toISOString(),
    items: todasLasResenas.slice(0, 50),
    nuevas,
  };

  fs.writeFileSync("data.json", JSON.stringify(data, null, 2));
  console.log(`Reseñas totales: ${todasLasResenas.length}. Nuevas desde la última sync: ${nuevas.length}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
