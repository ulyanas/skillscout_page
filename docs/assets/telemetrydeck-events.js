(function () {
  "use strict";

  const APP_ID = "D96EABE1-3B07-40E5-B149-DFA286B7FA5B";
  const ENDPOINT = "https://tele.iamsimpl.com/v2/namespace/com.skillscout/";
  const SESSION_KEY = "skillscout.telemetry.session";
  const BOT_PATTERN =
    /bot|crawl|spider|slurp|googlebot|bingbot|yandex|baidu|duckduckbot|facebookexternalhit|twitterbot|linkedinbot|applebot/i;
  const EVENT_MAP = {
    get_extension_click: "Extension.downloadClicked",
    list_skills_click: "Skills.listSubmissionOpened",
    feature_slot_click: "Skills.featuredSlotClicked"
  };

  let fallbackSessionSeed = createRandomID();

  function createRandomID() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function getSessionSeed() {
    try {
      let seed = sessionStorage.getItem(SESSION_KEY);
      if (!seed) {
        seed = createRandomID();
        sessionStorage.setItem(SESSION_KEY, seed);
      }
      return seed;
    } catch {
      return fallbackSessionSeed;
    }
  }

  async function hash(value) {
    if (globalThis.crypto && globalThis.crypto.subtle && globalThis.TextEncoder) {
      const bytes = new TextEncoder().encode(value);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    return value.replace(/[^a-z0-9]/gi, "");
  }

  function isTestEnvironment() {
    const hostname = window.location.hostname;
    return (
      window.location.protocol === "file:" ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    );
  }

  function isBot() {
    return BOT_PATTERN.test(navigator.userAgent || "");
  }

  function normalizePayload(payload) {
    return Object.fromEntries(
      Object.entries(payload)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 500) : value])
    );
  }

  function getBrowserContext() {
    const userAgent = navigator.userAgent || "";
    const isTablet = /iPad|Tablet/i.test(userAgent);
    const isMobile =
      !isTablet &&
      (navigator.userAgentData?.mobile ?? /Android|iPhone|iPod|Mobile/i.test(userAgent));
    const browserMatch =
      userAgent.match(/Edg\/([\d.]+)/) ||
      userAgent.match(/OPR\/([\d.]+)/) ||
      userAgent.match(/Chrome\/([\d.]+)/) ||
      userAgent.match(/Version\/([\d.]+).*Safari/) ||
      userAgent.match(/Firefox\/([\d.]+)/);
    const browserName = userAgent.includes("Edg/")
      ? "Edge"
      : userAgent.includes("OPR/")
        ? "Opera"
        : userAgent.includes("Chrome/")
          ? "Chrome"
          : userAgent.includes("Safari/")
            ? "Safari"
            : userAgent.includes("Firefox/")
              ? "Firefox"
              : "Unknown";

    return {
      platform: navigator.userAgentData?.platform || navigator.platform || "Web",
      browserName,
      browserVersion: browserMatch?.[1] || "",
      device: isTablet ? "Tablet" : isMobile ? "Mobile" : "Desktop",
      isMobile,
      isTablet,
      isDesktop: !isMobile && !isTablet,
      isTouchCapable: navigator.maxTouchPoints > 0
    };
  }

  function getPagePayload() {
    const url = new URL(window.location.href);
    const referrer = document.referrer || "";
    const browser = getBrowserContext();
    const campaignKeys = [
      "ref",
      "source",
      "src",
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "MSCLKID",
      "GCLID"
    ];
    const campaign = Object.fromEntries(
      campaignKeys
        .filter((key) => url.searchParams.has(key))
        .map((key) => [key, url.searchParams.get(key)])
    );
    const combinedSource =
      url.searchParams.get("ref") ||
      url.searchParams.get("source") ||
      url.searchParams.get("utm_source") ||
      url.searchParams.get("src") ||
      undefined;

    return {
      url: url.href,
      host: url.host,
      path: url.pathname,
      scheme: url.protocol.replace(":", ""),
      referer: referrer,
      combinedSource,
      locale: navigator.language,
      preferredLanguage: navigator.language,
      telemetryClientVersion: "Skillscout Web 1.0",
      "TelemetryDeck.Navigation.schemaVersion": "1",
      "TelemetryDeck.Navigation.sourcePath": referrer,
      "TelemetryDeck.Navigation.destinationPath": url.pathname,
      "TelemetryDeck.Navigation.identifier": `${referrer || "(direct)"} -> ${url.href}`,
      "TelemetryDeck.Device.platform": browser.platform,
      "TelemetryDeck.Device.screenResolutionHeight": window.screen.height,
      "TelemetryDeck.Device.screenResolutionWidth": window.screen.width,
      "TelemetryDeck.Device.screenScaleFactor": window.devicePixelRatio || 1,
      "TelemetryDeck.Device.timeZone": Intl.DateTimeFormat().resolvedOptions().timeZone,
      "TelemetryDeck.RunContext.locale": navigator.language,
      "TelemetryDeck.UserPreference.language": navigator.language,
      "TelemetryDeck.SDK.name": "Skillscout Web",
      "TelemetryDeck.SDK.version": "1.0",
      ...browser,
      ...campaign
    };
  }

  async function track(type, payload = {}) {
    if (!type) return;
    if (isTestEnvironment() || isBot()) return;

    try {
      const sessionSeed = getSessionSeed();
      const [clientUser, sessionID] = await Promise.all([
        hash(`user:${sessionSeed}`),
        hash(`session:${sessionSeed}`)
      ]);
      const event = {
        appID: APP_ID,
        clientUser,
        sessionID,
        type,
        isTestMode: isTestEnvironment(),
        payload: normalizePayload({
          ...getPagePayload(),
          "Skillscout.Web.pagePath": window.location.pathname,
          ...payload
        })
      };

      await fetch(ENDPOINT, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        keepalive: true,
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify([event])
      });
    } catch {
      // Analytics must never interrupt the user's action.
    }
  }

  window.skillscoutTelemetry = Object.freeze({ track });
  track("pageView", {
    "Skillscout.Web.pageTitle": document.title
  });

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-telemetry-event], [data-ga-event]");
    if (!trigger) return;

    const type = trigger.dataset.telemetryEvent || EVENT_MAP[trigger.dataset.gaEvent];
    if (!type) return;

    track(type, {
      "Skillscout.Web.placement":
        trigger.dataset.telemetryPlacement || trigger.dataset.gaLabel || "unknown",
      "Skillscout.Web.linkURL": trigger.href || "",
      "Skillscout.Web.linkText": trigger.textContent.trim().replace(/\s+/g, " ").slice(0, 120)
    });
  });
})();
