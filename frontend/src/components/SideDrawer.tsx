import { useEffect } from 'react';
import { BrandLogo } from './BrandLogo';

export type SideDrawerItem = {
  key: string;
  label: string;
  icon?: string;
  section?: 'main' | 'simulator' | 'projects' | 'admin' | 'danger';
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
};

type SideDrawerProps = {
  title: string;
  subtitle?: string;
  open: boolean;
  onClose: () => void;
  items: SideDrawerItem[];
};

export function SideDrawer({ title, subtitle, open, onClose, items }: SideDrawerProps) {
  const mainItems = items.filter((item) => (item.section ?? 'main') === 'main');
  const simulatorItems = items.filter((item) => item.section === 'simulator');
  const projectItems = items.filter((item) => item.section === 'projects');
  const adminItems = items.filter((item) => item.section === 'admin');
  const dangerItems = items.filter((item) => item.section === 'danger' || item.danger);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="side-drawer-backdrop" onClick={onClose} aria-label="Fechar menu lateral" role="presentation">
      <aside
        className="side-drawer nav-drawer"
        onClick={(event) => event.stopPropagation()}
        aria-label={title}
        role="dialog"
        aria-modal="true"
      >
        <header className="side-drawer-header">
          <BrandLogo size="sm" subtitle={false} markOnly className="drawer-brand-mark" />
          <div className="side-drawer-title">
            <strong>{title}</strong>
            {subtitle ? <small>{subtitle}</small> : null}
          </div>
          <button type="button" className="side-drawer-close" onClick={onClose} aria-label="Fechar menu">
            ✕
          </button>
        </header>

        <nav className="side-drawer-list" aria-label={`Navegação de ${title}`}>
          {mainItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`side-drawer-item${item.active ? ' active' : ''}${item.danger ? ' danger' : ''}`}
              onClick={() => {
                item.onClick();
                onClose();
              }}
            >
              {item.icon ? <span className="nav-icon-badge" aria-hidden="true">{item.icon}</span> : null}
              <span>{item.label}</span>
            </button>
          ))}
          {simulatorItems.length > 0 && <p className="side-drawer-section-label">Simulador</p>}
          {simulatorItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`side-drawer-item${item.active ? ' active' : ''}`}
              onClick={() => {
                item.onClick();
                onClose();
              }}
            >
              {item.icon ? <span className="nav-icon-badge" aria-hidden="true">{item.icon}</span> : null}
              <span>{item.label}</span>
            </button>
          ))}
          {projectItems.length > 0 && <p className="side-drawer-section-label">Projetos</p>}
          {projectItems.map((item) => (
            <button key={item.key} type="button" className={`side-drawer-item${item.active ? ' active' : ''}`} onClick={() => { item.onClick(); onClose(); }}>
              {item.icon ? <span className="nav-icon-badge" aria-hidden="true">{item.icon}</span> : null}
              <span>{item.label}</span>
            </button>
          ))}
          {adminItems.length > 0 && <p className="side-drawer-section-label">Administração</p>}
          {adminItems.map((item) => (
            <button key={item.key} type="button" className={`side-drawer-item${item.active ? ' active' : ''}`} onClick={() => { item.onClick(); onClose(); }}>
              {item.icon ? <span className="nav-icon-badge" aria-hidden="true">{item.icon}</span> : null}
              <span>{item.label}</span>
            </button>
          ))}
          {dangerItems.length > 0 && <p className="side-drawer-section-label danger">Conta</p>}
          {dangerItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`side-drawer-item${item.active ? ' active' : ''}${item.danger ? ' danger' : ''}`}
              onClick={() => {
                item.onClick();
                onClose();
              }}
            >
              {item.icon ? <span className="nav-icon-badge" aria-hidden="true">{item.icon}</span> : null}
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>
    </div>
  );
}
