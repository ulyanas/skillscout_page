/**
 * "Feature your skills here" promo slot for hand-written guide pages.
 *
 * Injects one banner per page and its styles, so a guide only needs
 *   <script src="/assets/promo-slot.js?v=..." defer></script>
 * The directory (/official/) and generated vendor pages render their own
 * markup instead — this file is only for the guides.
 */
(function () {
  "use strict";

  // forms.gle strips query params on redirect, so link the expanded viewform URL
  // (short link equivalent: https://forms.gle/iGfD5tDgTfCE4QX66)
  var FORM_URL =
    "https://docs.google.com/forms/d/e/1FAIpQLSdjimLAZ1-KCArqwFVrNWEyVXLx6MYXqDsASAw48qTN5mWvOw/viewform";

  var STYLES = [
    ".promo-slot{display:flex;align-items:center;gap:14px;margin:34px 0;padding:14px 18px;",
    "border:1px dashed rgba(15,91,216,.38);border-radius:18px;",
    "background:radial-gradient(120% 180% at 0% 0%,rgba(15,91,216,.09),transparent 60%),",
    "radial-gradient(120% 180% at 100% 0%,rgba(19,184,180,.12),transparent 55%),var(--panel,#fff);",
    "color:var(--text,#111);text-decoration:none;",
    "transition:border-color 140ms ease,box-shadow 140ms ease,transform 140ms ease}",
    // guide articles underline every link, so out-specify article a:not(...)
    "article a.promo-slot,.promo-slot,.promo-slot *{text-decoration:none;font-weight:400}",
    "article a.promo-slot,.promo-slot{color:var(--text,#111)}",
    "article a.promo-slot .promo-slot-title,.promo-slot-title{font-weight:700}",
    ".promo-slot:hover{border-color:rgba(15,91,216,.7);box-shadow:0 10px 30px rgba(17,17,17,.07);transform:translateY(-1px)}",
    ".promo-slot-mark{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;",
    "flex-shrink:0;border:1px solid rgba(15,91,216,.22);border-radius:12px;",
    "background:linear-gradient(140deg,rgba(15,91,216,.16),rgba(19,184,180,.18));color:#0f5bd8}",
    ".promo-slot-mark svg{width:20px;height:20px}",
    ".promo-slot-copy{min-width:0}",
    ".promo-slot-title{display:block;color:var(--text,#111);font-size:16px;font-weight:700;letter-spacing:-.01em;line-height:1.25}",
    ".promo-slot-subtitle{display:block;margin-top:2px;color:var(--text-muted,#5f5f5f);font-size:13px;line-height:1.4}",
    ".promo-slot-badge{display:inline-flex;align-items:center;gap:5px;margin-left:auto;flex-shrink:0;",
    "border-radius:999px;background:var(--text,#111);color:#fff;padding:7px 11px;font-size:11px;font-weight:700;",
    "line-height:1;white-space:nowrap}",
    ".promo-slot-badge svg{width:12px;height:12px}",
    ".promo-slot-badge,.promo-slot-cta{color:#fff}",
    ".promo-slot-cta{display:inline-flex;align-items:center;gap:6px;flex-shrink:0;border-radius:999px;",
    "background:linear-gradient(140deg,#0f5bd8,#13b8b4);color:#fff;padding:10px 16px;font-size:13px;",
    "font-weight:700;line-height:1;white-space:nowrap}",
    "@media (max-width:640px){.promo-slot{flex-wrap:wrap;gap:10px}",
    ".promo-slot-mark{order:0}.promo-slot-badge{order:1;margin-left:auto}",
    ".promo-slot-copy{order:2;flex:1 1 100%}",
    ".promo-slot-cta{order:3;flex:1 1 100%;justify-content:center}}"
  ].join("");

  var SPARKLE_BIG =
    "M8 1.5l1.1 3.8 3.4 1.2-3.4 1.2L8 11.5 6.9 7.7 3.5 6.5l3.4-1.2L8 1.5Z";
  var SPARKLE_SMALL =
    "M12.5 9.5l.45 1.55 1.55.45-1.55.45-.45 1.55-.45-1.55-1.55-.45 1.55-.45.45-1.55Z";
  var SPARKLE_CENTERED =
    "M8 1.6l1.15 5.25L14.4 8l-5.25 1.15L8 14.4l-1.15-5.25L1.6 8l5.25-1.15L8 1.6Z";

  ready(function () {
    var slug = getSlug();
    var host = document.querySelector("main article") || document.querySelector("main");
    if (!host || document.querySelector(".promo-slot")) return;

    var style = document.createElement("style");
    style.textContent = STYLES;
    document.head.append(style);

    var banner = document.createElement("a");
    banner.className = "promo-slot";
    banner.href = buildUrl(slug);
    banner.target = "_blank";
    banner.rel = "noopener sponsored";
    banner.dataset.gaEvent = "feature_slot_click";
    banner.dataset.gaLabel = "guide-" + slug;
    banner.innerHTML =
      '<span class="promo-slot-mark" aria-hidden="true"><svg viewBox="0 0 16 16">' +
      '<path d="' + SPARKLE_BIG + '" fill="currentColor"/>' +
      '<path d="' + SPARKLE_SMALL + '" fill="currentColor"/></svg></span>' +
      '<span class="promo-slot-copy">' +
      '<span class="promo-slot-title">Feature your skills here</span>' +
      '<span class="promo-slot-subtitle">Put your skills in front of AI builders browsing official skills</span>' +
      "</span>" +
      '<span class="promo-slot-badge"><svg viewBox="0 0 16 16" aria-hidden="true">' +
      '<path d="' + SPARKLE_CENTERED + '" fill="currentColor"/></svg>Featured</span>' +
      '<span class="promo-slot-cta">Apply for this spot <span aria-hidden="true">&rarr;</span></span>';

    // Listing page: above the cards. Article: after the last paragraph.
    var listSection = document.querySelector("main .list");
    if (listSection) {
      listSection.before(banner);
    } else {
      host.append(banner);
    }

    // TelemetryDeck picks the click up through the shared data-ga-event hook
    banner.addEventListener("click", function () {
      if (window.posthog && window.posthog.capture) {
        window.posthog.capture("feature_slot_click", {
          placement: "guide",
          guide_slug: slug,
          href: banner.href
        });
      }
    });
  });

  function buildUrl(slug) {
    var params = [
      "utm_source=skillscout.sh",
      "utm_medium=guide",
      "utm_campaign=feature_your_skill",
      "utm_content=guide_" + encodeURIComponent(slug)
    ];
    return FORM_URL + "?" + params.join("&");
  }

  function getSlug() {
    var parts = location.pathname.split("/").filter(Boolean);
    return parts[1] || "index";
  }

  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }
})();
