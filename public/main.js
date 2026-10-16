/**
 * main.js — client entry (ES module).
 * Sections:
 *   1. Settings & key bindings      6. Three.js scene / arena / characters (skins, ragdoll)
 *   2. Audio (WebAudio synth)       7. Cannon-es physics (local prediction, ragdoll, debris)
 *   3. Input (kbd/mouse/touch)      8. Network + match flow (snapshots, interpolation, reconciliation)
 *   4. UI helpers & menus           9. Render loop + boot (state machine: AUTH -> MENU -> QUEUE -> MATCH)
 *   5. Friends / party / profile
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import * as FB from './firebase-auth.js';

const S = window.SHARED;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const angLerp = (a, b, t) => { let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * t; };
/** Tiny DOM builder — uses textContent so user names can never inject HTML. */
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'cls') e.className = v; else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(c));
  return e;
}

/* =====================================================================================
 * 1. SETTINGS & KEY BINDINGS
 * ===================================================================================== */
const DEFAULT_BINDS = { forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', dash: 'ShiftLeft', attack: 'Mouse0', block: 'Mouse2', heavy: 'KeyE' };
const ACTION_LABELS = { forward: 'Move forward', back: 'Move back', left: 'Strafe left', right: 'Strafe right', jump: 'Jump', dash: 'Dash', attack: 'Attack', block: 'Block / Parry', heavy: 'Heavy attack' };
const Settings = {
  binds: { ...DEFAULT_BINDS }, sfx: true, music: true, forceTouch: false,
  load() { try { const j = JSON.parse(localStorage.getItem('ca.settings')); if (j) { Object.assign(this, j); this.binds = { ...DEFAULT_BINDS, ...j.binds }; } } catch {} },
  save() { localStorage.setItem('ca.settings', JSON.stringify({ binds: this.binds, sfx: this.sfx, music: this.music, forceTouch: this.forceTouch })); }
};
function keyLabel(code) {
  if (code.startsWith('Mouse')) return ['LMB', 'MMB', 'RMB'][+code.slice(5)] || 'Mouse' + code.slice(5);
  return code.replace('Key', '').replace('Digit', '').replace('Left', 'L-').replace('Right', 'R-').replace('Arrow', '↔ ').replace('Space', 'Space');
}

/* =====================================================================================
 * 2. AUDIO — tiny synth, no asset downloads
 * ===================================================================================== */
const SFX = (() => {
  let ctx, musicTimer = null, step = 0;
  const ensure = () => { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); return ctx; };
  function tone(f0, f1, dur, type = 'sine', vol = 0.12) {
    if (!Settings.sfx) return;
    const c = ensure(), o = c.createOscillator(), g = c.createGain(), t = c.currentTime;
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur);
  }
  function noise(dur, vol = 0.2) {
    if (!Settings.sfx) return;
    const c = ensure(), n = c.sampleRate * dur, buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = c.createBufferSource(), g = c.createGain(); s.buffer = buf; g.gain.value = vol; s.connect(g).connect(c.destination); s.start();
  }
  const notes = [220, 261.6, 329.6, 392, 329.6, 261.6, 196, 246.9];
  return {
    swing: () => tone(300, 900, 0.12, 'sawtooth', 0.07), shoot: () => tone(900, 200, 0.15, 'square', 0.07),
    hit: () => { noise(0.15, 0.25); tone(180, 50, 0.15, 'square', 0.12); }, parry: () => tone(1400, 2400, 0.22, 'triangle', 0.18),
    block: () => tone(500, 300, 0.1, 'square', 0.1), dash: () => tone(200, 700, 0.15, 'sine', 0.1), jump: () => tone(250, 520, 0.1, 'sine', 0.07),
    ko: () => tone(400, 40, 0.8, 'sawtooth', 0.2), fight: () => tone(440, 880, 0.3, 'square', 0.15), click: () => tone(700, 900, 0.05, 'square', 0.05),
    startMusic() {
      if (!Settings.music || musicTimer) return; ensure();
      musicTimer = setInterval(() => { if (!Settings.music) return; const f = notes[step++ % notes.length]; tone(f, f * 0.99, 0.28, 'triangle', 0.035); if (step % 8 === 1) tone(f / 2, f / 2, 1.2, 'sine', 0.04); }, 240);
    },
    stopMusic() { clearInterval(musicTimer); musicTimer = null; }
  };
})();

/* =====================================================================================
 * 3. INPUT — keyboard/mouse (rebindable) + virtual joystick/buttons
 * ===================================================================================== */
const isTouchDevice = () => ('ontouchstart' in window) || navigator.maxTouchPoints > 0 || matchMedia('(pointer:coarse)').matches;
const Input = {
  held: new Set(), tHeld: {}, joy: { x: 0, y: 0 }, seq: 0,
  latch: { jump: 0, dash: 0, attack: 0, heavy: 0 }, localJump: 0,
  actionsOf(code) { return Object.keys(Settings.binds).filter((a) => Settings.binds[a] === code); },
  trigger(a) { if (a in this.latch) { this.latch[a] = 1; if (a === 'jump') { this.localJump = 1; SFX.jump(); } } },
  press(code) { if (this.held.has(code)) return; this.held.add(code); this.actionsOf(code).forEach((a) => this.trigger(a)); },
  release(code) { this.held.delete(code); },
  touchPress(a) { this.tHeld[a] = true; this.trigger(a); },
  touchRelease(a) { this.tHeld[a] = false; },
  isDown(a) { return this.held.has(Settings.binds[a]) || !!this.tHeld[a]; },
  axis() {
    let x = (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0) + this.joy.x;
    let z = (this.isDown('forward') ? 1 : 0) - (this.isDown('back') ? 1 : 0) - this.joy.y;   // joystick y is screen-down
    const l = Math.hypot(x, z); if (l > 1) { x /= l; z /= l; }
    return { mx: x, mz: z };
  },
  /** Directional attack: forward = thrust, left/right = slash, neutral/back = overhead. */
  attackDir(a) { return a.mz > 0.5 ? 0 : a.mx < -0.5 ? 1 : a.mx > 0.5 ? 2 : 3; },
  sample() {
    const a = this.axis();
    const o = { seq: ++this.seq, mx: a.mx, mz: a.mz, block: this.isDown('block'), dir: this.attackDir(a),
      jump: !!this.latch.jump, dash: !!this.latch.dash, attack: !!this.latch.attack, heavy: !!this.latch.heavy };
    this.latch.jump = this.latch.dash = this.latch.attack = this.latch.heavy = 0;
    return o;
  },
  init() {
    const typing = (e) => /INPUT|TEXTAREA/.test(e.target.tagName);
    addEventListener('keydown', (e) => {
      if (Remap.active || App.state !== 'MATCH' || typing(e)) return;
      if (this.actionsOf(e.code).length) e.preventDefault();
      this.press(e.code);
    });
    addEventListener('keyup', (e) => this.release(e.code));
    const cv = $('#gl');
    cv.addEventListener('mousedown', (e) => { if (App.state === 'MATCH' && !Remap.active) { e.preventDefault(); this.press('Mouse' + e.button); } });
    addEventListener('mouseup', (e) => this.release('Mouse' + e.button));
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('blur', () => { this.held.clear(); this.tHeld = {}; this.joy.x = this.joy.y = 0; });

    // ---- virtual joystick ----
    const zone = $('#joy-zone'), base = $('#joy-base'), knob = $('#joy-knob'); let pid = null; const R = 52;
    const move = (e) => {
      const r = base.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let dx = e.clientX - cx, dy = e.clientY - cy; const l = Math.hypot(dx, dy); if (l > R) { dx = dx / l * R; dy = dy / l * R; }
      knob.style.transform = `translate(${dx}px,${dy}px)`; this.joy.x = dx / R; this.joy.y = dy / R;
    };
    zone.addEventListener('pointerdown', (e) => { pid = e.pointerId; zone.setPointerCapture(pid); move(e); });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId === pid) move(e); });
    const end = (e) => { if (e.pointerId !== pid) return; pid = null; this.joy.x = this.joy.y = 0; knob.style.transform = ''; };
    zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);
    // ---- action buttons ----
    $$('.tbtn').forEach((b) => {
      const a = b.dataset.act;
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('active'); this.touchPress(a); });
      const up = () => { b.classList.remove('active'); this.touchRelease(a); };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
    });
    this.applyTouchMode();
  },
  applyTouchMode() { document.body.classList.toggle('touch', isTouchDevice() || Settings.forceTouch); }
};

