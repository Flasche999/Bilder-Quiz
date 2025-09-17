// server.js – Bildklick-Quiz (Raumcode + Name + Farben + Scoreboard + getrenntes Reveal)
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

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────
const COLORS = [
  '#ef4444','#22c55e','#3b82f6','#eab308',
  '#a855f7','#14b8a6','#f97316','#84cc16',
  '#f43f5e','#06b6d4'
];

let state = {
  players: {},          // id -> {id,name,score,colorIdx,locked,click}
  round: null,          // {id,title,imageUrl,visibleMs,clickRadiusPct,target,question,startedAt,willDarkAt,reveal}
  playlist: [],
  playlistIndex: -1,
  roomCode: '1234'      // Default Raumcode (Admin kann ändern)
};

const newId=()=>Math.random().toString(36).slice(2,8);
const now=()=>Date.now();
const toAdmin=()=>io.to('admin');

// Admin-Shape inkl. Farben & Code
function adminShape(){
  return {
    roomCode: state.roomCode,
    players:Object.values(state.players).map(p=>({
      id:p.id, name:p.name, score:p.score,
      color:COLORS[p.colorIdx%COLORS.length],
      locked:p.locked, click:p.click
    })),
    round:state.round, playlist:state.playlist, playlistIndex:state.playlistIndex
  };
}
function broadcastAdmin(){ toAdmin().emit('admin:state', adminShape()); }

// Scoreboard an alle Spieler senden
function broadcastPlayersList(){
  const list = Object.values(state.players).map(p=>({
    id:p.id, name:p.name, score:p.score, color: COLORS[p.colorIdx%COLORS.length]
  }));
  io.emit('players:list', list);
}

function isHit(click,target){
  if(!click||!target) return false;
  const dx=(click.x-target.x), dy=(click.y-target.y);
  const distPct=Math.sqrt(dx*dx+dy*dy)*100;
  return distPct<=target.rPct;
}

