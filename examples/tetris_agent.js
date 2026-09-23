import { serve } from '../src/index.js';

// ==========================================
// 1. TETRIS SIMULATOR LOGIC
// ==========================================
const BOARD_WIDTH = 10;
const BOARD_HEIGHT = 16; // 16 rows for clean CLI view

const PIECES = {
  I: [
    [[1, 1, 1, 1]],
    [[1], [1], [1], [1]]
  ],
  O: [
    [[1, 1], [1, 1]]
  ],
  T: [
    [[0, 1, 0], [1, 1, 1]],
    [[1, 0], [1, 1], [1, 0]],
    [[1, 1, 1], [0, 1, 0]],
    [[0, 1], [1, 1], [0, 1]]
  ],
  L: [
    [[0, 0, 1], [1, 1, 1]],
    [[1, 0], [1, 0], [1, 1]],
    [[1, 1, 1], [1, 0, 0]],
    [[1, 1], [0, 1], [0, 1]]
  ],
  J: [
    [[1, 0, 0], [1, 1, 1]],
    [[1, 1], [1, 0], [1, 0]],
    [[1, 1, 1], [0, 0, 1]],
    [[0, 1], [0, 1], [1, 1]]
  ],
  S: [
    [[0, 1, 1], [1, 1, 0]],
    [[1, 0], [1, 1], [0, 1]]
  ],
  Z: [
    [[1, 1, 0], [0, 1, 1]],
    [[0, 1], [1, 1], [1, 0]]
  ]
};

const PIECE_NAMES = Object.keys(PIECES);

class TetrisGame {
  constructor() {
    this.board = Array.from({ length: BOARD_HEIGHT }, () => Array(BOARD_WIDTH).fill(0));
    this.score = 0;
    this.linesCleared = 0;
    this.gameOver = false;
  }

  cloneBoard(board) {
    return board.map(row => [...row]);
  }

  getColumnHeights(board = this.board) {
    const heights = Array(BOARD_WIDTH).fill(0);
    for (let col = 0; col < BOARD_WIDTH; col++) {
      for (let row = 0; row < BOARD_HEIGHT; row++) {
        if (board[row][col] !== 0) {
          heights[col] = BOARD_HEIGHT - row;
          break;
        }
      }
    }
    return heights;
  }

  countHoles(board = this.board) {
    let holes = 0;
    for (let col = 0; col < BOARD_WIDTH; col++) {
      let blockFound = false;
      for (let row = 0; row < BOARD_HEIGHT; row++) {
        if (board[row][col] !== 0) {
          blockFound = true;
        } else if (blockFound && board[row][col] === 0) {
          holes++;
        }
      }
    }
    return holes;
  }

  calculateBumpiness(heights) {
    let bumpiness = 0;
    for (let i = 0; i < heights.length - 1; i++) {
      bumpiness += Math.abs(heights[i] - heights[i + 1]);
    }
    return bumpiness;
  }

