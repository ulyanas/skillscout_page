(function () {
  "use strict";

  const APP_ID = "D96EABE1-3B07-40E5-B149-DFA286B7FA5B";
  const ENDPOINT = "https://tele.iamsimpl.com/v2/namespace/com.skillscout/";
  const SESSION_KEY = "skillscout.telemetry.session";
  const EVENT_MAP = {
    get_extension_click: "Extension.downloadClicked",
    list_skills_click: "Skills.listSubmissionOpened"
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

  function normalizePayload(payload) {
    return Object.fromEntries(
      Object.entries(payload)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 500) : value])
    );
  }

  async function track(type, payload = {}) {
    if (!type) return;

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
