/**
 * shared.js — constants used by BOTH the Node server (require) and the browser (window.SHARED).
 * Keeping physics numbers in one place keeps client prediction and server authority in sync.
 */
(function (root) {
  const SHARED = {
    ARENA: 13,          // half-extent of the square platform (x/z in [-13, 13])
    GRAVITY: -26,
    TICK_RATE: 30,      // server simulation + snapshot rate (Hz)
    JUMP: 9.5,
    DASH_KICK: 20,      // knockback-style velocity added by a dash
    DASH_CD: 1.1,
    DASH_COST: 20,
    FALL_Y: -12,        // below this = ring-out
    KNOCK_DECAY: 4,     // knockback velocity decays by exp(-4 dt)
    PARRY_WINDOW: 0.25, // seconds after raising block that count as a parry
    ROUNDS_TO_WIN: 2,

    // Archetypes: weapon type + stats. range 0 => ranged weapon (projectile).
    ARCH: {
      blade:  { name: 'Blade Dancer', weapon: 'sword',   hp: 100, speed: 7.5, dmg: 12, heavy: 26, range: 2.6, weight: 1.0,
                desc: 'Fast and precise. Balanced damage, great mobility.' },
      titan:  { name: 'Titan',        weapon: 'hammer',  hp: 140, speed: 5.5, dmg: 18, heavy: 40, range: 3.0, weight: 1.7,
                desc: 'Slow bruiser. Huge knockback, very hard to launch.' },
      ranger: { name: 'Ranger',       weapon: 'blaster', hp: 90,  speed: 7.0, dmg: 8,  heavy: 22, range: 0,   weight: 0.9,
                desc: 'Ranged pressure. Light bolts and a charged shot.' }
    },

    // Cosmetic catalogue (client renders these; ownership lives in Firestore).
    SKINS: {
      neon_cyan:     { name: 'Neon Cyan',     rarity: 'common',    price: 0,    color: '#0b3d4a', emissive: '#00e5ff', accent: '#7dfcff', glow: 0.8 },
      crimson_pulse: { name: 'Crimson Pulse', rarity: 'common',    price: 0,    color: '#3d0b16', emissive: '#ff2a55', accent: '#ff8aa3', glow: 0.8 },
      toxic_green:   { name: 'Toxic Green',   rarity: 'rare',      price: 300,  color: '#10300f', emissive: '#39ff14', accent: '#b6ff9e', glow: 1.0 },
      void_violet:   { name: 'Void Violet',   rarity: 'rare',      price: 300,  color: '#1d0b3d', emissive: '#a855ff', accent: '#d9b3ff', glow: 1.0 },
      solar_gold:    { name: 'Solar Gold',    rarity: 'epic',      price: 800,  color: '#3d2c07', emissive: '#ffb800', accent: '#fff0a8', glow: 1.2 },
      phantom_white: { name: 'Phantom',       rarity: 'legendary', price: 1500, color: '#e8f0ff', emissive: '#9ad0ff', accent: '#ffffff', glow: 1.5 }
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SHARED;
  else root.SHARED = SHARED;
})(typeof window !== 'undefined' ? window : globalThis);
