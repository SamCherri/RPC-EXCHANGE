import { useEffect, useMemo, useState } from 'react';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { UserDashboard } from './pages/UserDashboard';
import { AdminDashboard } from './pages/AdminDashboard';
import { BrokerDashboard } from './pages/BrokerDashboard';
import { CompanyRequestPage } from './pages/CompanyRequestPage';
import { CompaniesPage } from './pages/CompaniesPage';
import { WithdrawalsPage } from './pages/WithdrawalsPage';
import { ProjectOwnerPanel } from './pages/ProjectOwnerPanel';
import { RpcMarketPage } from './pages/RpcMarketPage';
import { RegistrationStatusPage } from './pages/RegistrationStatusPage';
import { api, getCurrentUser, CurrentUserResponse } from './services/api';
import { BrandLogo } from './components/BrandLogo';
import { SideDrawer, SideDrawerItem } from './components/SideDrawer';
import { SupportWidget } from './components/SupportWidget';

type PublicTab = 'login' | 'register';
type PrivateScreen = 'home' | 'markets' | 'wallet' | 'rpc-market' | 'withdrawals' | 'company-request' | 'admin' | 'broker' | 'my-projects';

type ViewerRoles = {
  canSeeAdmin: boolean;
  canSeeBroker: boolean;
  canSeeProjectOwner: boolean;
  canSeeAdminSupport: boolean;
};

type CurrentUser = CurrentUserResponse['user'];


const ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'COIN_CHIEF_ADMIN', 'DEVELOPER']);
const SUPPORT_ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'DEVELOPER']);
const BROKER_ROLES = new Set(['VIRTUAL_BROKER']);
const PROJECT_OWNER_ROLES = new Set(['BUSINESS_OWNER']);

function decodeRolesFromToken(token: string | null): ViewerRoles {
  if (!token) return { canSeeAdmin: false, canSeeBroker: false, canSeeProjectOwner: false, canSeeAdminSupport: false };

  try {
    const [, payload] = token.split('.');
    if (!payload) return { canSeeAdmin: false, canSeeBroker: false, canSeeProjectOwner: false, canSeeAdminSupport: false };

    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as { role?: unknown; roles?: unknown };

    const extractedRoles = [
      ...(Array.isArray(parsed.roles) ? parsed.roles : []),
      ...(typeof parsed.role === 'string' ? [parsed.role] : []),
    ]
      .filter((role): role is string => typeof role === 'string')
      .map((role) => role.trim().toUpperCase());

    return {
      canSeeAdmin: extractedRoles.some((role) => ADMIN_ROLES.has(role)),
      canSeeBroker: extractedRoles.some((role) => BROKER_ROLES.has(role)),
      canSeeProjectOwner: extractedRoles.some((role) => PROJECT_OWNER_ROLES.has(role)),
      canSeeAdminSupport: extractedRoles.some((role) => SUPPORT_ADMIN_ROLES.has(role)),
    };
  } catch {
    return { canSeeAdmin: false, canSeeBroker: false, canSeeProjectOwner: false, canSeeAdminSupport: false };
  }
}

