/* CollabOne board: HTTP API client (CONTRACT §4). Human session only: Bearer = Cognito ID token. */
(function () {
  'use strict';
  const C1 = (window.C1 = window.C1 || {});

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message || code || 'Request failed');
      this.status = status;
      this.code = code;
    }
  }

  const Api = {
    base: '',
    init(config) {
      this.base = String(config.apiBase || '').replace(/\/$/, '');
    },

    async request(method, path, body) {
      const token = await C1.Auth.idToken();
      if (!token) throw new ApiError(401, 'unauthorized', 'Your session expired. Sign in again.');
      const headers = { Authorization: 'Bearer ' + token };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(this.base + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
      let data = null;
      const text = await res.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (e) {
          data = null;
        }
      }
      if (!res.ok) {
        const err = (data && data.error) || {};
        throw new ApiError(res.status, err.code || 'error', err.message || 'Request failed (' + res.status + ')');
      }
      return data;
    },

    get(p) {
      return this.request('GET', p);
    },
    post(p, b) {
      return this.request('POST', p, b === undefined ? {} : b);
    },
    del(p) {
      return this.request('DELETE', p);
    },

    // Reads
    me: () => Api.get('/me'),
    board: (projectId) => Api.get('/board' + (projectId ? '?projectId=' + encodeURIComponent(projectId) : '')),
    ticket: (tid) => Api.get('/tickets/' + encodeURIComponent(tid)),
    escalations: () => Api.get('/escalations?status=open'),
    decisions: () => Api.get('/decisions?status=open'),
    proposals: () => Api.get('/proposals?status=pending'),
    knowledge: () => Api.get('/knowledge?status=active'),
    rules: (projectId) => Api.get('/rules' + (projectId ? '?projectId=' + encodeURIComponent(projectId) : '')),
    events: (since) => Api.get('/events?since=' + encodeURIComponent(since) + '&limit=200'),
    tokens: () => Api.get('/tokens'),

    // Human actions
    createSeat: (seat) => Api.post('/seats/me', seat),
    approve: (pid) => Api.post('/proposals/' + encodeURIComponent(pid) + '/approve'),
    reject: (pid) => Api.post('/proposals/' + encodeURIComponent(pid) + '/reject'),
    resolve: (eid, resolution, reason) => Api.post('/escalations/' + encodeURIComponent(eid) + '/resolve', { resolution, reason }),
    contest: (eid, reason) => Api.post('/escalations/' + encodeURIComponent(eid) + '/contest', { reason }),
    vote: (did, option, why) => Api.post('/decisions/' + encodeURIComponent(did) + '/vote', { option, why }),
    action: (action, payload) => Api.post('/actions', { action, payload }),
    joinCode: () => Api.post('/join-codes'),
    release: () => Api.get('/release'),
    revokeToken: (tokenId) => Api.del('/tokens/' + encodeURIComponent(tokenId)),
  };

  C1.Api = Api;
  C1.ApiError = ApiError;
})();
