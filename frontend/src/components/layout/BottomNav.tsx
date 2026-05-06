export type BottomNavItem = { key: string; label: string; icon: string; active?: boolean; onClick: () => void };

export function BottomNav({ items }: { items: BottomNavItem[] }) {
  return (
    <nav className="bottom-nav mobile-only" aria-label="Navegação principal">
      {items.map((item) => (
        <button key={item.key} type="button" className={`bottom-nav-item${item.active ? ' active' : ''}`} onClick={item.onClick}>
          <span className="nav-icon-badge" aria-hidden="true">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
