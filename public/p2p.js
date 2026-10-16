/**
 * p2p.js — "serverless" online mode for static hosting (GitHub Pages). No Node server, no paid hosting.
 *
 * How it works
 *  - A free public PeerJS broker only introduces browsers to each other.
 *  - The first player to open the game claims the fixed peer id LOBBY_ID and becomes the LOBBY HOST:
 *    their tab runs the exact same game-server code as server.js (gamecore.js) and everyone else connects to it.
 *  - If the host closes the tab, the remaining players automatically reconnect and one of them becomes the new host
 *    (matches in progress are lost, menus / friends / matchmaking keep working).
 *  - window.io is replaced by a socket.io-compatible client, so main.js needs no changes.
 */
(function (root) {
  const rid = () => Math.random().toString(36).slice(2, 10);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clone = (v) => { try { return v === undefined ? v : structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); } };

  /* ---------------- server side (runs in the host's tab) ---------------- */
  class ServerSocket {
    constructor(server, send) {
      this.server = server; this.id = 's' + rid(); this.data = {}; this.handshake = { auth: {} };
      this.rooms = new Set(); this.h = {}; this._send = send;
    }
    on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; }
    emit(ev, data) { this._send({ e: ev, d: data }); return this; }
    join(r) { this.rooms.add(r); this.server._room(r).add(this); }
    leave(r) { this.rooms.delete(r); this.server._rooms.get(r)?.delete(this); }
    _recv(m) {
      const cb = m.a != null ? (res) => this._send({ ack: m.a, d: res }) : undefined;
      for (const f of this.h[m.e] || []) { try { f(m.d, cb); } catch (err) { console.error('[p2p server]', m.e, err); } }
    }
    _close() {
      if (this._closed) return; this._closed = true;
      for (const f of this.h.disconnect || []) { try { f(); } catch (err) { console.error(err); } }
      this.rooms.forEach((r) => this.server._rooms.get(r)?.delete(this)); this.server.sockets.sockets.delete(this.id);
    }
  }
  class MiniServer {      // the subset of socket.io's Server that gamecore.js uses
    constructor() { this.mw = []; this.conn = []; this.sockets = { sockets: new Map() }; this._rooms = new Map(); }
    use(fn) { this.mw.push(fn); }
    on(ev, fn) { if (ev === 'connection') this.conn.push(fn); }
    to(room) { return { emit: (ev, data) => this._rooms.get(room)?.forEach((s) => s.emit(ev, data)) }; }
    _room(r) { if (!this._rooms.has(r)) this._rooms.set(r, new Set()); return this._rooms.get(r); }
    async accept(socket, auth) {
      socket.handshake.auth = auth || {};
      for (const fn of this.mw) await new Promise((res, rej) => fn(socket, (e) => (e ? rej(e) : res())));
      this.sockets.sockets.set(socket.id, socket); this.conn.forEach((f) => f(socket));
    }
  }

  /* ---------------- client side (socket.io-compatible) ---------------- */
  class ClientSocket {
    constructor(auth) { this.auth = auth; this.h = {}; this.connected = false; this.id = null; this.acks = new Map(); this.ackId = 0; this.active = true; this._link = null; this._stop = null; }
    on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; }
    off(ev, fn) { this.h[ev] = (this.h[ev] || []).filter((f) => f !== fn); return this; }
    once(ev, fn) { const w = (...a) => { this.off(ev, w); fn(...a); }; return this.on(ev, w); }
    _fire(ev, ...a) { for (const f of [...(this.h[ev] || [])]) { try { f(...a); } catch (e) { console.error(e); } } }
    emit(ev, data, cb) {
      if (typeof data === 'function') { cb = data; data = undefined; }
      if (!this.connected || !this._link) return this;           // dropped while offline (socket.io would buffer; callers check ready() first)
      const m = { e: ev, d: data }; if (cb) { m.a = ++this.ackId; this.acks.set(m.a, cb); }
      this._link(m); return this;
    }
    _recv(m) {
      if (m.ack != null) { const cb = this.acks.get(m.ack); this.acks.delete(m.ack); cb && cb(m.d); return; }
      this._fire(m.e, m.d);
    }
    _ready(id) { this.id = id; this.connected = true; this._fire('connect'); }
    _lost() {
      if (!this.connected) return; this.connected = false; this._link = null; this.acks.clear(); this._fire('disconnect');
      if (this.active) setTimeout(() => this.active && start(this), 400 + Math.random() * 1600);   // reconnect / maybe become host
    }
    disconnect() { this.active = false; const was = this.connected; this.connected = false; this._link = null; this._stop && this._stop(); if (was) this._fire('disconnect'); }
  }

  /* ---------------- networking glue (browser only) ---------------- */
  const LOBBY = () => root.LOBBY_ID || 'cyber-arena-lobby-7q2x9';
  const PEER_OPTS = () => ({
    debug: 0,
    config: { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
    ] }
  });
  let HOST = null;   // { peer, server, game, users:Set<ClientSocket> } — present while THIS tab is the lobby host

  /** Attach a ClientSocket to an in-process server socket (used by the host's own player, and by tests). */
  async function loopback(server, cs) {
    const ss = new ServerSocket(server, (m) => queueMicrotask(() => cs._recv(clone(m))));
    cs._link = (m) => queueMicrotask(() => ss._recv(clone(m)));
    cs._stop = () => ss._close();
    await server.accept(ss, cs.auth);
    cs._ready(ss.id);
    return ss;
  }

  function becomeHost(peer, cs) {
    const server = new MiniServer(), game = root.createGame(server, root.SHARED, {});
    HOST = { peer, server, game, users: new Set([cs]) };
    peer.on('connection', (conn) => {
      let ss = null;
      conn.on('data', async (m) => {
        if (m && m.hello) {
          ss = new ServerSocket(server, (msg) => { if (conn.open) conn.send(msg); });
          try { await server.accept(ss, m.hello); conn.send({ ready: ss.id }); }
          catch (e) { conn.send({ err: (e && e.message) || 'auth failed' }); setTimeout(() => conn.close(), 200); }
          return;
        }
        ss && ss._recv(m);
      });
      conn.on('close', () => ss && ss._close());
      conn.on('error', () => ss && ss._close());
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* ignore */ } });
    peer.on('error', () => { /* keep hosting; individual connection errors are handled per-connection */ });
    cs._stop = null;
    loopback(server, cs).then((ss) => {
      cs._stop = () => { ss._close(); HOST && HOST.users.delete(cs); if (HOST && !HOST.users.size) { try { peer.destroy(); } catch { /* ignore */ } HOST = null; } };
    });
  }

  function tryHost(cs) {
    return new Promise((res) => {
      let done = false; const peer = new root.Peer(LOBBY(), PEER_OPTS());
      const fail = () => { if (!done) { done = true; try { peer.destroy(); } catch { /* ignore */ } res(false); } };
      peer.on('open', () => { if (done) return; done = true; becomeHost(peer, cs); res(true); });
      peer.on('error', fail); setTimeout(fail, 9000);
    });
  }

  function tryJoin(cs) {
    return new Promise((res) => {
      let done = false, peer;
      const fail = () => { if (!done) { done = true; try { peer && peer.destroy(); } catch { /* ignore */ } res(false); } };
      try { peer = new root.Peer(undefined, PEER_OPTS()); } catch { return res(false); }
      peer.on('error', () => { if (done) { cs._lost(); } else fail(); });
      peer.on('open', () => {
        const conn = peer.connect(LOBBY(), { reliable: true, serialization: 'json' });
        cs._stop = () => { try { conn.close(); peer.destroy(); } catch { /* ignore */ } };
        conn.on('open', () => conn.send({ hello: cs.auth }));
        conn.on('data', (m) => {
          if (m && m.ready) { done = true; cs._link = (msg) => conn.open && conn.send(msg); cs._ready(m.ready); res(true); }
          else if (m && m.err) { fail(); cs._fire('connect_error', new Error(m.err)); }
          else cs._recv(m);
        });
        conn.on('close', () => { if (done) { cs._lost(); try { peer.destroy(); } catch { /* ignore */ } } else fail(); });
        conn.on('error', () => { if (!done) fail(); });
      });
      setTimeout(fail, 10000);
    });
  }

  async function start(cs) {
    if (cs._starting) return; cs._starting = true;
    try {
      while (cs.active && !cs.connected) {
        if (await tryHost(cs)) return;
        if (!cs.active) return;
        if (await tryJoin(cs)) return;
        cs._fire('connect_error', new Error('lobby not reachable, retrying…'));
        await sleep(1500 + Math.random() * 2000);
      }
    } finally { cs._starting = false; }
  }

  function io(_url, opts) { const cs = new ClientSocket((opts && opts.auth) || {}); setTimeout(() => start(cs), 0); return cs; }

  const api = { io, MiniServer, ServerSocket, ClientSocket, loopback };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.P2P = api;
})(typeof window !== 'undefined' ? window : globalThis);
