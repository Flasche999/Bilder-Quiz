// server.js – Bildklick‑Quiz (Neustart)
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

// State
const COLORS = ['#3b82f6','#eab308','#22c55e','#ef4444','#a855f7','#14b8a6','#f97316','#84cc16'];
let state = { players:{}, round:null, playlist:[], playlistIndex:-1 };

const newId=()=>Math.random().toString(36).slice(2,8);
const now=()=>Date.now();
const toAdmin=()=>io.to('admin');

function adminShape(){
  return {
    players:Object.values(state.players).map(p=>({id:p.id,name:p.name,score:p.score,color:COLORS[p.colorIdx%COLORS.length],locked:p.locked,click:p.click})),
    round:state.round, playlist:state.playlist, playlistIndex:state.playlistIndex
  };
}
function broadcastAdmin(){ toAdmin().emit('admin:state', adminShape()); }
function isHit(click,target){ if(!click||!target) return false;
  const dx=(click.x-target.x), dy=(click.y-target.y);
  const distPct=Math.sqrt(dx*dx+dy*dy)*100; return distPct<=target.rPct; }

io.on('connection',(socket)=>{
  const role=socket.handshake.query?.role||'player';
  if(role==='admin'){ socket.join('admin'); socket.emit('admin:state',adminShape());
    socket.on('admin:setPlaylist',(d,ack)=>{state.playlist=Array.isArray(d)?d:(d?.items||[]);state.playlistIndex=state.playlist.length?0:-1;broadcastAdmin();ack&&ack();});
    socket.on('admin:startFromPlaylist',(ack)=>{ if(state.playlistIndex<0) return;startRound(state.playlist[state.playlistIndex]);ack&&ack();});
    socket.on('admin:nextInPlaylist',(ack)=>{if(!state.playlist.length)return;state.playlistIndex=(state.playlistIndex+1)%state.playlist.length;startRound(state.playlist[state.playlistIndex]);ack&&ack();});
    socket.on('admin:startRound',(cfg,ack)=>{startRound(cfg);ack&&ack();});
    socket.on('admin:revealClicks',(_,ack)=>{ if(!state.round)return;state.round.reveal=true;io.emit('round:reveal',shapeReveal());broadcastAdmin();ack&&ack();});
    socket.on('admin:judge',(_,ack)=>{ if(!state.round)return;const winners=[];for(const p of Object.values(state.players)){if(isHit(p.click,state.round.target)){p.score=(p.score||0)+5;winners.push(p.id);}}io.emit('round:judged',{winners});broadcastAdmin();ack&&ack();});
    return; }
  // Player
  const id=socket.id;
  state.players[id]={id,name:`Spieler ${Object.keys(state.players).length}`,score:0,colorIdx:Object.keys(state.players).length%COLORS.length,locked:false,click:null};
  socket.emit('hello',{id,color:COLORS[state.players[id].colorIdx],round:publicRoundShape()});
  broadcastAdmin();
  socket.on('player:setName',(n)=>{state.players[id].name=String(n||'Spieler').slice(0,24);broadcastAdmin();});
  socket.on('player:click',({x,y})=>{const p=state.players[id];if(!state.round||!p)return;const t=now();if(t<state.round.willDarkAt)return;if(p.locked)return;p.click={x:Math.min(1,Math.max(0,x)),y:Math.min(1,Math.max(0,y))};p.locked=true;toAdmin().emit('admin:playerClick',{id:p.id,name:p.name,color:COLORS[p.colorIdx],click:p.click});});
  socket.on('disconnect',()=>{delete state.players[id];broadcastAdmin();});
});

function publicRoundShape(){if(!state.round)return null;const {id,title,imageUrl,visibleMs,clickRadiusPct,question,startedAt,willDarkAt,reveal,target}=state.round;return{id,title,imageUrl,visibleMs,clickRadiusPct,question,startedAt,willDarkAt,reveal,target};}
function shapeReveal(){const clicks=Object.values(state.players).filter(p=>p.click).map(p=>({id:p.id,name:p.name,color:COLORS[p.colorIdx],x:p.click.x,y:p.click.y}));return{clicks,clickRadiusPct:state.round?.clickRadiusPct??6};}
function startRound(cfg){for(const p of Object.values(state.players)){p.locked=false;p.click=null;}state.round={id:newId(),title:cfg.title||null,imageUrl:cfg.imageUrl,visibleMs:Math.max(1000,Number(cfg.visibleMs||20000)),clickRadiusPct:Math.max(1,Number(cfg.clickRadiusPct||6)),target:cfg.target||{x:.5,y:.5,rPct:8},question:cfg.question||null,startedAt:now(),willDarkAt:now()+Math.max(1000,Number(cfg.visibleMs||20000)),reveal:false};io.emit('round:start',publicRoundShape());broadcastAdmin();}
const PORT=process.env.PORT||10000;server.listen(PORT,()=>console.log('Server on :'+PORT));
