# Cyber Arena 1v1 — free, always-online on GitHub Pages

No Node server needed. Upload this folder to your GitHub repo and open your GitHub Pages link.

How online works (free peer-to-peer): the first player to open the game becomes the "lobby host"
(their browser runs the game server code); everyone else connects to them. If the host leaves, the
others reconnect automatically and one becomes the new host. It is online whenever at least one player has the page open.

Tips
- Test alone: open the link in 2 tabs, pick different guest names, add each other by the @name under your name, or press Find Match in both.
- Rare strict networks may block WebRTC; try another Wi-Fi / mobile data.
- A host's tab must stay open (browsers may slow background tabs).

Optional: `npm install && npm start` runs the classic Node server version (NET_MODE auto-switches on localhost:3000). See public/config.js.
