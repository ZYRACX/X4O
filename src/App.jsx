import React, { useCallback, useEffect, useRef, useState } from 'react';

const SIZE = 10;
const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const emptyBoard = () => Array(SIZE * SIZE).fill(null);
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const ONLINE_SESSION_KEY = 'fourfold-online-session';
const GUEST_NAME_KEY = 'fourfold-guest-display-name';
let socketClientPromise;

function loadSocketClient() {
  if (window.io) return Promise.resolve(window.io);
  if (!socketClientPromise) socketClientPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${API_BASE}/socket.io/socket.io.js`;
    script.async = true;
    script.onload = () => {
      if (window.io) resolve(window.io);
      else { socketClientPromise = null; reject(new Error('Online client did not load.')); }
    };
    script.onerror = () => { socketClientPromise = null; reject(new Error('Could not load the online game client.')); };
    document.head.appendChild(script);
  });
  return socketClientPromise;
}

async function readApiResponse(response) {
  let data;
  try { data = await response.json(); }
  catch { throw new Error('Online service is unreachable. Check VITE_API_URL and make sure the backend is running.'); }
  if (!response.ok) throw new Error(data.error || 'Online request failed.');
  return data;
}

function matchmakingAuthHeaders() {
  try {
    const saved = JSON.parse(localStorage.getItem('fourfold-account') || 'null');
    if (saved?.session?.access_token) return { Authorization: `Bearer ${saved.session.access_token}` };
    if (saved?.queueTicket) return { 'X-Queue-Ticket': saved.queueTicket };
  } catch { /* A missing local account simply means the player needs to log in. */ }
  return {};
}

function guestPresenceId() {
  const key = 'fourfold-presence-id';
  let id = '';
  try { id = localStorage.getItem(key) || ''; } catch { /* Storage may be unavailable in private browsing. */ }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    id = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
        const value = Math.random() * 16 | 0;
        return (char === 'x' ? value : (value & 3 | 8)).toString(16);
      });
    try { localStorage.setItem(key, id); } catch { /* The generated ID still works for this heartbeat. */ }
  }
  return id;
}

function scoreMove(board, index, mark) {
  const row = Math.floor(index / SIZE), col = index % SIZE;
  const lines = [];
  for (const [dr, dc] of DIRECTIONS) {
    const cells = [index];
    for (const sign of [-1, 1]) {
      let r = row + dr * sign, c = col + dc * sign;
      while (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r * SIZE + c] === mark) {
        cells.push(r * SIZE + c); r += dr * sign; c += dc * sign;
      }
    }
    if (cells.length >= 4) lines.push(cells);
  }
  return lines;
}

function countPotential(board, index, mark, target = 4) {
  const row = Math.floor(index / SIZE), col = index % SIZE;
  let value = 0;
  for (const [dr, dc] of DIRECTIONS) {
    let count = 1, open = 0;
    for (const sign of [-1, 1]) {
      let r = row + dr * sign, c = col + dc * sign;
      while (r >= 0 && r < SIZE && c >= 0 && c < SIZE) {
        const cell = board[r * SIZE + c];
        if (cell === mark) { count++; r += dr * sign; c += dc * sign; }
        else { if (cell === null) open++; break; }
      }
    }
    if (count >= target) value += 10000;
    else if (count + open >= target) value += Math.pow(count, 3) * (open === 2 ? 1.5 : 1);
  }
  return value;
}

function AdminPanel({ onBack }) {
  const [accounts, setAccounts] = useState([]), [query, setQuery] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [editing, setEditing] = useState(null);
  const adminHeaders = () => {
    const saved = JSON.parse(localStorage.getItem('fourfold-account') || 'null');
    return { Authorization: `Bearer ${saved?.session?.access_token || ''}`, 'Content-Type': 'application/json' };
  };
  const load = async () => {
    setBusy(true); setError('');
    try { const data = await readApiResponse(await fetch(`${API_BASE}/api/admin/accounts`, { headers: adminHeaders() })); setAccounts(data.accounts || []); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  useEffect(() => { load(); }, []);
  const update = async (path, options, success) => {
    setBusy(true); setError(''); setNotice('');
    try { await readApiResponse(await fetch(`${API_BASE}${path}`, { ...options, headers: adminHeaders() })); setNotice(success); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const filtered = accounts.filter(account => `${account.username} ${account.email} ${account.id}`.toLowerCase().includes(query.toLowerCase()));
  return <main className="app-shell admin-shell">
    <header className="topbar"><a className="brand" href="#top"><span className="brand-mark">X4O</span><span>X4O</span></a><button className="home-button" onClick={onBack}>← Back to game</button></header>
    <section className="admin-content">
      <div className="admin-heading"><div><div className="eyebrow"><span className="live-dot" /> ADMINISTRATION</div><h1>Accounts<span>.</span></h1><p>Review player details and manage account access.</p></div><button className="secondary-action" onClick={load} disabled={busy}>↻ Refresh</button></div>
      <div className="admin-summary"><div><small>TOTAL ACCOUNTS</small><strong>{accounts.length}</strong></div><div><small>VERIFIED</small><strong>{accounts.filter(a => a.verified).length}</strong></div><div><small>SUSPENDED</small><strong>{accounts.filter(a => a.suspended).length}</strong></div></div>
      <label className="admin-search"><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search username, email, or account ID" /></label>
      {error && <p className="account-error" role="alert">{error}</p>}{notice && <p className="account-notice" role="status">{notice}</p>}
      <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>PLAYER</th><th>STATUS</th><th>JOINED</th><th>LAST ACTIVE</th><th>ACTIONS</th></tr></thead><tbody>
        {filtered.map(account => <tr key={account.id}><td><div className="admin-player"><span className="room-avatar">{(account.username || '?')[0].toUpperCase()}</span><span><strong>{account.username || 'No username'}</strong><small>{account.email}</small></span></div></td><td><span className={`admin-status ${account.suspended ? 'suspended' : 'active-status'}`}>{account.suspended ? 'Suspended' : 'Active'}</span><small className="verified-mark">{account.verified ? 'Verified' : 'Unverified'}</small></td><td>{account.createdAt ? new Date(account.createdAt).toLocaleDateString() : '—'}</td><td>{account.lastSignInAt ? new Date(account.lastSignInAt).toLocaleDateString() : 'Never'}</td><td><div className="admin-actions"><button onClick={() => setEditing(account)}>Edit</button><button onClick={() => { if (window.confirm(`${account.suspended ? 'Restore' : 'Suspend'} ${account.username}'s account?`)) update(`/api/admin/accounts/${account.id}/suspend`, { method: 'POST', body: JSON.stringify({ suspended: !account.suspended }) }, `Account ${account.suspended ? 'restored' : 'suspended'}.`); }} disabled={busy}>{account.suspended ? 'Restore' : 'Suspend'}</button><button className="delete-action" onClick={() => { if (window.confirm(`Permanently delete ${account.username} (${account.email})? This cannot be undone.`)) update(`/api/admin/accounts/${account.id}`, { method: 'DELETE' }, 'Account deleted.'); }} disabled={busy}>Delete</button></div></td></tr>)}
        {!filtered.length && <tr><td colSpan="5" className="admin-empty">{busy ? 'Loading accounts…' : 'No accounts match this search.'}</td></tr>}
      </tbody></table></div>
    </section>
    {editing && <div className="account-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setEditing(null); }}><section className="account-dialog" role="dialog" aria-modal="true"><button className="account-close" onClick={() => setEditing(null)} aria-label="Close">×</button><div className="eyebrow"><span className="live-dot" /> EDIT PLAYER</div><h2>Update account.</h2><p>Changes to email may require the player to confirm their new address.</p><form className="account-form" onSubmit={async e => { e.preventDefault(); const form = new FormData(e.currentTarget); await update(`/api/admin/accounts/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ username: form.get('username'), email: form.get('email') }) }, 'Account details updated.'); setEditing(null); }}><label>USERNAME<input name="username" defaultValue={editing.username} required minLength="3" maxLength="20" pattern="[A-Za-z0-9_]+" /></label><label>EMAIL<input name="email" type="email" defaultValue={editing.email} required /></label><button className="start-button" disabled={busy}>Save changes <span>→</span></button></form></section></div>}
  </main>;
}

function scoreBotMoves(board) {
  const available = board.map((v, i) => v === null ? i : -1).filter(i => i >= 0);
  if (available.length === SIZE * SIZE) return [{ index: 44, ownScore: 0, blockScore: 0, score: 0 }];
  return available.map(i => {
    const after = [...board]; after[i] = 'O';
    const ownScore = scoreMove(after, i, 'O').length;
    const blockBoard = [...board]; blockBoard[i] = 'X';
    const blockScore = scoreMove(blockBoard, i, 'X').length;
    const ownPotential = countPotential(board, i, 'O');
    const blockPotential = countPotential(board, i, 'X');
    const row = Math.floor(i / SIZE), col = i % SIZE;
    const nearby = DIRECTIONS.reduce((sum, [dr, dc]) => {
      for (const sign of [-1, 1]) {
        const r = row + dr * sign, c = col + dc * sign;
        if (r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r * SIZE + c]) sum++;
      }
      return sum;
    }, 0);
    const center = 9 - (Math.abs(row - 4.5) + Math.abs(col - 4.5));
    const score = ownScore * 100000 + blockScore * 80000 + ownPotential * 1.1 + blockPotential * 0.95 + nearby * 0.8 + center * 0.12 + Math.random() * 0.2;
    return { index: i, ownScore, blockScore, score };
  });
}

