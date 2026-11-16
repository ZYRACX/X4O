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
const adminEmails = new Set((process.env.ADMIN_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
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
  winningCells: room.winning_cells || [], winnerSeat: room.winner_seat || null, createdAt: room.created_at, expiresAt: room.expires_at,
});
const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const newCode = () => crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase();
const cleanName = value => typeof value === 'string' ? value.trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 24) : '';
const roomPlayerName = (name, isGuest) => isGuest ? `G ${name}` : name;
const comparablePlayerName = name => String(name || '').replace(/^G\s+/i, '').trim().toLocaleLowerCase();
const roomSelect = 'id,code,visibility,status,creator_name,player1_name,player2_name,board,scores,turn,last_move,winning_cells,winner_seat,created_at,expires_at,player1_token_hash,player2_token_hash';
const matchmakingQueues = { verified: [], unverified: [] };
const matchmakingPlayers = new Map();
const matchmakingPairs = new Map();
const matchmakingTickets = new Map();
const activeRoomConnections = new Map();
const disconnectTimers = new Map();
const disconnectGraceMs = 10_000;
const activePresenceMs = 90_000;

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
const connectionKey = (roomId, seat) => `${roomId}:${seat}`;
async function forfeitRoom(roomId, leavingSeat) {
  const key = connectionKey(roomId, leavingSeat);
  clearTimeout(disconnectTimers.get(key)); disconnectTimers.delete(key);
  const room = await getRoom(roomId);
  if (!room || room.status !== 'playing') return room;
  const winnerSeat = leavingSeat === 'X' ? 'O' : 'X';
  const { data, error } = await supabase.from('game_rooms').update({
    status: 'finished', winner_seat: winnerSeat,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', roomId).eq('status', 'playing').select(roomSelect).maybeSingle();
  if (error) throw error;
  const finishedRoom = data || await getRoom(roomId);
  if (data) io.to(roomId).emit('room:updated', { room: safeRoom(data) });
  return finishedRoom;
}
async function requireMatchmakingPlayer(req, res, next) {
  try {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (token) {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data.user) {
        const { data: profile, error: profileError } = await supabase.from('player_profiles').select('username').eq('id', data.user.id).maybeSingle();
        if (profileError) throw profileError;
        if (!profile?.username) return res.status(403).json({ error: 'Your player profile is not ready for matchmaking.' });
        req.matchmakingPlayer = { id: data.user.id, username: profile.username, verified: !!data.user.email_confirmed_at };
        return next();
      }
    }
    const rawTicket = req.headers['x-queue-ticket'];
    const ticket = typeof rawTicket === 'string' ? matchmakingTickets.get(hashToken(rawTicket)) : null;
    if (!ticket || ticket.expiresAt <= Date.now()) {
      if (typeof rawTicket === 'string') matchmakingTickets.delete(hashToken(rawTicket));
      return res.status(401).json({ error: 'Log in to your account to use matchmaking. New unverified accounts can queue from this device after registering.' });
    }
    req.matchmakingPlayer = { id: ticket.id, username: ticket.username, verified: false };
    next();
  } catch (error) { next(error); }
}
async function requireAdmin(req, res, next) {
  try {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return res.status(401).json({ error: 'Log in with an admin account.' });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Your session is invalid. Log in again.' });
    if (!adminEmails.has((data.user.email || '').toLowerCase())) return res.status(403).json({ error: 'Admin access is not enabled for this account.' });
    req.adminUser = data.user;
    next();
  } catch (error) { next(error); }
}
function adminAccount(user, profile) {
  return { id: user.id, email: user.email, username: profile?.username || user.user_metadata?.username || '', createdAt: user.created_at, lastSignInAt: user.last_sign_in_at, verified: !!user.email_confirmed_at, suspended: !!user.banned_until && new Date(user.banned_until) > new Date() };
}
const playerQueueState = id => matchmakingPlayers.get(id) || { state: 'idle' };
function removeFromQueue(id) {
  for (const queue of Object.values(matchmakingQueues)) {
    const index = queue.findIndex(player => player.id === id);
    if (index >= 0) queue.splice(index, 1);
  }
}
function publicQueueState(id) {
  const state = playerQueueState(id);
  if (state.state === 'pairing') {
    const pair = matchmakingPairs.get(state.pairId);
    return { state: 'ready', queue: pair?.group, waitingPlayers: pair ? matchmakingQueues[pair.group].length : 0, deadline: pair?.deadline, ready: pair?.ready.has(id) || false, opponent: pair?.players.find(player => player.id !== id)?.username || 'Opponent' };
  }
  if (state.state === 'matched') return { state: 'matched', queue: state.queue, waitingPlayers: matchmakingQueues[state.queue]?.length || 0, match: state.match };
  const group = state.verified === false ? 'unverified' : 'verified';
  return { state: state.state, queue: group, waitingPlayers: matchmakingQueues[group].length };
}
function pairQueuedPlayers(group) {
  const queue = matchmakingQueues[group];
  while (queue.length >= 2) {
    const players = [queue.shift(), queue.shift()];
    const pairId = crypto.randomUUID();
    const pair = { id: pairId, group, players, ready: new Set(), deadline: Date.now() + 10_000, status: 'ready', timer: null };
    matchmakingPairs.set(pairId, pair);
    players.forEach(player => matchmakingPlayers.set(player.id, { state: 'pairing', pairId }));
    pair.timer = setTimeout(() => {
      if (pair.status !== 'ready') return;
      pair.status = 'expired';
      for (const player of players) {
        if (pair.ready.has(player.id)) {
          matchmakingQueues[group].unshift(player);
          matchmakingPlayers.set(player.id, { state: 'waiting', verified: player.verified });
        } else matchmakingPlayers.set(player.id, { state: 'idle', verified: player.verified });
      }
      matchmakingPairs.delete(pair.id);
      pairQueuedPlayers(group);
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
    pair.players.forEach(player => matchmakingPlayers.set(player.id, { state: 'idle', verified: player.verified }));
    matchmakingPairs.delete(pair.id);
    throw error;
  }
  const match = { room: safeRoom(data) };
  matchmakingPlayers.set(first.id, { state: 'matched', queue: pair.group, match: { ...match, seat: 'X', playerToken: firstToken } });
  matchmakingPlayers.set(second.id, { state: 'matched', queue: pair.group, match: { ...match, seat: 'O', playerToken: secondToken } });
  pair.status = 'matched';
}

app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/api/presence', async (req, res, next) => {
  try {
    let accountId = null;
    const token = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (token) {
      const { data } = await supabase.auth.getUser(token);
      if (data.user) accountId = data.user.id;
    }
    const rawTicket = req.headers['x-queue-ticket'];
    const ticket = !accountId && typeof rawTicket === 'string' ? matchmakingTickets.get(hashToken(rawTicket)) : null;
    if (ticket?.expiresAt > Date.now()) accountId = ticket.id;
    const guestId = typeof req.body?.guestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.body.guestId) ? req.body.guestId : null;
    if (!accountId && !guestId) return res.status(400).json({ error: 'A valid guest identifier is required.' });
    if (accountId && guestId) await supabase.from('player_presence').delete().eq('id', `guest:${guestId}`);
    const identity = accountId ? `account:${accountId}` : `guest:${guestId}`;
    const { error } = await supabase.from('player_presence').upsert({
      id: identity, account_id: accountId, guest_id: accountId ? null : guestId, last_seen: new Date().toISOString(),
    });
    if (error) throw error;
    // Occasionally prune old guest rows so a long-lived hobby deployment stays small.
    if (Math.random() < 0.01) await supabase.from('player_presence').delete().lt('last_seen', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.get('/api/stats', async (_req, res, next) => {
  try {
    const activeSince = new Date(Date.now() - activePresenceMs).toISOString();
    const [profiles, activeAccounts, activeGuests] = await Promise.all([
      supabase.from('player_profiles').select('id', { count: 'exact', head: true }),
      supabase.from('player_presence').select('id', { count: 'exact', head: true }).not('account_id', 'is', null).gt('last_seen', activeSince),
      supabase.from('player_presence').select('id', { count: 'exact', head: true }).not('guest_id', 'is', null).gt('last_seen', activeSince),
    ]);
    for (const result of [profiles, activeAccounts, activeGuests]) if (result.error) throw result.error;
    res.json({
      totalPlayers: profiles.count || 0,
      activeAccounts: activeAccounts.count || 0,
      guestPlayers: activeGuests.count || 0,
    });
  } catch (error) { next(error); }
});
app.get('/api/admin/me', requireAdmin, (_req, res) => res.json({ admin: true }));
app.get('/api/admin/accounts', requireAdmin, async (req, res, next) => {
  try {
    let page = 1, users = [];
    while (true) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 100 });
      if (error) throw error;
      users = users.concat(data.users);
      if (data.users.length < 100) break;
      page++;
    }
    const ids = users.map(user => user.id);
    const { data: profiles, error: profileError } = ids.length ? await supabase.from('player_profiles').select('id,username,created_at').in('id', ids) : { data: [], error: null };
    if (profileError) throw profileError;
    const profileById = new Map((profiles || []).map(profile => [profile.id, profile]));
    res.json({ accounts: users.map(user => adminAccount(user, profileById.get(user.id))), total: users.length });
  } catch (error) { next(error); }
});
app.patch('/api/admin/accounts/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = req.params.id;
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–20 characters using letters, numbers, or underscores.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
    const { data: oldProfile, error: lookupError } = await supabase.from('player_profiles').select('id,username').eq('id', id).maybeSingle();
    if (lookupError) throw lookupError;
    if (!oldProfile) return res.status(404).json({ error: 'Account profile not found.' });
    const { data: profile, error: profileError } = await supabase.from('player_profiles').update({ username }).eq('id', id).select('id,username').maybeSingle();
    if (profileError) throw profileError;
    if (!profile) return res.status(404).json({ error: 'Account profile not found.' });
    const { data, error } = await supabase.auth.admin.updateUserById(id, { email, user_metadata: { username } });
    if (error) { await supabase.from('player_profiles').update({ username: oldProfile.username }).eq('id', id); throw error; }
    res.json({ account: adminAccount(data.user, profile) });
  } catch (error) { next(error); }
});
app.post('/api/admin/accounts/:id/suspend', requireAdmin, async (req, res, next) => {
  try {
    if (req.params.id === req.adminUser.id) return res.status(400).json({ error: 'You cannot suspend your own admin account.' });
    const suspend = req.body?.suspended === true;
    const { data, error } = await supabase.auth.admin.updateUserById(req.params.id, { ban_duration: suspend ? '876000h' : 'none' });
    if (error) throw error;
    const { data: profile } = await supabase.from('player_profiles').select('id,username').eq('id', req.params.id).maybeSingle();
    res.json({ account: adminAccount(data.user, profile) });
  } catch (error) { next(error); }
});
app.delete('/api/admin/accounts/:id', requireAdmin, async (req, res, next) => {
  try {
    if (req.params.id === req.adminUser.id) return res.status(400).json({ error: 'You cannot delete your own admin account.' });
    const { error } = await supabase.auth.admin.deleteUser(req.params.id);
    if (error) throw error;
    res.json({ deleted: true, id: req.params.id });
  } catch (error) { next(error); }
});
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
    let queueTicket;
    if (!data.user.email_confirmed_at && data.user.identities?.length) {
      const { data: profile, error: profileError } = await supabase.from('player_profiles').select('username').eq('id', data.user.id).maybeSingle();
      if (profileError) throw profileError;
      if (profile?.username) {
        queueTicket = newToken();
        matchmakingTickets.set(hashToken(queueTicket), { id: data.user.id, username: profile.username, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
      }
    }
    res.status(201).json({ user: { id: data.user.id, email: data.user.email, username, verified: !!data.user.email_confirmed_at }, session: data.session, queueTicket, confirmationRequired: !data.session });
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
app.post('/api/matchmaking/queue', requireMatchmakingPlayer, (req, res) => {
  const player = req.matchmakingPlayer;
  const state = playerQueueState(player.id);
  if (state.state === 'matched') return res.json(publicQueueState(player.id));
  if (state.state !== 'waiting' && state.state !== 'pairing') {
    const group = player.verified ? 'verified' : 'unverified';
    matchmakingQueues[group].push({ ...player, joinedAt: Date.now() });
    matchmakingPlayers.set(player.id, { state: 'waiting', verified: player.verified });
    pairQueuedPlayers(group);
  }
  res.status(202).json(publicQueueState(player.id));
});
app.get('/api/matchmaking/status', requireMatchmakingPlayer, (req, res) => res.json(publicQueueState(req.matchmakingPlayer.id)));
app.post('/api/matchmaking/ready', requireMatchmakingPlayer, async (req, res, next) => {
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
app.post('/api/matchmaking/cancel', requireMatchmakingPlayer, (req, res) => {
  const playerId = req.matchmakingPlayer.id;
  const state = playerQueueState(playerId);
  if (state.state === 'waiting') removeFromQueue(playerId);
  if (state.state === 'pairing') {
    const pair = matchmakingPairs.get(state.pairId);
    if (pair?.status === 'ready') {
      pair.status = 'cancelled'; clearTimeout(pair.timer); matchmakingPairs.delete(pair.id);
      const opponent = pair.players.find(player => player.id !== playerId);
      if (opponent && pair.ready.has(opponent.id)) {
        const group = opponent.verified ? 'verified' : 'unverified';
        matchmakingQueues[group].unshift(opponent); matchmakingPlayers.set(opponent.id, { state: 'waiting', verified: opponent.verified });
      } else if (opponent) matchmakingPlayers.set(opponent.id, { state: 'idle', verified: opponent.verified });
      pairQueuedPlayers(pair.group);
    }
  }
  if (state.state !== 'matched') matchmakingPlayers.set(playerId, { state: 'idle', verified: state.verified ?? req.matchmakingPlayer.verified });
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
    const creatorDisplayName = cleanName(req.body?.playerName);
    const creatorName = roomPlayerName(creatorDisplayName, req.body?.isGuest === true);
    const visibility = req.body?.visibility;
    if (!creatorDisplayName) return res.status(400).json({ error: 'Enter a player name (up to 24 characters).' });
    if (!['public', 'private'].includes(visibility)) return res.status(400).json({ error: 'Choose a public or private room.' });
    const token = newToken();
    const room = {
      code: newCode(), visibility, status: 'waiting', creator_name: creatorName,
      player1_name: creatorName, player1_token_hash: hashToken(token),
      board: Array(100).fill(null), scores: { X: 0, O: 0 }, turn: 'X', winning_cells: [],
    };
    const { data, error } = await supabase.from('game_rooms').insert(room).select(roomSelect).single();
    if (error) {
      if (error.code === '42703' || error.code === 'PGRST204') {
        console.error('Room creation failed because the game_rooms schema is out of date:', error);
        return res.status(503).json({ error: 'Room service needs a database schema update. Run backend/supabase/migrate_room_schema.sql in the Supabase SQL Editor, then try again.' });
      }
      throw error;
    }
    res.status(201).json({ room: safeRoom(data), seat: 'X', playerToken: token });
  } catch (error) { next(error); }
});

app.post('/api/rooms/join', async (req, res, next) => {
  try {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
    const playerDisplayName = cleanName(req.body?.playerName);
    const playerName = roomPlayerName(playerDisplayName, req.body?.isGuest === true);
    if (!/^[A-F0-9]{6}$/.test(code)) return res.status(400).json({ error: 'Enter a valid six-character room code.' });
    if (!playerDisplayName) return res.status(400).json({ error: 'Enter a player name (up to 24 characters).' });
    const { data: room, error: findError } = await supabase.from('game_rooms').select(roomSelect).eq('code', code).maybeSingle();
    if (findError) throw findError;
    if (!room || room.status !== 'waiting' || room.player2_token_hash || new Date(room.expires_at) <= new Date()) return res.status(409).json({ error: 'That room is not available. It may have started or closed.' });
    if (comparablePlayerName(playerDisplayName) === comparablePlayerName(room.player1_name)) {
      return res.status(409).json({ error: 'That username is already taken in this room. Choose a different name to join.' });
    }
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

app.post('/api/rooms/:id/leave', async (req, res, next) => {
  try {
    const token = req.body?.playerToken;
    if (typeof token !== 'string' || token.length < 20) return res.status(401).json({ error: 'A valid player token is required.' });
    const room = await getRoom(req.params.id);
    const seat = room && await getSeat(room, token);
    if (!room || !seat) return res.status(401).json({ error: 'That token is not a player in this room.' });
    const finishedRoom = await forfeitRoom(room.id, seat);
    res.json({ room: safeRoom(finishedRoom), forfeited: finishedRoom?.winner_seat === (seat === 'X' ? 'O' : 'X') });
  } catch (error) { next(error); }
});

io.on('connection', socket => {
  socket.on('room:join', async ({ roomId, playerToken } = {}) => {
    try {
      const room = await getRoom(roomId);
      if (!room) return socket.emit('room:error', { error: 'Room not found.' });
      const seat = await getSeat(room, playerToken);
      if (!seat) return socket.emit('room:error', { error: 'This device is not a player in this room.' });
      const key = connectionKey(room.id, seat);
      clearTimeout(disconnectTimers.get(key)); disconnectTimers.delete(key);
      const connections = activeRoomConnections.get(key) || new Set();
      connections.add(socket.id); activeRoomConnections.set(key, connections);
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

  socket.on('disconnect', () => {
    const { roomId, seat } = socket.data;
    if (!roomId || !seat) return;
    const key = connectionKey(roomId, seat);
    const connections = activeRoomConnections.get(key);
    connections?.delete(socket.id);
    if (connections?.size) return;
    activeRoomConnections.delete(key);
    clearTimeout(disconnectTimers.get(key));
    const timeout = setTimeout(() => {
      disconnectTimers.delete(key);
      if (activeRoomConnections.get(key)?.size) return;
      forfeitRoom(roomId, seat).catch(error => console.error('Could not record disconnect forfeit:', error));
    }, disconnectGraceMs);
    disconnectTimers.set(key, timeout);
  });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'The online game service encountered an error.' });
});

const port = Number(process.env.PORT || 3001);
server.listen(port, '0.0.0.0', () => console.log(`X4O backend listening on ${port}`));
