/** Whole-second timecodes. Read older millisecond/frame values without requiring a migration. */
export function parseNoteTime(value: string): number | null {
  const frames=value.trim().match(/^(\d+):([0-5]\d):([0-5]\d):([0-2]\d)$/);
  if(frames)return +frames[4]<25?Math.floor(+frames[1]*3600 + +frames[2]*60 + +frames[3] + +frames[4]/25):null;
  const parts=value.trim().match(/^(?:(\d+):)?([0-5]?\d):([0-5]\d)(?:\.(\d{1,3}))?$/);
  return parts?Math.floor(+(parts[1]||0)*3600 + +parts[2]*60 + +parts[3] + Number(`0.${parts[4]||0}`)):null;
}
export function formatNoteTime(seconds: number): string {
  const whole=Math.floor(Math.max(0,Number.isFinite(seconds)?seconds:0));
  return `${String(Math.floor(whole/3600)).padStart(2,'0')}:${String(Math.floor(whole/60)%60).padStart(2,'0')}:${String(whole%60).padStart(2,'0')}`;
}
export function validNoteRange(start: number | null, end: number | null, duration: number): boolean {
  return start!==null&&Number.isInteger(start)&&start>=0&&start<=duration&&(end===null||(Number.isInteger(end)&&end>start&&end<=duration));
}
