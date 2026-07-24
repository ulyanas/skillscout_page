(function () {
  "use strict";

  const DISMISS_KEY = "skillscout.mdviewerBannerDismissed";
  const DISMISSED_CLASS = "mdviewer-banner-dismissed";

  function isBannerDismissed() {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  }

  function saveBannerDismissal() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // The banner still closes for this page when storage is unavailable.
    }
  }

  if (isBannerDismissed()) {
    document.documentElement.classList.add(DISMISSED_CLASS);
  }

  function createMdviewerBanner() {
    const banner = document.createElement("aside");
    banner.className = "partner-banner";
    banner.id = "mdviewerBanner";
    banner.setAttribute("aria-label", "MDViewer promotion");
    banner.innerHTML = `
      <a
        class="partner-banner-link"
        href="https://getmd.ma/?utm_source=skillscout&utm_medium=referral&utm_campaign=mdviewer_banner&utm_content=banner"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="View any SKILL.md instantly with MDViewer"
        data-telemetry-event="Partner.mdViewerOpened"
        data-telemetry-placement="sitewide-partner-banner"
      ></a>
      <div class="partner-banner-inner">
        <div class="partner-banner-brand" aria-hidden="true">
          <img class="partner-banner-logo" src="/assets/mdviewer-icon.webp" alt="" width="512" height="512" />
          <span class="partner-banner-name">MDViewer</span>
        </div>
        <p class="partner-banner-copy" aria-hidden="true">
          <svg class="partner-banner-copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2.5 12s3.5-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.5 5.5-9.5 5.5S2.5 12 2.5 12Z"></path>
            <circle cx="12" cy="12" r="2.5"></circle>
          </svg>
          <span>View any <code>SKILL.md</code> instantly <span class="partner-banner-copy-suffix">with MDViewer</span></span>
        </p>
        <div class="partner-banner-actions">
          <span class="partner-banner-cta" aria-hidden="true">Get MDViewer</span>
          <button class="partner-banner-dismiss" id="dismissMdviewerBanner" type="button" aria-label="Dismiss MDViewer banner">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18"></path>
            </svg>
          </button>
        </div>
      </div>
    `;
    return banner;
  }

  function ensureMdviewerBanner() {
    let banner = document.getElementById("mdviewerBanner");
    if (!banner) {
      banner = createMdviewerBanner();
      const header = document.querySelector(".site-nav-wrap, #navWrap, body > header");
      if (header) {
        header.insertAdjacentElement("afterend", banner);
      } else {
        document.body.prepend(banner);
      }
    }

    const dismissButton = banner.querySelector("#dismissMdviewerBanner");
    if (dismissButton && !dismissButton.dataset.siteShellBound) {
      dismissButton.dataset.siteShellBound = "true";
      dismissButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        saveBannerDismissal();
        document.documentElement.classList.add(DISMISSED_CLASS);
        banner.hidden = true;
      });
    }
  }

  function bindArticleHeader() {
    const burgerButton = document.getElementById("articleBurgerBtn");
    const mobileMenu = document.getElementById("articleMobileMenu");
    const navWrap = document.getElementById("articleNavWrap");

    if (burgerButton && mobileMenu) {
      burgerButton.addEventListener("click", () => {
        const open = mobileMenu.classList.toggle("open");
        burgerButton.classList.toggle("open", open);
        burgerButton.setAttribute("aria-expanded", String(open));
      });

      mobileMenu.querySelectorAll(".site-mobile-link").forEach((link) => {
        link.addEventListener("click", () => {
          mobileMenu.classList.remove("open");
          burgerButton.classList.remove("open");
          burgerButton.setAttribute("aria-expanded", "false");
        });
      });
    }

    if (navWrap) {
      const syncNavBorder = () => navWrap.classList.toggle("scrolled", window.scrollY > 8);
      syncNavBorder();
      window.addEventListener("scroll", syncNavBorder, { passive: true });
    }
  }

  function ensureCoffeeButton() {
    if (document.getElementById("buyMeACoffeeButton")) return;

    const button = document.createElement("a");
    button.className = "bmc-support-button";
    button.id = "buyMeACoffeeButton";
    button.href = "https://buymeacoffee.com/ulyanas";
    button.target = "_blank";
    button.rel = "noopener noreferrer";
    button.setAttribute("aria-label", "Buy me a coffee");
    button.setAttribute("data-telemetry-event", "Support.buyMeACoffeeOpened");
    button.setAttribute("data-telemetry-placement", "sitewide-floating-button");
    button.innerHTML = `
      <img
        class="bmc-support-logo"
        src="/assets/bmc-brand-logo.svg"
        alt=""
        width="195"
        height="40"
        aria-hidden="true"
      />
    `;
    document.body.append(button);
  }

  document.addEventListener("DOMContentLoaded", () => {
    ensureMdviewerBanner();
    bindArticleHeader();
    ensureCoffeeButton();
  });
})();
