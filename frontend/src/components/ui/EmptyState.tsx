import { ReactNode } from 'react';

export function EmptyState({ title, description, action, icon }: { title: string; description: string; action?: ReactNode; icon?: string }) {
  return (
    <article className="empty-state-panel">
      {icon ? <span>{icon}</span> : null}
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </article>
  );
}
