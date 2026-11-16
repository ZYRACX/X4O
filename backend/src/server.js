import crypto from 'node:crypto';
import http from 'node:http';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { createClient } from '@supabase/supabase-js';
import { Server } from 'socket.io';
import { applyMove } from './game.js';

const { SUPABASE_URL } = process.env;
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SECRET) throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY before starting the backend.');

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
const normalizeOrigin = origin => origin.trim().replace(/\/+$/, '');
const allowedOrigins = (process.env.WEB_ORIGIN || 'http://localhost:5173').split(',').map(value => normalizeOrigin(value)).filter(Boolean);
const appOrigin = normalizeOrigin(process.env.APP_ORIGIN || allowedOrigins[0] || 'http://localhost:5173');
const originAllowed = origin => !origin || allowedOrigins.includes('*') || allowedOrigins.includes(normalizeOrigin(origin));
const corsOrigin = (origin, callback) => {
  if (!origin || allowedOrigins.includes('*')) return callback(null, true);
  if (!originAllowed(origin)) return callback(new Error('Origin not allowed'));
  return callback(null, normalizeOrigin(origin));
};
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: corsOrigin } });

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '32kb' }));

const safeRoom = room => ({
  id: room.id, code: room.code, visibility: room.visibility, status: room.status,
  creatorName: room.creator_name, player1Name: room.player1_name, player2Name: room.player2_name,
  board: room.board, scores: room.scores, turn: room.turn, lastMove: room.last_move,
  winningCells: room.winning_cells || [], createdAt: room.created_at, expiresAt: room.expires_at,
});
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const newCode = () => crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
const cleanName = value => typeof value === 'string' ? value.trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 24) : '';
const roomSelect = 'id,code,visibility,status,creator_name,player1_name,player2_name,board,scores,turn,last_move,winning_cells,created_at,expires_at,player1_token_hash,player2_token_hash';
const matchmakingQueue = [];
const matchmakingPlayers = new Map();
const matchmakingPairs = new Map();

async function getRoom(id) {
  const { data, error } = await supabase.from('game_rooms').select(roomSelect).eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}