io.on('connection',(socket)=>{
  const role=socket.handshake.query?.role||'player';

  // ── ADMIN
  if(role==='admin'){
    socket.join('admin');
    socket.emit('admin:state', adminShape());

    // Raumcode setzen
    socket.on('admin:setRoomCode', (code, ack)=>{
      const c = String(code||'').trim();
      if (!c) return ack && ack({ok:false, error:'empty_code'});
      state.roomCode = c;
      broadcastAdmin();
      ack && ack({ok:true});
    });

    // Playlist steuern
    socket.on('admin:setPlaylist',(d,ack)=>{
      state.playlist = Array.isArray(d) ? d : (d?.items||[]);
      state.playlistIndex = state.playlist.length ? 0 : -1;
      broadcastAdmin(); ack && ack({ok:true});
    });

    socket.on('admin:startFromPlaylist',(ack)=>{
      if(state.playlistIndex<0) return ack && ack({ok:false,error:'no_playlist'});
      startRound(state.playlist[state.playlistIndex]);
      ack && ack({ok:true});
    });

    socket.on('admin:nextInPlaylist',(ack)=>{
      if(!state.playlist.length) return ack && ack({ok:false,error:'no_playlist'});
      state.playlistIndex = (state.playlistIndex+1)%state.playlist.length;
      startRound(state.playlist[state.playlistIndex]);
      ack && ack({ok:true});
    });

    socket.on('admin:startRound',(cfg,ack)=>{ startRound(cfg); ack&&ack({ok:true}); });

    // ★ Getrenntes Reveal – Admin bekommt alle, Spieler nur ihren eigenen Radius
    socket.on('admin:revealClicks',(_,ack)=>{
      if(!state.round) return ack && ack({ok:false});
      state.round.reveal = true;

      // 1) Admin: alle Klicks
      const all = shapeRevealAll(); // { clicks:[{id,name,color,x,y}], clickRadiusPct }
      io.to('admin').emit('round:revealAll', all);

      // 2) Spieler: nur eigener Klick & Radius
      for(const p of Object.values(state.players)){
        if(p.click){
          io.to(p.id).emit('round:revealYou', {
            click: { x:p.click.x, y:p.click.y, color: COLORS[p.colorIdx] },
            clickRadiusPct: state.round.clickRadiusPct
          });
        }else{
          io.to(p.id).emit('round:revealYou', {
            click: null,
            clickRadiusPct: state.round.clickRadiusPct
          });
        }
      }

      broadcastAdmin(); ack && ack({ok:true});
    });

    // Auswertung -> +5 Punkte für Treffer
    socket.on('admin:judge',(_,ack)=>{
      if(!state.round) return ack && ack({ok:false});
      const winners=[];
      for(const p of Object.values(state.players)){
        if(isHit(p.click,state.round.target)){
          p.score=(p.score||0)+5;
          winners.push(p.id);
        }
      }
      io.emit('round:judged',{winners});
      broadcastAdmin();
      broadcastPlayersList(); // Scoreboard aktualisieren
      ack&&ack({ok:true});
    });

    return; // admin done
  }

  // ── PLAYER
  // Gate: Spieler müssen zuerst mit Name + Raumcode joinen
  socket.emit('hello', { needJoin:true });

  socket.on('player:join', ({name, roomCode}, ack)=>{
    const n = String(name||'').trim();
    const rc = String(roomCode||'').trim();
    if (!n || !rc) return ack && ack({ok:false, error:'name_or_code_missing'});
    if (rc !== state.roomCode) return ack && ack({ok:false, error:'wrong_code'});

    const id = socket.id;
    const colorIdx = Object.keys(state.players).length % COLORS.length;

    state.players[id] = {
      id,
      name: n.slice(0,24),
      score: state.players[id]?.score || 0,
      colorIdx,
      locked:false,
      click:null
    };

    // initiale Infos zurück
    socket.emit('joined', {
      id,
      color: COLORS[colorIdx],
      round: publicRoundShape()
    });

    broadcastAdmin();
    broadcastPlayersList();
    ack && ack({ok:true});
  });

  socket.on('player:click',({x,y})=>{
    const p=state.players[socket.id];
    if(!state.round || !p) return;      // nur registrierte Spieler
    const t=now();
    if(t<state.round.willDarkAt) return; // erst nach Abdunkeln
    if(p.locked) return;                  // nur 1 Klick

    p.click={x:Math.min(1,Math.max(0,x)), y:Math.min(1,Math.max(0,y))};
    p.locked=true;

    // Admin Live-Update
    toAdmin().emit('admin:playerClick',{
      id:p.id,name:p.name,color:COLORS[p.colorIdx],click:p.click
    });
  });

  socket.on('disconnect',()=>{
    if (state.players[socket.id]) {
      delete state.players[socket.id];
      broadcastAdmin();
      broadcastPlayersList();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function publicRoundShape(){
  if(!state.round) return null;
  const {id,title,imageUrl,visibleMs,clickRadiusPct,question,startedAt,willDarkAt,reveal,target}=state.round;
  return {id,title,imageUrl,visibleMs,clickRadiusPct,question,startedAt,willDarkAt,reveal,target};
}

function shapeRevealAll(){
  const clicks = Object.values(state.players)
    .filter(p=>p.click)
    .map(p=>({
      id:p.id, name:p.name,
      color:COLORS[p.colorIdx],
      x:p.click.x, y:p.click.y
    }));
  return { clicks, clickRadiusPct: state.round?.clickRadiusPct ?? 6 };
}

function startRound(cfg){
  // Reset Locks & Clicks
  for(const p of Object.values(state.players)){ p.locked=false; p.click=null; }

  state.round={
    id:newId(),
    title:cfg.title||null,
    imageUrl:cfg.imageUrl,
    visibleMs:Math.max(1000,Number(cfg.visibleMs||20000)),
    clickRadiusPct:Math.max(1,Number(cfg.clickRadiusPct||6)),
    target:cfg.target||{x:.5,y:.5,rPct:8},
    question:cfg.question||null,
    startedAt:now(),
    willDarkAt:now()+Math.max(1000,Number(cfg.visibleMs||20000)),
    reveal:false
  };

  io.emit('round:start', publicRoundShape());
  broadcastAdmin();
}

// ─────────────────────────────────────────────────────────────
const PORT=process.env.PORT||10000;
server.listen(PORT,()=>console.log('Server on :'+PORT));
