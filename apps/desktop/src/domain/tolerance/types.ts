export type ReviewConfig = {
  source: 'ssh'|'local'; enginePath:string; modelPath:string; humanModelPath:string; configPath:string;
  workingDir:string|null; sshRoute:{host:string;user:string|null;port:number|null}[];identityFile:string|null;useAgentIdentities:boolean;
  humanProfile:string;screenVisits:number;deepVisits:number;minCandidateVisits:number;targetCoverage:number;
  maxSupplementalMoves:number;maxDeepPositions:number;maxAlternatives:number;futureDecisions:number;
};
export type Request = {sgfText:string;anchorNodeId:string;mode:'position'|'scan'|'compare'|'training';config:ReviewConfig;alternatives:string[]};
export type Candidate = {vertex:string;probability:number;visits:number;scoreLoss:number|null;winLossPp:number|null;scoreBlack:number|null;winrateBlack:number|null;order:number|null;pv:string[]};
export type Distribution = {referenceScoreMove:string|null;referenceWinMove:string|null;coverage:number;unknown:number;candidates:Candidate[]};
export type PositionResult = {input:{nodeId:string;turn:number;player:string;actualMove:string|null;boardSize:number};stage:string;distribution:Distribution;response:{rootInfo:{visits:number;winrate:number;scoreLead:number|null;scoreMean:number|null};[key:string]:unknown}};
export type Branch = {rootMove:string;isActual:boolean;rootScoreLoss:number|null;rootWinLossPp:number|null;opponentReply:string;opponentProbability:number;states:PositionResult[];line:[string,string][];sgfText:string;nodeIds:string[]};
export type Report = {format:'lizzieyzy-tolerance-v1';algorithm:'human-loss-v1';jobId:string;documentHash:string;request:Request;identity:{engineVersion:string;engineSha256:string;modelSha256:string;humanModelSha256:string;configSha256:string;cacheSafe:boolean}|null;status:string;phase:string;completed:number;total:number;queryCount:number;cacheHits:number;positions:PositionResult[];branches:Branch[];error:string|null;cleanupConfirmed:boolean;updatedAt:number};
export type ReviewEvent = Pick<Report,'jobId'|'documentHash'|'status'|'phase'|'completed'|'total'|'queryCount'|'cacheHits'|'error'|'cleanupConfirmed'> & {position:PositionResult|null;branch:Branch|null};
export const defaultConfig:ReviewConfig={source:'ssh',enginePath:'',modelPath:'',humanModelPath:'',configPath:'',workingDir:null,sshRoute:[],identityFile:null,useAgentIdentities:false,humanProfile:'proyear_2023',screenVisits:2048,deepVisits:8192,minCandidateVisits:128,targetCoverage:.97,maxSupplementalMoves:8,maxDeepPositions:8,maxAlternatives:2,futureDecisions:3};