async function getSeat(room, token) {
  const digest = hashToken(token || '');
  if (room.player1_token_hash === digest) return 'X';
  if (room.player2_token_hash === digest) return 'O';
  return null;
}
async function requireVerifiedPlayer(req, res, next) {
  try {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return res.status(401).json({ error: 'Log in with a verified account to use matchmaking.' });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user?.email_confirmed_at) return res.status(403).json({ error: 'Verify your account email before using matchmaking.' });
    const { data: profile, error: profileError } = await supabase.from('player_profiles').select('username').eq('id', data.user.id).maybeSingle();
    if (profileError) throw profileError;
    if (!profile?.username) return res.status(403).json({ error: 'Your player profile is not ready for matchmaking.' });
    req.matchmakingPlayer = { id: data.user.id, username: profile.username };
    next();
  } catch (error) { next(error); }
}
const playerQueueState = id => matchmakingPlayers.get(id) || { state: 'idle' };
function removeFromQueue(id) {
  const index = matchmakingQueue.findIndex(player => player.id === id);
  if (index >= 0) matchmakingQueue.splice(index, 1);
}
function publicQueueState(id) {
  const state = playerQueueState(id);
  if (state.state === 'pairing') {
    const pair = matchmakingPairs.get(state.pairId);
    return { state: 'ready', deadline: pair?.deadline, ready: pair?.ready.has(id) || false, opponent: pair?.players.find(player => player.id !== id)?.username || 'Opponent' };
  }
  if (state.state === 'matched') return { state: 'matched', match: state.match };
  return { state: state.state };
}
function pairQueuedPlayers() {
  while (matchmakingQueue.length >= 2) {
    const players = [matchmakingQueue.shift(), matchmakingQueue.shift()];
    const pairId = crypto.randomUUID();
    const pair = { id: pairId, players, ready: new Set(), deadline: Date.now() + 10_000, status: 'ready', timer: null };
    matchmakingPairs.set(pairId, pair);
    players.forEach(player => matchmakingPlayers.set(player.id, { state: 'pairing', pairId }));
    pair.timer = setTimeout(() => {
      if (pair.status !== 'ready') return;
      pair.status = 'expired';
      for (const player of players) {
        if (pair.ready.has(player.id)) {
          matchmakingQueue.unshift(player);
          matchmakingPlayers.set(player.id, { state: 'waiting' });
        } else matchmakingPlayers.delete(player.id);
      }
      matchmakingPairs.delete(pair.id);
      pairQueuedPlayers();
    }, 10_000);
  }
}
async function startMatchedGame(pair) {
  pair.status = 'creating';
  clearTimeout(pair.timer);
  const [first, second] = pair.players;
  const firstToken = newToken(), secondToken = newToken();
  const game = {
    code: newCode(), visibility: 'private', status: 'playing', creator_name: first.username,
    player1_name: first.username, player2_name: second.username,
    player1_token_hash: hashToken(firstToken), player2_token_hash: hashToken(secondToken),
    board: Array(100).fill(null), scores: { X: 0, O: 0 }, turn: 'X', winning_cells: [], expires_at: null,
  };
  const { data, error } = await supabase.from('game_rooms').insert(game).select(roomSelect).single();
  if (error) {
    pair.status = 'error';
    pair.players.forEach(player => matchmakingPlayers.delete(player.id));
    matchmakingPairs.delete(pair.id);
    throw error;
  }
  const match = { room: safeRoom(data) };
  matchmakingPlayers.set(first.id, { state: 'matched', match: { ...match, seat: 'X', playerToken: firstToken } });
  matchmakingPlayers.set(second.id, { state: 'matched', match: { ...match, seat: 'O', playerToken: secondToken } });
  pair.status = 'matched';
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body?.password;
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–20 characters using letters, numbers, or underscores.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Password must be between 8 and 72 characters.' });
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { username }, emailRedirectTo: appOrigin } });
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json({ user: { id: data.user.id, email: data.user.email, username, verified: !!data.user.email_confirmed_at }, session: data.session, confirmationRequired: !data.session });
  } catch (error) { next(error); }
});
app.post('/api/auth/confirm', async (req, res, next) => {
  try {
    const access_token = req.body?.access_token;
    const refresh_token = req.body?.refresh_token;
    if (typeof access_token !== 'string' || typeof refresh_token !== 'string') return res.status(400).json({ error: 'Confirmation link is missing its session tokens.' });
    const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
    if (error) return res.status(401).json({ error: 'That confirmation link is invalid or expired. Request a new one and try again.' });
    res.json({ user: { id: data.user.id, email: data.user.email, username: data.user.user_metadata?.username || '', verified: !!data.user.email_confirmed_at }, session: data.session });
  } catch (error) { next(error); }
});
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = req.body?.password;
    if (!email || typeof password !== 'string') return res.status(400).json({ error: 'Enter your email and password.' });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });
    res.json({ user: { id: data.user.id, email: data.user.email, username: data.user.user_metadata?.username || '', verified: !!data.user.email_confirmed_at }, session: data.session });
  } catch (error) { next(error); }
});
app.post('/api/matchmaking/queue', requireVerifiedPlayer, (req, res) => {
  const player = req.matchmakingPlayer;
  const state = playerQueueState(player.id);
  if (state.state === 'matched') return res.json(publicQueueState(player.id));
  if (state.state !== 'waiting' && state.state !== 'pairing') {
    matchmakingQueue.push({ ...player, joinedAt: Date.now() });
    matchmakingPlayers.set(player.id, { state: 'waiting' });
    pairQueuedPlayers();
  }
  res.status(202).json(publicQueueState(player.id));
});
app.get('/api/matchmaking/status', requireVerifiedPlayer, (req, res) => res.json(publicQueueState(req.matchmakingPlayer.id)));
app.post('/api/matchmaking/ready', requireVerifiedPlayer, async (req, res, next) => {
  try {
    const playerId = req.matchmakingPlayer.id;
    const state = playerQueueState(playerId);
    if (state.state !== 'pairing') return res.status(409).json({ error: 'This ready check expired. Join the queue again.' });
    const pair = matchmakingPairs.get(state.pairId);
    if (!pair || pair.status !== 'ready' || Date.now() > pair.deadline) return res.status(409).json({ error: 'This ready check expired. Join the queue again.' });
    pair.ready.add(playerId);
    if (pair.ready.size === 2) await startMatchedGame(pair);
    res.json(publicQueueState(playerId));
  } catch (error) { next(error); }
});
app.post('/api/matchmaking/cancel', requireVerifiedPlayer, (req, res) => {
  const playerId = req.matchmakingPlayer.id;
  const state = playerQueueState(playerId);
  if (state.state === 'waiting') removeFromQueue(playerId);
  if (state.state === 'pairing') {
    const pair = matchmakingPairs.get(state.pairId);
    if (pair?.status === 'ready') {
      pair.status = 'cancelled'; clearTimeout(pair.timer); matchmakingPairs.delete(pair.id);
      const opponent = pair.players.find(player => player.id !== playerId);
      if (opponent && pair.ready.has(opponent.id)) {
        matchmakingQueue.unshift(opponent); matchmakingPlayers.set(opponent.id, { state: 'waiting' });
      } else if (opponent) matchmakingPlayers.delete(opponent.id);
      pairQueuedPlayers();
    }
  }
  if (state.state !== 'matched') matchmakingPlayers.delete(playerId);
  res.json({ state: 'idle' });
});
app.get('/api/rooms', async (_req, res, next) => {
  try {
    const { data, error } = await supabase.from('game_rooms')
      .select('id,code,creator_name,player1_name,visibility,status,created_at')
      .eq('visibility', 'public').eq('status', 'waiting').gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ rooms: data.map(room => ({ id: room.id, code: room.code, creatorName: room.creator_name, playerName: room.player1_name, visibility: room.visibility, createdAt: room.created_at })) });
  } catch (error) { next(error); }
});

