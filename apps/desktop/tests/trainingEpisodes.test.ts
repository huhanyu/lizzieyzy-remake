import test from 'node:test';
import assert from 'node:assert/strict';
import {trainingEpisodes,trainingSignal,trainingOpeningTurns,trainingPhase} from '../src/domain/tolerance/training.ts';
import type {PositionResult,Report} from '../src/domain/tolerance/types.ts';
function p(move:number,loss:number,safe=.95,unknown=.02,player='B',winLoss=loss>=3?15:0):PositionResult{
 return {input:{nodeId:`node-${move}`,turn:move-1,player,actualMove:'A1',boardSize:19},stage:'deep',response:{rootInfo:{visits:8192,winrate:.6,scoreLead:0,scoreMean:null}},distribution:{referenceScoreMove:'B1',referenceWinMove:'B1',coverage:1-unknown,unknown,candidates:[{vertex:'A1',probability:.001,visits:256,scoreLoss:loss,winLossPp:winLoss,scoreBlack:0,winrateBlack:.4,order:1,pv:[]},{vertex:'B1',probability:safe,visits:1024,scoreLoss:0,winLossPp:0,scoreBlack:loss,winrateBlack:.6,order:0,pv:[]},{vertex:'C1',probability:1-safe-unknown-.001,visits:256,scoreLoss:5,winLossPp:20,scoreBlack:-5,winrateBlack:.4,order:2,pv:[]}]}};
}
function report(positions:PositionResult[],status='complete'):Report{return {documentHash:'sgf-hash',positions,status,cleanupConfirmed:true,request:{mode:'training'}} as Report;}
test('131–141 is one episode beginning after move 130, despite the safe move 137',()=>{
 const r=report([p(129,0),p(131,8.98),p(133,4.83,.51),p(135,1.74,.2869,.0755,'B',14.989),p(137,0,.9814,.0077),p(139,.424,.1821,.091),p(141,2.26,.2717,.0933,'B',40.624)]);
 const episodes=trainingEpisodes(r);assert.equal(episodes.length,1);assert.equal(episodes[0].turn,130);assert.equal(episodes[0].endTurn,141);assert.deepEqual(episodes[0].findings.map(v=>v.input.turn+1),[131,133,135,139,141]);
});
test('unknown mass alone never creates low tolerance and a later observed collapse is not substituted for an earlier risk',()=>{
 assert.equal(trainingSignal(p(9,0,.1,.8)),null);
 const e=trainingEpisodes(report([p(71,0,.25,.1),p(73,8)]));assert.equal(e[0].turn,70);
});
test('players, sustained recovery, long gaps and long spans create separate starts',()=>{
 assert.equal(trainingEpisodes(report([p(71,4),p(72,5,.95,.02,'W')])).length,2);
 assert.equal(trainingEpisodes(report([p(71,4),p(73,0),p(75,0),p(77,0),p(79,4)])).length,2);
 assert.equal(trainingEpisodes(report([p(71,4),p(81,4)])).length,2);
 assert.equal(trainingEpisodes(report([71,77,83,89,95].map(n=>p(n,4)))).length,2);
});
test('no qualifying positions produces no exercises; cancelled output remains provisional',()=>{
 assert.deepEqual(trainingEpisodes(report([p(71,0)])),[]);
 assert.equal(trainingEpisodes(report([p(71,4)],'cancelled'))[0].provisional,true);
 assert.deepEqual(trainingEpisodes({...report([p(71,4)]),request:{mode:'position'}} as Report),[]);
});

test('opening is omitted before grouping; midgame starts at the first eligible decision and smaller boards scale',()=>{
 const episodes=trainingEpisodes(report([p(16,5),p(58,5),p(61,5),p(63,4),p(165,4)]));
 assert.deepEqual(episodes.map(e=>e.turn+1),[61,165]);
 assert.deepEqual(episodes[0].findings.map(p=>p.input.turn+1),[61,63]);
 assert.equal(trainingOpeningTurns(19),60);assert.equal(trainingOpeningTurns(9),14);
 const small=[p(14,4),p(15,4)];small.forEach(p=>p.input.boardSize=9);
 assert.equal(trainingEpisodes(report(small))[0].turn,14);
 assert.equal(trainingPhase(60,19),'中盘');assert.equal(trainingPhase(160,19),'后盘');
});
