/**
 * firebase-auth.js — Auth + Firestore integration.
 *   register / login / guest (anonymous) / logout, cloud profile persistence, friend system.
 *
 * Works WITHOUT Firebase too: if the config below is still a placeholder it falls back to a
 * localStorage "offline profile" so you can test the game immediately.
 *
 * SETUP: Firebase console -> Authentication (enable Email/Password + Anonymous) -> Firestore.
 *        Paste your web config into FIREBASE_CONFIG, then paste the rules at the bottom into Firestore.
 *
 * Firestore layout
 *   users/{uid}            { name, handle, coins, inventory[], equipped{arch,skin}, friends[uids], createdAt }
 *   handles/{handle}       { uid }                       (unique, searchable user ID)
 *   friendRequests/{id}    { from, fromName, fromHandle, to, status: 'pending'|'accepted' }
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js';
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signInAnonymously,
  signOut, onAuthStateChanged, updateProfile
} from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, collection, query, where, getDocs, addDoc,
  deleteDoc, onSnapshot, serverTimestamp, arrayUnion, runTransaction
} from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js';

export const FIREBASE_CONFIG = window.FIREBASE_CONFIG || {
  apiKey: 'YOUR_API_KEY', authDomain: 'YOUR_PROJECT.firebaseapp.com', projectId: 'YOUR_PROJECT',
  storageBucket: 'YOUR_PROJECT.appspot.com', messagingSenderId: '000000000000', appId: 'YOUR_APP_ID'
};
export const CONFIGURED = !FIREBASE_CONFIG.apiKey.startsWith('YOUR_');

let auth = null, db = null;
if (CONFIGURED) { const app = initializeApp(FIREBASE_CONFIG); auth = getAuth(app); db = getFirestore(app); }

const DEFAULT_PROFILE = () => ({
  coins: 500, inventory: ['neon_cyan', 'crimson_pulse'], equipped: { arch: 'blade', skin: 'neon_cyan' }, friends: []
});

/* ================= offline fallback ================= */
const LS = 'cyberarena.offline';
function offlineLoad() { try { return JSON.parse(localStorage.getItem(LS)); } catch { return null; } }
function offlineUser(name) {
  let p = offlineLoad();
  if (!p) { p = { uid: 'local_' + Math.random().toString(36).slice(2, 9), name: name || 'Guest', handle: '', ...DEFAULT_PROFILE() };
            p.handle = (p.name.toLowerCase().replace(/\W/g, '') || 'guest') + '_' + Math.floor(1000 + Math.random() * 9000);
            localStorage.setItem(LS, JSON.stringify(p)); }
  return { user: { uid: p.uid, displayName: p.name, isAnonymous: true, offline: true }, profile: p };
}

/* ================= auth ================= */
const listeners = new Set();
export function onUser(cb) { listeners.add(cb); }
const emit = (v) => listeners.forEach((cb) => cb(v));

export async function register(email, password, displayName) {
  if (!CONFIGURED) throw new Error('Firebase not configured — use Guest mode or add your config.');
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(cred.user, { displayName });
  const profile = await createProfile(cred.user, displayName);
  emit({ user: cred.user, profile }); return { user: cred.user, profile };
}
export async function login(email, password) {
  if (!CONFIGURED) throw new Error('Firebase not configured — use Guest mode or add your config.');
  const cred = await signInWithEmailAndPassword(auth, email, password);
  const profile = await loadProfile(cred.user.uid) || await createProfile(cred.user, cred.user.displayName);
  emit({ user: cred.user, profile }); return { user: cred.user, profile };
}
export async function guest(name = 'Guest') {
  if (!CONFIGURED) { const r = offlineUser(name); emit(r); return r; }
  const cred = await signInAnonymously(auth);                     // anonymous account still gets a cloud profile
  const profile = await loadProfile(cred.user.uid) || await createProfile(cred.user, name);
  emit({ user: cred.user, profile }); return { user: cred.user, profile };
}
export async function logout() { if (CONFIGURED) await signOut(auth); emit(null); }
export async function getIdToken(user) { try { return CONFIGURED && auth.currentUser ? await auth.currentUser.getIdToken() : null; } catch { return null; } }

/** Restore a previous session on page load. */
export function restoreSession() {
  if (!CONFIGURED) { const p = offlineLoad(); if (p) { const r = offlineUser(p.name); emit(r); } return; }
  onAuthStateChanged(auth, async (user) => {
    if (!user) return;
    const profile = await loadProfile(user.uid) || await createProfile(user, user.displayName || 'Player');
    emit({ user, profile });
  });
}

