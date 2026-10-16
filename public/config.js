// ===== Cyber Arena config =====
// NET_MODE:
//   'auto'   (default) -> GitHub Pages / any static host: free peer-to-peer online mode (no server needed).
//                         Opening via `npm start` (localhost:3000) or SERVER_URL_OVERRIDE uses the Node server instead.
//   'p2p'    -> always peer-to-peer.    'server' -> always the Node server.
window.NET_MODE = 'auto';
window.SERVER_URL_OVERRIDE = '';     // only for 'server' mode, e.g. 'https://my-game.onrender.com'
window.LOBBY_ID = 'cyber-arena-lobby-7q2x9';   // change to any unique string to run your own private lobby

// ===== Firebase (accounts + cloud saves: coins, skins, equipped, friends) =====
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyC7vm7iiOZLzom4oTuE5VrouDw3meePYvU",
  authDomain: "krd1v1.firebaseapp.com",
  projectId: "krd1v1",
  storageBucket: "krd1v1.firebasestorage.app",
  messagingSenderId: "605966112641",
  appId: "1:605966112641:web:2caee9027be23f67fdfa80"
};
