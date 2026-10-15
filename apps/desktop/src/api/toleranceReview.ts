import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import type { Report, Request, ReviewEvent, ReviewConfig } from '../domain/tolerance/types';
import { isTauriRuntime } from './backend';
export const loadTolerance=(sgfText:string)=>invoke<Report|null>('tolerance_load',{sgfText,jobId:null});
export const cancelTolerance=(jobId:string)=>invoke<void>('tolerance_cancel',{jobId});
export const startTolerance=(jobId:string,request:Request)=>invoke<void>('tolerance_start',{jobId,request});
export const listenTolerance=(callback:(event:ReviewEvent)=>void)=>listen<ReviewEvent>('tolerance://progress',e=>callback(e.payload));
export async function exportTolerance(report:Report){
  const text=JSON.stringify(report,null,2);
  if(isTauriRuntime()) {const path=await save({defaultPath:'tolerance-review.json',filters:[{name:'容错复盘 JSON',extensions:['json']}]});if(path)await invoke('tolerance_export',{path,reportJson:text});}
  else {const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='tolerance-review.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}

export const loadToleranceConfig=()=>invoke<ReviewConfig|null>("tolerance_config_load");
export const loadTrainingConfig=()=>invoke<ReviewConfig|null>("training_config_load");
export const saveToleranceConfig=(config:ReviewConfig)=>invoke<void>("tolerance_config_save",{config});
