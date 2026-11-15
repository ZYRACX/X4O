export const BOARD_SIZE = 10;
const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];

export function getScoringLines(board, index, mark) {
  const row = Math.floor(index / BOARD_SIZE), col = index % BOARD_SIZE;
  const lines = [];
  for (const [dr, dc] of DIRECTIONS) {
    const cells = [index];
    for (const sign of [-1, 1]) {
      let r = row + dr * sign, c = col + dc * sign;
      while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r * BOARD_SIZE + c] === mark) {
        cells.push(r * BOARD_SIZE + c); r += dr * sign; c += dc * sign;
      }
    }
    if (cells.length >= 4) lines.push(cells);
  }
  return lines;
}

export function applyMove(room, index, mark) {
  if (!Number.isInteger(index) || index < 0 || index >= BOARD_SIZE * BOARD_SIZE) throw new Error('Choose a cell on the board.');
  if (room.status !== 'playing') throw new Error('This game is not accepting moves.');
  if (room.turn !== mark) throw new Error('Wait for your turn.');
  if (room.board[index] !== null) throw new Error('That cell is already taken.');
  const board = [...room.board]; board[index] = mark;
  const lines = getScoringLines(board, index, mark);
  const scores = { ...room.scores, [mark]: room.scores[mark] + lines.length };
  const finished = board.every(Boolean);
  return {
    board, scores, last_move: index, winning_cells: [...new Set(lines.flat())],
    turn: mark === 'X' ? 'O' : 'X', status: finished ? 'finished' : room.status,
  };
}