app.post('/api/rooms', async (req, res, next) => {
  try {
    const creatorName = cleanName(req.body?.playerName);
    const visibility = req.body?.visibility;
    if (!creatorName) return res.status(400).json({ error: 'Enter a player name (up to 24 characters).' });
    if (!['public', 'private'].includes(visibility)) return res.status(400).json({ error: 'Choose a public or private room.' });
    const token = newToken();
    const room = {
      code: newCode(), visibility, status: 'waiting', creator_name: creatorName,
      player1_name: creatorName, player1_token_hash: hashToken(token),
      board: Array(100).fill(null), scores: { X: 0, O: 0 }, turn: 'X', winning_cells: [],
    };
    const { data, error } = await supabase.from('game_rooms').insert(room).select(roomSelect).single();
    if (error) throw error;
    res.status(201).json({ room: safeRoom(data), seat: 'X', playerToken: token });
  } catch (error) { next(error); }
});

app.post('/api/rooms/join', async (req, res, next) => {
  try {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
    const playerName = cleanName(req.body?.playerName);
    if (!/^[A-F0-9]{6}$/.test(code)) return res.status(400).json({ error: 'Enter a valid six-character room code.' });
    if (!playerName) return res.status(400).json({ error: 'Enter a player name (up to 24 characters).' });
    const { data: room, error: findError } = await supabase.from('game_rooms').select(roomSelect).eq('code', code).maybeSingle();
    if (findError) throw findError;
    if (!room || room.status !== 'waiting' || room.player2_token_hash || new Date(room.expires_at) <= new Date()) return res.status(409).json({ error: 'That room is not available. It may have started or closed.' });
    const token = newToken();
    const { data, error } = await supabase.from('game_rooms').update({
      player2_name: playerName, player2_token_hash: hashToken(token), status: 'playing', expires_at: null, updated_at: new Date().toISOString(),
    }).eq('id', room.id).eq('status', 'waiting').is('player2_token_hash', null).select(roomSelect).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'Another player just joined this room. Choose another room.' });
    io.to(data.id).emit('room:updated', { room: safeRoom(data) });
    res.json({ room: safeRoom(data), seat: 'O', playerToken: token });
  } catch (error) { next(error); }
});

app.post('/api/rooms/:id/rejoin', async (req, res, next) => {
  try {
    const token = req.body?.playerToken;
    if (typeof token !== 'string' || token.length < 20) return res.status(401).json({ error: 'A valid player token is required.' });
    const room = await getRoom(req.params.id);
    if (!room || (room.expires_at && new Date(room.expires_at) <= new Date())) return res.status(404).json({ error: 'Room not found or expired.' });
    const seat = await getSeat(room, token);
    if (!seat) return res.status(401).json({ error: 'That token is not a player in this room.' });
    res.json({ room: safeRoom(room), seat });
  } catch (error) { next(error); }
});

io.on('connection', socket => {
  socket.on('room:join', async ({ roomId, playerToken } = {}) => {
    try {
      const room = await getRoom(roomId);
      if (!room) return socket.emit('room:error', { error: 'Room not found.' });
      const seat = await getSeat(room, playerToken);
      if (!seat) return socket.emit('room:error', { error: 'This device is not a player in this room.' });
      socket.data.roomId = room.id; socket.data.seat = seat;
      await socket.join(room.id);
      socket.emit('room:state', { room: safeRoom(room), seat });
    } catch (error) { socket.emit('room:error', { error: 'Could not connect to the room.' }); }
  });

  socket.on('room:move', async ({ index } = {}) => {
    try {
      const { roomId, seat } = socket.data;
      if (!roomId || !seat) return socket.emit('room:error', { error: 'Join a room before playing.' });
      const room = await getRoom(roomId);
      if (!room) return socket.emit('room:error', { error: 'Room not found.' });
      const update = applyMove(room, index, seat);
      const expiresAt = update.status === 'finished' ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : undefined;
      const { data, error } = await supabase.from('game_rooms').update({ ...update, ...(expiresAt ? { expires_at: expiresAt } : {}), updated_at: new Date().toISOString() })
        .eq('id', roomId).eq('status', 'playing').eq('turn', seat).select(roomSelect).maybeSingle();
      if (error) throw error;
      if (!data) return socket.emit('room:error', { error: 'The board changed. Wait for the latest turn.' });
      io.to(roomId).emit('room:updated', { room: safeRoom(data) });
    } catch (error) { socket.emit('room:error', { error: error.message || 'Move could not be saved.' }); }
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'The online game service encountered an error.' });
});

const port = Number(process.env.PORT || 3001);
server.listen(port, '0.0.0.0', () => console.log(`Fourfold backend listening on ${port}`));
