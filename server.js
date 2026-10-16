/**
 * server.js — Express + Socket.io backend.
 *  - Serves /public
 *  - Presence (uid -> socket) for friend online status
 *  - Matchmaking queue + private party matches
 *  - Authoritative 1v1 simulation @ 30 Hz (movement, dash, melee/ranged, block/parry, knockback, ring-out, rounds)
 *
 * Run:  npm install && npm start      (PORT env var optional)
 * Optional auth verification: set FIREBASE_SERVICE_ACCOUNT to the service-account JSON string.
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const S = require('./public/shared.js');

// ---------- optional Firebase ID-token verification ----------
let admin = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    console.log('[auth] Firebase token verification ON');
  } catch (e) { console.warn('[auth] firebase-admin unavailable, trusting client uid:', e.message); admin = null; }
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
// Monetization stub: wire Stripe/Paddle here, then grant the skin via firebase-admin on webhook.
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size, online: online.size }));   // uptime pings / host health check
app.post('/api/checkout', (_req, res) => res.status(501).json({ error: 'Payment provider not configured' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 10000, pingTimeout: 8000 });

// ---------- state ----------
const online = new Map();   // uid -> socket.id
const handles = new Map();  // lowercase handle -> uid (friend requests when Firebase isn't used)
const queue = [];           // sockets waiting for a public match
const parties = new Map();  // partyId -> { id, leader, members:[uid] }
const partyOf = new Map();  // uid -> partyId
const rooms = new Map();    // roomId -> room
let uidCounter = 0;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sockByUid = (uid) => io.sockets.sockets.get(online.get(uid));

// ---------- auth middleware ----------
io.use(async (socket, next) => {
  const { token, uid, name } = socket.handshake.auth || {};
  try {
    if (admin && token) {
      const dec = await admin.auth().verifyIdToken(token);
      socket.data.uid = dec.uid;
    } else {
      socket.data.uid = String(uid || 'anon_' + (++uidCounter)).slice(0, 64);
    }
    socket.data.name = String(name || 'Player').slice(0, 20);
    socket.data.handle = String((socket.handshake.auth || {}).handle || '').slice(0, 32).toLowerCase();
    next();
  } catch (e) { next(new Error('auth failed')); }
});

io.on('connection', (socket) => {
  const uid = socket.data.uid;
  online.set(uid, socket.id);
  if (socket.data.handle) handles.set(socket.data.handle, uid);

  // ---------- friends (lightweight, used when Firebase isn't configured) ----------
  socket.on('friend:request', ({ handle } = {}, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    const tuid = handles.get(String(handle || '').trim().toLowerCase()), t = tuid && sockByUid(tuid);
    if (!t) return reply({ error: 'Player not found (they must be online)' });
    if (tuid === uid) return reply({ error: "That's you!" });
    t.emit('friend:request', { fromUid: uid, fromName: socket.data.name, fromHandle: socket.data.handle });
    reply({ ok: true, name: t.data.name });
  });
  socket.on('friend:accept', ({ uid: other } = {}) => {
    const t = sockByUid(other); if (t) t.emit('friend:added', { uid, name: socket.data.name, handle: socket.data.handle });
  });

  // ---------- presence ----------
  socket.on('presence:get', (uids, cb) => {
    if (!Array.isArray(uids) || typeof cb !== 'function') return;
    const out = {};
    uids.slice(0, 200).forEach((u) => { out[u] = online.has(u); });
    cb(out);
  });
  socket.on('ping_', (t, cb) => typeof cb === 'function' && cb(t));

  // ---------- party ----------
  const pushParty = (p) => p.members.forEach((m) => {
    const s = sockByUid(m);
    if (s) s.emit('party:state', {
      id: p.id, leader: p.leader,
      members: p.members.map((u) => ({ uid: u, name: sockByUid(u)?.data.name || u }))
    });
  });
  const leaveParty = () => {
    const pid = partyOf.get(uid); if (!pid) return;
    const p = parties.get(pid); partyOf.delete(uid);
    if (!p) return;
    p.members = p.members.filter((m) => m !== uid);
    socket.emit('party:state', null);
    if (!p.members.length) parties.delete(pid);
    else { if (p.leader === uid) p.leader = p.members[0]; pushParty(p); }
  };
  socket.on('party:create', () => {
    leaveParty();
    const p = { id: 'p' + Math.random().toString(36).slice(2, 8), leader: uid, members: [uid] };
    parties.set(p.id, p); partyOf.set(uid, p.id); pushParty(p);
  });
  socket.on('party:invite', ({ toUid } = {}) => {
    const pid = partyOf.get(uid); const p = parties.get(pid);
    const t = sockByUid(toUid);
    if (!p || p.leader !== uid || !t || p.members.length >= 2) return;
    t.emit('party:invited', { partyId: p.id, from: socket.data.name });
  });
  socket.on('party:accept', ({ partyId } = {}) => {
    const p = parties.get(partyId);
    if (!p || p.members.length >= 2) return socket.emit('toast', 'Party unavailable');
    leaveParty(); p.members.push(uid); partyOf.set(uid, p.id); pushParty(p);
  });
  socket.on('party:leave', leaveParty);
  socket.on('party:start', (loadouts) => {
    const p = parties.get(partyOf.get(uid));
    if (!p || p.leader !== uid || p.members.length !== 2) return socket.emit('toast', 'Need 2 party members');
    const a = sockByUid(p.members[0]), b = sockByUid(p.members[1]);
    if (a && b) createMatch(a, b, true);
  });

  // ---------- matchmaking ----------
  socket.on('queue:join', (loadout) => {
    socket.data.loadout = sanitizeLoadout(loadout);
    if (!queue.includes(socket) && !socket.data.room) queue.push(socket);
    tryPair();
  });
  socket.on('queue:leave', () => { const i = queue.indexOf(socket); if (i >= 0) queue.splice(i, 1); });
  // party members publish their loadout before 'party:start'
  socket.on('loadout:set', (l) => { socket.data.loadout = sanitizeLoadout(l); });

  // ---------- in-match input ----------
  socket.on('input', (i) => {
    const r = rooms.get(socket.data.room); if (!r) return;
    const p = r.players.find((pl) => pl.id === socket.id); if (!p || !i) return;
    const prev = p.input;
    p.input = {
      seq: i.seq | 0,
      mx: clamp(+i.mx || 0, -1, 1), mz: clamp(+i.mz || 0, -1, 1),
      block: !!i.block,
      // one-shots survive until consumed by a sim step even if two packets arrive between ticks
      jump: !!i.jump || prev.jump, dash: !!i.dash || prev.dash,
      attack: !!i.attack || prev.attack, heavy: !!i.heavy || prev.heavy,
      dir: clamp(i.dir | 0, 0, 3)
    };
    if (i.attack || i.heavy) p.atkBufUntil = r.t + 0.2;   // short input buffer so taps during cooldown aren't lost
    p.lastSeq = p.input.seq;
  });
  socket.on('match:forfeit', () => {
    const r = rooms.get(socket.data.room);
    if (r) endMatch(r, r.players.find((p) => p.id !== socket.id)?.id, 'forfeit');
  });

  socket.on('disconnect', () => {
    if (online.get(uid) === socket.id) { online.delete(uid); if (handles.get(socket.data.handle) === uid) handles.delete(socket.data.handle); }
    const qi = queue.indexOf(socket); if (qi >= 0) queue.splice(qi, 1);
    leaveParty();
    const r = rooms.get(socket.data.room);
    if (r) endMatch(r, r.players.find((p) => p.id !== socket.id)?.id, 'forfeit');
  });
});

function sanitizeLoadout(l = {}) {
  return {
    arch: S.ARCH[l.arch] ? l.arch : 'blade',
    skin: S.SKINS[l.skin] ? l.skin : 'neon_cyan',   // NOTE: verify ownership server-side with firebase-admin in production
    name: String(l.name || 'Player').slice(0, 20)
  };
}

function tryPair() {
  while (queue.length >= 2) createMatch(queue.shift(), queue.shift(), false);
}

// ---------- match / simulation ----------
function newPlayer(sock, slot) {
  const L = sock.data.loadout || sanitizeLoadout();
  const A = S.ARCH[L.arch];
  return {
    id: sock.id, uid: sock.data.uid, name: L.name, arch: L.arch, skin: L.skin, slot,
    x: slot === 0 ? -6 : 6, y: 0, z: 0, vx: 0, vy: 0, vz: 0, kx: 0, kz: 0,
    hp: A.hp, maxHp: A.hp, st: 100, fx: slot === 0 ? 1 : -1, fz: 0,
    input: { seq: 0, mx: 0, mz: 0 }, lastSeq: 0,
    atkCd: 0, dashCd: 0, blocking: false, blockSince: -9, pending: null, stagger: 0, dead: false, score: 0
  };
}

function createMatch(sa, sb, isPrivate) {
  const id = 'r' + Math.random().toString(36).slice(2, 9);
  const players = [newPlayer(sa, 0), newPlayer(sb, 1)];
  const room = {
    id, players, projectiles: [], events: [], t: 0, tick: 0, phase: 'countdown', phaseEnd: 3, pid: 0,
    loop: null, private: isPrivate, over: false
  };
  rooms.set(id, room);
  [sa, sb].forEach((s) => { s.data.room = id; s.join(id); });
  const info = players.map(({ id, uid, name, arch, skin, slot }) => ({ id, uid, name, arch, skin, slot }));
  io.to(id).emit('match:start', { room: id, players: info });
  room.loop = setInterval(() => step(room, 1 / S.TICK_RATE), 1000 / S.TICK_RATE);
}

function resetRound(r) {
  r.players.forEach((p) => {
    const A = S.ARCH[p.arch];
    Object.assign(p, { x: p.slot === 0 ? -6 : 6, y: 0, z: 0, vx: 0, vy: 0, vz: 0, kx: 0, kz: 0, hp: A.hp, st: 100,
      atkCd: 0, dashCd: 0, blocking: false, pending: null, stagger: 0, dead: false });
  });
  r.projectiles = [];
  r.phase = 'countdown'; r.phaseEnd = r.t + 3;
}

function endMatch(r, winnerId, reason) {
  if (r.over) return; r.over = true;
  clearInterval(r.loop);
  io.to(r.id).emit('match:end', { winner: winnerId, reason });
  r.players.forEach((p) => { const s = io.sockets.sockets.get(p.id); if (s) { s.leave(r.id); s.data.room = null; } });
  rooms.delete(r.id);
}

function damage(r, tgt, src, dmg, kb, fx, fz, heavy, melee) {
  const A = S.ARCH[tgt.arch];
  if (tgt.blocking) {
    if (melee && r.t - tgt.blockSince <= S.PARRY_WINDOW) {          // PARRY: attacker is staggered and shoved back
      src.stagger = 0.9; src.pending = null; src.kx -= fx * 9; src.kz -= fz * 9;
      tgt.st = Math.min(100, tgt.st + 20);
      r.events.push({ t: 'parry', id: tgt.id }); return;
    }
    tgt.st -= dmg * 1.5 + 8; dmg *= 0.15; kb *= 0.35;                 // normal block
    r.events.push({ t: 'block', id: tgt.id });
    if (tgt.st <= 0) { tgt.st = 0; tgt.blocking = false; tgt.stagger = 0.8; r.events.push({ t: 'guardbreak', id: tgt.id }); }
  }
  tgt.hp -= dmg;
  tgt.kx += (fx * kb) / A.weight; tgt.kz += (fz * kb) / A.weight;
  if (heavy) { tgt.vy = Math.max(tgt.vy, (kb * 0.3) / A.weight); }
  tgt.stagger = Math.max(tgt.stagger, heavy ? 0.45 : 0.2); tgt.pending = null;
  r.events.push({ t: 'hit', id: tgt.id, by: src.id, dmg: Math.round(dmg), heavy: !!heavy });
}

function resolveAttack(r, p, o) {
  const A = S.ARCH[p.arch]; const pend = p.pending; p.pending = null;
  const heavy = pend.kind === 'heavy';
  const dmg = heavy ? A.heavy : A.dmg;
  if (A.range > 0) {                                                  // ---- melee: cone test ----
    const dx = o.x - p.x, dz = o.z - p.z, d = Math.hypot(dx, dz) || 1;
    const reach = A.range + (pend.dir === 0 ? 0.6 : 0) + 0.5;          // thrust reaches further
    const cone = pend.dir === 0 ? 0.92 : (pend.dir === 3 ? 0.5 : 0.25); // thrust narrow, slashes wide
    const dot = (dx / d) * p.fx + (dz / d) * p.fz;
    if (d <= reach && dot >= cone && Math.abs(o.y - p.y) < 1.8 && !o.dead)
      damage(r, o, p, dmg, heavy ? 22 : 11, dx / d, dz / d, heavy, true);
  } else {                                                            // ---- ranged: projectile ----
    const sp = heavy ? 24 : 34;
    r.projectiles.push({ id: ++r.pid, owner: p.id, x: p.x + p.fx, y: p.y + 1.3, z: p.z + p.fz,
      vx: p.fx * sp, vz: p.fz * sp, life: 1.6, dmg, heavy });
  }
}

function step(r, dt) {
  r.t += dt; r.tick++;
  const [a, b] = r.players;

  // ---- phase machine ----
  if (r.phase === 'countdown' && r.t >= r.phaseEnd) { r.phase = 'fight'; r.events.push({ t: 'fight' }); }
  if (r.phase === 'roundover' && r.t >= r.phaseEnd) {
    const w = r.players.find((p) => p.score >= S.ROUNDS_TO_WIN);
    if (w) return endMatch(r, w.id, 'ko'); else resetRound(r);
  }

  for (const p of r.players) {
    const o = p === a ? b : a; const A = S.ARCH[p.arch]; const inp = p.input;
    // face opponent (camera-relative controls are built on this)
    const dx = o.x - p.x, dz = o.z - p.z, d = Math.hypot(dx, dz) || 1;
    p.fx = dx / d; p.fz = dz / d;

    p.stagger = Math.max(0, p.stagger - dt); p.atkCd = Math.max(0, p.atkCd - dt); p.dashCd = Math.max(0, p.dashCd - dt);
    const canAct = r.phase === 'fight' && !p.dead && p.stagger <= 0;

    // block (stamina drains while held)
    const wantBlock = canAct && inp.block && p.st > 0 && !p.pending;
    if (wantBlock && !p.blocking) p.blockSince = r.t;
    p.blocking = wantBlock;
    p.st = clamp(p.st + (p.blocking ? -6 : 18) * dt, 0, 100);

    // movement intent: forward = toward opponent, right = perpendicular
    let wx = p.fx * inp.mz + -p.fz * inp.mx, wz = p.fz * inp.mz + p.fx * inp.mx;
    const wl = Math.hypot(wx, wz); if (wl > 1) { wx /= wl; wz /= wl; }
    if (!canAct) { wx = 0; wz = 0; }
    const sp = A.speed * (p.blocking ? 0.4 : 1) * (p.pending ? 0.5 : 1);
    p.vx = wx * sp; p.vz = wz * sp;

    // jump / dash
    const inside = Math.abs(p.x) <= S.ARENA && Math.abs(p.z) <= S.ARENA;
    const grounded = inside && p.y <= 0.01 && p.vy <= 0.01;
    if (canAct && inp.jump && grounded) p.vy = S.JUMP;
    if (canAct && inp.dash && p.dashCd <= 0 && p.st >= S.DASH_COST) {
      const dl = wl > 0.1 ? 1 : 0; const ddx = dl ? wx / wl : p.fx, ddz = dl ? wz / wl : p.fz;
      p.kx += ddx * S.DASH_KICK; p.kz += ddz * S.DASH_KICK; p.dashCd = S.DASH_CD; p.st -= S.DASH_COST;
      r.events.push({ t: 'dash', id: p.id });
    }

    // attacks (windup -> resolve)
    if (canAct && !p.blocking && p.atkCd <= 0 && !p.pending && (inp.attack || inp.heavy)) {
      const heavy = !!inp.heavy && p.st >= 25;
      if (inp.heavy && !heavy && !inp.attack) { /* not enough stamina */ }
      else {
        const kind = heavy ? 'heavy' : 'light';
        if (heavy) p.st -= 25;
        const wind = A.range > 0 ? (heavy ? 0.45 : 0.18) : (heavy ? 0.4 : 0.1);
        p.pending = { at: r.t + wind, kind, dir: inp.dir };
        p.atkCd = heavy ? 1.1 : 0.5;
        inp.attack = inp.heavy = false;
        r.events.push({ t: 'swing', id: p.id, kind, dir: inp.dir, wind });
      }
    }
    if (p.pending && r.t >= p.pending.at) resolveAttack(r, p, o);
    inp.jump = inp.dash = false;                                        // consume one-shots
    if (r.t > (p.atkBufUntil || 0)) inp.attack = inp.heavy = false;

    // integrate
    const kd = Math.exp(-S.KNOCK_DECAY * dt); p.kx *= kd; p.kz *= kd;
    p.x += (p.vx + p.kx) * dt; p.z += (p.vz + p.kz) * dt;
    p.vy += S.GRAVITY * dt; p.y += p.vy * dt;
    const nowInside = Math.abs(p.x) <= S.ARENA && Math.abs(p.z) <= S.ARENA;
    if (nowInside && p.y <= 0 && p.vy <= 0) { p.y = 0; p.vy = 0; }
  }

  // player-vs-player body push
  { const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
    if (d < 1.0 && d > 0.001) { const push = (1.0 - d) / 2; a.x -= (dx / d) * push; a.z -= (dz / d) * push; b.x += (dx / d) * push; b.z += (dz / d) * push; } }

  // projectiles
  r.projectiles = r.projectiles.filter((pr) => {
    pr.life -= dt; pr.x += pr.vx * dt; pr.z += pr.vz * dt;
    const t = r.players.find((p) => p.id !== pr.owner), src = r.players.find((p) => p.id === pr.owner);
    if (!t.dead && Math.hypot(t.x - pr.x, t.z - pr.z) < 0.9 && Math.abs(t.y + 1 - pr.y) < 1.4) {
      const d = Math.hypot(pr.vx, pr.vz) || 1;
      damage(r, t, src, pr.dmg, pr.heavy ? 16 : 7, pr.vx / d, pr.vz / d, pr.heavy, false); return false;
    }
    return pr.life > 0;
  });

  // KO / ring-out
  if (r.phase === 'fight') {
    for (const p of r.players) {
      if (!p.dead && (p.hp <= 0 || p.y < S.FALL_Y)) {
        p.dead = true; p.hp = Math.max(0, p.hp);
        const w = r.players.find((q) => q !== p); w.score++;
        r.phase = 'roundover'; r.phaseEnd = r.t + 3;
        r.events.push({ t: 'round', winner: w.id, loser: p.id, ringout: p.y < S.FALL_Y });
        break;
      }
    }
  }

  // snapshot
  io.to(r.id).emit('snap', {
    tick: r.tick, ph: r.phase, left: Math.max(0, r.phaseEnd - r.t),
    ack: { [a.id]: a.lastSeq, [b.id]: b.lastSeq },
    sc: [a.score, b.score],
    p: r.players.map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, kx: p.kx, kz: p.kz,
      hp: p.hp, mhp: p.maxHp, st: p.st, bl: p.blocking, stg: p.stagger, dead: p.dead })),
    pr: r.projectiles.map((q) => ({ id: q.id, x: q.x, y: q.y, z: q.z, h: q.heavy })),
    ev: r.events
  });
  r.events = [];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Cyber Arena running on http://localhost:${PORT}`));
