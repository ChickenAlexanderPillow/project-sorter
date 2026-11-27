import { useSyncExternalStore } from 'react';
import { getBackgroundActivities, subscribeBackgroundActivities } from './notificationActivity';
export function useBackgroundActivities() {
  return useSyncExternalStore(subscribeBackgroundActivities, getBackgroundActivities, getBackgroundActivities);
}
