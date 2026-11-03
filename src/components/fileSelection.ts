/** Selection follows the visible section order, including across dividers. */
export function selectFilePaths(current:string[], ordered:string[], path:string, anchor:string|null, extend=false, toggle=false):string[] {
  const allowed=new Set(ordered);
  const selected=current.filter(item=>allowed.has(item));
  if(extend&&anchor&&allowed.has(anchor)) {
    const a=ordered.indexOf(anchor),b=ordered.indexOf(path);
    const range=ordered.slice(Math.min(a,b),Math.max(a,b)+1);
    return toggle?[...new Set([...selected,...range])]:range;
  }
  return toggle?(selected.includes(path)?selected.filter(item=>item!==path):[...selected,path]):[path];
}