/** Rebinding modal: captures the next key / mouse button. Duplicates are swapped, Esc cancels. */
const Remap = {
  active: false, action: null,
  start(a) { this.active = true; this.action = a; $('#remap-action').textContent = ACTION_LABELS[a]; $('#remap-modal').classList.remove('hidden'); },
  finish(code) {
    if (code !== 'Escape') {
      const old = Settings.binds[this.action];
      for (const k in Settings.binds) if (k !== this.action && Settings.binds[k] === code) Settings.binds[k] = old;   // swap
      Settings.binds[this.action] = code; Settings.save(); renderBinds();
    }
    this.active = false; $('#remap-modal').classList.add('hidden');
  }
};
addEventListener('keydown', (e) => { if (Remap.active) { e.preventDefault(); e.stopPropagation(); Remap.finish(e.code); } }, true);
addEventListener('mousedown', (e) => { if (Remap.active) { e.preventDefault(); e.stopPropagation(); Remap.finish('Mouse' + e.button); } }, true);

/* =====================================================================================
 * 4. UI HELPERS & MENUS
 * ===================================================================================== */
const App = { state: 'AUTH', user: null, profile: null, party: null, friends: [], requests: [], presence: {}, stopWatch: null };
function setState(s) {
  App.state = s;
  document.body.classList.toggle('match', s === 'MATCH');
  $('#app').classList.toggle('in-match', s === 'MATCH');
  $('#app').classList.toggle('hidden', s === 'AUTH');
  $('#auth').classList.toggle('hidden', s !== 'AUTH');
  $('#hud').classList.toggle('on', s === 'MATCH');
}
function showScreen(name) { $$('.screen').forEach((s) => s.classList.toggle('active', s.id === 'scr-' + name)); SFX.click(); if (name === 'friends') { refreshFriends(); } }
function toast(msg) { const t = h('div', { cls: 'toast' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2600); }
const loadout = () => ({ arch: App.profile.equipped.arch, skin: App.profile.equipped.skin, name: App.profile.name });

function renderChip() {
  $('#chip-name').textContent = App.profile.name; $('#chip-handle').textContent = '@' + (App.profile.handle || 'offline');
  $('#chip-coins').textContent = App.profile.coins + ' ◈';
}
function renderPlayLoadout() {
  const L = loadout(), A = S.ARCH[L.arch], K = S.SKINS[L.skin], el = $('#play-loadout'); el.replaceChildren(
    h('div', { style: `width:14px;height:14px;background:${K.emissive};box-shadow:0 0 10px ${K.emissive}` }), h('b', {}, A.name), h('span', { cls: 'dim' }, `${K.name} · ${A.weapon}`));
}
function renderArch() {
  const box = $('#arch-list'); box.replaceChildren();
  const stat = (label, v, max) => h('div', { cls: 'stat' }, label, h('div', { cls: 'bar' }, h('i', { style: `width:${v / max * 100}%` })));
  for (const [id, A] of Object.entries(S.ARCH)) {
    box.append(h('div', { cls: 'card' + (App.profile.equipped.arch === id ? ' sel' : ''), onclick: () => equip('arch', id) },
      h('h3', {}, A.name), h('div', { cls: 'stat' }, A.desc), stat('HP', A.hp, 140), stat('Speed', A.speed, 8), stat('Damage', A.heavy, 40), stat('Weight', A.weight, 1.7)));
  }
}
function renderSkins() {
  const box = $('#skin-list'); box.replaceChildren();
  for (const [id, K] of Object.entries(S.SKINS)) {
    const owned = App.profile.inventory.includes(id);
    box.append(h('div', { cls: 'card' + (App.profile.equipped.skin === id ? ' sel' : ''), onclick: () => (owned ? equip('skin', id) : buySkin(id)) },
      h('div', { cls: 'tag r-' + K.rarity }, K.rarity),
      h('div', { cls: 'swatch', style: `background:linear-gradient(90deg,${K.color},${K.emissive});box-shadow:0 0 14px ${K.emissive}` }),
      h('h3', {}, K.name), h('div', { cls: 'stat' }, owned ? (App.profile.equipped.skin === id ? 'EQUIPPED' : 'Owned') : `Buy ${K.price} ◈`)));
  }
}
function renderBinds() {
  const box = $('#keybind-list'); box.replaceChildren();
  for (const a of Object.keys(DEFAULT_BINDS)) box.append(h('div', { cls: 'bind' }, h('span', {}, ACTION_LABELS[a]), h('div', { cls: 'keycap', onclick: () => Remap.start(a) }, keyLabel(Settings.binds[a]))));
}
function renderAllMenus() { renderChip(); renderPlayLoadout(); renderArch(); renderSkins(); renderBinds(); renderFriends(); renderParty(); }

async function equip(kind, id) {
  App.profile.equipped[kind] = id; renderAllMenus(); Preview.rebuild();
  Net.socket?.emit('loadout:set', loadout());
  FB.saveProfile(App.profile.uid, { equipped: App.profile.equipped }).catch(() => {});
}
async function buySkin(id) {
  const K = S.SKINS[id];
  // Real-money hook: POST /api/checkout {skin:id} -> redirect to Stripe, grant via webhook (server-side!).
  if (App.profile.coins < K.price) return toast('Not enough ◈ — win matches to earn more');
  App.profile.coins -= K.price; App.profile.inventory.push(id);
  await FB.saveProfile(App.profile.uid, { coins: App.profile.coins, inventory: App.profile.inventory }).catch(() => {});
  toast(`Unlocked ${K.name}`); equip('skin', id);
}

/* ---- auth form ---- */
function bindAuthUI() {
  const msg = (t) => ($('#auth-msg').textContent = t);
  const run = (fn) => async () => { msg(''); try { await fn(); } catch (e) { msg((e.message || 'Error').replace('Firebase: ', '')); } };
  $('#btn-login').onclick = run(() => FB.login($('#auth-email').value.trim(), $('#auth-pass').value));
  $('#btn-register').onclick = run(() => FB.register($('#auth-email').value.trim(), $('#auth-pass').value, $('#auth-name').value.trim() || 'Player'));
  $('#btn-guest').onclick = run(() => FB.guest($('#auth-name').value.trim() || 'Guest'));
  $('#btn-logout').onclick = () => FB.logout();
  $$('[data-go]').forEach((b) => (b.onclick = () => showScreen(b.dataset.go)));
  // settings
  $('#opt-sfx').onchange = (e) => { Settings.sfx = e.target.checked; Settings.save(); };
  $('#opt-music').onchange = (e) => { Settings.music = e.target.checked; Settings.save(); Settings.music ? SFX.startMusic() : SFX.stopMusic(); };
  $('#opt-touch').onchange = (e) => { Settings.forceTouch = e.target.checked; Settings.save(); Input.applyTouchMode(); };
  $('#btn-reset-binds').onclick = () => { Settings.binds = { ...DEFAULT_BINDS }; Settings.save(); renderBinds(); };
  $('#opt-sfx').checked = Settings.sfx; $('#opt-music').checked = Settings.music; $('#opt-touch').checked = Settings.forceTouch;
  // queue
  $('#btn-queue').onclick = async () => {
    if (!(await Net.ready())) return;
    Net.socket.emit('queue:join', loadout()); setState('QUEUE');
    $('#btn-queue').classList.add('hidden'); $('#btn-cancel').classList.remove('hidden'); $('#queue-status').textContent = 'SEARCHING FOR OPPONENT…';
  };
  $('#btn-cancel').onclick = () => { Net.socket?.emit('queue:leave'); resetQueueUI(); };
  $('#hud-menu-btn').onclick = () => Net.socket?.emit('match:forfeit');
}
function resetQueueUI() { setState('MENU'); $('#btn-queue').classList.remove('hidden'); $('#btn-cancel').classList.add('hidden'); $('#queue-status').textContent = ''; }

/* =====================================================================================
 * 5. FRIENDS / PARTY
 * ===================================================================================== */
async function refreshFriends() {
  if (!App.profile) return;
  App.profile = { ...App.profile, ...(await FB.loadProfile(App.profile.uid).catch(() => null) || {}) };
  App.friends = await FB.listFriends(App.profile).catch(() => []);
  renderFriends(); pollPresence();
}
function pollPresence() {
  if (!Net.socket || !App.friends.length) return;
  Net.socket.emit('presence:get', App.friends.map((f) => f.uid), (map) => { App.presence = map; renderFriends(); });
}
function renderFriends() {
  const list = $('#friend-list'); list.replaceChildren();
  if (!App.friends.length) list.append(h('div', { cls: 'dim' }, 'No friends yet — add one by user ID (the @name under your name).'));
  const canInvite = App.party && App.party.leader === App.profile.uid && App.party.members.length < 2;
  App.friends.sort((a, b) => (App.presence[b.uid] ? 1 : 0) - (App.presence[a.uid] ? 1 : 0)).forEach((f) => {
    const on = !!App.presence[f.uid];
    list.append(h('div', { cls: 'item' }, h('span', { cls: 'dot' + (on ? ' on' : '') }), h('div', { cls: 'grow' }, h('b', {}, f.name), h('div', { cls: 'dim' }, '@' + f.handle + (on ? ' · online' : ' · offline'))),
      on && canInvite ? h('button', { cls: 'btn small', onclick: () => Net.send('party:invite', { toUid: f.uid }) }, 'Invite') : null));
  });
  const rl = $('#request-list'); rl.replaceChildren();
  if (!App.requests.length) rl.append(h('div', { cls: 'dim' }, 'No pending requests.'));
  App.requests.forEach((r) => rl.append(h('div', { cls: 'item' }, h('div', { cls: 'grow' }, h('b', {}, r.fromName), h('div', { cls: 'dim' }, '@' + r.fromHandle)),
    h('button', { cls: 'btn small', onclick: async () => {
      if (r.local) { FB.addLocalFriend(App.profile.uid, { uid: r.from, name: r.fromName, handle: r.fromHandle }); Net.socket?.emit('friend:accept', { uid: r.from }); App.requests = App.requests.filter((x) => x !== r); }
      else await FB.respondRequest(App.profile, r, true);
      refreshFriends(); } }, 'Accept'),
    h('button', { cls: 'btn small hot', onclick: () => { if (r.local) { App.requests = App.requests.filter((x) => x !== r); renderFriends(); } else FB.respondRequest(App.profile, r, false); } }, '✕'))));
}
function renderParty() {
  const p = App.party, box = $('#party-members'); box.replaceChildren();
  if (!p) box.append(h('div', { cls: 'dim' }, 'Not in a party.'));
  else p.members.forEach((m) => box.append(h('div', { cls: 'item' }, h('span', { cls: 'dot on' }), h('b', {}, m.name), p.leader === m.uid ? h('span', { cls: 'tag r-legendary', style: 'position:static' }, 'LEADER') : null)));
  $('#btn-party-leave').disabled = !p;
  $('#btn-party-start').disabled = !(p && p.leader === App.profile.uid && p.members.length === 2);
  $('#btn-party-create').disabled = !!p;
}
function bindFriendUI() {
  $('#btn-friend-add').onclick = async () => {
    const m = $('#friend-msg'); m.textContent = '';
    if (!FB.CONFIGURED) {                                   // no Firebase: friend requests go through the game server
      const handle = $('#friend-search').value.trim().toLowerCase(); if (!handle) return;
      if (!(await Net.ready())) { m.textContent = 'Game server offline'; return; }
      Net.socket.emit('friend:request', { handle }, (res) => { m.textContent = res?.error || `Request sent to ${res.name}`; if (!res?.error) $('#friend-search').value = ''; });
      return;
    }
    try { const t = await FB.sendFriendRequest(App.profile, $('#friend-search').value); m.textContent = `Request sent to ${t.name}`; $('#friend-search').value = ''; }
    catch (e) { m.textContent = e.message; }
  };
  $('#btn-party-create').onclick = () => Net.send('party:create');
  $('#btn-party-leave').onclick = () => Net.send('party:leave');
  $('#btn-party-start').onclick = () => { Net.send('loadout:set', loadout()); Net.send('party:start'); };
  $('#chip-name').before(h('span', { id: 'net-status', cls: 'dim' }, '● offline'));
  setInterval(() => App.state !== 'AUTH' && pollPresence(), 8000);
}
function showPartyInvite({ partyId, from }) {
  const box = $('#party-toast'); box.replaceChildren(h('div', { cls: 'panel' }, h('b', {}, `${from} invited you to a party`), h('div', { cls: 'row', style: 'margin-top:10px' },
    h('button', { cls: 'btn small', onclick: () => { Net.socket.emit('loadout:set', loadout()); Net.socket.emit('party:accept', { partyId }); box.replaceChildren(); } }, 'Join'),
    h('button', { cls: 'btn small hot', onclick: () => box.replaceChildren() }, 'Decline'))));
  setTimeout(() => box.replaceChildren(), 15000);
}

/* =====================================================================================
 * 6. THREE.JS — scene, arena, characters, skins, ragdoll
 * ===================================================================================== */
const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setClearColor(0x05070d);
const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0x05070d, 0.017);
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 300);
function resize() { const w = innerWidth, h2 = innerHeight; renderer.setSize(w, h2, false); camera.aspect = w / h2; camera.fov = w / h2 < 1 ? 78 : 60; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

scene.add(new THREE.HemisphereLight(0x6fc8ff, 0x180a2a, 0.9));
const L1 = new THREE.PointLight(0x00e5ff, 60, 40); L1.position.set(-10, 8, 8); scene.add(L1);
const L2 = new THREE.PointLight(0xff2a8a, 60, 40); L2.position.set(10, 8, -8); scene.add(L2);

// ---- arena platform ----
const A = S.ARENA;
const platform = new THREE.Mesh(new THREE.BoxGeometry(A * 2, 1, A * 2), new THREE.MeshStandardMaterial({ color: 0x0b1424, metalness: 0.8, roughness: 0.35 }));
platform.position.y = -0.5; scene.add(platform);
const grid = new THREE.GridHelper(A * 2, A * 2, 0x00e5ff, 0x0a3b52); grid.position.y = 0.01; grid.material.transparent = true; grid.material.opacity = 0.6; scene.add(grid);
const edgeMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff });
[[0, -A, A * 2 + 0.4, 0.3], [0, A, A * 2 + 0.4, 0.3], [-A, 0, 0.3, A * 2], [A, 0, 0.3, A * 2]].forEach(([x, z, w, d]) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, d), edgeMat); m.position.set(x, 0.02, z); scene.add(m);
});
const spawnRing = (x) => { const r = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.1, 32), new THREE.MeshBasicMaterial({ color: 0xff2a8a, side: THREE.DoubleSide })); r.rotation.x = -Math.PI / 2; r.position.set(x, 0.03, 0); scene.add(r); };
spawnRing(-6); spawnRing(6);
const stars = (() => {
  const n = 700, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const r = 70 + Math.random() * 60, a = Math.random() * 6.283, b = Math.acos(2 * Math.random() - 1); pos[i * 3] = r * Math.sin(b) * Math.cos(a); pos[i * 3 + 1] = Math.abs(r * Math.cos(b)) - 20; pos[i * 3 + 2] = r * Math.sin(b) * Math.sin(a); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x9ad0ff, size: 0.6, fog: false })); scene.add(p); return p;
})();
const halo = new THREE.Mesh(new THREE.TorusGeometry(24, 0.15, 8, 80), new THREE.MeshBasicMaterial({ color: 0xff2a8a })); halo.rotation.x = Math.PI / 2; halo.position.y = -7; scene.add(halo);