  canPlace(board, shape, row, col) {
    const h = shape.length;
    const w = shape[0].length;
    if (col < 0 || col + w > BOARD_WIDTH) return false;
    if (row < 0 || row + h > BOARD_HEIGHT) return false;

    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        if (shape[r][c] && board[row + r][col + c]) {
          return false;
        }
      }
    }
    return true;
  }

  dropPiece(board, shape, col) {
    const h = shape.length;
    let finalRow = -1;
    for (let row = 0; row <= BOARD_HEIGHT - h; row++) {
      if (this.canPlace(board, shape, row, col)) {
        finalRow = row;
      } else {
        break;
      }
    }
    if (finalRow === -1) return null;

    const newBoard = this.cloneBoard(board);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < shape[0].length; c++) {
        if (shape[r][c]) {
          newBoard[finalRow + r][col + c] = 1;
        }
      }
    }

    // Check line clears
    let cleared = 0;
    for (let r = BOARD_HEIGHT - 1; r >= 0; r--) {
      if (newBoard[r].every(cell => cell !== 0)) {
        cleared++;
        newBoard.splice(r, 1);
        newBoard.unshift(Array(BOARD_WIDTH).fill(0));
        r++; // Recheck row
      }
    }

    return { board: newBoard, row: finalRow, linesCleared: cleared };
  }

  generateCandidateMoves(pieceName) {
    const rotations = PIECES[pieceName];
    const candidates = [];

    for (let rotIdx = 0; rotIdx < rotations.length; rotIdx++) {
      const shape = rotations[rotIdx];
      const w = shape[0].length;

      for (let col = 0; col <= BOARD_WIDTH - w; col++) {
        const result = this.dropPiece(this.board, shape, col);
        if (!result) continue;

        const heights = this.getColumnHeights(result.board);
        const maxHeight = Math.max(...heights);
        const holes = this.countHoles(result.board);
        const bumpiness = this.calculateBumpiness(heights);

        // Natural language criteria description for Laya System-1
        const features = [];
        if (result.linesCleared > 0) {
          features.push(`clears ${result.linesCleared} line(s)`);
        }
        if (holes === 0) {
          features.push('creates 0 holes (clean surface)');
        } else {
          features.push(`creates ${holes} covered hole(s)`);
        }
        if (bumpiness <= 4) {
          features.push('keeps surface flat');
        } else {
          features.push(`rough surface (bumpiness ${bumpiness})`);
        }
        features.push(`resulting tower height ${maxHeight}/${BOARD_HEIGHT}`);

        const description = `Place at col ${col}, rot ${rotIdx}: ${features.join(', ')}`;
        candidates.push({
          id: `move_c${col}_r${rotIdx}`,
          col,
          rotIdx,
          shape,
          result,
          maxHeight,
          holes,
          linesCleared: result.linesCleared,
          bumpiness,
          description
        });
      }
    }

    // Return a curated top subset of candidates to stay within ~5-8 choices
    // Sort primarily by: linesCleared (desc), holes (asc), maxHeight (asc), bumpiness (asc)
    candidates.sort((a, b) => {
      if (b.linesCleared !== a.linesCleared) return b.linesCleared - a.linesCleared;
      if (a.holes !== b.holes) return a.holes - b.holes;
      if (a.maxHeight !== b.maxHeight) return a.maxHeight - b.maxHeight;
      return a.bumpiness - b.bumpiness;
    });

    // Pick top best + 1 or 2 diverse alternatives so Laya evaluates realistic trade-offs
    return candidates.slice(0, 5);
  }

  applyMove(candidate) {
    this.board = candidate.result.board;
    this.linesCleared += candidate.linesCleared;
    this.score += candidate.linesCleared * 100 + 10;
  }

  renderBoardCLI(currentPiece = null, selectedCandidate = null) {
    const lines = [];
    const heights = this.getColumnHeights();
    const maxHeight = Math.max(...heights);
    const holes = this.countHoles();

    lines.push('  +--------------------+');
    for (let r = 0; r < BOARD_HEIGHT; r++) {
      let rowStr = '  |';
      for (let c = 0; c < BOARD_WIDTH; c++) {
        if (this.board[r][c] !== 0) {
          rowStr += '[]';
        } else {
          rowStr += ' .';
        }
      }
      rowStr += '|';
      if (r === 1) rowStr += `   Score        : ${this.score}`;
      if (r === 2) rowStr += `   Lines Cleared: ${this.linesCleared}`;
      if (r === 3) rowStr += `   Max Height   : ${maxHeight}/${BOARD_HEIGHT}`;
      if (r === 4) rowStr += `   Holes        : ${holes}`;
      if (r === 6 && currentPiece) rowStr += `   Next Piece   : [ ${currentPiece} ]`;
      lines.push(rowStr);
    }
    lines.push('  +--------------------+');
    lines.push('   0 1 2 3 4 5 6 7 8 9');
    return lines.join('\n');
  }
}

