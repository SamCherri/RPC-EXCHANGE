import { ReactNode } from 'react';
import { MobileTopbar } from './MobileTopbar';
import { BottomNav, BottomNavItem } from './BottomNav';
import { SideDrawer, SideDrawerItem } from './SideDrawer';

export function AppShell({
  children, canGoBack, onBackHome, onOpenMenu, onLogout, drawerOpen, onCloseDrawer, drawerItems, bottomItems,
}: {
  children: ReactNode;
  canGoBack: boolean;
  onBackHome: () => void;
  onOpenMenu: () => void;
  onLogout: () => void;
  drawerOpen: boolean;
  onCloseDrawer: () => void;
  drawerItems: SideDrawerItem[];
  bottomItems: BottomNavItem[];
}) {
  return (
    <main className="container app-shell">
      <MobileTopbar canGoBack={canGoBack} onBackHome={onBackHome} onOpenMenu={onOpenMenu} onLogout={onLogout} />
      <SideDrawer title="Menu principal" subtitle="RPC Exchange" open={drawerOpen} onClose={onCloseDrawer} items={drawerItems} />
      <section className="app-shell-main">{children}</section>
      <BottomNav items={bottomItems} />
    </main>
  );
}
