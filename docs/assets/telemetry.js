(function () {
  var APP_ID = '3C9562B0-BB40-4DD1-83DF-92702B479D3A';
  var API = 'https://tele.iamsimpl.com/v2/';

  var loc = window.location;
  var nav = navigator;
  var scr = window.screen;
  var ua = nav.userAgent || '';

  var isTest = /^localhost$|^127(\.\d+){0,2}\.\d+$|^\[::1?]$/.test(loc.hostname) || loc.protocol === 'file:';

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
    sessionID = sessionStorage.getItem('td_session');
    if (!sessionID) {
      sessionID = crypto.randomUUID();
      sessionStorage.setItem('td_session', sessionID);
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
    if (/Mobi|Android.*Mobile|iPhone/.test(ua)) return 'phone';
    if (/iPad|Android(?!.*Mobile)|Tablet/.test(ua)) return 'tablet';
    return 'desktop';
  }

  var browser = parseBrowser();
  var os = parseOS();
  var majorVersion = os.version.split('.')[0] || '';
  var majorMinor = os.version.split('.').slice(0, 2).join('.') || '';
  var conn = nav.connection || nav.mozConnection || nav.webkitConnection;

  // --- UTM parameters ---
  var params = new URLSearchParams(loc.search);
  var utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

  // --- build payload (all values must be strings) ---
  var payload = {
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

    'TelemetryDeck.UserPreference.colorScheme': window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    'TelemetryDeck.UserPreference.language': nav.language || '',
    'TelemetryDeck.UserPreference.region': Intl.DateTimeFormat().resolvedOptions().locale || '',

    'TelemetryDeck.RunContext.locale': nav.language || '',
    'TelemetryDeck.RunContext.targetEnvironment': 'web',

    'TelemetryDeck.SDK.name': 'WebSDK-Custom',
    'TelemetryDeck.SDK.version': '2.0.0',
    'TelemetryDeck.SDK.nameAndVersion': 'WebSDK-Custom 2.0.0',

    'TelemetryDeck.Navigation.url': loc.href,
    'TelemetryDeck.Navigation.referrer': document.referrer || '',
    'TelemetryDeck.Navigation.path': loc.pathname,
    'TelemetryDeck.Navigation.host': loc.hostname,

    'TelemetryDeck.Browser.name': browser.name,
    'TelemetryDeck.Browser.version': browser.version,
    'TelemetryDeck.Browser.userAgent': ua,
    'TelemetryDeck.Browser.languages': (nav.languages || []).join(','),
    'TelemetryDeck.Browser.cookiesEnabled': String(nav.cookieEnabled),
    'TelemetryDeck.Browser.doNotTrack': String(nav.doNotTrack === '1' || window.doNotTrack === '1'),
    'TelemetryDeck.Browser.touchSupport': String('ontouchstart' in window || nav.maxTouchPoints > 0),
    'TelemetryDeck.Browser.maxTouchPoints': String(nav.maxTouchPoints || 0),
    'TelemetryDeck.Browser.colorDepth': String(scr.colorDepth),

    'TelemetryDeck.Viewport.width': String(window.innerWidth),
    'TelemetryDeck.Viewport.height': String(window.innerHeight),

    'TelemetryDeck.Page.title': document.title || '',

    'TelemetryDeck.Detection.isBot': String(/bot|crawl|spider|slurp|googlebot|bingbot|yandex|baidu|duckduckbot|facebookexternalhit|twitterbot|linkedinbot|applebot/i.test(ua))
  };

  if (conn) {
    if (conn.effectiveType) payload['TelemetryDeck.Network.effectiveType'] = conn.effectiveType;
    if (conn.downlink) payload['TelemetryDeck.Network.downlink'] = String(conn.downlink);
    if (conn.saveData !== undefined) payload['TelemetryDeck.Network.saveData'] = String(conn.saveData);
  }

  utmKeys.forEach(function (k) {
    var v = params.get(k);
    if (v) payload['TelemetryDeck.Campaign.' + k] = v;
  });

  // --- send signal in TelemetryDeck SignalPostBody format ---
  var signal = {
    receivedAt: new Date().toISOString(),
    appID: APP_ID,
    clientUser: clientUser,
    sessionID: sessionID,
    type: 'pageView',
    payload: payload,
    isTestMode: isTest ? 'true' : 'false'
  };

  fetch(API, {
    method: 'POST',
    mode: 'cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([signal])
  }).catch(function () {});
})();
