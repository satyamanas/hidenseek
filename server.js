const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

const games = new Map();          // code -> game
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MIN_RADIUS = 20;            // meters
const SEEK_RANGE_M = 25;          // seeker must be this close to tag a hider

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join("");
  } while (games.has(code));
  return code;
}

// Distance between two lat/lng points in meters
function distM(a, b) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function newPlayer(id, name, role) {
  return { id, name, role, found: false, lat: null, lng: null, outside: false, connected: true };
}

function publicPlayers(g) {
  return [...g.players.values()].map(p => ({
    id: p.id, name: p.name, role: p.role, found: p.found, connected: p.connected
  }));
}

// Positions of players who are not the game master (used for timed reveals)
function snapshot(g) {
  return [...g.players.values()]
    .filter(p => p.role !== "gm" && p.lat != null)
    .map(p => ({ id: p.id, name: p.name, role: p.role, found: p.found, lat: p.lat, lng: p.lng }));
}

// Send each player only what they are allowed to see
function sendState(g) {
  const timers = {
    loc: Math.max(0, g.nextLoc - g.elapsed),
    shrink: Math.max(0, g.nextShrink - g.elapsed),
    end: Math.max(0, g.cfg.lenSec - g.elapsed)
  };
  const live = [...g.players.values()]
    .filter(p => p.lat != null)
    .map(p => ({ id: p.id, name: p.name, role: p.role, found: p.found, lat: p.lat, lng: p.lng }));

  for (const p of g.players.values()) {
    if (!p.connected) continue;
    io.to(p.id).emit("state", {
      code: g.code,
      phase: g.phase,
      message: g.message || null,
      gmId: g.gmId,
      center: g.cfg.center,
      zoneR: g.zoneR,
      timers,
      players: publicPlayers(g),
      reveal: g.lastReveal,                        // everyone sees this, only at reveal time
      live: p.id === g.gmId ? live : null,         // only the game master sees everyone live
      me: { id: p.id, role: p.role, found: p.found, outside: p.outside, lat: p.lat, lng: p.lng }
    });
  }
}

function endGame(g, msg) {
  if (g.phase !== "running") return;
  g.phase = "over";
  g.message = msg;
  clearInterval(g.timer);
  sendState(g);
}

function checkEnd(g) {
  const hiders = [...g.players.values()].filter(p => p.role === "hider");
  if (hiders.length === 0 || hiders.every(p => p.found)) {
    endGame(g, "All hiders found! Seekers win!");
  }
}

function tick(g) {
  if (g.phase !== "running") return;
  g.elapsed += 1;

  // Outside-zone check using real coordinates
  for (const p of g.players.values()) {
    p.outside = p.lat != null && distM(p, g.cfg.center) > g.zoneR;
  }

  if (g.elapsed >= g.nextLoc) {
    g.lastReveal = snapshot(g);
    g.nextLoc += g.cfg.locSec;
    io.to(g.code).emit("notice", "Location reveal! Positions updated.");
  }

  if (g.elapsed >= g.nextShrink) {
    g.zoneR = Math.max(MIN_RADIUS, g.zoneR * (1 - g.cfg.shrinkPct / 100));
    g.nextShrink += g.cfg.shrinkSec;
    io.to(g.code).emit("notice", `Zone shrank to ${Math.round(g.zoneR)} m`);
  }

  checkEnd(g);
  if (g.phase === "running" && g.elapsed >= g.cfg.lenSec) {
    endGame(g, "Time's up! Hiders win!");
    return;
  }
  sendState(g);
}

