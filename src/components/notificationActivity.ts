export type NotificationActivity = {
  id: string; kind: 'copy' | 'publish' | 'review' | 'import' | 'drive' | 'other';
  title: string; context: string; detail: string; percent: number | null;
};
export const activityPercent = (completed: number | undefined, total: number | undefined) =>
  total && total > 0 && completed !== undefined && Number.isFinite(completed) && Number.isFinite(total)
    ? Math.max(0, Math.min(100, completed / total * 100)) : null;

const activities = new Map<string, NotificationActivity>();
let snapshot: NotificationActivity[] = [];
const listeners = new Set<() => void>();
const changed = () => { snapshot = [...activities.values()]; listeners.forEach(listener => listener()); };
export function reportBackgroundActivity(activity: NotificationActivity) { activities.set(activity.id, activity); changed(); }
export function finishBackgroundActivity(id: string) { if (activities.delete(id)) changed(); }
export const getBackgroundActivities = () => snapshot;
export function subscribeBackgroundActivities(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
