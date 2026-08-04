// ==UserScript==
// @name         CDSE Browser — client-credentials auth
// @namespace    local.cdse.clientcreds
// @version      1.0
// @description  Log in to the official Copernicus Browser with a client-credentials token instead of interactive Keycloak SSO. Personal use only — your client secret lives in this script.
// @match        https://browser.dataspace.copernicus.eu/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      identity.dataspace.copernicus.eu
// ==/UserScript==

/*
 * HOW IT WORKS
 *  1. Mints a token via the CDSE client_credentials grant using GM_xmlhttpRequest
 *     (cross-origin, no CORS, secret stays in the script).
 *  2. Injects `Authorization: Bearer <token>` onto every CDSE API request
 *     (fetch + XHR/axios), because the production app reads its token from the
 *     Keycloak instance — which is empty here — not from the redux store.
 *  3. Reaches the app's redux store via React fiber traversal (the store is not
 *     exposed on window) and dispatches `auth/setUser`, which is what unlocks
 *     the UI: dismisses the login modal and enables timelapse etc.
 *  4. Re-mints on a timer to keep the ~30-min token fresh.
 *
 * FRAGILE BY NATURE: steps 2/3 hook the app's minified internals (React fiber
 * fields, the redux action string/shape). If upstream restructures the build,
 * this can break — watch the console for the [cdse-auth] logs to see where.
 *
 * SECURITY: this embeds a client secret in a browser script. Keep it to your
 * own machine; never share or publish it. This is your credential.
 */

(function () {
  'use strict';

  // ----- CONFIG: fill these in from the CDSE Dashboard OAuth client ---------
  const CLIENT_ID = 'FILL_ME_IN';
  const CLIENT_SECRET = 'FILL_ME_IN';
  const TOKEN_URL =
    'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
  // How long before expiry to re-mint (seconds).
  const REFRESH_LEEWAY = 180;
  // -------------------------------------------------------------------------

  const log = (...a) => console.log('[cdse-auth]', ...a);
  const warn = (...a) => console.warn('[cdse-auth]', ...a);

  // Current token, shared with the network hooks (installed synchronously below
  // so they're in place before the app makes any request).
  let currentToken = null;

  // --- 2) Wire-level Bearer injection --------------------------------------
  const shouldAuth = (url) => {
    if (!url) return false;
    try {
      const u = new URL(url, location.href);
      if (u.hostname === 'identity.dataspace.copernicus.eu') return false; // never leak to the IdP
      return u.hostname.endsWith('dataspace.copernicus.eu');
    } catch {
      return false;
    }
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (currentToken && shouldAuth(url)) {
        const headers = new Headers((init && init.headers) || (input && input.headers) || {});
        headers.set('Authorization', 'Bearer ' + currentToken);
        init = Object.assign({}, init, { headers });
      }
    } catch (e) {
      warn('fetch hook error', e);
    }
    return origFetch.call(this, input, init);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cdseUrl = url;
    this.__cdseAuthSet = false;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    // Replace the app's (empty) Authorization value in place rather than
    // appending — setRequestHeader combines duplicate headers with ", ".
    if (currentToken && /^authorization$/i.test(name) && shouldAuth(this.__cdseUrl)) {
      this.__cdseAuthSet = true;
      return origSetHeader.call(this, name, 'Bearer ' + currentToken);
    }
    return origSetHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (currentToken && !this.__cdseAuthSet && shouldAuth(this.__cdseUrl)) {
        origSetHeader.call(this, 'Authorization', 'Bearer ' + currentToken);
        this.__cdseAuthSet = true;
      }
    } catch (e) {
      warn('xhr send hook error', e);
    }
    return origSend.call(this, body);
  };

  // --- 1) Mint a token -----------------------------------------------------
  const mintToken = () =>
    new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: TOKEN_URL,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        }).toString(),
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              resolve(JSON.parse(res.responseText));
            } catch (e) {
              reject(new Error('token response not JSON: ' + e.message));
            }
          } else {
            reject(new Error('token HTTP ' + res.status + ': ' + res.responseText));
          }
        },
        onerror: () => reject(new Error('token request failed (network)')),
      });
    });

  // --- 3) Find the redux store via React fiber traversal -------------------
  const findStore = () => {
    const root = document.getElementById('root');
    if (!root) return null;
    const key = Object.keys(root).find((k) => k.startsWith('__reactContainer$'));
    if (!key) return null;

    const stack = [root[key]];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      const store = node.memoizedProps && node.memoizedProps.store;
      if (store && typeof store.dispatch === 'function' && typeof store.getState === 'function') {
        return store;
      }
      if (node.child) stack.push(node.child);
      if (node.sibling) stack.push(node.sibling);
    }
    return null;
  };

  const waitForStore = (timeoutMs = 30000, intervalMs = 400) =>
    new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        const store = findStore();
        if (store) return resolve(store);
        if (Date.now() - started > timeoutMs) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });

  const applyToStore = (store, data) => {
    store.dispatch({
      type: 'auth/setUser',
      payload: {
        userdata: { name: 'local' }, // stub — client_credentials has no ID token
        access_token: data.access_token,
        token_expiration: Date.now() + data.expires_in * 1000,
      },
    });
  };

  // --- Orchestration -------------------------------------------------------
  const start = async () => {
    if (CLIENT_ID === 'FILL_ME_IN' || CLIENT_SECRET === 'FILL_ME_IN') {
      warn('CLIENT_ID / CLIENT_SECRET not set — edit the script.');
      return;
    }

    const store = await waitForStore();
    if (!store) {
      warn('redux store not found — the app internals may have changed. UI will stay locked, though API requests are still authenticated on the wire.');
    }

    const cycle = async () => {
      try {
        const data = await mintToken();
        currentToken = data.access_token;
        if (store) applyToStore(store, data);
        log('token applied; expires_in', data.expires_in + 's');
        const nextMs = Math.max((data.expires_in - REFRESH_LEEWAY) * 1000, 30000);
        setTimeout(cycle, nextMs);
      } catch (e) {
        warn('mint failed, retrying in 10s:', e.message);
        setTimeout(cycle, 10000);
      }
    };
    cycle();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
