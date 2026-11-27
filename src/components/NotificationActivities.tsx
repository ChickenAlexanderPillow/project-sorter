import { CloudUpload, Copy, FolderSync, Layers, Pin, Undo2, Upload } from 'lucide-react';
import type { NotificationActivity } from './notificationActivity';
import './NotificationActivities.css';

export function NotificationActivities({ activities }: { activities: NotificationActivity[] }) {
  if (!activities.length) return null;
  return <section className="notification-activities" aria-label="In progress">
    <div className="notification-activities-heading"><Pin size={11} aria-hidden="true"/><span>In progress</span><span>{activities.length}</span></div>
    <div className="notification-activities-list">{activities.map(activity => {
      const Icon = {copy:Copy,publish:Upload,review:CloudUpload,import:Layers,drive:FolderSync,other:Undo2}[activity.kind];
      return <article key={activity.id} className="notification-activity" aria-label={`${activity.title}: ${activity.context}`}>
        <div className="notification-activity-heading"><Icon size={14} aria-hidden="true"/><strong>{activity.title}</strong>{activity.percent !== null && <span>{Math.floor(activity.percent + 1e-9)}%</span>}</div>
        {activity.context && <p className="notification-activity-context" title={activity.context}>{activity.context}</p>}
        <p className="notification-activity-detail" title={activity.detail}>{activity.detail}</p>
        {activity.percent !== null && <progress className="frameio-upload-progress" value={activity.percent} max={100} aria-label={`${activity.title} progress`}/>}
      </article>;
    })}</div>
  </section>;
}
