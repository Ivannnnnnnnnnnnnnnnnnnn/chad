/* Starlink chad — plan selection & payment modal. */
(function () {
  "use strict";

  var modal = document.getElementById("paymentModal");
  if (!modal) return;

  var form = document.getElementById("paymentForm");
  var packageIdInput = document.getElementById("selectedPackageId");
  var methodInput = document.getElementById("selectedPaymentMethod");
  var phoneSection = document.getElementById("phoneSection");
  var phoneInput = document.getElementById("phone_number");
  var summaryName = document.getElementById("summaryName");
  var summaryData = document.getElementById("summaryData");
  var summaryPrice = document.getElementById("summaryPrice");
  var closeBtn = document.getElementById("closeModalBtn");
  var payBtn = document.getElementById("payBtn");
  var errorBox = document.getElementById("checkoutError");

  var methodButtons = modal.querySelectorAll(".payment-method-btn");

  // Chad mobile rules come from the server (/api/mobile-rules) so the client
  // and server cannot drift apart.
  var CHAD_RULES = null;

  function localPhoneDigits(value) {
    var digits = (value || "").replace(/\D/g, "");
    var cc = CHAD_RULES ? String(CHAD_RULES.countryCode).replace(/\D/g, "") : "235";
    if (digits.indexOf(cc) === 0) digits = digits.slice(cc.length);
    return digits;
  }

  function validatePhone(value) {
    var m = (CHAD_RULES && CHAD_RULES.messages) || {};
    var length = (CHAD_RULES && CHAD_RULES.length) || 8;
    var prefixes = (CHAD_RULES && CHAD_RULES.prefixes) || ["6", "7", "9"];
    var digits = localPhoneDigits(value);
    if (!digits) return m.required || "Veuillez saisir votre numéro de téléphone.";
    if (digits.length !== length) return m.length || "Numéro invalide.";
    if (prefixes.indexOf(digits.charAt(0)) === -1) return m.prefix || "Préfixe invalide.";
    if (new RegExp("^(\\d)\\1{" + (length - 1) + "}$").test(digits)) {
      return m.repeated || "Veuillez saisir un numéro de téléphone valide.";
    }
    return "";
  }

  function setPhoneError(message) {
    if (!phoneInput) return;
    var hint = document.getElementById("phoneHint");
    var errorEl = document.getElementById("phoneError");
    if (message) {
      phoneInput.classList.add("border-red-500");
      phoneInput.setAttribute("aria-invalid", "true");
      if (errorEl) {
        errorEl.textContent = message;
        errorEl.classList.remove("hidden");
      } else if (hint) {
        hint.textContent = message;
        hint.classList.add("text-red-500");
      }
    } else {
      phoneInput.classList.remove("border-red-500");
      phoneInput.removeAttribute("aria-invalid");
      if (errorEl) {
        errorEl.textContent = "";
        errorEl.classList.add("hidden");
      }
    }
  }

  function openModal() {
    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    modal.classList.add("hidden");
    document.body.style.overflow = "";
    resetModal();
  }

  function resetModal() {
    methodButtons.forEach(function (b) { b.classList.remove("selected"); });
    if (phoneSection) phoneSection.classList.add("hidden");
    form.reset();
  }

  document.querySelectorAll(".select-plan-btn").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var card = btn.closest(".package-card");
      document.querySelectorAll(".package-card").forEach(function (c) {
        c.classList.remove("selected");
      });
      card.classList.add("selected");

      packageIdInput.value = card.dataset.packageId;
      summaryName.textContent = card.dataset.packageName;
      summaryData.textContent = card.dataset.packageData;
      summaryPrice.textContent = "XAF " + card.dataset.packagePrice + "/" + card.dataset.packagePeriod;
      openModal();
    });
  });

  methodButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      methodButtons.forEach(function (b) { b.classList.remove("selected"); });
      btn.classList.add("selected");
      methodInput.value = btn.dataset.method;
      phoneSection.classList.remove("hidden");
      if (phoneInput) phoneInput.focus();

      var hint = document.getElementById("phoneHint");
      if (hint) {
        hint.textContent =
          btn.dataset.method === "moov"
            ? "Un code OTP à 6 chiffres vous sera envoyé."
            : "Un code OTP à 4 chiffres vous sera envoyé.";
      }
    });
  });

  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", function (e) {
    if (e.target === modal) closeModal();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
  });

  if (phoneInput) {
    phoneInput.addEventListener("input", function () {
      phoneInput.value = phoneInput.value.replace(/[^\d ]/g, "");
      if (phoneInput.getAttribute("aria-invalid") === "true") {
        setPhoneError(validatePhone(phoneInput.value));
      }
    });
    phoneInput.addEventListener("blur", function () {
      if (phoneInput.value) setPhoneError(validatePhone(phoneInput.value));
    });
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    if (!methodInput.value) {
      setPhoneError("");
      if (errorBox) {
        errorBox.textContent = "Veuillez sélectionner un mode de paiement.";
        errorBox.classList.remove("hidden");
      }
      return;
    }
    var phoneError = validatePhone(phoneInput ? phoneInput.value : "");
    if (phoneError) {
      setPhoneError(phoneError);
      if (phoneInput) phoneInput.focus();
      return;
    }

    if (payBtn) { payBtn.disabled = true; payBtn.textContent = "Traitement…"; }
    try {
      var res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planId: packageIdInput.value,
          method: methodInput.value,
          phone: phoneInput.value,
        }),
      });
      var data = await res.json();
      if (!res.ok || !data.ok) {
        if (payBtn) { payBtn.disabled = false; payBtn.textContent = "Payer maintenant"; }
        setPhoneError(data.error || "Une erreur est survenue.");
        return;
      }
      window.location.href = data.next;
    } catch (err) {
      if (payBtn) { payBtn.disabled = false; payBtn.textContent = "Payer maintenant"; }
      setPhoneError("Connexion impossible. Veuillez réessayer.");
    }
  });

  fetch("/api/mobile-rules")
    .then(function (r) { return r.json(); })
    .then(function (rules) { CHAD_RULES = rules; })
    .catch(function () { /* fall back to built-in defaults */ });

  // Show a server-supplied error (e.g. returned after a failed verification).
  var params = new URLSearchParams(window.location.search);
  if (params.get("error") && errorBox) {
    errorBox.textContent = params.get("error");
    errorBox.classList.remove("hidden");
  }
})();