io.on("connection", socket => {
  let myCode = null;
  const myGame = () => games.get(myCode);

  // GAME MASTER: create a game centered on their current GPS position
  socket.on("create", (cfg, cb) => {
    const center = cfg && cfg.center;
    if (!center || typeof center.lat !== "number" || typeof center.lng !== "number") {
      return cb({ ok: false, error: "Waiting for GPS. Allow location access and try again." });
    }
    const code = newCode();
    const radius = clamp(+cfg.radius || 300, 50, 3000);
    const g = {
      code,
      gmId: socket.id,
      phase: "lobby",
      message: null,
      cfg: {
        center,
        shrinkPct: clamp(+cfg.shrinkPct || 20, 5, 60),
        locSec: clamp(+cfg.locMin || 3, 1, 30) * 60,
        shrinkSec: clamp(+cfg.shrinkMin || 10, 1, 60) * 60,
        lenSec: clamp(+cfg.lenMin || 45, 10, 180) * 60
      },
      zoneR: radius,
      elapsed: 0,
      nextLoc: 0,
      nextShrink: 0,
      lastReveal: [],
      players: new Map(),
      timer: null
    };
    g.nextLoc = g.cfg.locSec;
    g.nextShrink = g.cfg.shrinkSec;

    const gm = newPlayer(socket.id, String(cfg.name || "Game Master").slice(0, 16), "gm");
    gm.lat = center.lat;
    gm.lng = center.lng;
    g.players.set(socket.id, gm);

    games.set(code, g);
    socket.join(code);
    myCode = code;
    cb({ ok: true, code });
    sendState(g);
  });

  // PLAYER: join with a code and name (also used to rejoin after a dropped connection)
  socket.on("join", ({ code, name } = {}, cb) => {
    const g = games.get(String(code || "").toUpperCase());
    if (!g) return cb({ ok: false, error: "No game with that code." });
    name = String(name || "").trim().slice(0, 16);
    if (!name) return cb({ ok: false, error: "Enter your name." });

    const existing = [...g.players.values()].find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (existing.connected) return cb({ ok: false, error: "That name is already in the game." });
      // Rejoin: take over the old player record
      const oldId = existing.id;
      g.players.delete(oldId);
      existing.id = socket.id;
      existing.connected = true;
      g.players.set(socket.id, existing);
      if (g.gmId === oldId) g.gmId = socket.id;
    } else {
      if (g.phase !== "lobby") return cb({ ok: false, error: "That game has already started." });
      g.players.set(socket.id, newPlayer(socket.id, name, "hider"));
    }

    socket.join(g.code);
    myCode = g.code;
    cb({ ok: true, code: g.code });
    sendState(g);
  });

  // Real GPS updates from each phone
  socket.on("location", ({ lat, lng } = {}) => {
    const g = myGame();
    if (!g || typeof lat !== "number" || typeof lng !== "number") return;
    const p = g.players.get(socket.id);
    if (!p) return;
    p.lat = lat;
    p.lng = lng;
  });

  // GAME MASTER controls (lobby)
  socket.on("setRole", ({ id, role } = {}) => {
    const g = myGame();
    if (!g || g.gmId !== socket.id || g.phase !== "lobby") return;
    const p = g.players.get(id);
    if (!p || p.role === "gm") return;
    p.role = role === "seeker" ? "seeker" : "hider";
    sendState(g);
  });

  socket.on("randomRoles", () => {
    const g = myGame();
    if (!g || g.gmId !== socket.id || g.phase !== "lobby") return;
    const players = [...g.players.values()].filter(p => p.role !== "gm");
    players.forEach(p => { p.role = Math.random() < 0.3 ? "seeker" : "hider"; });
    if (players.length >= 2) {
      if (!players.some(p => p.role === "seeker")) players[0].role = "seeker";
      if (!players.some(p => p.role === "hider")) players[players.length - 1].role = "hider";
    }
    sendState(g);
  });

  socket.on("kick", id => {
    const g = myGame();
    if (!g || g.gmId !== socket.id || g.phase !== "lobby" || id === socket.id) return;
    if (!g.players.has(id)) return;
    g.players.delete(id);
    io.to(id).emit("kicked");
    sendState(g);
  });

  socket.on("start", cb => {
    const g = myGame();
    if (!g || g.gmId !== socket.id) return cb({ ok: false, error: "Only the game master can start." });
    if (g.phase !== "lobby") return cb({ ok: false, error: "Game already started." });
    const players = [...g.players.values()].filter(p => p.role !== "gm");
    if (players.length < 2) return cb({ ok: false, error: "Need at least 2 players." });
    if (!players.some(p => p.role === "seeker")) return cb({ ok: false, error: "Need at least one seeker." });
    if (!players.some(p => p.role === "hider")) return cb({ ok: false, error: "Need at least one hider." });

    g.phase = "running";
    g.elapsed = 0;
    g.lastReveal = snapshot(g);
    g.timer = setInterval(() => tick(g), 1000);
    io.to(g.code).emit("notice", "Game started! Seekers, go!");
    sendState(g);
    cb({ ok: true });
  });

  // Tag a hider. Seekers must be within range (checked on the server with real GPS).
  socket.on("found", (hiderId, cb) => {
    const g = myGame();
    if (!g || g.phase !== "running") return;
    const me = g.players.get(socket.id);
    const target = g.players.get(hiderId);
    if (!me || !target || target.role !== "hider" || target.found) return;

    const isGM = g.gmId === socket.id;
    if (!isGM) {
      if (me.role !== "seeker") return;
      if (me.lat == null || target.lat == null || distM(me, target) > SEEK_RANGE_M) {
        return cb && cb({ ok: false, error: `Get within ${SEEK_RANGE_M} m to tag them.` });
      }
    }
    target.found = true;
    io.to(g.code).emit("notice", `${target.name} was found!`);
    checkEnd(g);
    sendState(g);
  });

  socket.on("end", () => {
    const g = myGame();
    if (!g || g.gmId !== socket.id) return;
    endGame(g, "Game ended by the game master.");
  });

  socket.on("disconnect", () => {
    const g = myGame();
    if (!g) return;
    const p = g.players.get(socket.id);
    if (!p) return;

    if (g.phase === "lobby" && p.role !== "gm") {
      g.players.delete(socket.id);
    } else {
      p.connected = false;
    }
    sendState(g);

    // Clean up the room if nobody is left connected
    setTimeout(() => {
      const anyone = [...g.players.values()].some(x => x.connected);
      if (!anyone) {
        clearInterval(g.timer);
        games.delete(g.code);
      }
    }, 60 * 1000);
  });
});

server.listen(PORT, () => {
  console.log(`Hide & Seek server running on port ${PORT}`);
});
