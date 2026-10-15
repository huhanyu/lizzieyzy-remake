import React from 'react';
import {createRoot} from 'react-dom/client';
import {ToleranceReviewPanel} from '../src/components/ToleranceReviewPanel';
import type {Report} from '../src/domain/tolerance/types';
import data from './fixtures/tolerance/preview-report.json';
import '../src/styles.css';
const report=data as unknown as Report;
const controller={busy:false,busyRef:{current:false},report,error:'',start:async()=>{},cancel:async()=>{}};
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:1000,margin:'20px auto'}}><h2>真实远端数据回放 · UI 验证</h2><p>此页仅用于展示已记录的 waffle 结果，不启动引擎；小棋盘按主线回放；训练与文件保存需原生应用验收。</p><ToleranceReviewPanel controller={controller} nodeId={report.request.anchorNodeId} onNodeSelect={()=>{}} disabled={true} profile={null} remote={null} onStartTraining={async()=>{throw new Error('请在桌面应用中训练');}}/></main>);