// ---- characters ----
const RAG = {   // ragdoll hitboxes + joints (torso-local pivot pT, part-local pivot pP)
  torso: { box: [0.4, 0.5, 0.225], off: [0, 0, 0] },
  head: { box: [0.27, 0.27, 0.27], off: [0, 0, 0], pT: [0, 0.5, 0], pP: [0, -0.25, 0] },
  armL: { box: [0.11, 0.4, 0.11], off: [0, -0.4, 0], pT: [-0.55, 0.4, 0], pP: [0, 0, 0] },
  armR: { box: [0.11, 0.4, 0.11], off: [0, -0.4, 0], pT: [0.55, 0.4, 0], pP: [0, 0, 0] },
  legL: { box: [0.15, 0.35, 0.15], off: [0, -0.35, 0], pT: [-0.2, -0.4, 0], pP: [0, 0, 0] },
  legR: { box: [0.15, 0.35, 0.15], off: [0, -0.35, 0], pT: [0.2, -0.4, 0], pP: [0, 0, 0] }
};
const auraVS = 'varying vec3 n;varying vec3 v;void main(){n=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.);v=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}';
const auraFS = 'uniform vec3 c;uniform float t;varying vec3 n;varying vec3 v;void main(){float f=pow(1.-abs(dot(n,v)),2.5);float p=.65+.35*sin(t*4.);gl_FragColor=vec4(c*f*p*1.8,f*.9);}';