function chooseBotMove(board, difficulty) {
  const candidates = scoreBotMoves(board);
  const highestRated = moves => moves.reduce((best, move) => move.score > best.score ? move : best).index;

  if (difficulty === 'Medium') {
    // Medium still scores immediate points, but sometimes overlooks a direct block
    // so the player gets an opening to complete their line on the next turn.
    const canScore = candidates.some(move => move.ownScore > 0);
    const canBlock = candidates.some(move => move.blockScore > 0);
    if (!canScore && canBlock && Math.random() < 0.25) {
      const nonBlockingMoves = candidates.filter(move => move.blockScore === 0);
      if (nonBlockingMoves.length) return highestRated(nonBlockingMoves);
    }
  }

  // Hard uses the full greedy score: immediate scoring, blocking, and line setup.
  return highestRated(candidates);
}

function App() {
  const [board, setBoard] = useState(emptyBoard);
  const [scores, setScores] = useState({ X: 0, O: 0 });
  const [turn, setTurn] = useState('X');
  const [status, setStatus] = useState('playing');
  const [lastMove, setLastMove] = useState(null);
  const [highlight, setHighlight] = useState([]);
  const [difficulty, setDifficulty] = useState('Medium');
  const [sound, setSound] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [mode, setMode] = useState('PvE');
  const [screen, setScreen] = useState('home');
  const [isAdmin, setIsAdmin] = useState(false);
  const [playerName, setPlayerName] = useState(() => localStorage.getItem(GUEST_NAME_KEY) || '');
  const [guestNameLocked, setGuestNameLocked] = useState(() => localStorage.getItem(GUEST_NAME_KEY) !== null);
  const [account, setAccount] = useState(() => { try { return JSON.parse(localStorage.getItem('fourfold-account') || 'null')?.user || null; } catch { return null; } });
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountMode, setAccountMode] = useState('register');
  const [accountError, setAccountError] = useState('');
  const [accountNotice, setAccountNotice] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [roomVisibility, setRoomVisibility] = useState('private');
  const [joinCode, setJoinCode] = useState('');
  const [publicRooms, setPublicRooms] = useState([]);
  const [lobbyLoading, setLobbyLoading] = useState(false);
  const [onlineMessage, setOnlineMessage] = useState('');
  const [onlineRoom, setOnlineRoom] = useState(null);
  const [onlineSeat, setOnlineSeat] = useState(null);
  const [onlineToken, setOnlineToken] = useState(null);
  const [connectionState, setConnectionState] = useState('');
  const [queueState, setQueueState] = useState({ state: 'idle' });
  const [queueError, setQueueError] = useState('');
  const [queueStartedAt, setQueueStartedAt] = useState(null);
  const [queueClock, setQueueClock] = useState(Date.now());
  const [liveStats, setLiveStats] = useState(null);
  const lastQueueState = useRef('idle');
  const timer = useRef();
  const audio = useRef(null);
  const socketRef = useRef(null);

  useEffect(() => {
    let alive = true;
    const refreshStats = async () => {
      try {
        try {
          await fetch(`${API_BASE}/api/presence`, {
            method: 'POST', headers: { ...matchmakingAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ guestId: guestPresenceId() }),
          });
        } catch { /* Presence is only used for counts; stats and gameplay can continue without it. */ }
        const response = await fetch(`${API_BASE}/api/stats`);
        const data = await readApiResponse(response);
        if (alive) setLiveStats(data);
      } catch { /* Counts stay on their last successful snapshot while the API wakes or reconnects. */ }
    };
    refreshStats();
    const interval = window.setInterval(refreshStats, 30_000);
    return () => { alive = false; window.clearInterval(interval); };
  }, [account?.id]);

  useEffect(() => {
    let alive = true;
    const token = (() => { try { return JSON.parse(localStorage.getItem('fourfold-account') || 'null')?.session?.access_token; } catch { return null; } })();
    if (!token) { setIsAdmin(false); return () => { alive = false; }; }
    fetch(`${API_BASE}/api/admin/me`, { headers: { Authorization: `Bearer ${token}` } }).then(response => { if (alive) setIsAdmin(response.ok); }).catch(() => { if (alive) setIsAdmin(false); });
    return () => { alive = false; };
  }, [account?.id]);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const access_token = hash.get('access_token');
    const refresh_token = hash.get('refresh_token');
    if (!access_token || !refresh_token) return;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    fetch(`${API_BASE}/api/auth/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token, refresh_token }) })
      .then(readApiResponse)
      .then(data => {
        localStorage.setItem('fourfold-account', JSON.stringify({ user: data.user, session: data.session }));
        setAccount(data.user); setPlayerName(data.user.username);
      })
      .catch(error => { setAccountError(error.message); setAccountMode('login'); setAccountOpen(true); });
  }, []);

  const acceptOnlineSession = useCallback(({ room, seat, playerToken }) => {
    setOnlineRoom(room); setOnlineSeat(seat); setOnlineToken(playerToken);
    localStorage.setItem(ONLINE_SESSION_KEY, JSON.stringify({ roomId: room.id, playerToken }));
    setBoard(room.board); setScores(room.scores); setTurn(room.turn); setStatus(room.status);
    setLastMove(room.lastMove ?? null); setHighlight(room.winningCells || []);
    setMode('online'); setScreen('game'); setOnlineMessage(''); setConnectionState('Connecting');
  }, []);

  const playTone = useCallback((kind) => {
    if (!sound) return;
    try {
      const context = audio.current || (audio.current = new AudioContext());
      const oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.frequency.value = kind === 'score' ? 660 : kind === 'win' ? 880 : 420;
      gain.gain.setValueAtTime(0.08, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.18);
      oscillator.start(); oscillator.stop(context.currentTime + 0.18);
    } catch { /* Audio is optional and may be unavailable in some browsers. */ }
  }, [sound]);

  useEffect(() => {
    if (screen !== 'matchmaking' || !account || (!account.verified && !account.queueTicket)) return;
    let alive = true;
    const updateStatus = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/matchmaking/status`, { headers: matchmakingAuthHeaders() });
        const data = await readApiResponse(response);
        if (!alive) return;
        setQueueError(''); setQueueState(data);
        if (data.state === 'ready' && lastQueueState.current !== 'ready') playTone('win');
        lastQueueState.current = data.state;
        if (data.state === 'matched') acceptOnlineSession(data.match);
      } catch (error) { if (alive) setQueueError(error.message); }
    };
    updateStatus();
    const interval = window.setInterval(() => { setQueueClock(Date.now()); updateStatus(); }, 1100);
    return () => { alive = false; window.clearInterval(interval); };
  }, [screen, account?.verified, acceptOnlineSession, playTone]);

  const makeMove = useCallback((index, mark) => {
    if (board[index] || status !== 'playing') return;
    const next = [...board]; next[index] = mark;
    const lines = scoreMove(next, index, mark);
    const updatedScores = { ...scores, [mark]: scores[mark] + lines.length };
    setBoard(next); setLastMove(index); setHighlight(lines.flat()); setScores(updatedScores);
    if (lines.length) playTone('score');
    else playTone('move');
    if (next.every(Boolean)) {
      setStatus('finished');
      if (updatedScores.X !== updatedScores.O) playTone('win');
    } else setTurn(mark === 'X' ? 'O' : 'X');
    window.clearTimeout(timer.current);
  }, [board, playTone, scores, status]);

  useEffect(() => {
    if (mode !== 'PvE' || turn !== 'O' || status !== 'playing') return;
    setThinking(true);
    timer.current = window.setTimeout(() => {
      const index = difficulty === 'Easy'
        ? board.map((v, i) => v === null ? i : -1).filter(i => i >= 0)[Math.floor(Math.random() * board.filter(v => v === null).length)]
        : chooseBotMove(board, difficulty);
      if (index !== undefined) makeMove(index, 'O');
      setThinking(false);
    }, 460);
    return () => window.clearTimeout(timer.current);
  }, [mode, turn, status, difficulty, board, makeMove]);

  useEffect(() => {
    if (!highlight.length) return;
    const id = window.setTimeout(() => setHighlight([]), 1100);
    return () => window.clearTimeout(id);
  }, [highlight]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(ONLINE_SESSION_KEY) || 'null');
      if (!saved?.roomId || !saved?.playerToken) return;
      fetch(`${API_BASE}/api/rooms/${saved.roomId}/rejoin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerToken: saved.playerToken }),
      }).then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not restore your online game.');
        acceptOnlineSession({ ...data, playerToken: saved.playerToken });
      }).catch(() => localStorage.removeItem(ONLINE_SESSION_KEY));
    } catch { localStorage.removeItem(ONLINE_SESSION_KEY); }
  }, [acceptOnlineSession]);

  useEffect(() => {
    if (mode !== 'online' || screen !== 'home') return;
    let alive = true;
    const refreshRooms = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/rooms`);
        const data = await readApiResponse(response);
        if (alive) { setPublicRooms(data.rooms || []); setOnlineMessage(''); }
      } catch (error) { if (alive) setOnlineMessage(error.message); }
    };
    refreshRooms();
    const interval = window.setInterval(refreshRooms, 12000);
    return () => { alive = false; window.clearInterval(interval); };
  }, [mode, screen]);

  useEffect(() => {
    if (mode !== 'online' || screen !== 'game' || !onlineRoom?.id || !onlineToken) return;
    let disposed = false, socket;
    setConnectionState('Connecting');
    loadSocketClient().then(io => {
      if (disposed) return;
      socket = io(API_BASE || window.location.origin, { path: '/socket.io', transports: ['websocket', 'polling'] });
      socketRef.current = socket;
      socket.on('connect', () => { setConnectionState('Connected'); socket.emit('room:join', { roomId: onlineRoom.id, playerToken: onlineToken }); });
      socket.on('disconnect', () => setConnectionState('Reconnecting'));
      socket.on('connect_error', () => setConnectionState('Reconnecting'));
      const updateRoom = room => {
        setOnlineRoom(room); setBoard(room.board); setScores(room.scores); setTurn(room.turn); setStatus(room.status);
        setLastMove(room.lastMove ?? null); setHighlight(room.winningCells || []); setConnectionState('Connected'); setOnlineMessage('');
      };
      socket.on('room:state', ({ room, seat }) => { setOnlineSeat(seat); updateRoom(room); });
      socket.on('room:updated', ({ room }) => updateRoom(room));
      socket.on('room:error', ({ error }) => setOnlineMessage(error));
    }).catch(error => { if (!disposed) { setConnectionState('Offline'); setOnlineMessage(error.message); } });
    return () => { disposed = true; socket?.disconnect(); if (socketRef.current === socket) socketRef.current = null; };
  }, [mode, screen, onlineRoom?.id, onlineToken]);

  const restart = () => {
    window.clearTimeout(timer.current); setBoard(emptyBoard()); setScores({ X: 0, O: 0 });
    setTurn('X'); setStatus('playing'); setLastMove(null); setHighlight([]); setThinking(false);
  };

  const changeMode = (nextMode) => {
    if (nextMode === mode) return;
    window.clearTimeout(timer.current);
    setBoard(emptyBoard()); setScores({ X: 0, O: 0 }); setTurn('X');
    setStatus('playing'); setLastMove(null); setHighlight([]); setThinking(false);
    if (nextMode !== 'online') {
      localStorage.removeItem(ONLINE_SESSION_KEY); setOnlineRoom(null); setOnlineSeat(null); setOnlineToken(null);
    }
    setOnlineMessage('');
    setMode(nextMode);
  };

  const leaveOnlineGame = async () => {
    if (mode === 'online' && status === 'playing' && onlineRoom?.id && onlineToken) {
      try {
        await fetch(`${API_BASE}/api/rooms/${onlineRoom.id}/leave`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerToken: onlineToken }),
        });
      } catch { /* Socket disconnect grace will record the forfeit if the request cannot reach the server. */ }
    }
    restart();
    if (mode === 'online') {
      socketRef.current?.disconnect(); setOnlineRoom(null); setOnlineSeat(null); setOnlineToken(null);
      localStorage.removeItem(ONLINE_SESSION_KEY);
    }
    setScreen('home');
  };

  const loadPublicRooms = async () => {
    setLobbyLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/rooms`);
      const data = await readApiResponse(response);
      setPublicRooms(data.rooms || []); setOnlineMessage('');
    } catch (error) { setOnlineMessage(error.message); }
    finally { setLobbyLoading(false); }
  };

  const lockGuestName = () => {
    if (account || !playerName.trim()) return;
    const savedName = playerName.trim();
    localStorage.setItem(GUEST_NAME_KEY, savedName);
    setPlayerName(savedName);
    setGuestNameLocked(true);
  };

  const createOnlineRoom = async () => {
    setLobbyLoading(true); setOnlineMessage('');
    try {
      const response = await fetch(`${API_BASE}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerName: displayName, isGuest: !account, visibility: roomVisibility }) });
      const data = await readApiResponse(response);
      lockGuestName();
      acceptOnlineSession(data);
    } catch (error) { setOnlineMessage(error.message); }
    finally { setLobbyLoading(false); }
  };

  const joinOnlineRoom = async code => {
    setLobbyLoading(true); setOnlineMessage('');
    try {
      const response = await fetch(`${API_BASE}/api/rooms/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerName: displayName, isGuest: !account, code }) });
      const data = await readApiResponse(response);
      lockGuestName();
      acceptOnlineSession(data);
    } catch (error) {
      setOnlineMessage(error.message);
      if (!account && error.message.toLowerCase().includes('already taken in this room')) setGuestNameLocked(false);
    }
    finally { setLobbyLoading(false); }
  };

  const startMatchmaking = async () => {
    setQueueError(''); setQueueStartedAt(Date.now()); setQueueClock(Date.now()); setQueueState({ state: 'waiting', queue: account?.verified ? 'verified' : 'unverified' }); lastQueueState.current = 'waiting'; setScreen('matchmaking');
    try {
      const response = await fetch(`${API_BASE}/api/matchmaking/queue`, { method: 'POST', headers: matchmakingAuthHeaders() });
      const data = await readApiResponse(response);
      if (data.state === 'ready' && lastQueueState.current !== 'ready') playTone('win');
      setQueueState(data); lastQueueState.current = data.state;
      if (data.state === 'matched') acceptOnlineSession(data.match);
    } catch (error) { setQueueError(error.message); }
  };
  const acceptMatch = async () => {
    try {
      const response = await fetch(`${API_BASE}/api/matchmaking/ready`, { method: 'POST', headers: matchmakingAuthHeaders() });
      const data = await readApiResponse(response); setQueueState(data); lastQueueState.current = data.state;
      if (data.state === 'matched') acceptOnlineSession(data.match);
    } catch (error) { setQueueError(error.message); }
  };
  const leaveMatchmaking = async () => {
    try {
      await fetch(`${API_BASE}/api/matchmaking/cancel`, { method: 'POST', headers: matchmakingAuthHeaders() });
    } finally { setQueueState({ state: 'idle' }); lastQueueState.current = 'idle'; setScreen('home'); }
  };

  const winner = scores.X === scores.O ? 'It’s a draw' : scores.X > scores.O ? 'You win!' : 'Bot wins';
  const filled = board.filter(Boolean).length;
  const displayName = account?.username || playerName.trim();
  const elapsedSeconds = queueStartedAt ? Math.max(0, Math.floor((queueClock - queueStartedAt) / 1000)) : 0;
  const readySeconds = queueState.deadline ? Math.max(0, Math.ceil((queueState.deadline - queueClock) / 1000)) : 10;
  if (screen === 'admin') return <AdminPanel onBack={() => setScreen('home')} />;
  const submitAccount = async event => {
    event.preventDefault(); setAccountError(''); setAccountNotice(''); setAccountBusy(true);
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    try {
      const response = await fetch(`${API_BASE}/api/auth/${accountMode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await readApiResponse(response);
      if (data.session) {
        const saved = { user: data.user, session: data.session };
        localStorage.setItem('fourfold-account', JSON.stringify(saved)); setAccount(data.user); setPlayerName(data.user.username); setAccountOpen(false);
      } else if (data.queueTicket) {
        localStorage.setItem('fourfold-account', JSON.stringify({ user: data.user, queueTicket: data.queueTicket }));
        setAccount(data.user); setPlayerName(data.user.username);
        setAccountNotice('Check your email to confirm your account. You can queue now in the unverified player pool.');
      } else setAccountNotice('Check your email to confirm your account, then log in.');
    } catch (error) { setAccountError(error.message); }
    finally { setAccountBusy(false); }
  };

  if (screen === 'matchmaking') return <main className="app-shell home-shell matchmaking-shell">
    <header className="topbar"><a className="brand" href="#top" aria-label="X4O home"><span className="brand-mark">X4O</span><span>X4O</span></a><button className="home-button" onClick={leaveMatchmaking}>← Cancel queue</button></header>
    <section className="matchmaking-content" aria-live="polite">
      <div className="eyebrow"><span className={queueState.state === 'ready' ? 'connected-dot' : 'live-dot'} /> {queueState.queue === 'unverified' ? 'UNVERIFIED' : 'VERIFIED'} RANDOM 1V1 QUEUE</div>
      {queueState.state === 'ready' ? <><div className="queue-orbit ready-orbit"><span>×</span><i>VS</i><span>○</span></div><h1>Opponent found.</h1><p className="matchmaking-copy">{queueState.opponent} is ready to play. Accept before the timer runs out.</p><div className="queue-timer ready-timer">00:{String(readySeconds).padStart(2, '0')}</div><button className="start-button ready-button" onClick={acceptMatch}>I’m ready <span>→</span></button>{queueState.ready && <p className="queue-note">You’re ready. Waiting for the other player…</p>}</> : queueState.state === 'idle' ? <><div className="queue-orbit"><span>×</span><i>?</i><span>○</span></div><h1>Queue ended.</h1><p className="matchmaking-copy">You missed the ready check and were removed. Start again to find another match.</p><button className="start-button" onClick={startMatchmaking}>Queue again <span>→</span></button></> : queueState.state === 'matched' ? <><h1>Match found.</h1><p className="matchmaking-copy">Connecting you to your game…</p></> : <><div className="queue-orbit"><span>×</span><i>···</i><span>○</span></div><h1>Finding your match.</h1><p className="matchmaking-copy">You’re in line. We’ll pair you with the next available player.</p><div className="queue-timer">{String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:{String(elapsedSeconds % 60).padStart(2, '0')}</div><div className="queue-count"><strong>{queueState.waitingPlayers ?? '—'}</strong><span>PLAYERS WAITING</span></div><p className="queue-note">Searching for an opponent</p></>}
      {queueError && <p className="account-error" role="alert">{queueError}</p>}
    </section>
    <footer><span>X4O <i>·</i> {queueState.queue === 'unverified' ? 'UNVERIFIED' : 'VERIFIED'} QUEUE</span><span>FIRST COME. FIRST SERVED.</span></footer>
  </main>;

  if (screen === 'home') return <main className="app-shell home-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="X4O home"><span className="brand-mark">X4O</span><span>X4O</span></a>
      <div className="account-actions">{account ? <><span className="account-greeting">{account.username}</span>{isAdmin && <button className="home-button admin-entry" onClick={() => setScreen('admin')}>Admin panel</button>}<button className="home-button" onClick={() => { localStorage.removeItem('fourfold-account'); setAccount(null); setIsAdmin(false); setPlayerName(localStorage.getItem(GUEST_NAME_KEY) || ''); }}>Log out</button></> : <button className="home-button" onClick={() => { setAccountMode('register'); setAccountOpen(true); }}>Account <span>· Log in</span></button>}<button className={`icon-button ${sound ? 'active' : ''}`} onClick={() => setSound(v => !v)} aria-label={sound ? 'Mute sound' : 'Enable sound'} title={sound ? 'Mute sound' : 'Enable sound'}>{sound ? '♫' : '♪'}</button></div>
    </header>
    <section className="home-content" id="top">
      <div className="home-intro">
        <div className="eyebrow"><span className="live-dot" /> 10 × 10 STRATEGY</div>
        <h1>Make your move.<br /><em>Own the board.</em></h1>
        <p className="intro-copy">Connect four. Score in every direction.<br className="desktop-break" /> The player with the most points wins.</p>
      </div>
      <div className="mode-cards" role="group" aria-label="Choose a game mode">
        <button className={`mode-card ${mode === 'PvP' ? 'chosen' : ''}`} onClick={() => changeMode('PvP')} aria-pressed={mode === 'PvP'}>
          <span className="mode-card-icon pvp-icon"><span>×</span><span>○</span></span>
          <span className="mode-card-copy"><strong>Player vs Player</strong><small>Two players, one board. Take turns on the same device.</small></span>
          <span className="mode-card-radio" />
        </button>
        <button className={`mode-card ${mode === 'PvE' ? 'chosen' : ''}`} onClick={() => changeMode('PvE')} aria-pressed={mode === 'PvE'}>
          <span className="mode-card-icon pve-icon"><span>×</span><span>✳</span></span>
          <span className="mode-card-copy"><strong>Player vs Bot</strong><small>Play solo against a bot. Pick a challenge level.</small></span>
          <span className="mode-card-radio" />
        </button>
        <button className={`mode-card ${mode === 'online' ? 'chosen' : ''}`} onClick={() => changeMode('online')} aria-pressed={mode === 'online'}>
          <span className="mode-card-icon online-icon"><span>◎</span></span>
          <span className="mode-card-copy"><strong>Online Multiplayer</strong><small>Play across devices with a room code or join a public room.</small></span>
          <span className="mode-card-radio" />
        </button>
      </div>
      <div className="home-live-stats" aria-live="polite">
        <div><span>TOTAL PLAYERS</span><strong>{liveStats?.totalPlayers ?? '—'}</strong></div>
        <div><span>CONCURRENT PLAYERS</span><strong>{liveStats ? <>{liveStats.activeAccounts} <i>+</i> {liveStats.guestPlayers}</> : '—'}</strong></div>
      </div>
      {mode === 'online' ? <section className="online-lobby" aria-label="Online multiplayer lobby">
        <div className="matchmaking-panel"><div><strong>Random 1v1</strong><small>Verified and unverified accounts have separate queues.</small></div>{account?.verified || account?.queueTicket ? <button className="start-button" onClick={startMatchmaking}>Find a match <span>→</span></button> : <button className="secondary-action" onClick={() => { setAccountMode('login'); setAccountOpen(true); }}>Log in to unlock</button>}</div>
        <label className="name-field">YOUR DISPLAY NAME<input value={account?.username || playerName} maxLength={24} onChange={e => { const value = e.target.value; setPlayerName(value); if (value) localStorage.setItem(GUEST_NAME_KEY, value); else localStorage.removeItem(GUEST_NAME_KEY); }} placeholder="Enter your name" autoComplete="nickname" readOnly={!!account || guestNameLocked} aria-readonly={!!account || guestNameLocked} />{guestNameLocked && !account && <small className="guest-name-note">Saved for this browser. It can be changed if a room already has that name.</small>}</label>
        <div className="create-room-panel"><div><strong>Create a room</strong><small>Choose whether your room appears in the public list.</small></div><div className="create-room-controls"><select aria-label="Room visibility" value={roomVisibility} onChange={e => setRoomVisibility(e.target.value)}><option value="private">Private</option><option value="public">Public</option></select><button className="start-button" disabled={!displayName || lobbyLoading} onClick={createOnlineRoom}>Create {roomVisibility} room <span>→</span></button></div></div>
        <form className="join-room-form" onSubmit={e => { e.preventDefault(); joinOnlineRoom(joinCode); }}><label className="name-field">JOIN WITH A ROOM CODE<input value={joinCode} maxLength={6} onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-F0-9]/g, ''))} placeholder="6 character code" /></label><button className="secondary-action" disabled={!displayName || joinCode.length !== 6 || lobbyLoading}>Join room</button></form>
        <div className="public-rooms"><div className="public-rooms-heading"><div><strong>Public rooms</strong><small>Open rooms waiting for another player</small></div><button className="refresh-button" onClick={loadPublicRooms} disabled={lobbyLoading} aria-label="Refresh public rooms">↻</button></div>
          {publicRooms.length ? <div className="room-list">{publicRooms.map(room => <div className="room-list-item" key={room.id}><div className="room-owner"><span className="room-avatar">{room.creatorName.slice(0, 1).toUpperCase()}</span><span><strong>{room.creatorName}</strong><small>Room {room.code}</small></span></div><button className="secondary-action" disabled={!displayName || lobbyLoading} onClick={() => joinOnlineRoom(room.code)}>Join</button></div>)}</div> : <p className="empty-rooms">{lobbyLoading ? 'Loading rooms…' : 'No public rooms are waiting. Create one to get started.'}</p>}
        </div>
        {onlineMessage && <p className="online-message" role="alert">{onlineMessage}</p>}
      </section> : <div className="home-actions">
        {mode === 'PvE' && <label className="difficulty home-difficulty"><span>BOT LEVEL</span><select value={difficulty} onChange={e => setDifficulty(e.target.value)}><option>Easy</option><option>Medium</option><option>Hard</option></select></label>}
        <button className="start-button" onClick={() => setScreen('game')}>Start {mode === 'PvP' ? 'PvP' : 'PvE'} game <span>→</span></button>
      </div>}
      <div className="home-rules"><span><b>4</b> in a row = 1 point</span><i>·</i><span>Most points wins</span><i>·</i><span>100 cells</span></div>
    </section>
    <footer><span>X4O <i>·</i> SCORE MODE</span><span>CHOOSE YOUR GAME</span></footer>
    {accountOpen && <div className="account-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setAccountOpen(false); }}><section className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-title"><button className="account-close" onClick={() => setAccountOpen(false)} aria-label="Close">×</button><div className="eyebrow"><span className="live-dot" /> PLAYER ACCOUNT</div><h2 id="account-title">{accountMode === 'register' ? 'Reserve your name.' : 'Welcome back.'}</h2><p>{accountMode === 'register' ? 'Create an account to claim a username for online play.' : 'Log in with the email and password linked to your account.'}</p><form className="account-form" onSubmit={submitAccount}>{accountMode === 'register' && <label>USERNAME<input name="username" required minLength="3" maxLength="20" pattern="[A-Za-z0-9_]+" autoComplete="username" placeholder="Your player name" /></label>}<label>EMAIL<input type="email" name="email" required maxLength="254" autoComplete="email" placeholder="you@example.com" /></label><label>PASSWORD<input type="password" name="password" required minLength="8" maxLength="72" autoComplete={accountMode === 'register' ? 'new-password' : 'current-password'} placeholder="At least 8 characters" /></label><button className="start-button" disabled={accountBusy}>{accountBusy ? 'Please wait…' : accountMode === 'register' ? 'Create account' : 'Log in'} <span>→</span></button></form>{accountError && <p className="account-error" role="alert">{accountError}</p>}{accountNotice && <p className="account-notice" role="status">{accountNotice}</p>}<button className="account-switch" onClick={() => { setAccountMode(accountMode === 'register' ? 'login' : 'register'); setAccountError(''); setAccountNotice(''); }}>{accountMode === 'register' ? 'Already registered? Log in' : 'New here? Create an account'}</button></section></div>}
  </main>;

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="X4O home"><span className="brand-mark">X4O</span><span>X4O</span></a>
      <div className="top-actions">
        {mode === 'PvE' && <label className="difficulty"><span>BOT LEVEL</span><select value={difficulty} onChange={e => setDifficulty(e.target.value)} disabled={status !== 'playing'}><option>Easy</option><option>Medium</option><option>Hard</option></select></label>}
        {mode === 'online' && <div className="online-game-badge"><span className={connectionState === 'Connected' ? 'connected-dot' : 'disconnected-dot'} />{connectionState || 'Connecting'} <b>{onlineRoom?.code}</b><button onClick={async () => { try { await navigator.clipboard.writeText(onlineRoom.code); setOnlineMessage('Room code copied.'); } catch { setOnlineMessage(`Share room code ${onlineRoom.code} with your opponent.`); } }} aria-label="Copy room code">Copy</button></div>}
        <button className={`icon-button ${sound ? 'active' : ''}`} onClick={() => setSound(v => !v)} aria-label={sound ? 'Mute sound' : 'Enable sound'} title={sound ? 'Mute sound' : 'Enable sound'}>{sound ? '♫' : '♪'}</button>
        {mode !== 'online' && <button className="restart-top" onClick={restart}><span>↻</span><span className="restart-label">New game</span></button>}
        <button className="home-button" onClick={leaveOnlineGame}>← <span>{mode === 'online' && status === 'playing' ? 'Leave match' : 'Home'}</span></button>
      </div>
    </header>

    <section className="game-layout" id="top">
      <div className="intro">
        <div className="eyebrow"><span className="live-dot" /> {mode === 'PvP' ? 'LOCAL TWO PLAYER' : mode === 'online' ? 'ONLINE MULTIPLAYER' : 'THE FOUR IN A ROW GAME'}</div>
        <h1>Think ahead.<br /><em>Score more.</em></h1>
        <p className="intro-copy">Build lines of four. Every direction counts.<br className="desktop-break" /> The board is yours to shape.</p>
        <div className="score-panel">
          <div className={`player-score you ${turn === 'X' && status === 'playing' ? 'current' : ''}`}>
            <div className="score-label"><span className="symbol x-symbol">×</span><span>{mode === 'PvP' ? 'PLAYER 1' : mode === 'online' ? onlineRoom?.player1Name || 'PLAYER 1' : 'YOU'}</span>{mode === 'PvE' && turn === 'X' && status === 'playing' && <span className="turn-tag">YOUR TURN</span>}</div>
            <div className="score-number">{scores.X.toString().padStart(2, '0')}</div>
          </div>
          <div className="score-divider"><span>VS</span></div>
          <div className={`player-score bot ${turn === 'O' && status === 'playing' ? 'current' : ''}`}>
            <div className="score-label"><span className="symbol o-symbol">○</span><span>{mode === 'PvP' ? 'PLAYER 2' : mode === 'online' ? onlineRoom?.player2Name || 'WAITING' : 'BOT'}</span>{mode === 'PvE' && turn === 'O' && status === 'playing' && <span className="turn-tag">{thinking ? 'THINKING' : 'BOT TURN'}</span>}</div>
            <div className="score-number">{scores.O.toString().padStart(2, '0')}</div>
          </div>
        </div>
        <div className="progress-row"><span>BOARD PROGRESS</span><span>{filled} <i>/ 100</i></span></div>
        <div className="progress-track"><span style={{ width: `${filled}%` }} /></div>
        {status === 'finished' ? <div className="result-card"><span className="result-icon">✦</span><div><strong>{mode === 'online' ? onlineRoom?.winnerSeat ? `${onlineRoom.winnerSeat === 'X' ? onlineRoom.player1Name : onlineRoom.player2Name} wins!` : scores.X === scores.O ? 'It’s a draw' : `${scores.X > scores.O ? onlineRoom?.player1Name : onlineRoom?.player2Name} wins!` : mode === 'PvP' && winner !== 'It’s a draw' ? `${winner === 'You win!' ? 'Player 1' : 'Player 2'} wins!` : winner}</strong><small>{mode === 'online' && onlineRoom?.winnerSeat ? `${onlineRoom.winnerSeat === onlineSeat ? 'Opponent left the match' : 'You left the match'} · ` : ''}Final score · {scores.X} — {scores.O}</small></div></div> : <div className="tip-card"><span className="tip-icon">✳</span><p>{mode === 'online' ? status === 'waiting' ? `Room ${onlineRoom?.visibility}. Share code ${onlineRoom?.code} and wait for an opponent.` : onlineMessage || (connectionState !== 'Connected' ? 'Connecting to your opponent…' : turn === onlineSeat ? 'Your turn. Choose an empty cell.' : `${turn === 'X' ? onlineRoom?.player1Name : onlineRoom?.player2Name} is thinking…`) : thinking ? 'Bot is weighing its next move…' : turn === 'X' ? mode === 'PvP' ? 'Player 1’s turn. Place a mark to begin.' : 'Your move. Find a line—or set up the next one.' : mode === 'PvP' ? 'Player 2’s turn. Find a way to score.' : 'Look for chances to create two scoring directions.'}</p></div>}
        <div className="how-to"><span className="how-icon">?</span><div><strong>HOW TO PLAY</strong><p>Place a mark to complete four connected cells in any direction. Each direction scores one point.</p></div></div>
      </div>

      <div className="board-column">
        <div className="board-heading"><span>THE BOARD</span><span className="board-count">{filled}<i> / 100</i></span></div>
        <div className={`board-frame ${status === 'finished' ? 'is-finished' : ''}`}>
          <div className="board" role="grid" aria-label="10 by 10 game board">
            {board.map((mark, i) => <button key={i} role="gridcell" aria-label={`Row ${Math.floor(i / SIZE) + 1}, column ${i % SIZE + 1}${mark ? `, ${mark}` : ', empty'}`} className={`cell ${mark ? `marked ${mark.toLowerCase()}` : ''} ${highlight.includes(i) ? 'scored' : ''} ${lastMove === i ? 'last-move' : ''}`} onClick={() => { if (mark || status !== 'playing') return; if (mode === 'online') { if (onlineSeat !== turn) setOnlineMessage('Wait for your turn.'); else if (!socketRef.current?.connected) setOnlineMessage('Reconnecting to the room…'); else socketRef.current.emit('room:move', { index: i }); } else if (!thinking && (mode === 'PvP' || turn === 'X')) makeMove(i, turn); }} disabled={!!mark || status !== 'playing' || thinking || (mode === 'PvE' && turn !== 'X') || (mode === 'online' && (status !== 'playing' || connectionState !== 'Connected' || turn !== onlineSeat))}>{mark && <span>{mark === 'X' ? '×' : '○'}</span>}</button>)}
          </div>
        </div>
        <div className="board-footer"><span><kbd>4</kbd> IN A ROW = <b>1 POINT</b></span><span>{status === 'finished' ? 'GAME COMPLETE' : 'FIRST TO OUTSCORE WINS'}</span></div>
      </div>
    </section>
    <footer><span>X4O <i>·</i> SCORE MODE</span><span>100 CELLS. ONE WINNER.</span></footer>
  </main>;
}

export default App;
