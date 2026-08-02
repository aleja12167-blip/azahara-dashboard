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

function esperar(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function shopifyGet(path, intentos = 5) {
  for (let intento = 0; intento < intentos; intento++) {
    const res = await fetch(`https://${STORE}/admin/api/${API_VERSION}/${path}`, {
      headers: { "X-Shopify-Access-Token": TOKEN },
    });
    if (res.status === 429) {
      const esperaSeg = parseFloat(res.headers.get("Retry-After")) || 1;
      await esperar(esperaSeg * 1000 + 200);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Shopify API ${path} -> ${res.status} ${await res.text()}`);
    }
    return res.json();
  }
  throw new Error(`Shopify API ${path} -> agotados los reintentos por límite de tasa`);
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
    await esperar(550); // Shopify permite ~2 solicitudes/segundo
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
