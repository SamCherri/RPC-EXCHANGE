import { ReactNode } from 'react';

type PageShellProps = {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function PageShell({ title, subtitle, actions, children, className = '' }: PageShellProps) {
  return (
    <section className={`page-shell ${className}`.trim()}>
      <header className="page-shell-header">
        <div>
          <h2 className="page-title">{title}</h2>
          {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="page-shell-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}
