import { useEffect,useRef,useState } from 'react';
import type { ToleranceController } from '../hooks/useToleranceReview';
import { defaultConfig,type ReviewConfig,type PositionResult,type Branch } from '../domain/tolerance/types';
import { lossSummary } from '../domain/tolerance/metrics';
import { exportTolerance,loadToleranceConfig,loadTrainingConfig,saveToleranceConfig } from '../api/toleranceReview';
import { replaySgfPositionAtNode,saveSgfDocument,isTauriRuntime } from '../api/backend';
import type { EngineProfileDto,PositionDto } from '../domain/types';
import type { RemoteEngineConfig } from '../api/engineTools';
import { trainingEpisodes,trainingPhase,type TrainingEpisode } from '../domain/tolerance/training';
import { TrainingPositionPreview } from './TrainingPositionPreview';
import { BoardCanvas } from './BoardCanvas';
import './ToleranceReviewPanel.css';
const percent=(v:number)=>`${(v*100).toFixed(1)}%`;
const number=(v:number|null|undefined)=>v==null?'未知':v.toFixed(2);
function savedConfig():ReviewConfig{try{return {...defaultConfig,...JSON.parse(localStorage.getItem('tolerance-config-v1')||'null')};}catch{return {...defaultConfig};}}
export function ToleranceReviewPanel({controller:c,nodeId,onNodeSelect,disabled,profile,remote,onStartTraining,onSaveTraining}:{controller:ToleranceController;nodeId:string|null;onNodeSelect:(id:string)=>void;disabled:boolean;profile:EngineProfileDto|null;remote:RemoteEngineConfig|null;onStartTraining:(episode:TrainingEpisode,config:ReviewConfig)=>Promise<void>;onSaveTraining?:()=>Promise<void>}){
  const [config,setConfig]=useState(savedConfig),[metric,setMetric]=useState<'score'|'win'>('score'),[safe,setSafe]=useState(1),[bad,setBad]=useState(3),[alternatives,setAlternatives]=useState(''),[chosen,setChosen]=useState<string|null>(null),[branchIndex,setBranchIndex]=useState(0),[message,setMessage]=useState('');
  const changed=useRef(false);
  const [preparing,setPreparing]=useState(false),[starting,setStarting]=useState(false),[loaded,setLoaded]=useState(!isTauriRuntime());
  useEffect(()=>{let active=true;if(isTauriRuntime())void loadToleranceConfig().then(v=>{if(active&&!changed.current&&v)setConfig(v);}).catch(e=>setMessage(String(e))).finally(()=>{if(active)setLoaded(true);});return()=>{active=false;};},[]);
  const report=c.report;
  useEffect(()=>{try{localStorage.setItem('tolerance-config-v1',JSON.stringify(config));}catch{}},[config]);
  useEffect(()=>{setChosen(nodeId);},[nodeId]);
  const position=report?.positions.find(p=>p.input.nodeId===chosen)??report?.positions.find(p=>p.input.nodeId===nodeId)??report?.positions[0];
  const branch=report?.branches[branchIndex];
  const set=(patch:Partial<ReviewConfig>)=>{changed.current=true;setConfig(old=>({...old,...patch}));};
  const run=(mode:'position'|'scan'|'compare')=>{setMessage('');if(isTauriRuntime())void saveToleranceConfig(config).catch(e=>setMessage(String(e)));void c.start(mode,config,alternatives.split(/[\s,，]+/).filter(Boolean).map(s=>s.toLowerCase()==='pass'?'pass':s.toUpperCase()));};
  const episodes=trainingEpisodes(report);
  async function extract(){
    if(preparing||c.busy)return;setPreparing(true);setMessage('');
    try{
      const cfg=await loadTrainingConfig();
      if(!cfg)throw new Error('尚未保存远端训练配置，请先配置 SSH 分析引擎。');
      await c.start('training',cfg);
    }catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setPreparing(false);}
  }
  async function train(episode:TrainingEpisode){
    if(!report||starting)return;setStarting(true);setMessage('');
    try{const cfg=await loadTrainingConfig();if(!cfg)throw new Error('尚未保存远端训练配置');await onStartTraining(episode,cfg);}catch(e){setMessage(String(e));}finally{setStarting(false);}
  }
  return <section className="tolerance-panel" aria-label="局面训练">
    <header><strong>局面训练</strong><span>从棋谱中的关键问题段开始续弈</span></header>
    <p className="tolerance-note">提取中盘与后盘局面，跳过开局。相邻问题归并为一个起点，训练时隐藏原谱后续和分析提示。</p>
    <p className="tolerance-note">使用已保存的远端训练引擎，后台完成分析与续弈。</p>
    <div className="tolerance-actions"><button className="training-primary" disabled={disabled||preparing||starting||!loaded} onClick={()=>void extract()}>{preparing&&!c.busy?'准备训练引擎…':'提取训练局面'}</button>{c.busy&&<button onClick={()=>void c.cancel()}>取消并保留结果</button>}{onSaveTraining&&<button disabled={disabled||preparing||starting} onClick={()=>void onSaveTraining().catch(e=>setMessage(String(e)))}>另存上次训练棋谱</button>}</div>
    {(message||c.error)&&<p role="status">{message||c.error}</p>}
    {report?.error&&<p role="alert">{report.error}</p>}
    {report&&<p role="status">{c.busy?`${report.phase} · ${report.completed}/${report.total}`:report.status==='complete'&&['training','scan'].includes(report.request.mode)?`提取结果：${episodes.length} 个起点`:report.request.mode==='training'||report.request.mode==='scan'?'提取未完成，以下为暂存局面':'高级分析结果已保留，可提取全盘训练局面'}</p>}
    {c.busy&&report&&<progress max={Math.max(1,report.total)} value={report.completed}/>}
    <div className="training-episodes">{episodes.map((episode,i)=><article className="training-card" key={episode.id}>
      <TrainingPositionPreview sgfText={report!.request.sgfText} nodeId={episode.nodeId} turn={episode.turn}/>
      <div className="training-card-content">
      <strong>局面 {i+1} · {trainingPhase(episode.turn,episode.findings[0].input.boardSize)} · 第 {episode.turn+1} 手前 · 执{episode.player==='B'?'黑':'白'}</strong>
      <p>问题段：第 {episode.turn+1}{episode.endTurn>episode.turn+1?`–${episode.endTurn}`:''} 手 · 合并 {episode.findings.length} 个问题点{episode.provisional?' · 暂存，未完成全盘提取':''}</p>
      <div><button disabled={disabled||preparing||starting} onClick={()=>void train(episode)}>开始训练</button><button disabled={disabled||preparing||starting} onClick={()=>onNodeSelect(episode.nodeId)}>查看起点</button></div>
      <details><summary>查看识别依据</summary>{episode.findings.map(p=><p key={p.input.nodeId}>第 {p.input.turn+1} 手 {p.input.actualMove} · {p.stage==='deep'?'已加深':'粗扫'}{p.distribution.candidates.find(m=>m.vertex===p.input.actualMove)?.scoreLoss!=null?` · 目损失 ${number(p.distribution.candidates.find(m=>m.vertex===p.input.actualMove)?.scoreLoss)}`:''}</p>)}</details>
      </div>
    </article>)}</div>
    {report?.status==='complete'&&['training','scan'].includes(report.request.mode)&&!episodes.length&&<p>本次预算下没有发现符合条件的中盘或后盘训练起点。</p>}
    <details className="training-advanced"><summary>高级分析与设置</summary>
    <details><summary>分析模型与算力 · {config.source==='ssh'?'SSH 远端':'本地'} · {config.humanProfile}</summary>
      <fieldset disabled={c.busy} className="tolerance-config">
        <label>算力<select value={config.source} onChange={e=>set({source:e.target.value as ReviewConfig['source']})}><option value="ssh">SSH 远端</option><option value="local">本地</option><option value="cloud" disabled>智子云（未提供完整 HumanSL 响应）</option></select></label>
        <button type="button" onClick={()=>{if(remote)set({source:'ssh',enginePath:remote.enginePath,modelPath:remote.modelPath,configPath:remote.configPath,sshRoute:[{host:remote.host,user:remote.user??null,port:remote.port??null}],identityFile:remote.identityFile??null});else if(profile)set({source:'local',enginePath:profile.engine_path,modelPath:profile.model_path??'',configPath:profile.config_path??'',workingDir:profile.working_dir??null});}}>沿用当前引擎路径</button>
        {(['enginePath','modelPath','humanModelPath','configPath'] as const).map((key,i)=><label key={key}>{['KataGo 可执行文件','局面评估模型（如 TF11）','HumanSL 人类模型','分析配置文件'][i]}<input value={config[key]} onChange={e=>set({[key]:e.target.value})}/></label>)}
        <label>工作目录<input value={config.workingDir??''} onChange={e=>set({workingDir:e.target.value||null})}/></label>
        {config.source==='ssh'&&<><p>按本机 → 目标机的顺序配置。多跳使用已有 SSH agent 转发；各跳须已信任主机密钥，目标机需 Python 3。</p>
          {config.sshRoute.map((h,i)=><div className="tolerance-hop" key={i}><input aria-label={`第 ${i+1} 跳主机`} placeholder="SSH 主机或别名" value={h.host} onChange={e=>set({sshRoute:config.sshRoute.map((v,j)=>j===i?{...v,host:e.target.value}:v)})}/><input aria-label={`第 ${i+1} 跳用户`} placeholder="用户（可选）" value={h.user??''} onChange={e=>set({sshRoute:config.sshRoute.map((v,j)=>j===i?{...v,user:e.target.value||null}:v)})}/><input aria-label={`第 ${i+1} 跳端口`} type="number" placeholder="22" min={1} max={65535} value={h.port??''} onChange={e=>set({sshRoute:config.sshRoute.map((v,j)=>j===i?{...v,port:e.target.value?Number(e.target.value):null}:v)})}/><button onClick={()=>set({sshRoute:config.sshRoute.filter((_,j)=>j!==i)})}>移除</button></div>)}
          <button disabled={config.sshRoute.length>=4} onClick={()=>set({sshRoute:[...config.sshRoute,{host:'',user:null,port:null}]})}>添加 SSH 跳点</button>
          <label>本机私钥路径（可选）<input value={config.identityFile??''} onChange={e=>set({identityFile:e.target.value||null})}/></label>
          <label><input type="checkbox" checked={config.useAgentIdentities} onChange={e=>set({useAgentIdentities:e.target.checked})}/>允许使用 agent 中的身份</label></>}
        <label>人类棋力<select value={config.humanProfile} onChange={e=>set({humanProfile:e.target.value})}><option value="proyear_2023">职业风格（2023）</option>{[9,7,5,3,1].map(n=><option key={n} value={`rank_${n}d`}>{n} 段</option>)}{[1,5,10,15,20].map(n=><option key={n} value={`rank_${n}k`}>{n} 级</option>)}</select></label>
        {(['screenVisits','deepVisits','minCandidateVisits','maxDeepPositions','maxSupplementalMoves','maxAlternatives','futureDecisions'] as const).map((key,i)=><label key={key}>{['粗扫访问预算','加深访问预算','可信候选最低访问','全盘加深局面上限','每局面补搜上限','替代走法上限（1–3）','后续己方决策（1–3）'][i]}<input type="number" min={key==='maxSupplementalMoves'||key==='maxDeepPositions'?0:1} value={config[key]} onChange={e=>set({[key]:Number(e.target.value)})}/></label>)}
        <label>目标覆盖率<input type="number" min={.5} max={.999} step={.01} value={config.targetCoverage} onChange={e=>set({targetCoverage:Number(e.target.value)})}/></label>
        <button type="button" onClick={()=>{if(isTauriRuntime())void saveToleranceConfig(config).then(()=>setMessage("容错引擎设置已保存。")).catch(e=>setMessage(String(e)));else setMessage("预览设置已保存在此浏览器。");}}>保存容错配置</button>
      </fieldset>
    </details>
    <div className="tolerance-actions"><button disabled={disabled||c.busy} onClick={()=>run('position')}>分析当前局面</button><button disabled={disabled||c.busy} onClick={()=>run('scan')}>扫描全盘</button><button disabled={disabled||c.busy} onClick={()=>run('compare')}>比较后续容错</button>{c.busy&&<button onClick={()=>void c.cancel()}>取消并保留结果</button>}</div>
    <label>指定替代走法（可选，最多 3 个，如 J4 L9）<input disabled={c.busy} value={alternatives} onChange={e=>setAlternatives(e.target.value)} placeholder="留空自动选近等值候选"/></label>
    <p className="tolerance-note">分析的是当前节点之后的决策。职业档位表示落点风格代理；后续分支是代表性变化。低容错不能单独证明此前走法有误。</p>
    {c.error&&<p role="alert">{c.error}</p>}{message&&<p role="status">{message}</p>}
    {report&&<><p role="status">{({starting:'准备中',running:'运行中',complete:'已完成',cancelled:'已取消',failed:'失败',interrupted:'已中断'} as Record<string,string>)[report.status]??report.status} · {report.phase} · {report.completed}/{report.total} · 查询 {report.queryCount} · 缓存 {report.cacheHits}</p><progress max={Math.max(1,report.total)} value={report.completed}/>
      {report.error&&<p role="alert">{report.error}</p>}
      <div className="tolerance-actions"><button disabled={c.busy} onClick={()=>void exportTolerance(report).catch(e=>setMessage(String(e)))}>导出完整 JSON</button>{report.identity&&<span title={JSON.stringify(report.identity,null,2)}>模型指纹 {report.identity.modelSha256.slice(0,12)} · {report.request.config.humanProfile}</span>}</div>
      <p className="tolerance-note">本次任务预算：粗扫 {report.request.config.screenVisits} / 加深 {report.request.config.deepVisits}；可信候选至少 {report.request.config.minCandidateVisits} 次访问。</p>
      <div className="tolerance-thresholds"><label>损失口径<select value={metric} onChange={e=>{const m=e.target.value as 'score'|'win';setMetric(m);setSafe(m==='score'?1:5);setBad(m==='score'?3:10);}}><option value="score">目差</option><option value="win">胜率百分点</option></select></label><label>可接受 ≤<input type="number" min={0} step={.5} value={safe} onChange={e=>setSafe(Math.max(0,Number(e.target.value)))}/></label><label>大损失 ≥<input type="number" min={0} step={.5} value={bad} onChange={e=>setBad(Math.max(0,Number(e.target.value)))}/></label></div>
      {!!report.positions.length&&<div className="tolerance-timeline" aria-label="全盘容错时间轴">{[...report.positions].sort((a,b)=>a.input.turn-b.input.turn).map(p=>{const s=lossSummary(p.distribution,metric,safe,bad);return <button key={p.input.nodeId} aria-pressed={position?.input.nodeId===p.input.nodeId} title={`第 ${p.input.turn+1} 手前 · 可接受 ${percent(s.good)} · 未知 ${percent(s.unknown)}`} onClick={()=>{setChosen(p.input.nodeId);if(!c.busy)onNodeSelect(p.input.nodeId);}}><span>{p.input.turn+1}</span><i style={{height:`${Math.max(2,s.good*50)}px`}}/></button>;})}</div>}
      {position&&<DistributionView p={position} metric={metric} safe={safe} bad={bad}/>}
      {!!report.branches.length&&<><h4>后续分支对照</h4><p className="tolerance-note">每条路线最多两种合理对手应手，再看后续己方决策。应手概率是第一步的 HumanSL 概率，未探索应手不计入结果。</p>
        <div className="tolerance-table"><table><thead><tr><th>首手 / 对手应手</th><th>首手损失（目 / pp）</th><th>应手概率</th><th>后续可接受质量</th><th>未知最大值</th></tr></thead><tbody>{report.branches.map((b,i)=>{const values=b.states.map(p=>lossSummary(p.distribution,metric,safe,bad));return <tr key={`${b.rootMove}-${b.opponentReply}`}><td><button aria-pressed={branchIndex===i} onClick={()=>setBranchIndex(i)}>{b.rootMove}{b.isActual?'（实战）':''} → {b.opponentReply}</button></td><td>{number(b.rootScoreLoss)} / {number(b.rootWinLossPp)}</td><td>{percent(b.opponentProbability)}</td><td>{values.map(s=>percent(s.good)).join(' → ')}</td><td>{percent(Math.max(...values.map(s=>s.unknown)))}</td></tr>;})}</tbody></table></div>
        {branch&&<BranchPreview branch={branch} onError={setMessage}/>}
      </>}
    </>}
    </details>
  </section>;
}
function DistributionView({p,metric,safe,bad}:{p:PositionResult;metric:'score'|'win';safe:number;bad:number}){
  const [all,setAll]=useState(false);const d=p.distribution,s=lossSummary(d,metric,safe,bad);
  const edges=metric==='score'?[0,1,2,3,5,10,Infinity]:[0,5,10,20,40,60,Infinity];
  const bins=edges.slice(0,-1).map((low,i)=>({label:`${low}–${edges[i+1]===Infinity?'∞':edges[i+1]}`,p:d.candidates.reduce((sum,c)=>{const v=metric==='score'?c.scoreLoss:c.winLossPp;return sum+(v!==null&&v>=low&&v<edges[i+1]?c.probability:0);},0)}));
  return <div className="tolerance-distribution"><h4>第 {p.input.turn+1} 手前 · {p.input.player==='B'?'黑':'白'}方 · 实战 {p.input.actualMove??'无后续'} · {p.stage==='deep'?'已加深':'粗扫'}</h4>
    <div className="tolerance-kpis"><span>可接受 <b>{percent(s.good)}</b></span><span>大损失 <b>{percent(s.tail)}</b></span><span>未知 <b>{percent(s.unknown)}</b></span><span>已知部分期望损失 <b>≥ {s.expected.toFixed(2)}</b></span></div>
    <p className="tolerance-note">损失基准：{metric==='score'?d.referenceScoreMove:d.referenceWinMove}。候选不足最低访问量视为未知；概率始终以全部合法落点为分母。</p>
    <div className="tolerance-histogram" aria-label="概率加权损失分布">{[...bins,{label:'未知',p:s.unknown}].map(b=><div key={b.label}><span>{percent(b.p)}</span><i style={{height:`${b.p*100}px`}}/><small>{b.label}</small></div>)}</div>
    <div className="tolerance-table"><table><thead><tr><th>落点</th><th>HumanSL 概率</th><th>访问</th><th>目损失</th><th>胜率损失 pp</th></tr></thead><tbody>{d.candidates.slice(0,all?undefined:12).map(m=><tr key={m.vertex}><td>{m.vertex}{m.vertex===p.input.actualMove?'（实战）':''}</td><td>{percent(m.probability)}</td><td>{m.visits}</td><td>{number(m.scoreLoss)}</td><td>{number(m.winLossPp)}</td></tr>)}</tbody></table></div><button onClick={()=>setAll(!all)}>{all?'收起':'展开全部合法落点'}</button>
  </div>;
}
function BranchPreview({branch,onError}:{branch:Branch;onError:(s:string)=>void}){
  const [step,setStep]=useState(0),[position,setPosition]=useState<PositionDto|null>(null);
  useEffect(()=>setStep(0),[branch.rootMove,branch.opponentReply]);
  const index=Math.min(step,branch.nodeIds.length-1);
  useEffect(()=>{let active=true;setPosition(null);if(!isTauriRuntime())return;void replaySgfPositionAtNode(branch.sgfText,branch.nodeIds[index]).then(p=>{if(active)setPosition(p);}).catch(e=>{if(active)onError(String(e));});return()=>{active=false;};},[branch.sgfText,branch.nodeIds[index]]);
  return <div className="tolerance-branch"><p>变化预览 · {branch.line.map(([c,m])=>`${c} ${m}`).join(' → ')}</p><input aria-label="变化步数" type="range" min={0} max={branch.nodeIds.length-1} value={index} onChange={e=>setStep(Number(e.target.value))}/><span>第 {index} 步</span>{!isTauriRuntime()&&<p>原生变化棋盘请在桌面应用中查看。</p>}{position&&<BoardCanvas position={position} showCandidates={false}/>}
    <button onClick={()=>void saveSgfDocument(null,branch.sgfText,`tolerance-${branch.rootMove}-${branch.opponentReply}.sgf`).catch(e=>onError(String(e)))}>另存含此变化的棋谱</button></div>;
}
