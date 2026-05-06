import { ReactNode } from 'react';

export function InfoCallout({ title, children, tone = 'info' }: { title: string; children: ReactNode; tone?: 'info' | 'warning' | 'neutral' }) {
  return (
    <article className={`info-callout info-callout-${tone}`}>
      <strong>{title}</strong>
      <div>{children}</div>
    </article>
  );
}
