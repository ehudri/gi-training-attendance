/* Shared helpers for the check-in and admin pages */
(function () {
  const CFG = window.APP_CONFIG || {};

  /** POST JSON to the Apps Script web app (text/plain avoids a CORS preflight). */
  async function api(action, data) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    let res;
    try {
      res = await fetch(CFG.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action }, data || {})),
        signal: ctrl.signal,
        redirect: 'follow',
      });
    } catch (e) {
      return { ok: false, code: 'network', message: 'אין חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב.' };
    } finally {
      clearTimeout(timer);
    }
    try {
      return await res.json();
    } catch (e) {
      return { ok: false, code: 'network', message: 'תשובה לא צפויה מהשרת. נסו שוב.' };
    }
  }

  /** Loads Google Identity Services once. */
  let gisPromise = null;
  function loadGis() {
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      if (window.google && google.accounts && google.accounts.id) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('gis')); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }

  /** Renders the official Google button into `el`; onToken(idToken, payload) on success. */
  async function renderGoogleButton(el, onToken) {
    await loadGis();
    google.accounts.id.initialize({
      client_id: CFG.GOOGLE_CLIENT_ID,
      callback: (resp) => onToken(resp.credential, decodeJwt(resp.credential)),
      ux_mode: 'popup',
      auto_select: false,
      cancel_on_tap_outside: true,
      use_fedcm_for_button: true,
    });
    el.innerHTML = '';
    google.accounts.id.renderButton(el, {
      type: 'standard', theme: 'filled_blue', size: 'large', shape: 'pill',
      text: 'signin_with', locale: 'he', logo_alignment: 'left',
      width: Math.min(360, Math.max(240, el.clientWidth || 320)),
    });
  }

  function decodeJwt(token) {
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(atob(part).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
      return JSON.parse(json);
    } catch (e) { return {}; }
  }

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  function formatDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return iso || '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  function formatShortDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? `${Number(m[3])}.${Number(m[2])}.${m[1]}` : (iso || '');
  }

  function todayIso() {
    // today's date in Israel, regardless of the device's timezone
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const $ = (sel, root) => (root || document).querySelector(sel);

  function busy(on) {
    let o = document.getElementById('busy');
    if (!o) {
      o = document.createElement('div');
      o.id = 'busy'; o.className = 'overlay'; o.hidden = true;
      o.innerHTML = '<div class="spinner" role="status" aria-label="טוען"></div>';
      document.body.appendChild(o);
    }
    o.hidden = !on;
  }

  let toastTimer;
  function toast(msg) {
    let t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  /** Builds a scalable SVG QR code (uses qrcode-generator). */
  function qrSvg(text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount(), m = 4, size = n + m * 2;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  /** Public check-in URL for a training. */
  function checkinUrl(id) {
    const base = CFG.PUBLIC_BASE_URL || new URL('../', location.href).href;
    const u = new URL(base);
    u.search = '?t=' + encodeURIComponent(id);
    u.hash = '';
    return u.href;
  }

  const ICONS = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    question: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><path d="M12 17.5h.01"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/></svg>',
  };

  window.App = { CFG, api, loadGis, renderGoogleButton, decodeJwt, store, formatDate, formatShortDate, todayIso, esc, $, busy, toast, qrSvg, checkinUrl, ICONS };
})();
