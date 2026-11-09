export type MediaHealthStatus = 'missing' | 'unavailable' | 'local' | 'moved' | 'copied' | 'unknown' | 'found';

// Accessible local media still needs attention: another editor cannot use it
// from the NAS. Only accessible network media belongs in the healthy list.
export function statusFor(status: string): MediaHealthStatus {
  if (status.startsWith('missing_')) return 'missing';
  if (status.startsWith('unavailable_')) return 'unavailable';
  if (status === 'available_local') return 'local';
  if (status === 'available_after_season_move') return 'moved';
  if (status === 'copied_to_nas') return 'copied';
  if (status === 'available_nas') return 'found';
  return 'unknown';
}