// ==========================================
// 2. MAIN TETRIS AGENT RUNNER OVER HTTP
// ==========================================
async function main() {
  console.log('='.repeat(70));
  console.log('         LAYA SYSTEM-ONE: AUTONOMOUS TETRIS OVER HTTP PROTOCOL        ');
  console.log('='.repeat(70));

  const serverPort = 8990;
  console.log(`\n[1/3] Booting Laya System-One HTTP Decision Server on port ${serverPort}...`);
  const { url, close } = await serve({ host: '127.0.0.1', port: serverPort });
  console.log(`✓ HTTP Server running at ${url}/v1/systemone`);

  console.log('\n[2/3] Initializing Tetris Environment...');
  const game = new TetrisGame();

  // Pre-seed bottom 2 rows with some blocks and a gap to create an interesting puzzle
  game.board[BOARD_HEIGHT - 1] = [1, 1, 1, 1, 1, 1, 1, 1, 0, 1]; // Col 8 is open
  game.board[BOARD_HEIGHT - 2] = [1, 1, 0, 1, 1, 1, 0, 1, 0, 1];

  console.log('Initial Board State:\n' + game.renderBoardCLI());

  const NUM_STEPS = 12;
  console.log(`\n[3/3] Playing ${NUM_STEPS} turns using real-time HTTP System-1 decisions...\n`);

  const stepLatencies = [];

  for (let step = 1; step <= NUM_STEPS; step++) {
    // Pick piece
    const piece = PIECE_NAMES[(step + 2) % PIECE_NAMES.length];
    const candidates = game.generateCandidateMoves(piece);

    if (candidates.length === 0) {
      console.log('Game Over! No legal moves available.');
      break;
    }

    // Build criteria map for candidate choices
    const criteriaMap = {};
    for (const cand of candidates) {
      criteriaMap[cand.id] = cand.description;
    }

    const heights = game.getColumnHeights();
    const currentMaxHeight = Math.max(...heights);

    const httpPayload = {
      model: 'laya-multilingual',
      state: {
        game: 'Tetris',
        turn: step,
        current_piece: piece,
        score: game.score,
        lines_cleared: game.linesCleared,
        max_tower_height: `${currentMaxHeight}/${BOARD_HEIGHT}`,
        board_holes: game.countHoles()
      },
      questions: {
        action: {
          type: 'choice',
          instructions: 'Choose the most strategic move: prioritize clearing lines, keeping the board flat, and avoiding holes.',
          criteria: criteriaMap
        },
        danger: {
          type: 'score',
          instructions: 'Assess the current board danger level',
          criteria: [
            'Safe: board height is low and controlled',
            'Caution: towers rising or multiple holes',
            'Critical Danger: near top ceiling'
          ]
        },
        imminent_loss: {
          type: 'noul',
          instructions: 'Is the game in imminent danger of topping out and losing?',
          threshold: 0.6
        }
      }
    };

    // Make HTTP Request to /v1/systemone
    const t0 = performance.now();
    const response = await fetch(`${url}/v1/systemone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(httpPayload)
    });
    const decisionData = await response.json();
    const latency = performance.now() - t0;
    stepLatencies.push(latency);

    // Extract Laya's decision
    const chosenMoveId = decisionData.answers.action.choice;
    const confidence = (decisionData.answers.action.confidence * 100).toFixed(1);
    const dangerScore = decisionData.answers.danger.score.toFixed(2);
    const lossRisk = decisionData.answers.imminent_loss.noul.toFixed(2);

    const chosenCandidate = candidates.find(c => c.id === chosenMoveId) || candidates[0];

    // Apply move to Tetris board
    game.applyMove(chosenCandidate);

    console.log('-'.repeat(70));
    console.log(`TURN ${step}/${NUM_STEPS} | Piece: [ ${piece} ] | HTTP Latency: ${latency.toFixed(1)} ms`);
    console.log(`Decision: ${chosenCandidate.id} (Confidence: ${confidence}%)`);
    console.log(`Description: ${chosenCandidate.description}`);
    console.log(`Risk Assessment: Danger Score = ${dangerScore}/2.0 | Imminent Loss Risk = ${lossRisk}`);
    console.log(game.renderBoardCLI(piece, chosenCandidate));
  }

  // Summary
  const avgLatency = stepLatencies.reduce((a, b) => a + b, 0) / stepLatencies.length;
  console.log('\n' + '='.repeat(70));
  console.log('                        GAME FINISHED                           ');
  console.log('='.repeat(70));
  console.log(`  Total Turns Played  : ${NUM_STEPS}`);
  console.log(`  Final Score         : ${game.score}`);
  console.log(`  Total Lines Cleared : ${game.linesCleared}`);
  console.log(`  Avg HTTP Latency    : ${avgLatency.toFixed(1)} ms / decision`);
  console.log(`  Fastest Decision    : ${Math.min(...stepLatencies).toFixed(1)} ms`);
  console.log('='.repeat(70));

  close();
  console.log('\n✓ Tetris HTTP server closed cleanly.');
}

main().catch(err => {
  console.error('Tetris agent failed:', err);
  process.exit(1);
});