function makeCharacter(archId, skinId) {
  const Ar = S.ARCH[archId], K = S.SKINS[skinId];
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: K.color, roughness: 0.4, metalness: 0.7, emissive: K.emissive, emissiveIntensity: 0.25 * K.glow });
  const accMat = new THREE.MeshStandardMaterial({ color: K.accent, emissive: K.emissive, emissiveIntensity: K.glow, roughness: 0.2, metalness: 0.3 });
  const box = (w, hh, d, mat, y0 = 0) => { const geo = new THREE.BoxGeometry(w, hh, d); if (y0) geo.translate(0, y0, 0); return new THREE.Mesh(geo, mat); };
  const parts = {
    torso: box(0.8, 1, 0.45, bodyMat), head: new THREE.Mesh(new THREE.SphereGeometry(0.27, 16, 12), accMat),
    armL: box(0.22, 0.8, 0.22, bodyMat, -0.4), armR: box(0.22, 0.8, 0.22, bodyMat, -0.4),
    legL: box(0.3, 0.7, 0.3, bodyMat, -0.35), legR: box(0.3, 0.7, 0.3, bodyMat, -0.35)
  };
  parts.torso.position.set(0, 1.1, 0); parts.head.position.set(0, 1.85, 0);
  parts.armL.position.set(-0.55, 1.5, 0); parts.armR.position.set(0.55, 1.5, 0);
  parts.legL.position.set(-0.2, 0.7, 0); parts.legR.position.set(0.2, 0.7, 0);
  const chest = box(0.5, 0.2, 0.05, accMat); chest.position.set(0, 0.15, 0.25); parts.torso.add(chest);
  // weapon (attached to right arm so it ragdolls with it)
  if (Ar.weapon === 'sword') {
    const blade = box(0.07, 1.3, 0.03, accMat); blade.position.y = -1.45; const guard = box(0.32, 0.05, 0.09, bodyMat); guard.position.y = -0.85; parts.armR.add(blade, guard);
  } else if (Ar.weapon === 'hammer') {
    const shaft = box(0.07, 1.4, 0.07, bodyMat); shaft.position.y = -1.0; const head = box(0.55, 0.38, 0.38, accMat); head.position.y = -1.75; parts.armR.add(shaft, head);
  } else {
    const barrel = box(0.12, 0.14, 0.7, accMat); barrel.position.set(0, -0.85, 0.25); const grip = box(0.1, 0.25, 0.1, bodyMat); grip.position.set(0, -0.95, 0); parts.armR.add(barrel, grip);
  }
  // fresnel aura for epic / legendary skins (emissive shader feedback)
  let auraMat = null;
  if (K.rarity === 'epic' || K.rarity === 'legendary') {
    auraMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { c: { value: new THREE.Color(K.emissive) }, t: { value: 0 } }, vertexShader: auraVS, fragmentShader: auraFS });
    parts.torso.add(new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.2, 0.65), auraMat));
    parts.head.add(new THREE.Mesh(new THREE.SphereGeometry(0.36, 16, 12), auraMat));
  }
  const shield = new THREE.Mesh(new THREE.CircleGeometry(0.95, 28), new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
  shield.position.set(0, 1.2, 0.8); shield.visible = false; g.add(shield);
  Object.values(parts).forEach((p) => g.add(p));
  const rest = {}; for (const [k, p] of Object.entries(parts)) rest[k] = { p: p.position.clone(), q: p.quaternion.clone() };
  const ch = { g, parts, bodyMat, accMat, auraMat, shield, rest, archId, skinId, K, Ar, anim: { t: -1, dir: 3, wind: 0.2, kind: 'light' }, flash: 0, parry: 0, rag: null, cons: [], yaw: 0 };
  parts.armR.rotation.x = -1.0; return ch;
}
function disposeCharacter(ch) { if (ch.rag) unragdoll(ch); scene.remove(ch.g); ch.g.traverse((o) => { o.geometry?.dispose(); }); }

