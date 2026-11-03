export type PreviewLayer={id:number;source:string;ready:boolean;failed:boolean};
export type PreviewAction={type:'request';id:number;source:string}|{type:'ready'|'failed'|'settled';id:number};
export function previewLayers(layers:PreviewLayer[],action:PreviewAction):PreviewLayer[] {
  if(action.type==='request')return [...layers.filter(layer=>layer.ready).slice(-1),{id:action.id,source:action.source,ready:false,failed:false}];
  if(!layers.some(layer=>layer.id===action.id))return layers;
  if(action.type==='settled')return layers.filter(layer=>layer.id>=action.id);
  // Late decoder events must never reveal a file that was abandoned.
  if(layers[layers.length-1]?.id!==action.id)return layers;
  const selected=layers[layers.length-1];
  if(selected.ready&&selected.failed===(action.type==='failed'))return layers;
  return layers.map(layer=>layer.id===action.id?{...layer,ready:true,failed:action.type==='failed'}:layer);
}
