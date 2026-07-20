// Requires GA4_SERVICE_ACCOUNT_JSON (full JSON key as a string) and GA4_PROPERTY_ID as env vars.
const crypto = require("crypto");
const fs = require("fs");

const PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const SERVICE_ACCOUNT_JSON = process.env.GA4_SERVICE_ACCOUNT_JSON;

if (!PROPERTY_ID || !SERVICE_ACCOUNT_JSON) {
  console.error("Faltan GA4_PROPERTY_ID o GA4_SERVICE_ACCOUNT_JSON en el entorno.");
  process.exit(1);
}

const key = JSON.parse(SERVICE_ACCOUNT_JSON);

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer
    .sign(key.private_key)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`OAuth token error -> ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return json.access_token;
}

async function runReport(token, body) {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    throw new Error(`GA4 Data API error -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function ga4DateToISO(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

async function main() {
  const token = await getAccessToken();

  const sessionsReport = await runReport(token, {
    dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
    dimensions: [{ name: "date" }],
    metrics: [{ name: "sessions" }],
  });

  const eventsReport = await runReport(token, {
    dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
    dimensions: [{ name: "date" }, { name: "eventName" }],
    metrics: [{ name: "eventCount" }],
    dimensionFilter: {
      filter: {
        fieldName: "eventName",
        inListFilter: {
          values: ["view_item", "add_to_cart", "begin_checkout", "purchase"],
        },
      },
    },
  });

  const porFecha = {};

  for (const row of sessionsReport.rows || []) {
    const fecha = ga4DateToISO(row.dimensionValues[0].value);
    porFecha[fecha] = porFecha[fecha] || {};
    porFecha[fecha].visitas = parseInt(row.metricValues[0].value, 10);
  }

  for (const row of eventsReport.rows || []) {
    const fecha = ga4DateToISO(row.dimensionValues[0].value);
    const evento = row.dimensionValues[1].value;
    const cantidad = parseInt(row.metricValues[0].value, 10);
    porFecha[fecha] = porFecha[fecha] || {};
    const campo = {
      view_item: "vioProducto",
      add_to_cart: "agregoCarrito",
      begin_checkout: "iniciarCheckout",
      purchase: "compras",
    }[evento];
    porFecha[fecha][campo] = cantidad;
  }

  const data = JSON.parse(fs.readFileSync("data.json", "utf8"));
  for (const dia of data.dias) {
    const embudo = porFecha[dia.fecha] || {};
    dia.embudo = {
      visitas: embudo.visitas || 0,
      vioProducto: embudo.vioProducto || 0,
      agregoCarrito: embudo.agregoCarrito || 0,
      iniciarCheckout: embudo.iniciarCheckout || 0,
      compras: embudo.compras || 0,
    };
  }
  data.ga4UpdatedAt = new Date().toISOString();

  fs.writeFileSync("data.json", JSON.stringify(data, null, 2));
  console.log("Embudo GA4 agregado a data.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