const POSES = { 0: { s: [-0.6, 0], e: [-1.65, 0] }, 1: { s: [-1.4, 1.3], e: [-1.4, -1.3] }, 2: { s: [-1.4, -1.3], e: [-1.4, 1.3] }, 3: { s: [-2.8, 0], e: [0.3, 0] } };
const REST = [-1.0, 0];
function swingPose(a, ranged) {
  if (ranged) { if (a.t < 0.18) return [-1.55 - (a.kind === 'heavy' ? 0.3 : 0), 0]; a.t = -1; return REST; }
  const P = POSES[a.dir] || POSES[3], wind = Math.max(a.wind, 0.05), strike = 0.16, rec = 0.28;
  if (a.t < wind) { const u = a.t / wind; return [lerp(REST[0], P.s[0], u), lerp(REST[1], P.s[1], u)]; }
  if (a.t < wind + strike) { const u = (a.t - wind) / strike; return [lerp(P.s[0], P.e[0], u), lerp(P.s[1], P.e[1], u)]; }
  if (a.t < wind + strike + rec) { const u = (a.t - wind - strike) / rec; return [lerp(P.e[0], REST[0], u), lerp(P.e[1], REST[1], u)]; }
  a.t = -1; return REST;
}
/** Per-frame procedural animation + skin shader feedback (pulse, hit flash, low-HP flicker). */
function animateChar(ch, dt, t, st) {
  if (ch.auraMat) ch.auraMat.uniforms.t.value = t;
  const rate = ch.K.rarity === 'legendary' ? 6 : ch.K.rarity === 'epic' ? 4 : 2.5;
  ch.flash = Math.max(0, ch.flash - dt * 4); ch.parry = Math.max(0, ch.parry - dt * 3);
  const lowHp = st.hpFrac < 0.25 ? 0.5 + 0.5 * Math.sin(t * 18) : 0;
  ch.accMat.emissiveIntensity = ch.K.glow * (1 + 0.25 * Math.sin(t * rate)) + ch.flash * 3 + lowHp;
  ch.bodyMat.emissiveIntensity = 0.25 * ch.K.glow + ch.flash * 1.5;
  ch.shield.visible = !!st.blocking; ch.shield.material.opacity = 0.28 + 0.12 * Math.sin(t * 20) + ch.parry * 0.6;
  ch.shield.material.color.setHex(ch.parry > 0.05 ? 0xffffff : 0x00e5ff);
  if (ch.rag) return;
  const P = ch.parts; let [rx, rz] = REST;
  if (ch.anim.t >= 0) { ch.anim.t += dt; [rx, rz] = swingPose(ch.anim, ch.Ar.range === 0); }
  if (st.blocking) { rx = -1.7; rz = 0.3; P.armL.rotation.set(-1.7, 0, -0.3); } else P.armL.rotation.set(-0.4, 0, 0);
  P.armR.rotation.set(rx, 0, rz);
  const sw = Math.sin(t * 11) * Math.min(1, st.speed / 6) * 0.7; P.legL.rotation.x = sw; P.legR.rotation.x = -sw;
  P.torso.rotation.x = st.stagger ? -0.45 : 0; P.torso.position.y = 1.1 + Math.sin(t * 3) * 0.015;
}
function ragdoll(ch, vel) {
  if (ch.rag) return; ch.g.updateMatrixWorld(true);
  ch.rag = []; const Wp = new THREE.Vector3(), Wq = new THREE.Quaternion(); const bodies = {};
  for (const [name, part] of Object.entries(ch.parts)) {
    const d = RAG[name]; part.getWorldPosition(Wp); part.getWorldQuaternion(Wq);
    const b = new CANNON.Body({ mass: name === 'torso' ? 3 : 1, collisionFilterGroup: 4, collisionFilterMask: 1, linearDamping: 0.05, angularDamping: 0.15 });
    b.addShape(new CANNON.Box(new CANNON.Vec3(...d.box)), new CANNON.Vec3(...d.off));
    b.position.set(Wp.x, Wp.y, Wp.z); b.quaternion.set(Wq.x, Wq.y, Wq.z, Wq.w);
    b.velocity.set(vel.x + (Math.random() - 0.5) * 3, vel.y + 2 + Math.random() * 3, vel.z + (Math.random() - 0.5) * 3);
    b.angularVelocity.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
    world.addBody(b); bodies[name] = b; scene.attach(part); ch.rag.push({ part, b });
  }
  for (const [name, d] of Object.entries(RAG)) {
    if (name === 'torso') continue;
    const c = new CANNON.PointToPointConstraint(bodies.torso, new CANNON.Vec3(...d.pT), bodies[name], new CANNON.Vec3(...d.pP)); c.collideConnected = false;
    world.addConstraint(c); ch.cons.push(c);
  }
}
function unragdoll(ch) {
  if (!ch.rag) return;
  ch.cons.forEach((c) => world.removeConstraint(c)); ch.cons = [];
  ch.rag.forEach(({ b }) => world.removeBody(b)); ch.rag = null;
  for (const [k, p] of Object.entries(ch.parts)) { ch.g.add(p); p.position.copy(ch.rest[k].p); p.quaternion.copy(ch.rest[k].q); }
}

