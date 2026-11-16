import React, { useCallback, useEffect, useRef, useState } from 'react';

const SIZE = 10;
const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const emptyBoard = () => Array(SIZE * SIZE).fill(null);
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const ONLINE_SESSION_KEY = 'fourfold-online-session';
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

function chooseBotMove(board) {
  const available = board.map((v, i) => v === null ? i : -1).filter(i => i >= 0);
  if (available.length === SIZE * SIZE) return 44;
  let best = -Infinity, choices = [];
  for (const i of available) {
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
    if (score > best) { best = score; choices = [i]; }
    else if (score === best) choices.push(i);
  }
  return choices[Math.floor(Math.random() * choices.length)];
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
  const [playerName, setPlayerName] = useState('');
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
  const timer = useRef();
  const audio = useRef(null);
  const socketRef = useRef(null);

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
        : chooseBotMove(board);
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

  const loadPublicRooms = async () => {
    setLobbyLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/rooms`);
      const data = await readApiResponse(response);
      setPublicRooms(data.rooms || []); setOnlineMessage('');
    } catch (error) { setOnlineMessage(error.message); }
    finally { setLobbyLoading(false); }
  };

  const createOnlineRoom = async () => {
    setLobbyLoading(true); setOnlineMessage('');
    try {
      const response = await fetch(`${API_BASE}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerName, visibility: roomVisibility }) });
      const data = await readApiResponse(response);
      acceptOnlineSession(data);
    } catch (error) { setOnlineMessage(error.message); }
    finally { setLobbyLoading(false); }
  };

  const joinOnlineRoom = async code => {
    setLobbyLoading(true); setOnlineMessage('');
    try {
      const response = await fetch(`${API_BASE}/api/rooms/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerName, code }) });
      const data = await readApiResponse(response);
      acceptOnlineSession(data);
    } catch (error) { setOnlineMessage(error.message); }
    finally { setLobbyLoading(false); }
  };

  const winner = scores.X === scores.O ? 'It’s a draw' : scores.X > scores.O ? 'You win!' : 'Bot wins';
  const filled = board.filter(Boolean).length;
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
      } else setAccountNotice('Check your email to confirm your account, then log in.');
    } catch (error) { setAccountError(error.message); }
    finally { setAccountBusy(false); }
  };

  if (screen === 'home') return <main className="app-shell home-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="Fourfold home"><span className="brand-mark">4</span><span>FOURFOLD</span></a>
      <div className="account-actions">{account ? <><span className="account-greeting">{account.username}</span><button className="home-button" onClick={() => { localStorage.removeItem('fourfold-account'); setAccount(null); setPlayerName(''); }}>Log out</button></> : <button className="home-button" onClick={() => { setAccountMode('register'); setAccountOpen(true); }}>Account <span>· Log in</span></button>}<button className={`icon-button ${sound ? 'active' : ''}`} onClick={() => setSound(v => !v)} aria-label={sound ? 'Mute sound' : 'Enable sound'} title={sound ? 'Mute sound' : 'Enable sound'}>{sound ? '♫' : '♪'}</button></div>
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
      {mode === 'online' ? <section className="online-lobby" aria-label="Online multiplayer lobby">
        <label className="name-field">YOUR DISPLAY NAME<input value={playerName} maxLength={24} onChange={e => setPlayerName(e.target.value)} placeholder="Enter your name" autoComplete="nickname" /></label>
        <div className="create-room-panel"><div><strong>Create a room</strong><small>Choose whether your room appears in the public list.</small></div><div className="create-room-controls"><select aria-label="Room visibility" value={roomVisibility} onChange={e => setRoomVisibility(e.target.value)}><option value="private">Private</option><option value="public">Public</option></select><button className="start-button" disabled={!playerName.trim() || lobbyLoading} onClick={createOnlineRoom}>Create {roomVisibility} room <span>→</span></button></div></div>
        <form className="join-room-form" onSubmit={e => { e.preventDefault(); joinOnlineRoom(joinCode); }}><label className="name-field">JOIN WITH A ROOM CODE<input value={joinCode} maxLength={6} onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-F0-9]/g, ''))} placeholder="6 character code" /></label><button className="secondary-action" disabled={!playerName.trim() || joinCode.length !== 6 || lobbyLoading}>Join room</button></form>
        <div className="public-rooms"><div className="public-rooms-heading"><div><strong>Public rooms</strong><small>Open rooms waiting for another player</small></div><button className="refresh-button" onClick={loadPublicRooms} disabled={lobbyLoading} aria-label="Refresh public rooms">↻</button></div>
          {publicRooms.length ? <div className="room-list">{publicRooms.map(room => <div className="room-list-item" key={room.id}><div className="room-owner"><span className="room-avatar">{room.creatorName.slice(0, 1).toUpperCase()}</span><span><strong>{room.creatorName}</strong><small>Room {room.code}</small></span></div><button className="secondary-action" disabled={!playerName.trim() || lobbyLoading} onClick={() => joinOnlineRoom(room.code)}>Join</button></div>)}</div> : <p className="empty-rooms">{lobbyLoading ? 'Loading rooms…' : 'No public rooms are waiting. Create one to get started.'}</p>}
        </div>
        {onlineMessage && <p className="online-message" role="alert">{onlineMessage}</p>}
      </section> : <div className="home-actions">
        {mode === 'PvE' && <label className="difficulty home-difficulty"><span>BOT LEVEL</span><select value={difficulty} onChange={e => setDifficulty(e.target.value)}><option>Easy</option><option>Medium</option></select></label>}
        <button className="start-button" onClick={() => setScreen('game')}>Start {mode === 'PvP' ? 'PvP' : 'PvE'} game <span>→</span></button>
      </div>}
      <div className="home-rules"><span><b>4</b> in a row = 1 point</span><i>·</i><span>Most points wins</span><i>·</i><span>100 cells</span></div>
    </section>
    <footer><span>FOURFOLD <i>·</i> SCORE MODE</span><span>CHOOSE YOUR GAME</span></footer>
    {accountOpen && <div className="account-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setAccountOpen(false); }}><section className="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-title"><button className="account-close" onClick={() => setAccountOpen(false)} aria-label="Close">×</button><div className="eyebrow"><span className="live-dot" /> PLAYER ACCOUNT</div><h2 id="account-title">{accountMode === 'register' ? 'Reserve your name.' : 'Welcome back.'}</h2><p>{accountMode === 'register' ? 'Create an account to claim a username for online play.' : 'Log in with the email and password linked to your account.'}</p><form className="account-form" onSubmit={submitAccount}>{accountMode === 'register' && <label>USERNAME<input name="username" required minLength="3" maxLength="20" pattern="[A-Za-z0-9_]+" autoComplete="username" placeholder="Your player name" /></label>}<label>EMAIL<input type="email" name="email" required maxLength="254" autoComplete="email" placeholder="you@example.com" /></label><label>PASSWORD<input type="password" name="password" required minLength="8" maxLength="72" autoComplete={accountMode === 'register' ? 'new-password' : 'current-password'} placeholder="At least 8 characters" /></label><button className="start-button" disabled={accountBusy}>{accountBusy ? 'Please wait…' : accountMode === 'register' ? 'Create account' : 'Log in'} <span>→</span></button></form>{accountError && <p className="account-error" role="alert">{accountError}</p>}{accountNotice && <p className="account-notice" role="status">{accountNotice}</p>}<button className="account-switch" onClick={() => { setAccountMode(accountMode === 'register' ? 'login' : 'register'); setAccountError(''); setAccountNotice(''); }}>{accountMode === 'register' ? 'Already registered? Log in' : 'New here? Create an account'}</button></section></div>}
  </main>;

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="Fourfold home"><span className="brand-mark">4</span><span>FOURFOLD</span></a>
      <div className="top-actions">
        {mode === 'PvE' && <label className="difficulty"><span>BOT LEVEL</span><select value={difficulty} onChange={e => setDifficulty(e.target.value)} disabled={status !== 'playing'}><option>Easy</option><option>Medium</option></select></label>}
        {mode === 'online' && <div className="online-game-badge"><span className={connectionState === 'Connected' ? 'connected-dot' : 'disconnected-dot'} />{connectionState || 'Connecting'} <b>{onlineRoom?.code}</b><button onClick={async () => { try { await navigator.clipboard.writeText(onlineRoom.code); setOnlineMessage('Room code copied.'); } catch { setOnlineMessage(`Share room code ${onlineRoom.code} with your opponent.`); } }} aria-label="Copy room code">Copy</button></div>}
        <button className={`icon-button ${sound ? 'active' : ''}`} onClick={() => setSound(v => !v)} aria-label={sound ? 'Mute sound' : 'Enable sound'} title={sound ? 'Mute sound' : 'Enable sound'}>{sound ? '♫' : '♪'}</button>
        {mode !== 'online' && <button className="restart-top" onClick={restart}><span>↻</span><span className="restart-label">New game</span></button>}
        <button className="home-button" onClick={() => { restart(); if (mode === 'online') { socketRef.current?.disconnect(); setOnlineRoom(null); setOnlineSeat(null); setOnlineToken(null); localStorage.removeItem(ONLINE_SESSION_KEY); } setScreen('home'); }}>← <span>Home</span></button>
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
        {status === 'finished' ? <div className="result-card"><span className="result-icon">✦</span><div><strong>{mode === 'online' ? (scores.X === scores.O ? 'It’s a draw' : `${scores.X > scores.O ? onlineRoom?.player1Name : onlineRoom?.player2Name} wins!`) : mode === 'PvP' && winner !== 'It’s a draw' ? `${winner === 'You win!' ? 'Player 1' : 'Player 2'} wins!` : winner}</strong><small>Final score · {scores.X} — {scores.O}</small></div></div> : <div className="tip-card"><span className="tip-icon">✳</span><p>{mode === 'online' ? status === 'waiting' ? `Room ${onlineRoom?.visibility}. Share code ${onlineRoom?.code} and wait for an opponent.` : onlineMessage || (connectionState !== 'Connected' ? 'Connecting to your opponent…' : turn === onlineSeat ? 'Your turn. Choose an empty cell.' : `${turn === 'X' ? onlineRoom?.player1Name : onlineRoom?.player2Name} is thinking…`) : thinking ? 'Bot is weighing its next move…' : turn === 'X' ? mode === 'PvP' ? 'Player 1’s turn. Place a mark to begin.' : 'Your move. Find a line—or set up the next one.' : mode === 'PvP' ? 'Player 2’s turn. Find a way to score.' : 'Look for chances to create two scoring directions.'}</p></div>}
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
    <footer><span>FOURFOLD <i>·</i> SCORE MODE</span><span>100 CELLS. ONE WINNER.</span></footer>
  </main>;
}

export default App;
