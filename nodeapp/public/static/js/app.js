/* Starlink chad — shared page script. */
(function () {
  "use strict";

  // Highlight the active bottom-nav tab.
  var active = document.body.getAttribute("data-active") || "";
  document.querySelectorAll("nav a[href]").forEach(function (link) {
    var href = link.getAttribute("href").replace(/\/$/, "");
    if (href === "/" + active) link.classList.add("text-red-600");
  });

  // Register the service worker only where one exists. Nothing here caches
  // HTML: order pages carry per-order state and must always be fresh.
  if ("serviceWorker" in navigator && document.body.hasAttribute("data-sw-url")) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register(document.body.getAttribute("data-sw-url")).catch(function () {});
    });
  }
})();