/** Menu turntable preview of the equipped archetype + skin. */
const Preview = {
  ch: null,
  rebuild() {
    if (this.ch) { scene.remove(this.ch.g); this.ch = null; }
    if (!App.profile || App.state === 'MATCH') return;
    this.ch = makeCharacter(App.profile.equipped.arch, App.profile.equipped.skin); scene.add(this.ch.g);
  },
  hide() { if (this.ch) this.ch.g.visible = false; }, show() { if (this.ch) this.ch.g.visible = true; }
};

/* =====================================================================================
 * 7. CANNON-ES — local player prediction, ragdolls, hit debris
 * ===================================================================================== */
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, S.GRAVITY, 0) });
world.defaultContactMaterial.friction = 0.25; world.defaultContactMaterial.restitution = 0.2;
const groundBody = new CANNON.Body({ mass: 0, collisionFilterGroup: 1, collisionFilterMask: -1, position: new CANNON.Vec3(0, -0.5, 0) });
groundBody.addShape(new CANNON.Box(new CANNON.Vec3(A, 0.5, A))); world.addBody(groundBody);
// Player = point particle that only collides with the ground (matches server's feet-at-y=0 model exactly).
const myBody = new CANNON.Body({ mass: 1, shape: new CANNON.Particle(), collisionFilterGroup: 2, collisionFilterMask: 1, linearDamping: 0 });
world.addBody(myBody);

const debris = [];
const debrisGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);
function spawnDebris(pos, color, n = 8) {
  for (let i = 0; i < n && debris.length < 70; i++) {
    const mesh = new THREE.Mesh(debrisGeo, new THREE.MeshBasicMaterial({ color })); scene.add(mesh);
    const b = new CANNON.Body({ mass: 0.2, shape: new CANNON.Box(new CANNON.Vec3(0.07, 0.07, 0.07)), collisionFilterGroup: 8, collisionFilterMask: 1, position: new CANNON.Vec3(pos.x, pos.y + 1.2, pos.z) });
    b.velocity.set((Math.random() - 0.5) * 9, 3 + Math.random() * 6, (Math.random() - 0.5) * 9); b.angularVelocity.set(Math.random() * 10, Math.random() * 10, Math.random() * 10);
    world.addBody(b); debris.push({ mesh, b, life: 1.6 });
  }
}
function updateDebris(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i]; d.life -= dt; d.mesh.position.copy(d.b.position); d.mesh.quaternion.copy(d.b.quaternion);
    if (d.life <= 0 || d.b.position.y < -20) { world.removeBody(d.b); scene.remove(d.mesh); d.mesh.material.dispose(); debris.splice(i, 1); }
  }
}

/* =====================================================================================
 * 8. NETWORK + MATCH FLOW
 * ===================================================================================== */
const G = { active: false, myId: null, oppId: null, order: [], info: {}, ch: {}, snaps: [], last: null, k: { x: 0, z: 0 }, proj: new Map(), shake: 0, phase: '', bannerT: 0, lastSpeed: 0, ended: false };
const Net = {
  socket: null, sendTimer: null, pingTimer: null, lastErrToast: 0, connecting: null, _lib: null,
  setStatus(on) { const e = $('#net-status'); if (e) { e.textContent = on ? '● online' : '● offline'; e.style.color = on ? 'var(--green)' : 'var(--warn)'; } },
  /** Load socket.io client from the game server (non-blocking; free hosts can take ~1 min to wake up). */
  loadLib() {
    if (window.io) return Promise.resolve(true);
    if (this._lib) return this._lib;
    const load = (src, ms) => new Promise((ok, no) => {
      const sc = document.createElement('script'); sc.src = src; const t = setTimeout(() => { sc.remove(); no(new Error('timeout ' + src)); }, ms);
      sc.onload = () => { clearTimeout(t); ok(); }; sc.onerror = () => { clearTimeout(t); sc.remove(); no(new Error('load ' + src)); }; document.head.append(sc);
    });
    return (this._lib = (async () => {
      try {
        if (window.NET_MODE === 'p2p') {              // free peer-to-peer mode (GitHub Pages)
          if (!window.Peer) await load('https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js', 20000);
          await load('gamecore.js', 20000); await load('p2p.js', 20000); window.io = window.P2P.io;
        } else await load(window.SERVER_URL + '/socket.io/socket.io.js', 70000);   // Node server (free hosts can take ~1 min to wake)
        return !!window.io;
      } catch (e) { this._lib = null; return false; }
    })());
  },
  connect() {
    if (this.connecting) return this.connecting;
    return (this.connecting = (async () => {
      this.disconnect(); this.setStatus(false);
      if (!App.profile) return;
      if (!(await this.loadLib())) { toast('Game server unreachable — it will retry when you press a button'); return; }
      const token = await FB.getIdToken();
      const s = (this.socket = window.io(window.SERVER_URL, { auth: { token, uid: App.profile.uid, name: App.profile.name, handle: App.profile.handle || '' }, transports: ['websocket', 'polling'] }));
      s.on('connect', () => { this.setStatus(true); s.emit('loadout:set', loadout()); pollPresence(); });
      s.on('disconnect', () => {
        this.setStatus(false); App.party = null; renderParty();
        if (G.active && !G.ended) endMatch({ winner: null, reason: 'lost' });
        else if (App.state === 'QUEUE') resetQueueUI();
      });
      s.on('connect_error', (e) => { this.setStatus(false); if (Date.now() - this.lastErrToast > 6000) { this.lastErrToast = Date.now(); toast('Server: ' + e.message); } });
      s.on('toast', toast);
      s.on('party:state', (p) => { App.party = p; renderParty(); renderFriends(); });
      s.on('party:invited', showPartyInvite);
      s.on('friend:request', (r) => {          // friend system used when Firebase isn't configured
        if (App.requests.some((x) => x.id === r.fromUid)) return;
        App.requests.push({ id: r.fromUid, from: r.fromUid, fromName: r.fromName, fromHandle: r.fromHandle, local: true }); renderFriends(); toast(`Friend request from ${r.fromName}`);
      });
      s.on('friend:added', (f) => { FB.addLocalFriend(App.profile.uid, f); refreshFriends(); toast(`${f.name} is now your friend`); });
      s.on('match:start', startMatch);
      s.on('snap', onSnap);
      s.on('match:end', endMatch);
      this.pingTimer = setInterval(() => { const t = performance.now(); s.emit('ping_', t, () => { $('#ping').textContent = Math.round(performance.now() - t) + ' ms'; }); }, 2000);
    })().finally(() => { this.connecting = null; }));
  },
  /** Resolves true once a live connection exists (connects / wakes the server if needed). Never throws. */
  async ready() {
    if (this.socket?.connected) return true;
    toast('Connecting to game server…');
    if (!this.socket) await this.connect();
    if (this.socket && !this.socket.connected) await new Promise((r) => { const t = setTimeout(r, 25000); this.socket.once('connect', () => { clearTimeout(t); r(); }); });
    if (this.socket?.connected) return true;
    toast('Cannot reach the lobby — check your internet and try again'); return false;
  },
  send(ev, ...args) { this.ready().then((ok) => ok && this.socket.emit(ev, ...args)); },
  disconnect() { clearInterval(this.pingTimer); clearInterval(this.sendTimer); this.socket?.disconnect(); this.socket = null; }
};

