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
const createGame = require('./public/gamecore.js');

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
let game = null;
app.get('/health', (_req, res) => res.json({ ok: true, rooms: game ? game.rooms.size : 0, online: game ? game.online.size : 0 }));   // uptime pings / host health check
app.post('/api/checkout', (_req, res) => res.status(501).json({ error: 'Payment provider not configured' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 10000, pingTimeout: 8000 });

game = createGame(io, S, { verify: admin ? (token) => admin.auth().verifyIdToken(token) : null });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Cyber Arena running on http://localhost:${PORT}`));
