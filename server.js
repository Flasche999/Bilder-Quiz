
// server.js – Bildklick-Quiz (ESM)
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => res.status(200).type('text').send('OK'));

let state = {
  players: {}, // socketId -> { id, name, score, locked: false, click: {x,y} | null }
  round: null, // see initRound()
  volume: 0.5,
};

function initRound({ imageUrl, target, visibleMs, clickRadiusPct }) {
  state.round = {
    id: Date.now(),
    imageUrl,
    target,            // {x:0-1,y:0-1,rPct:0-100} (Zielbereich)
    visibleMs,         // Sichtbarkeitszeit für Spieler
    clickRadiusPct,    // Klick-Radius (Anzeige & Reveal)
    started: true,
    masked: true,      // Spieler bekommen nach Ablauf eine schwarze Maske
    revealed: false,   // Moderator kann später Klickfenster offenbaren
    clicks: {},        // playerId -> {x,y,locked}
  };
}

function broadcastAdminState() {
  const players = Object.values(state.players).map(p => ({
    id: p.id,
    name: p.name,
    score: p.score,
    locked: !!p.locked,
    click: p.click || null,
  }));
  io.to('admins').emit('admin:state', {
    players,
    round: state.round,
    volume: state.volume,
  });
}

io.on('connection', (socket) => {
  const role = socket.handshake.query.role || 'player';

  if (role === 'admin') {
    socket.join('admins');
    // Sofort Status schicken
    broadcastAdminState();

    socket.on('admin:startRound', (cfg, ack) => {
      const { imageUrl, target, visibleMs, clickRadiusPct } = cfg;
      initRound({ imageUrl, target, visibleMs, clickRadiusPct });
      // Reset aller Klicks & Locks
      Object.values(state.players).forEach(p => { p.locked = false; p.click = null; });
      io.emit('round:started', { 
        imageUrl, visibleMs, clickRadiusPct, roundId: state.round.id 
      });
      broadcastAdminState();
      ack && ack({ ok: true });
    });

    socket.on('admin:revealClicks', (_void, ack) => {
      if (!state.round) return;
      state.round.revealed = true;
      io.emit('round:reveal', {
        clicks: state.round.clicks,
        clickRadiusPct: state.round.clickRadiusPct,
      });
      broadcastAdminState();
      ack && ack({ ok: true });
    });

    socket.on('admin:judge', (_void, ack) => {
      if (!state.round) return;
      const { target } = state.round;
      const winners = [];
      for (const pid of Object.keys(state.round.clicks)) {
        const c = state.round.clicks[pid];
        const dx = c.x - target.x;
        const dy = c.y - target.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        const inTarget = dist <= (target.rPct/100); // Vergleich mit Prozent-Radius
        if (inTarget) {
          if (state.players[pid]) {
            state.players[pid].score += 5;
            winners.push(pid);
          }
        }
      }
      // Reveal erzwingen
      state.round.revealed = true;
      io.emit('round:judged', {
        winners,
        clicks: state.round.clicks,
        clickRadiusPct: state.round.clickRadiusPct,
        target,
      });
      broadcastAdminState();
      ack && ack({ ok: true, winners });
    });

    socket.on('admin:nextRound', (ack) => {
      if (state.round) {
        state.round.started = false;
      }
      io.emit('round:reset', {});
      broadcastAdminState();
      ack && ack({ ok: true });
    });

    socket.on('admin:setVolume', (vol) => {
      state.volume = Math.max(0, Math.min(1, Number(vol)||0));
      io.emit('volume:update', state.volume);
      broadcastAdminState();
    });

    socket.on('disconnect', () => {
      // Admin weg – nix zu tun
    });

    return; // admin handler end
  }

  // PLAYER
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

  socket.on('player:preview', ({x,y}) => {
    // Vorschau wird clientseitig gehandhabt; Server speichert nicht
  });

  socket.on('player:lock', ({x,y}, ack) => {
    const p = state.players[socket.id];
    if (!p || !state.round) return;
    if (p.locked) return ack && ack({ ok:false, msg:'Schon gelockt' });

    // Nur innerhalb [0,1] akzeptieren
    const nx = Math.max(0, Math.min(1, Number(x)||0));
    const ny = Math.max(0, Math.min(1, Number(y)||0));

    p.locked = true;
    p.click  = { x:nx, y:ny };
    state.round.clicks[socket.id] = { x:nx, y:ny, locked:true };

    // Den Spielern zeigen wir nur ihren eigenen Lock
    socket.emit('player:locked', p.click);
    // Dem Admin vollständigen Status
    broadcastAdminState();
    ack && ack({ ok:true });
  });

  socket.on('disconnect', () => {
    delete state.players[socket.id];
    if (state.round) delete state.round.clicks[socket.id];
    broadcastAdminState();
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log('Server listening on :' + PORT);
});
