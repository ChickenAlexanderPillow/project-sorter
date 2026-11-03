import { invoke } from '@tauri-apps/api/core';

let active=false;
export const isNativeFileDragActive=()=>active;
export async function startNativeFileDrag(clientPath:string,paths:string[]) {
  if(active)return;
  active=true;
  try {return await invoke<'dropped'|'cancelled'>('client_files_start_drag',{clientPath,paths});}
  finally {active=false;}
}