function setBanner(text, ms = 0) {
  const b = $('#banner'); b.textContent = text; b.classList.toggle('show', !!text); clearTimeout(G.bannerT);
  if (ms) G.bannerT = setTimeout(() => b.classList.remove('show'), ms);
}

function startMatch({ players }) {
  cleanupMatch();
  G.active = true; G.ended = false; G.myId = Net.socket.id; G.order = players.map((p) => p.id); G.snaps = []; G.last = null; G.phase = '';
  players.forEach((p) => { G.info[p.id] = p; const ch = makeCharacter(p.arch, p.skin); scene.add(ch.g); G.ch[p.id] = ch; });
  G.oppId = players.find((p) => p.id !== G.myId).id;
  const me = G.info[G.myId], op = G.info[G.oppId];
  myBody.position.set(me.slot === 0 ? -6 : 6, 0, 0); myBody.velocity.set(0, 0, 0); G.k.x = G.k.z = 0;
  $('#name-l').textContent = me.name; $('#name-r').textContent = op.name;
  Preview.hide(); resetQueueUI(); setState('MATCH');
  setBanner('');
  clearInterval(Net.sendTimer);
  Net.sendTimer = setInterval(() => { if (G.active && !G.ended) Net.socket.emit('input', Input.sample()); }, 1000 / S.TICK_RATE);
}
function cleanupMatch() {
  Object.values(G.ch).forEach(disposeCharacter); G.ch = {}; G.info = {};
  G.proj.forEach((m) => scene.remove(m)); G.proj.clear(); clearInterval(Net.sendTimer);
  G.active = false; Preview.show();
}
function endMatch({ winner, reason }) {
  G.ended = true; const won = winner === G.myId;
  setBanner(reason === 'lost' ? 'CONNECTION LOST' : reason === 'forfeit' ? (won ? 'OPPONENT LEFT' : 'FORFEIT') : won ? 'VICTORY' : 'DEFEAT');
  if (reason !== 'lost') App.profile.coins += won ? 60 : 20;         // NOTE: award server-side (firebase-admin) in production to prevent cheating
  FB.saveProfile(App.profile.uid, { coins: App.profile.coins }).catch(() => {});
  setTimeout(() => { cleanupMatch(); setBanner(''); setState('MENU'); Preview.rebuild(); renderAllMenus(); }, 3500);
}

function findP(snap, id) { return snap.p.find((p) => p.id === id); }
function onSnap(s) {
  if (!G.active) return;
  G.snaps.push({ t: performance.now(), s }); if (G.snaps.length > 30) G.snaps.shift(); G.last = s;
  // ---- phase transitions ----
  if (s.ph !== G.phase) {
    if (s.ph === 'countdown') { Object.values(G.ch).forEach(unragdoll); G.k.x = G.k.z = 0; }
    G.phase = s.ph;
  }
  if (s.ph === 'countdown') setBanner(String(Math.ceil(s.left)));
  // ---- events ----
  for (const e of s.ev) handleEvent(e, s);
  // ---- reconcile local prediction with authoritative state ----
  const me = findP(s, G.myId); if (!me) return;
  G.k.x = me.kx; G.k.z = me.kz;
  const ex = me.x - myBody.position.x, ez = me.z - myBody.position.z, ey = me.y - myBody.position.y, d = Math.hypot(ex, ez);
  if (d > 2.5 || Math.abs(ey) > 2 || s.ph === 'countdown') { myBody.position.set(me.x, me.y, me.z); myBody.velocity.y = me.vy; }
  else { myBody.position.x += ex * 0.2; myBody.position.z += ez * 0.2; if (Math.abs(ey) > 0.4) myBody.position.y += ey * 0.2; }
  if (Math.abs(me.vy - myBody.velocity.y) > 4) myBody.velocity.y = me.vy;
  // ---- projectiles ----
  const seen = new Set();
  for (const p of s.pr) {
    seen.add(p.id); let m = G.proj.get(p.id);
    if (!m) { m = new THREE.Mesh(new THREE.SphereGeometry(p.h ? 0.28 : 0.16, 10, 8), new THREE.MeshBasicMaterial({ color: p.h ? 0xffb800 : 0xff2a8a })); m.position.set(p.x, p.y, p.z); scene.add(m); G.proj.set(p.id, m); }
    m.userData.tx = p;
  }
  for (const [id, m] of G.proj) if (!seen.has(id)) { scene.remove(m); G.proj.delete(id); }
}
function charPos(id) {
  if (id === G.myId) return myBody.position;
  const c = G.ch[id]; return c ? c.g.position : new THREE.Vector3();
}
function handleEvent(e, s) {
  const ch = G.ch[e.id];
  switch (e.t) {
    case 'swing': ch && Object.assign(ch.anim, { t: 0, dir: e.dir, wind: e.wind, kind: e.kind }); (ch?.Ar.range === 0 ? SFX.shoot : SFX.swing)(); break;
    case 'hit': if (ch) { ch.flash = 1; spawnDebris(charPos(e.id), ch.K.emissive, e.heavy ? 14 : 8); }
      SFX.hit(); if (e.id === G.myId) { G.shake = e.heavy ? 0.6 : 0.3; const f = $('#dmg-flash'); f.style.opacity = 1; setTimeout(() => (f.style.opacity = 0), 120); } break;
    case 'parry': if (ch) ch.parry = 1; SFX.parry(); G.shake = Math.max(G.shake, 0.2); break;
    case 'block': SFX.block(); break;
    case 'guardbreak': if (ch) ch.flash = 1; SFX.hit(); break;
    case 'dash': SFX.dash(); break;
    case 'fight': setBanner('FIGHT!', 900); SFX.fight(); break;
    case 'round': {
      SFX.ko(); const loser = G.ch[e.loser], lp = findP(s, e.loser);
      if (loser && lp) ragdoll(loser, { x: lp.vx + lp.kx, y: lp.vy, z: lp.vz + lp.kz });
      setBanner(e.ringout ? 'RING OUT!' : 'K.O.', 2600); G.shake = 0.8; break;
    }
  }
}

