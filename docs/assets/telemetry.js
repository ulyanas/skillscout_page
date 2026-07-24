(function () {
  var APP_ID = 'D96EABE1-3B07-40E5-B149-DFA286B7FA5B';
  var API = 'https://tele.iamsimpl.com/v2/';
  var SESSION_KEY = 'skillscout.telemetry.session';
  var EVENT_MAP = {
    get_extension_click: 'Extension.downloadClicked',
    list_skills_click: 'Skills.listSubmissionOpened'
  };

  var loc = window.location;
  var nav = navigator;
  var scr = window.screen;
  var ua = nav.userAgent || '';

  var isTest = /^localhost$|^127(\.\d+){0,2}\.\d+$|^\[::1?]$/.test(loc.hostname) ||
    loc.protocol === 'file:' ||
    /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(loc.hostname);

  // --- anonymous user ID (persisted in localStorage) ---
  var storageKey = 'td_user';
  var clientUser = '';
  try {
    clientUser = localStorage.getItem(storageKey);
    if (!clientUser) {
      clientUser = crypto.randomUUID();
      localStorage.setItem(storageKey, clientUser);
    }
  } catch (e) {
    clientUser = crypto.randomUUID();
  }

  // --- session ID (persisted per tab session) ---
  var sessionID = '';
  try {
    sessionID = sessionStorage.getItem(SESSION_KEY);
    if (!sessionID) {
      sessionID = crypto.randomUUID();
      sessionStorage.setItem(SESSION_KEY, sessionID);
    }
  } catch (e) {
    sessionID = crypto.randomUUID();
  }

  // --- browser detection ---
  function parseBrowser() {
    if (/Edg\/(\S+)/.test(ua)) return { name: 'Edge', version: RegExp.$1 };
    if (/OPR\/(\S+)/.test(ua)) return { name: 'Opera', version: RegExp.$1 };
    if (/Chrome\/(\S+)/.test(ua) && !/Edg|OPR/.test(ua)) return { name: 'Chrome', version: RegExp.$1 };
    if (/Version\/(\S+).*Safari/.test(ua)) return { name: 'Safari', version: RegExp.$1 };
    if (/Firefox\/(\S+)/.test(ua)) return { name: 'Firefox', version: RegExp.$1 };
    return { name: 'Other', version: '' };
  }

  // --- OS detection ---
  function parseOS() {
    if (/Mac OS X ([\d_.]+)/.test(ua)) return { name: 'macOS', version: RegExp.$1.replace(/_/g, '.') };
    if (/Windows NT ([\d.]+)/.test(ua)) return { name: 'Windows', version: RegExp.$1 };
    if (/Android ([\d.]+)/.test(ua)) return { name: 'Android', version: RegExp.$1 };
    if (/iPhone OS ([\d_]+)/.test(ua)) return { name: 'iOS', version: RegExp.$1.replace(/_/g, '.') };
    if (/iPad.*OS ([\d_]+)/.test(ua)) return { name: 'iPadOS', version: RegExp.$1.replace(/_/g, '.') };
    if (/Linux/.test(ua)) return { name: 'Linux', version: '' };
    if (/CrOS/.test(ua)) return { name: 'ChromeOS', version: '' };
    return { name: 'Other', version: '' };
  }

  function deviceType() {
    if (/iPad|Tablet/i.test(ua)) return 'tablet';
    if (/Mobi|Android.*Mobile|iPhone|iPod/i.test(ua)) return 'phone';
    return 'desktop';
  }

  var browser = parseBrowser();
  var os = parseOS();
  var majorVersion = os.version.split('.')[0] || '';
  var majorMinor = os.version.split('.').slice(0, 2).join('.') || '';
  var conn = nav.connection || nav.mozConnection || nav.webkitConnection;

  // --- UTM + referral parameters ---
  var params = new URLSearchParams(loc.search);
  var campaignKeys = ['ref', 'source', 'src', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'MSCLKID', 'GCLID'];
  var combinedSource = params.get('ref') || params.get('source') || params.get('utm_source') || params.get('src') || '';

  // --- build payload ---
  function buildPayload(extra) {
    var url = new URL(loc.href);
    var referrer = document.referrer || '';
    var payload = {
      // navigation
      'TelemetryDeck.Navigation.schemaVersion': '1',
      'TelemetryDeck.Navigation.url': loc.href,
      'TelemetryDeck.Navigation.referrer': referrer,
      'TelemetryDeck.Navigation.sourcePath': referrer,
      'TelemetryDeck.Navigation.destinationPath': loc.pathname,
      'TelemetryDeck.Navigation.identifier': (referrer || '(direct)') + ' -> ' + loc.href,
      'TelemetryDeck.Navigation.path': loc.pathname,
      'TelemetryDeck.Navigation.host': loc.hostname,

      // device & OS
      'TelemetryDeck.Device.operatingSystem': os.name,
      'TelemetryDeck.Device.systemVersion': os.version,
      'TelemetryDeck.Device.systemMajorVersion': majorVersion,
      'TelemetryDeck.Device.systemMajorMinorVersion': majorMinor,
      'TelemetryDeck.Device.platform': deviceType(),
      'TelemetryDeck.Device.modelName': nav.platform || '',
      'TelemetryDeck.Device.screenResolutionWidth': String(scr.width),
      'TelemetryDeck.Device.screenResolutionHeight': String(scr.height),
      'TelemetryDeck.Device.screenScaleFactor': String(window.devicePixelRatio || 1),
      'TelemetryDeck.Device.timeZone': Intl.DateTimeFormat().resolvedOptions().timeZone || '',

      // browser
      'TelemetryDeck.Browser.name': browser.name,
      'TelemetryDeck.Browser.version': browser.version,
      'TelemetryDeck.Browser.userAgent': ua,
      'TelemetryDeck.Browser.languages': (nav.languages || []).join(','),
      'TelemetryDeck.Browser.cookiesEnabled': String(nav.cookieEnabled),
      'TelemetryDeck.Browser.doNotTrack': String(nav.doNotTrack === '1' || window.doNotTrack === '1'),
      'TelemetryDeck.Browser.touchSupport': String('ontouchstart' in window || nav.maxTouchPoints > 0),
      'TelemetryDeck.Browser.maxTouchPoints': String(nav.maxTouchPoints || 0),
      'TelemetryDeck.Browser.colorDepth': String(scr.colorDepth),

      // viewport & page
      'TelemetryDeck.Viewport.width': String(window.innerWidth),
      'TelemetryDeck.Viewport.height': String(window.innerHeight),
      'TelemetryDeck.Page.title': document.title || '',

      // user preferences
      'TelemetryDeck.UserPreference.colorScheme': window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      'TelemetryDeck.UserPreference.language': nav.language || '',
      'TelemetryDeck.UserPreference.region': Intl.DateTimeFormat().resolvedOptions().locale || '',

      // run context
      'TelemetryDeck.RunContext.locale': nav.language || '',
      'TelemetryDeck.RunContext.targetEnvironment': 'web',

      // SDK
      'TelemetryDeck.SDK.name': 'Skillscout Web',
      'TelemetryDeck.SDK.version': '2.0',
      'TelemetryDeck.SDK.nameAndVersion': 'Skillscout Web 2.0',

      // bot detection
      'TelemetryDeck.Detection.isBot': String(/bot|crawl|spider|slurp|googlebot|bingbot|yandex|baidu|duckduckbot|facebookexternalhit|twitterbot|linkedinbot|applebot/i.test(ua)),

      // skillscout-specific
      'Skillscout.Web.pagePath': loc.pathname,
      'Skillscout.Web.pageTitle': document.title || '',
      'telemetryClientVersion': 'Skillscout Web 2.0',
      'locale': nav.language || '',
      'preferredLanguage': nav.language || '',
      'combinedSource': combinedSource,
      'scheme': url.protocol.replace(':', '')
    };

    if (conn) {
      if (conn.effectiveType) payload['TelemetryDeck.Network.effectiveType'] = conn.effectiveType;
      if (conn.downlink) payload['TelemetryDeck.Network.downlink'] = String(conn.downlink);
      if (conn.saveData !== undefined) payload['TelemetryDeck.Network.saveData'] = String(conn.saveData);
    }

    campaignKeys.forEach(function (k) {
      var v = params.get(k);
      if (v) payload['TelemetryDeck.Campaign.' + k] = v;
    });

    var merged = Object.assign({}, payload, extra || {});
    return Object.fromEntries(
      Object.entries(merged)
        .filter(function (e) { return e[1] !== undefined && e[1] !== null && e[1] !== ''; })
        .map(function (e) { return [e[0], String(e[1]).slice(0, 500)]; })
    );
  }

  function send(type, extra) {
    if (!type) return;
    fetch(API, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      keepalive: true,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify([{
        receivedAt: new Date().toISOString(),
        appID: APP_ID,
        clientUser: clientUser,
        sessionID: sessionID,
        type: type,
        payload: buildPayload(extra),
        isTestMode: isTest ? 'true' : 'false'
      }])
    }).catch(function () {});
  }

  // --- expose for manual tracking ---
  window.skillscoutTelemetry = Object.freeze({ track: send });

  // --- pageView on load ---
  send('pageView');

  // --- click tracking for data-telemetry-event and data-ga-event ---
  document.addEventListener('click', function (event) {
    var trigger = event.target.closest('[data-telemetry-event], [data-ga-event]');
    if (!trigger) return;
    var type = trigger.dataset.telemetryEvent || EVENT_MAP[trigger.dataset.gaEvent];
    if (!type) return;
    send(type, {
      'Skillscout.Web.placement': trigger.dataset.telemetryPlacement || trigger.dataset.gaLabel || 'unknown',
      'Skillscout.Web.linkURL': trigger.href || '',
      'Skillscout.Web.linkText': (trigger.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120)
    });
  });
})();
