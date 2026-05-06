import { BrandLogo } from '../BrandLogo';

type MobileTopbarProps = {
  canGoBack: boolean;
  onBackHome: () => void;
  onOpenMenu: () => void;
  onLogout: () => void;
};

export function MobileTopbar({ canGoBack, onBackHome, onOpenMenu, onLogout }: MobileTopbarProps) {
  return (
    <header className="mobile-topbar premium-window">
      <div className="topbar-row mobile-topbar-layout">
        {canGoBack ? (
          <button className="back-button desktop-only" onClick={onBackHome}>← Voltar</button>
        ) : <span className="back-placeholder desktop-only" />}
        <button className="hamburger-button mobile-only" type="button" aria-label="Abrir menu" onClick={onOpenMenu}>☰</button>
        <div className="mobile-topbar-title"><BrandLogo size="sm" subtitle={false} /></div>
        <button className="button-danger small-button desktop-only" onClick={onLogout}>Sair</button>
      </div>
    </header>
  );
}