/** Client-side prediction: same movement model as the server, executed on a cannon-es body. */
function predictLocal(dt) {
  const s = G.last, me = s && findP(s, G.myId); if (!me) return;
  const Ar = S.ARCH[G.info[G.myId].arch], op = G.ch[G.oppId].g.position;
  const dx = op.x - myBody.position.x, dz = op.z - myBody.position.z, dl = Math.hypot(dx, dz) || 1, fx = dx / dl, fz = dz / dl;
  const canAct = s.ph === 'fight' && !me.dead && me.stg <= 0 && !G.ended;
  const ax = Input.axis(); let wx = fx * ax.mz + -fz * ax.mx, wz = fz * ax.mz + fx * ax.mx;
  const wl = Math.hypot(wx, wz); if (wl > 1) { wx /= wl; wz /= wl; }
  if (!canAct) { wx = 0; wz = 0; }
  const sp = Ar.speed * (me.bl ? 0.4 : 1);
  const kd = Math.exp(-S.KNOCK_DECAY * dt); G.k.x *= kd; G.k.z *= kd;
  myBody.velocity.x = wx * sp + G.k.x; myBody.velocity.z = wz * sp + G.k.z;
  const inside = Math.abs(myBody.position.x) <= A && Math.abs(myBody.position.z) <= A;
  const grounded = inside && myBody.position.y <= 0.05 && myBody.velocity.y <= 0.5;
  if (Input.localJump) { if (canAct && grounded) myBody.velocity.y = S.JUMP; Input.localJump = 0; }
  if (inside && myBody.position.y < 0 && myBody.velocity.y <= 0) { myBody.position.y = 0; myBody.velocity.y = 0; }   // safety net (mirrors server)
  G.lastSpeed = Math.hypot(wx, wz) * sp;
}
/** Opponent is rendered ~100 ms in the past, interpolated between the two surrounding snapshots. */
function interpOpp(rt) {
  const a = G.snaps; if (!a.length) return null;
  let i = a.length - 1; while (i > 0 && a[i].t > rt) i--;
  const s0 = a[i], s1 = a[Math.min(i + 1, a.length - 1)], p0 = findP(s0.s, G.oppId), p1 = findP(s1.s, G.oppId);
  if (!p0) return p1; if (s0 === s1 || !p1) return p0;
  const f = clamp((rt - s0.t) / (s1.t - s0.t), 0, 1);
  return { x: lerp(p0.x, p1.x, f), y: lerp(p0.y, p1.y, f), z: lerp(p0.z, p1.z, f) };
}

function matchFrame(dt, t) {
  predictLocal(dt); world.step(1 / 60, dt, 3);
  const mc = G.ch[G.myId], oc = G.ch[G.oppId]; if (!mc || !oc) return;
  const s = G.last, me = s && findP(s, G.myId), op = s && findP(s, G.oppId);
  // positions
  mc.g.position.set(myBody.position.x, myBody.position.y, myBody.position.z);
  const ip = interpOpp(performance.now() - 100); if (ip) oc.g.position.set(ip.x, ip.y, ip.z);
  // facing
  const dx = oc.g.position.x - mc.g.position.x, dz = oc.g.position.z - mc.g.position.z;
  if (!mc.rag) { mc.yaw = angLerp(mc.yaw, Math.atan2(dx, dz), 1 - Math.exp(-14 * dt)); mc.g.rotation.y = mc.yaw; }
  if (!oc.rag) { oc.yaw = angLerp(oc.yaw, Math.atan2(-dx, -dz), 1 - Math.exp(-14 * dt)); oc.g.rotation.y = oc.yaw; }
  animateChar(mc, dt, t, { blocking: me?.bl, stagger: me?.stg > 0, speed: G.lastSpeed, hpFrac: me ? me.hp / me.mhp : 1 });
  animateChar(oc, dt, t, { blocking: op?.bl, stagger: op?.stg > 0, speed: ip && op ? Math.hypot(op.vx, op.vz) : 0, hpFrac: op ? op.hp / op.mhp : 1 });
  [mc, oc].forEach((c) => c.rag && c.rag.forEach(({ part, b }) => { part.position.copy(b.position); part.quaternion.copy(b.quaternion); }));
  for (const m of G.proj.values()) if (m.userData.tx) m.position.lerp(new THREE.Vector3(m.userData.tx.x, m.userData.tx.y, m.userData.tx.z), 0.6);
  updateDebris(dt);
  // HUD
  if (s && me && op) {
    $('#hp-l').style.width = (me.hp / me.mhp * 100) + '%'; $('#hp-r').style.width = (op.hp / op.mhp * 100) + '%'; $('#st-l').style.width = me.st + '%';
    const mi = G.order.indexOf(G.myId); $('#sc-l').textContent = s.sc[mi]; $('#sc-r').textContent = s.sc[1 - mi];
  }
  // camera: behind me, looking toward the midpoint (lock-on style — works with touch, no mouse-look needed)
  const mp = mc.rag ? mc.parts.torso.position : mc.g.position, d = Math.hypot(dx, dz) || 1, fx = dx / d, fz = dz / d;
  const back = 6.5 + d * 0.35, desired = new THREE.Vector3(mp.x - fx * back, Math.max(4.2, mp.y + 4.2), mp.z - fz * back);
  camera.position.lerp(desired, 1 - Math.exp(-6 * dt));
  const look = new THREE.Vector3((mp.x + oc.g.position.x) / 2, 1.3, (mp.z + oc.g.position.z) / 2);
  G.shake = Math.max(0, G.shake - dt * 2.5);
  camera.position.x += (Math.random() - 0.5) * G.shake * 0.3; camera.position.y += (Math.random() - 0.5) * G.shake * 0.3;
  camera.lookAt(look);
}
function menuFrame(dt, t) {
  const pc = Preview.ch; if (pc) { pc.g.rotation.y = t * 0.6; animateChar(pc, dt, t, { speed: 0, hpFrac: 1 }); pc.g.position.set(0, 0, 0); }
  camera.position.set(Math.sin(t * 0.18) * 5.2, 2.3, Math.cos(t * 0.18) * 5.2); camera.lookAt(0, 1.2, 0);
}

/* =====================================================================================
 * 9. RENDER LOOP + BOOT
 * ===================================================================================== */
let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now; const t = now / 1000;
  if (App.state === 'MATCH' && G.active) matchFrame(dt, t); else menuFrame(dt, t);
  stars.rotation.y += dt * 0.01; halo.rotation.z += dt * 0.1;
  L1.position.x = Math.sin(t * 0.5) * 12; L2.position.x = Math.cos(t * 0.5) * 12;
  renderer.render(scene, camera);
}

Settings.load(); Input.init(); bindAuthUI(); bindFriendUI();
FB.onUser(async (r) => {
  if (!r) { Net.disconnect(); cleanupMatch(); App.stopWatch?.(); App.user = App.profile = null; App.party = null; Preview.rebuild(); SFX.stopMusic(); setState('AUTH'); return; }
  App.user = r.user; App.profile = r.profile;
  App.profile.equipped = App.profile.equipped || { arch: 'blade', skin: 'neon_cyan' };
  App.profile.inventory = App.profile.inventory || ['neon_cyan', 'crimson_pulse']; App.profile.friends = App.profile.friends || [];
  setState('MENU'); showScreen('menu'); Preview.rebuild(); renderAllMenus();
  Net.connect(); SFX.startMusic();
  App.stopWatch?.(); App.stopWatch = FB.watchRequests(App.profile, (reqs) => { App.requests = reqs; renderFriends(); if (reqs.length) toast(`${reqs.length} friend request(s)`); }, refreshFriends);
  refreshFriends();
});
FB.restoreSession();
requestAnimationFrame(frame);
