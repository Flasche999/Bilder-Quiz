// server.js – Bildklick-Quiz (ESM) – Auto-Lock, Click-freigabe nach Dunkelphase, History/Log/Playlist/Frage/Ziel + robuste Bildpfade
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => res.status(200).type('text').send('OK'));

// ─────────────────────────────────────────────────────────────
// Helpers für robuste Bildpfade
// ─────────────────────────────────────────────────────────────
function normUrl(u) {
  if (!u) return '';
  const s = String(u).trim();
  if (s.startsWith('http://') || s.startsWith('https://')) return s;
  return s.startsWith('/') ? s : '/' + s; // stelle führenden Slash sicher
}
function fileExistsUnderPublic(absUrl) {
  if (!absUrl || absUrl.startsWith('http')) return true; // externe URLs nicht prüfen
  const filePath = path.join(__dirname, 'public', absUrl.replace(/^\//,''));
  try { return fs.existsSync(filePath); } catch { return false; }
}

// ─────────────────────────────────────────────────────────────
// Globaler State
// ─────────────────────────────────────────────────────────────
let state = {
  players: {},      // socketId -> { id, name, score, locked, click }
  round: null,      // aktive Runde (s.u.)
  volume: 0.5,      // globale Lautstärke (0..1)
  history: [],      // Punkte-History: [{ts, roundId, playerId, playerName, delta, reason}]
  roundsLog: [],    // Runden-Log: [{roundId, title, imageUrl, visibleMs, clickRadiusPct, target, clicks:[...], winners:[...]}]
  playlist: [],     // [{title,imageUrl,visibleMs,clickRadiusPct,target,{question}}]
  playlistIndex: -1
};

// ─────────────────────────────────────────────────────────────
// Round-Init & Bewertung
// ─────────────────────────────────────────────────────────────
function initRound({ imageUrl, target, visibleMs, clickRadiusPct, title = null, question = null }) {
  const img = normUrl(imageUrl);
  state.round = {
    id: Date.now(),
    title,
    imageUrl: img,
    target,             // {x:0..1, y:0..1, rPct:1..40}
    visibleMs,          // Bild sichtbar (ms), danach schwarz
    clickRadiusPct,     // Reveal-Radius in %
    started: true,
    masked: true,       // Spieler erhalten nach Ablauf Maske
    revealed: false,    // globale Klickfenster offenbart?
    clicks: {},         // playerId -> {x,y,locked}
    question: question ? String(question).slice(0,200) : null,
    showTarget: false,
    allowClicks: false,                 // erst nach Dunkelphase wahr
    allowAt: Date.now() + (visibleMs||0) // Zeitstempel, ab wann Klicks erlaubt
  };

  // Serverseitig Klick-Phase freigeben, wenn Sichtbarkeitszeit vorbei
  const rid = state.round.id;
  setTimeout(() => {
    if (!state.round || state.round.id !== rid) return; // Runde hat sich geändert
    state.round.allowClicks = true;
    io.emit('round:allowClicks', {}); // Clients dürfen jetzt klicken
  }, state.round.visibleMs || 0);
}

function judgeRoundAndAward() {
  if (!state.round) return { winners: [] };
  const { target } = state.round;
  const winners = [];
  const clicksArray = [];

  for (const pid of Object.keys(state.round.clicks)) {
    const c = state.round.clicks[pid];
    const dx = c.x - target.x;
    const dy = c.y - target.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const inTarget = dist <= (target.rPct/100);

    clicksArray.push({
      playerId: pid,
      name: state.players[pid]?.name || 'Spieler',
      x: c.x, y: c.y, hit: inTarget
    });

    if (inTarget && state.players[pid]) {
      state.players[pid].score += 5;
      winners.push(pid);
      state.history.push({
        ts: Date.now(),
        roundId: state.round.id,
        playerId: pid,
        playerName: state.players[pid].name,
        delta: +5,
        reason: 'Treffer im Zielbereich'
      });
    }
  }

  // Runden-Log-Eintrag
  state.roundsLog.push({
    roundId: state.round.id,
    title: state.round.title,
    imageUrl: state.round.imageUrl,
    visibleMs: state.round.visibleMs,
    clickRadiusPct: state.round.clickRadiusPct,
    target: state.round.target,
    clicks: clicksArray,
    winners
  });

  return { winners };
}

function broadcastAdminState() {
  const players = Object.values(state.players).map(p => ({
    id: p.id,
    name: p.name,
    score: p.score,
    locked: !!p.locked,
    click: p.click || null,
  }));

  const historyTail = state.history.slice(-50);
  const roundsTail  = state.roundsLog.slice(-20);

  io.to('admins').emit('admin:state', {
    players,
    round: state.round,
    volume: state.volume,
    history: historyTail,
    roundsLog: roundsTail,
    playlist: state.playlist,
    playlistIndex: state.playlistIndex
  });
}

// ─────────────────────────────────────────────────────────────
// Socket.IO
// ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const role = socket.handshake.query.role || 'player';

  // ====================== ADMIN ======================
  if (role === 'admin') {
    socket.join('admins');
    broadcastAdminState();

    // Manuell konfigurierte Runde starten
    socket.on('admin:startRound', (cfg, ack) => {
      let { imageUrl, target, visibleMs, clickRadiusPct, title, question } = cfg;
      const img = normUrl(imageUrl);
      if (!fileExistsUnderPublic(img)) {
        console.warn('[admin:startRound] Bild nicht gefunden:', img);
      }
      initRound({ imageUrl: img, target, visibleMs, clickRadiusPct, title, question: question || null });

      // Reset aller Klicks & Locks
      Object.values(state.players).forEach(p => { p.locked = false; p.click = null; });

      // Beim Start Frage/Ziel nicht automatisch anzeigen
      state.round.showTarget = false;

      io.emit('round:started', {
        imageUrl: img,
        visibleMs,
        clickRadiusPct,
        roundId: state.round.id
      });
      broadcastAdminState();
      ack && ack({ ok: true });
    });

    // „Klicks zeigen“ → NUR eigenen Radius an jeden Spieler senden
    socket.on('admin:revealClicks', (_void, ack) => {
      if (!state.round) return;
      state.round.revealed = true;

      const cr = state.round.clickRadiusPct;
      for (const pid of Object.keys(state.players)) {
        const click = state.round.clicks[pid] || null;
        io.to(pid).emit('round:revealSelf', { click, clickRadiusPct: cr });
      }

      broadcastAdminState();
      ack && ack({ ok: true });
    });

    // Auswerten & Punkte vergeben (alle sehen alle Klicks)
    socket.on('admin:judge', (_void, ack) => {
      if (!state.round) return;
      const { winners } = judgeRoundAndAward();
      state.round.revealed = true;
      io.emit('round:judged', {
        winners,
        clicks: state.round.clicks,
        clickRadiusPct: state.round.clickRadiusPct,
        target: state.round.target,
      });
      broadcastAdminState();
      ack && ack({ ok: true, winners });
    });

    // Nächste Runde (Reset)
    socket.on('admin:nextRound', (ack) => {
      if (state.round) state.round.started = false;
      io.emit('round:reset', {});
      broadcastAdminState();
      ack && ack({ ok: true });
    });

    // Globale Lautstärke
    socket.on('admin:setVolume', (vol) => {
      state.volume = Math.max(0, Math.min(1, Number(vol)||0));
      io.emit('volume:update', state.volume);
      broadcastAdminState();
    });

    // Fragen & Ziel
    socket.on('admin:showQuestion', (text, ack) => {
      if (!state.round) return ack && ack({ok:false});
      state.round.question = String(text||'').slice(0,200);
      io.emit('round:question', { text: state.round.question });
      broadcastAdminState();
      ack && ack({ ok:true });
    });

    socket.on('admin:showQuestionFromRound', (_void, ack) => {
      if (!state.round) return ack && ack({ok:false});
      const text = state.round?.question || '';
      io.emit('round:question', { text });
      broadcastAdminState();
      ack && ack({ ok:true });
    });

    socket.on('admin:toggleTarget', (show, ack) => {
      if (!state.round) return ack && ack({ok:false});
      state.round.showTarget = !!show;
      io.emit('round:showTarget', { show: state.round.showTarget, target: state.round.target });
      broadcastAdminState();
      ack && ack({ ok:true });
    });

    // Playlist steuern
    socket.on('admin:setPlaylist', (list, ack) => {
      if (Array.isArray(list)) {
        state.playlist = list.map((it, i) => {
          const img = normUrl(String(it.imageUrl||''));
          if (!fileExistsUnderPublic(img)) {
            console.warn('[playlist] Bild nicht gefunden:', img);
          }
          return {
            title: String(it.title||`Bild ${i+1}`),
            imageUrl: img,
            visibleMs: Number(it.visibleMs)||4000,
            clickRadiusPct: Number(it.clickRadiusPct)||6,
            target: {
              x: Number(it.target?.x) || 0.5,
              y: Number(it.target?.y) || 0.5,
              rPct: Number(it.target?.rPct) || 8
            },
            question: it.question ? String(it.question).slice(0,200) : null
          };
        });
        state.playlistIndex = state.playlist.length ? 0 : -1;
        broadcastAdminState();
        ack && ack({ ok:true, count: state.playlist.length });
      } else {
        ack && ack({ ok:false, msg:'Ungültige Playlist' });
      }
    });

    socket.on('admin:setPlaylistIndex', (idx, ack) => {
      const n = Number(idx);
      if (Number.isInteger(n) && n >= 0 && n < state.playlist.length) {
        state.playlistIndex = n;
        broadcastAdminState();
        ack && ack({ ok:true });
      } else {
        ack && ack({ ok:false });
      }
    });

    socket.on('admin:startFromPlaylist', (ack) => {
      if (state.playlistIndex < 0 || state.playlistIndex >= state.playlist.length) {
        return ack && ack({ ok:false, msg:'Keine gültige Auswahl' });
      }
      const cfg = state.playlist[state.playlistIndex];
      const img = normUrl(cfg.imageUrl);
      if (!fileExistsUnderPublic(img)) {
        console.warn('[startFromPlaylist] Bild nicht gefunden:', img);
      }
      initRound({ ...cfg, imageUrl: img });
      Object.values(state.players).forEach(p => { p.locked = false; p.click = null; });
      state.round.showTarget = false;
      io.emit('round:started', {
        imageUrl: img,
        visibleMs: cfg.visibleMs,
        clickRadiusPct: cfg.clickRadiusPct,
        roundId: state.round.id
      });
      broadcastAdminState();
      ack && ack({ ok:true });
    });

    socket.on('admin:nextInPlaylist', (ack) => {
      if (state.playlist.length === 0) return ack && ack({ ok:false });
      state.playlistIndex = (state.playlistIndex + 1) % state.playlist.length;
      broadcastAdminState();
      ack && ack({ ok:true, index: state.playlistIndex });
    });

    socket.on('disconnect', () => {});
    return; // Ende Admin
  }

  // ====================== PLAYER ======================
  state.players[socket.id] = {
    id: socket.id,
    name: 'Spieler ' + socket.id.slice(0,4),
    score: 0,
    locked: false,
    click: null,
  };

  socket.emit('hello', {
    you: state.players[socket.id],
    round: state.round,
    volume: state.volume,
  });
  broadcastAdminState();

  socket.on('player:setName', (name) => {
    if (state.players[socket.id]) {
      state.players[socket.id].name = String(name||'').slice(0,32) || state.players[socket.id].name;
      broadcastAdminState();
    }
  });

  // Auto-Lock bei Klick – aber nur wenn die Klick-Phase freigegeben ist
  socket.on('player:lock', ({x,y}, ack) => {
    const p = state.players[socket.id];
    if (!p || !state.round) return;
    if (!state.round.allowClicks || Date.now() < (state.round.allowAt||0)) {
      return ack && ack({ ok:false, msg:'Noch nicht freigegeben' });
    }
    if (p.locked) return ack && ack({ ok:false, msg:'Schon gelockt' });

    const nx = Math.max(0, Math.min(1, Number(x)||0));
    const ny = Math.max(0, Math.min(1, Number(y)||0));

    p.locked = true;
    p.click  = { x:nx, y:ny };
    state.round.clicks[socket.id] = { x:nx, y:ny, locked:true };

    // Bestätigung + eigener Reveal-Kreis (nur für diesen Spieler)
    socket.emit('player:locked', p.click);
    const cr = state.round.clickRadiusPct || 6;
    socket.emit('player:selfReveal', { click: p.click, clickRadiusPct: cr });

    broadcastAdminState();
    ack && ack({ ok:true });
  });

  socket.on('disconnect', () => {
    delete state.players[socket.id];
    if (state.round) delete state.round.clicks[socket.id];
    broadcastAdminState();
  });
});

// ─────────────────────────────────────────────────────────────
// Serverstart
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log('Server listening on :' + PORT);
});