/* ================= profile ================= */
async function createProfile(user, name) {
  name = (name || 'Player').slice(0, 20);
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'player';
  let handle = '';
  for (let i = 0; i < 6 && !handle; i++) {                        // reserve a unique, searchable handle
    const h = `${base}_${Math.floor(1000 + Math.random() * 9000)}`;
    try {
      await runTransaction(db, async (tx) => {
        const ref = doc(db, 'handles', h);
        if ((await tx.get(ref)).exists()) throw new Error('taken');
        tx.set(ref, { uid: user.uid });
      });
      handle = h;
    } catch { /* retry */ }
  }
  const profile = { name, handle, ...DEFAULT_PROFILE(), createdAt: serverTimestamp() };
  await setDoc(doc(db, 'users', user.uid), profile);
  return { ...profile, uid: user.uid };
}
export async function loadProfile(uid) {
  if (!CONFIGURED) return offlineLoad();
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? { uid, ...snap.data() } : null;
}
/** Persist a partial update (equipped, inventory, coins...). Debounce at call-site if called often. */
export async function saveProfile(uid, patch) {
  if (!CONFIGURED) { const p = { ...offlineLoad(), ...patch }; localStorage.setItem(LS, JSON.stringify(p)); return; }
  await updateDoc(doc(db, 'users', uid), patch);
}

/* ================= friends ================= */
export async function findByHandle(handle) {
  if (!CONFIGURED) return null;
  const h = await getDoc(doc(db, 'handles', handle.trim().toLowerCase()));
  if (!h.exists()) return null;
  const p = await loadProfile(h.data().uid); return p;
}
export async function sendFriendRequest(me, handle) {
  if (!CONFIGURED) throw new Error('Friends need Firebase — add your config.');
  const target = await findByHandle(handle);
  if (!target) throw new Error('User not found');
  if (target.uid === me.uid) throw new Error("That's you!");
  if ((me.friends || []).includes(target.uid)) throw new Error('Already friends');
  await addDoc(collection(db, 'friendRequests'), {
    from: me.uid, fromName: me.name, fromHandle: me.handle, to: target.uid, status: 'pending', createdAt: serverTimestamp()
  });
  return target;
}
/** Live list of incoming pending requests + sync of requests I sent that were accepted. */
export function watchRequests(me, onIncoming, onFriendsChanged) {
  if (!CONFIGURED) return () => {};
  const inc = onSnapshot(query(collection(db, 'friendRequests'), where('to', '==', me.uid), where('status', '==', 'pending')),
    (s) => onIncoming(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
  // when the other side accepted, add them to MY friends array, then delete the request (rule-safe: I only write my own doc)
  const out = onSnapshot(query(collection(db, 'friendRequests'), where('from', '==', me.uid), where('status', '==', 'accepted')),
    async (s) => {
      for (const d of s.docs) {
        await updateDoc(doc(db, 'users', me.uid), { friends: arrayUnion(d.data().to) });
        await deleteDoc(d.ref);
      }
      if (s.docs.length) onFriendsChanged();
    });
  return () => { inc(); out(); };
}
export async function respondRequest(me, req, accept) {
  if (!accept) return deleteDoc(doc(db, 'friendRequests', req.id));
  await updateDoc(doc(db, 'users', me.uid), { friends: arrayUnion(req.from) });
  await updateDoc(doc(db, 'friendRequests', req.id), { status: 'accepted' });
}
export async function listFriends(me) {
  if (!CONFIGURED) return [];
  const out = [];
  for (const uid of me.friends || []) { const p = await loadProfile(uid); if (p) out.push({ uid, name: p.name, handle: p.handle }); }
  return out;
}

/* ================= Firestore security rules (paste into console) =================
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /users/{uid} {
      allow read: if request.auth != null;
      allow create: if request.auth.uid == uid;
      // owner may update their own doc. For production, move `coins` & `inventory` writes to
      // a Cloud Function / the Node server (firebase-admin) so players can't grant themselves items.
      allow update: if request.auth.uid == uid;
    }
    match /handles/{h} { allow read: if request.auth != null; allow create: if request.auth != null; }
    match /friendRequests/{id} {
      allow create: if request.auth.uid == request.resource.data.from;
      allow read: if request.auth.uid in [resource.data.from, resource.data.to];
      allow update: if request.auth.uid == resource.data.to;
      allow delete: if request.auth.uid in [resource.data.from, resource.data.to];
    }
  }
}
=================================================================================== */
