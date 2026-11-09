/* CollabOne board: Cognito managed login with authorization code + PKCE. Tokens live in sessionStorage only. */
(function () {
  'use strict';
  const C1 = (window.C1 = window.C1 || {});

  const KEY = 'c1.auth';
  const PKCE_KEY = 'c1.pkce';

  function ss() {
    try {
      return window.sessionStorage;
    } catch (e) {
      return null;
    }
  }

  function b64url(bytes) {
    let s = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomString(n) {
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return b64url(a);
  }

  async function sha256(text) {
    const data = new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', data);
  }

  function decodeJwt(token) {
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(
        atob(part)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  function read() {
    const store = ss();
    if (!store) return null;
    try {
      return JSON.parse(store.getItem(KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function write(v) {
    const store = ss();
    if (!store) return;
    if (v) store.setItem(KEY, JSON.stringify(v));
    else store.removeItem(KEY);
  }

  const Auth = {
    config: null,
    init(config) {
      this.config = config;
    },

    claims() {
      const t = read();
      return t ? decodeJwt(t.idToken) : null;
    },

    /** Returns a valid ID token, refreshing when it is about to expire. Null when signed out. */
    async idToken() {
      const t = read();
      if (!t) return null;
      const claims = decodeJwt(t.idToken);
      const expMs = claims && claims.exp ? claims.exp * 1000 : 0;
      if (expMs - Date.now() > 60 * 1000) return t.idToken;
      if (t.refreshToken) {
        try {
          const fresh = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken });
          write({ idToken: fresh.id_token, refreshToken: t.refreshToken });
          return fresh.id_token;
        } catch (e) {
          /* fall through to sign-out */
        }
      }
      write(null);
      return null;
    },

    async signIn() {
      const c = this.config.cognito;
      const verifier = randomString(48);
      const state = randomString(16);
      const challenge = b64url(await sha256(verifier));
      const store = ss();
      if (store) store.setItem(PKCE_KEY, JSON.stringify({ verifier, state, hash: location.hash || '' }));
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: c.clientId,
        redirect_uri: c.redirectUri,
        scope: 'openid email profile',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
      });
      location.assign(c.domain.replace(/\/$/, '') + '/oauth2/authorize?' + q.toString());
    },

    /** Completes the redirect from Cognito. Returns the hash to restore (deep link), or null when not a callback. */
    async handleCallback() {
      const params = new URLSearchParams(location.search);
      const code = params.get('code');
      if (!code) return null;
      const store = ss();
      let saved = null;
      try {
        saved = JSON.parse((store && store.getItem(PKCE_KEY)) || 'null');
      } catch (e) {
        saved = null;
      }
      if (store) store.removeItem(PKCE_KEY);
      history.replaceState(null, '', location.pathname);
      if (!saved || saved.state !== params.get('state')) throw new Error('Sign-in state did not match. Please sign in again.');
      const tokens = await this.tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.cognito.redirectUri,
        code_verifier: saved.verifier,
      });
      write({ idToken: tokens.id_token, refreshToken: tokens.refresh_token || null });
      return saved.hash || '';
    },

    async tokenRequest(fields) {
      const c = this.config.cognito;
      const body = new URLSearchParams(Object.assign({ client_id: c.clientId }, fields));
      const res = await fetch(c.domain.replace(/\/$/, '') + '/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!res.ok) throw new Error('Token request failed (' + res.status + ')');
      return res.json();
    },

    signOut() {
      write(null);
      const c = this.config && this.config.cognito;
      if (!c) {
        location.reload();
        return;
      }
      const q = new URLSearchParams({ client_id: c.clientId, logout_uri: c.logoutUri || c.redirectUri });
      location.assign(c.domain.replace(/\/$/, '') + '/logout?' + q.toString());
    },

    isSignedIn() {
      return !!read();
    },
  };

  C1.Auth = Auth;
  C1.decodeJwt = decodeJwt;
})();