export function App() {
  const [rpcMarketAction, setRpcMarketAction] = useState<'buy' | 'sell' | null>(null);
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [publicTab, setPublicTab] = useState<PublicTab>('login');
  const [screen, setScreen] = useState<PrivateScreen>('home');
  const [hasOwnedProjects, setHasOwnedProjects] = useState(false);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [isGlobalDrawerOpen, setIsGlobalDrawerOpen] = useState(false);

  const tokenRoles = useMemo(() => decodeRolesFromToken(token), [token]);
  const roles = useMemo(() => {
    if (currentUser) {
      const normalized = currentUser.roles.map((role) => role.trim().toUpperCase());
      return {
        canSeeAdmin: normalized.some((role) => ADMIN_ROLES.has(role)),
        canSeeBroker: normalized.some((role) => BROKER_ROLES.has(role)),
        canSeeProjectOwner: normalized.some((role) => PROJECT_OWNER_ROLES.has(role)),
        canSeeAdminSupport: normalized.some((role) => SUPPORT_ADMIN_ROLES.has(role)),
      };
    }

    return tokenRoles;
  }, [currentUser, tokenRoles]);
  const canSeeMyProjects = roles.canSeeProjectOwner || hasOwnedProjects;

  const registrationBlocked = Boolean(token && currentUser && !roles.canSeeAdmin && currentUser.approvalStatus !== 'APPROVED');


  useEffect(() => {
    if (token) {
      localStorage.setItem('token', token);
      return;
    }
    localStorage.removeItem('token');
  }, [token]);

  useEffect(() => {
    if (screen === 'admin' && !roles.canSeeAdmin) {
      setScreen('home');
    }
    if (screen === 'broker' && !roles.canSeeBroker) {
      setScreen('home');
    }
    if (screen === 'my-projects' && !canSeeMyProjects) {
      setScreen('home');
    }
  }, [roles.canSeeAdmin, roles.canSeeBroker, canSeeMyProjects, screen]);


  useEffect(() => {
    if (!token) {
      setHasOwnedProjects(false);
      setCurrentUser(null);
      return;
    }

    getCurrentUser()
      .then((response) => {
        setCurrentUser(response.user);
      })
      .catch((error: Error) => {
        if (error.message.toLowerCase().includes('não autenticado')) {
          setToken(null);
          setScreen('home');
          setPublicTab('login');
          return;
        }
        setCurrentUser(null);
      });

    api<{ companies: Array<{ id: string }> }>('/project-boosts/my-projects')
      .then((response) => setHasOwnedProjects(response.companies.length > 0))
      .catch(() => setHasOwnedProjects(false));
  }, [token]);


  const canGoBack = useMemo(() => screen !== 'home', [screen]);



  function handleLogout() {
    setToken(null);
    setScreen('home');
    setPublicTab('login');
  }

  const globalDrawerItems = useMemo<SideDrawerItem[]>(() => {
    const items: SideDrawerItem[] = [
      { key: 'home', label: 'Início', icon: '🏠', active: screen === 'home', onClick: () => setScreen('home'), section: 'main' },
      { key: 'markets', label: 'Mercados', icon: '🪙', active: screen === 'markets', onClick: () => setScreen('markets'), section: 'main' },
      { key: 'wallet', label: 'Carteira', icon: '💼', active: screen === 'wallet', onClick: () => setScreen('wallet'), section: 'main' },
      { key: 'rpc-market', label: 'RPC/R$', icon: '💴', active: screen === 'rpc-market', onClick: () => setScreen('rpc-market'), section: 'main' },
      { key: 'withdrawals', label: 'Saque', icon: '🏧', active: screen === 'withdrawals', onClick: () => setScreen('withdrawals'), section: 'secondary' },
      { key: 'company-request', label: 'Criar token', icon: '🚀', active: screen === 'company-request', onClick: () => setScreen('company-request'), section: 'secondary' },
    ];

    if (canSeeMyProjects) items.push({ key: 'my-projects', label: 'Meus Projetos', icon: '📊', active: screen === 'my-projects', onClick: () => setScreen('my-projects'), section: 'secondary' });
    if (roles.canSeeAdmin) items.push({ key: 'admin', label: 'Admin', icon: '🛠️', active: screen === 'admin', onClick: () => setScreen('admin'), section: 'main' });
    if (roles.canSeeBroker) items.push({ key: 'broker', label: 'Corretor', icon: '🤝', active: screen === 'broker', onClick: () => setScreen('broker'), section: 'secondary' });

    items.push({ key: 'logout', label: 'Sair', icon: '🚪', danger: true, section: 'danger', onClick: handleLogout });
    return items;
  }, [canSeeMyProjects, handleLogout, roles.canSeeAdmin, roles.canSeeBroker, screen]);

  if (registrationBlocked) {
    return (
      <main className="container mobile-app-shell">
        <RegistrationStatusPage onLogout={handleLogout} onReload={async () => { const response = await getCurrentUser(); setCurrentUser(response.user); }} />
        <SupportWidget />
      </main>
    );
  }

  if (!token) {
    return (
      <main className="container auth-shell">
        <section className="card public-entry-card">
          <header className="public-entry-header">
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
              <BrandLogo size="hero" subtitle={false} />
            </div>
            <p className="warning">Esta é uma ferramenta de simulação/interpretação de uma exchange. Nenhum valor possui conversão para dinheiro real.</p>
            <p className="info-text">Sem cripto real, sem blockchain, sem Pix, sem cartão e sem gateway de pagamento.</p>
          </header>



          <div className="benefits-grid nested-card">
            <span>🪙 Crie e negocie tokens</span>
            <span>📈 Gráficos e ordens</span>
            <span>💼 Carteira digital</span>
          </div>

          <nav className="pill-nav nested-card" aria-label="Alternar entre login e cadastro">
            <button className={publicTab === 'login' ? 'pill active' : 'pill'} onClick={() => setPublicTab('login')}>
              Login
            </button>
            <button className={publicTab === 'register' ? 'pill active' : 'pill'} onClick={() => setPublicTab('register')}>
              Cadastro
            </button>
          </nav>

          {publicTab === 'login' ? (
            <LoginPage
              onSuccess={(newToken) => {
                setToken(newToken);
                setScreen('home');
              }}
              onSwitchRegister={() => setPublicTab('register')}
            />
          ) : (
            <RegisterPage onSwitchLogin={() => setPublicTab('login')} />
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="container mobile-app-shell">
      <header className="card app-mobile-topbar">
        <div className="topbar-row mobile-topbar-layout">
          {canGoBack ? (
            <button className="back-button desktop-only" onClick={() => setScreen('home')}>
              ← Voltar
            </button>
          ) : (
            <span className="back-placeholder desktop-only" />
          )}
          <button className="hamburger-button mobile-only" type="button" aria-label="Abrir menu" onClick={() => setIsGlobalDrawerOpen(true)}>☰</button>
          <div className="mobile-topbar-title" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <BrandLogo size="sm" subtitle={false} />
          </div>
          <button className="button-danger small-button desktop-only" onClick={handleLogout}>
            Sair
          </button>
        </div>
      </header>

      <SideDrawer
        title="Menu principal"
        subtitle="Navegação rápida da RPC Exchange"
        open={isGlobalDrawerOpen}
        onClose={() => setIsGlobalDrawerOpen(false)}
        items={globalDrawerItems}
      />

      {screen === 'home' && (
        <section className="card">


          <section className="mobile-home-summary mobile-only">
            <div className="mobile-hero-card">
              <span className="mobile-hero-kicker">Painel principal</span>
              <div style={{ marginBottom: '10px' }}>
                <BrandLogo size="md" subtitle={false} />
              </div>
              <p>Negocie tokens, acompanhe sua carteira e acesse seus painéis pelo menu.</p>
            </div>

            <div className="mobile-primary-actions">
              <button className="mobile-action-card" onClick={() => setScreen('markets')}>
                <span>🪙</span>
                <strong>Mercados</strong>
                <small>Comprar e vender tokens</small>
              </button>
              <button className="mobile-action-card" onClick={() => setScreen('wallet')}>
                <span>💼</span>
                <strong>Carteira</strong>
                <small>Saldo e ativos</small>
              </button>
              <button className="mobile-action-card" onClick={() => setScreen('rpc-market')}>
                <span>💴</span>
                <strong>RPC/R$</strong>
                <small>Comprar e vender RPC</small>
              </button>
              {roles.canSeeAdmin && (
                <button className="mobile-action-card mobile-action-wide" onClick={() => setScreen('admin')}>
                  <span>🛠️</span>
                  <strong>Admin</strong>
                  <small>Tesouraria, usuários e auditoria</small>
                </button>
              )}
            </div>

            <div className="mobile-menu-hint">
              <span>☰</span>
              <p>Use o menu lateral para acessar Saque, Criar token, Projetos, Corretor e Sair.</p>
            </div>
            <div className="summary-grid">
              <article className="summary-item">
                <span className="summary-label">Navegação rápida</span>
                <strong className="summary-value">Mercados e Carteira</strong>
              </article>
              <article className="summary-item">
                <span className="summary-label">Experiência mobile</span>
                <strong className="summary-value">Botões grandes e leitura clara</strong>
              </article>
            </div>
          </section>

          <h2 className="desktop-only">Bem-vindo à RPC Exchange</h2>
          <p className="info-text desktop-only">Negocie tokens criados por usuários com RPC.</p>

          <div className="home-grid home-grid-actions nested-card desktop-home-actions desktop-only">
            <button className="home-tile" onClick={() => setScreen('markets')}><span>🪙</span><strong>Mercados</strong><small>Veja ativos disponíveis para negociar.</small></button>
            <button className="home-tile" onClick={() => setScreen('wallet')}><span>💼</span><strong>Carteira</strong><small>Acompanhe seu saldo e seus ativos.</small></button>
            <button className="home-tile" onClick={() => setScreen('withdrawals')}><span>🏧</span><strong>Saque</strong><small>Solicite a retirada de RPC para receber dentro do RP.</small></button>
            <button className="home-tile" onClick={() => setScreen('company-request')}><span>🚀</span><strong>Criar token</strong><small>Crie seu projeto e solicite listagem no mercado.</small></button>
            {canSeeMyProjects && <button className="home-tile" onClick={() => setScreen('my-projects')}><span>📊</span><strong>Meus Projetos</strong><small>Gerencie impulsões da sua moeda.</small></button>}
            {roles.canSeeAdmin && <button className="home-tile" onClick={() => setScreen('admin')}><span>🛠️</span><strong>Admin</strong><small>Painel administrativo</small></button>}
            {roles.canSeeBroker && <button className="home-tile" onClick={() => setScreen('broker')}><span>🤝</span><strong>Corretor</strong><small>Painel corretor</small></button>}
            <button className="home-tile home-tile-danger" onClick={handleLogout}><span>🚪</span><strong>Sair</strong><small>Encerrar sessão</small></button>
          </div>
        </section>
      )}

      {screen === 'markets' && <CompaniesPage />}
      {screen === 'wallet' && (
        <UserDashboard
          onOpenRpcMarket={(action) => {
            setRpcMarketAction(action ?? null);
            setScreen('rpc-market');
          }}
          onOpenCompanyMarket={(companyId) => {
            localStorage.setItem('rpc-exchange-open-company-market-id', companyId);
            setScreen('markets');
          }}
        />
      )}
      {screen === 'rpc-market' && <RpcMarketPage initialTradeFlow={rpcMarketAction} onTradeFlowHandled={() => setRpcMarketAction(null)} />}
      {screen === 'withdrawals' && <WithdrawalsPage />}
      {screen === 'company-request' && <CompanyRequestPage />}
      {screen === 'my-projects' && canSeeMyProjects && <ProjectOwnerPanel />}
      {screen === 'admin' && roles.canSeeAdmin && <AdminDashboard currentUserRoles={currentUser?.roles ?? []} canSeeSupport={roles.canSeeAdminSupport} onPermissionsUpdated={async () => { const response = await getCurrentUser(); setCurrentUser(response.user); }} />}
      {screen === 'broker' && roles.canSeeBroker && <BrokerDashboard />}
      <SupportWidget />
    </main>
  );
}


