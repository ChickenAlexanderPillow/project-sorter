function formatDate(raw?: string | null, full = false) {
  if (!raw) return 'Unavailable';
  try {
    const date = new Date(Number(BigInt(raw)) / 1e6);
    if (Number.isNaN(date.getTime())) return 'Unavailable';
    return new Intl.DateTimeFormat(undefined, full
      ? { dateStyle: 'medium', timeStyle: 'short' }
      : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  } catch { return 'Unavailable'; }
}

export function MediaFileDates({ created, modified, className }: { created?: string | null; modified?: string | null; className: string }) {
  return <dl className={`ig-file-dates ${className}`}>
    {([['Created', created], ['Modified', modified]] as const).map(([label, raw]) =>
      <div key={label}><dt>{label}</dt><dd title={`${label} ${formatDate(raw, true)}`}>{formatDate(raw)}</dd></div>
    )}
  </dl>;
}
