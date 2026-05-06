import { ReactNode } from 'react';

export function SectionHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <header className="section-header">
      <div>
        <h3>{title}</h3>
        {description ? <p className="info-text">{description}</p> : null}
      </div>
      {action ? <div>{action}</div> : null}
    </header>
  );
}
