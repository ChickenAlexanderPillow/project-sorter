import {invoke} from '@tauri-apps/api/core';

/** Deduplicate access checks; retries stay possible after a missing/offline file. */
export function createPreviewPreparation(check:(path:string)=>Promise<void>,limit=64) {
  const entries=new Map<string,{promise:Promise<void>;ready:boolean}>();
  return {
    isPrepared:(path:string)=>entries.get(path)?.ready??false,
    prepare(path:string):Promise<void> {
      const existing=entries.get(path);
      if(existing){entries.delete(path);entries.set(path,existing);return existing.promise;}
      const entry={promise:Promise.resolve(),ready:false};
      entry.promise=check(path).then(()=>{entry.ready=true;}).catch(error=>{
        if(entries.get(path)===entry)entries.delete(path);
        throw error;
      });
      entries.set(path,entry);
      if(entries.size>limit)entries.delete(entries.keys().next().value!);
      return entry.promise;
    },
  };
}
export const previewPreparation=createPreviewPreparation(path=>invoke<void>('media_prepare_preview',{path}));
