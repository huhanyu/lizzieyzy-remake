import type { PositionResult, Report } from './types.ts';

export type TrainingEpisode = {
  id: string; nodeId: string; turn: number; player: string;
  endTurn: number; findings: PositionResult[]; provisional: boolean;
};

// On 19x19, opening is the first 60 moves; smaller boards scale by area.
export const trainingOpeningTurns = (boardSize: number) => Math.ceil(60 * boardSize * boardSize / 361);
export const trainingPhase = (turn: number, boardSize: number) => turn >= Math.ceil(160 * boardSize * boardSize / 361) ? '后盘' : '中盘';

// Unknown probability can all be safe: only its upper bound can establish low tolerance.
export function trainingSignal(p: PositionResult): 'loss' | 'fragile' | null {
  if (!p.input.actualMove) return null;
  const actual = p.distribution.candidates.find(c => c.vertex === p.input.actualMove);
  if ((actual?.scoreLoss ?? 0) >= 3 || (actual?.winLossPp ?? 0) >= 10) return 'loss';
  const safe = p.distribution.candidates.reduce((sum, c) => sum + (c.winLossPp !== null && c.winLossPp <= 5 ? c.probability : 0), 0);
  const ownWin = p.input.player === 'B' ? p.response.rootInfo.winrate : 1 - p.response.rootInfo.winrate;
  // Near-certain lost games have a flat win-loss scale and are not useful low-tolerance targets.
  return ownWin >= .1 && safe + p.distribution.unknown <= .4 ? 'fragile' : null;
}

function recovered(p: PositionResult): boolean {
  return !trainingSignal(p) && p.distribution.candidates.reduce((sum, c) => sum + (c.winLossPp !== null && c.winLossPp <= 5 ? c.probability : 0), 0) >= .8;
}

export function trainingEpisodes(report: Report | null): TrainingEpisode[] {
  if (!report || !['training', 'scan'].includes(report.request.mode)) return [];
  const episodes: TrainingEpisode[] = [];
  for (const player of ['B', 'W']) {
    let current: TrainingEpisode | null = null, recovery = 0;
    const positions = [...report.positions].filter(p => p.input.player === player && p.input.turn >= trainingOpeningTurns(p.input.boardSize)).sort((a,b) => a.input.turn-b.input.turn);
    for (const p of positions) {
      if (!trainingSignal(p)) {
        recovery = recovered(p) ? recovery + 1 : 0;
        if (recovery >= 3) current = null;
        continue;
      }
      recovery = 0;
      // Bound both the gap and total span, so chaining cannot merge an entire game.
      if (!current || p.input.turn - (current.endTurn - 1) > 8 || p.input.turn - current.turn > 20) {
        current = {id: `${report.documentHash}:${p.input.nodeId}`, nodeId:p.input.nodeId, turn:p.input.turn, player,
          endTurn:p.input.turn+1, findings:[], provisional:report.status !== 'complete' || !report.cleanupConfirmed};
        episodes.push(current);
      }
      current.findings.push(p);
      current.endTurn = p.input.turn+1;
    }
  }
  return episodes.sort((a,b) => a.turn-b.turn || a.player.localeCompare(b.player));
}
