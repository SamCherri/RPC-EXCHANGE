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
import { TestModePage } from './pages/TestModePage';
import { TestModeRankingPage } from './pages/TestModeRankingPage';
import { TestModeReportPage } from './pages/TestModeReportPage';
import { api, getCurrentUser, CurrentUserResponse } from './services/api';
import { SideDrawerItem } from './components/layout/SideDrawer';
import { AppShell } from './components/layout/AppShell';
import { BrandLogo } from './components/BrandLogo';

type PublicTab = 'login' | 'register';
type PrivateScreen = 'home' | 'markets' | 'wallet' | 'rpc-market' | 'withdrawals' | 'company-request' | 'admin' | 'broker' | 'my-projects' | 'test-mode' | 'test-ranking' | 'test-report';

type ViewerRoles = {
  canSeeAdmin: boolean;
  canSeeBroker: boolean;
  canSeeProjectOwner: boolean;
};

type CurrentUser = CurrentUserResponse['user'];

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

const ADMIN_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'COIN_CHIEF_ADMIN']);
const BROKER_ROLES = new Set(['VIRTUAL_BROKER']);
const PROJECT_OWNER_ROLES = new Set(['BUSINESS_OWNER']);

function decodeRolesFromToken(token: string | null): ViewerRoles {
  if (!token) return { canSeeAdmin: false, canSeeBroker: false, canSeeProjectOwner: false };

  try {
    const [, payload] = token.split('.');
    if (!payload) return { canSeeAdmin: false, canSeeBroker: false, canSeeProjectOwner: false };

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
    };
  } catch {
    return { canSeeAdmin: false, canSeeBroker: false, canSeeProjectOwner: false };
  }
}

export function App() {
  const [rpcMarketAction, setRpcMarketAction] = useState<'buy' | 'sell' | null>(null);
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [publicTab, setPublicTab] = useState<PublicTab>('login');
  const [screen, setScreen] = useState<PrivateScreen>('home');
  const [installPromptEvent, setInstallPromptEvent] = useState<InstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(
    () => window.matchMedia('(display-mode: standalone)').matches || (window.navigator as Navigator & { standalone?: boolean }).standalone === true,
  );
  const [installHint, setInstallHint] = useState('');
  const [hasOwnedProjects, setHasOwnedProjects] = useState(false);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [isGlobalDrawerOpen, setIsGlobalDrawerOpen] = useState(false);
  const [systemMode, setSystemMode] = useState<'NORMAL'|'TEST'>('NORMAL');

  const tokenRoles = useMemo(() => decodeRolesFromToken(token), [token]);
  const roles = useMemo(() => {
    if (currentUser) {
      const normalized = currentUser.roles.map((role) => role.trim().toUpperCase());
      return {
        canSeeAdmin: normalized.some((role) => ADMIN_ROLES.has(role)),
        canSeeBroker: normalized.some((role) => BROKER_ROLES.has(role)),
        canSeeProjectOwner: normalized.some((role) => PROJECT_OWNER_ROLES.has(role)),
      };
    }

    return tokenRoles;
  }, [currentUser, tokenRoles]);
  const canSeeMyProjects = roles.canSeeProjectOwner || hasOwnedProjects;

  const isTestModeRestrictedUser = systemMode === 'TEST' && !roles.canSeeAdmin;
  const shouldShowTestModeEntry = roles.canSeeAdmin || systemMode === 'TEST';
  async function loadSystemMode() {
    try {
      const response = await api<{ mode: 'NORMAL'|'TEST' }>('/system-mode');
      setSystemMode(response.mode);
    } catch {
      setSystemMode('NORMAL');
    }
  }

  useEffect(() => {
    if (!token) return;

    if (
      isTestModeRestrictedUser &&
      screen !== 'test-mode' &&
      screen !== 'test-ranking' &&
      screen !== 'test-report'
    ) {
      setScreen('test-mode');
      return;
    }

    if (!roles.canSeeAdmin && systemMode === 'NORMAL' && (screen === 'test-mode' || screen === 'test-ranking' || screen === 'test-report')) {
      setScreen('home');
    }
  }, [isTestModeRestrictedUser, roles.canSeeAdmin, screen, systemMode, token]);

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

    void loadSystemMode();

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
  useEffect(() => {
    if (!token) return;
    const interval = window.setInterval(() => {
      void loadSystemMode();
    }, 15000);
    return () => window.clearInterval(interval);
  }, [token]);
  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPromptEvent(event as InstallPromptEvent);
      setInstallHint('');
    };

    const onInstalled = () => {
      setIsInstalled(true);
      setInstallPromptEvent(null);
      setInstallHint('App instalado com sucesso no seu dispositivo.');
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const canGoBack = useMemo(() => screen !== 'home', [screen]);

  async function handleInstallClick() {
    if (isInstalled) {
      setInstallHint('App instalado. Abra pela sua tela inicial.');
      return;
    }

    if (installPromptEvent) {
      await installPromptEvent.prompt();
      const choice = await installPromptEvent.userChoice;
      if (choice.outcome === 'accepted') {
        setInstallHint('Instalação iniciada.');
      } else {
        setInstallHint('Instalação cancelada. Você pode tentar novamente depois.');
      }
      setInstallPromptEvent(null);
      return;
    }

    setInstallHint('No navegador, toque nos três pontos e escolha Adicionar à tela inicial.');
  }

  function handleLogout() {
    setToken(null);
    setScreen('home');
    setPublicTab('login');
  }

  const showInstallCard = !isInstalled;

  const globalDrawerItems = useMemo<SideDrawerItem[]>(() => {
    const items: SideDrawerItem[] = [
      ...(shouldShowTestModeEntry ? [
        { key: 'test-mode', label: 'Modo Teste', icon: 'TM', active: screen === 'test-mode', onClick: () => setScreen('test-mode'), section: 'simulator' } as SideDrawerItem,
        { key: 'test-ranking', label: 'Ranking Teste', icon: '🏆', active: screen === 'test-ranking', onClick: () => setScreen('test-ranking'), section: 'simulator' } as SideDrawerItem,
        { key: 'test-report', label: 'Reportar Bug', icon: '🐞', active: screen === 'test-report', onClick: () => setScreen('test-report'), section: 'simulator' } as SideDrawerItem,
      ] : []),
      ...((isTestModeRestrictedUser
        ? []
        : [
            { key: 'home', label: 'Início', icon: '🏠', active: screen === 'home', onClick: () => setScreen('home'), section: 'main' },
            { key: 'markets', label: 'Mercados', icon: '🪙', active: screen === 'markets', onClick: () => setScreen('markets'), section: 'main' },
            { key: 'wallet', label: 'Carteira', icon: '💼', active: screen === 'wallet', onClick: () => setScreen('wallet'), section: 'main' },
            { key: 'rpc-market', label: 'RPC/R$', icon: '💎', active: screen === 'rpc-market', onClick: () => setScreen('rpc-market'), section: 'main' },
            { key: 'withdrawals', label: 'Saque', icon: '💸', active: screen === 'withdrawals', onClick: () => setScreen('withdrawals'), section: 'projects' },
            { key: 'company-request', label: 'Criar token', icon: '🚀', active: screen === 'company-request', onClick: () => setScreen('company-request'), section: 'projects' },
          ] as SideDrawerItem[])),
    ];

    if (canSeeMyProjects && !isTestModeRestrictedUser) items.push({ key: 'my-projects', label: 'Meus Projetos', icon: '📊', active: screen === 'my-projects', onClick: () => setScreen('my-projects'), section: 'projects' });
    if (roles.canSeeAdmin) items.push({ key: 'admin', label: 'Admin', icon: '🛡️', active: screen === 'admin', onClick: () => setScreen('admin'), section: 'admin' });
    if (roles.canSeeBroker && !isTestModeRestrictedUser) items.push({ key: 'broker', label: 'Corretor', icon: '🤝', active: screen === 'broker', onClick: () => setScreen('broker'), section: 'admin' });

    items.push({ key: 'logout', label: 'Sair', icon: '🚪', danger: true, section: 'danger', onClick: handleLogout });
    return items;
  }, [canSeeMyProjects, handleLogout, isTestModeRestrictedUser, roles.canSeeAdmin, roles.canSeeBroker, screen, shouldShowTestModeEntry]);

  if (!token) {
    return (
      <main className="container auth-shell app-shell">
        <section className="card public-entry-card auth-card premium-panel">
          <header className="public-entry-header page-hero-compact">
            <BrandLogo size="hero" className="auth-logo auth-lockup" />
            <p className="warning compact-callout">Ambiente RP de simulação econômica. Saldos e tokens não possuem valor real.</p>
            <p className="info-text">Sem Pix, cartão, blockchain, cripto real ou promessa de lucro.</p>
          </header>

          

          <div className="benefits-grid nested-card">
            <span>🪙 Crie e negocie tokens</span>
            <span>📈 Gráficos e ordens</span>
            <span>💼 Carteira digital</span>
            <span>📲 Instale como app</span>
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
        

          <article className="card install-card nested-card glass-panel">
            <h3>📲 Instalar aplicativo</h3>
            <p className="info-text">Use a RPC Exchange como app no celular.</p>
            <button className="button-primary" onClick={handleInstallClick} type="button">
              Instalar aplicativo
            </button>
            {installHint && <p className="info-text">{installHint}</p>}
          </article></section>
      </main>
    );
  }

  const bottomNavItems = [
    { key: 'home', label: 'Início', icon: '🏠', active: screen === 'home', onClick: () => setScreen('home') },
    { key: 'markets', label: 'Mercados', icon: '🪙', active: screen === 'markets', onClick: () => setScreen('markets') },
    { key: 'wallet', label: 'Carteira', icon: '💼', active: screen === 'wallet', onClick: () => setScreen('wallet') },
    { key: 'rpc-market', label: 'RPC/R$', icon: '💎', active: screen === 'rpc-market', onClick: () => setScreen('rpc-market') },
    { key: 'menu', label: 'Menu', icon: '☰', onClick: () => setIsGlobalDrawerOpen(true) },
  ];

  return (
    <AppShell
      canGoBack={canGoBack}
      onBackHome={() => setScreen('home')}
      onOpenMenu={() => setIsGlobalDrawerOpen(true)}
      onLogout={handleLogout}
      drawerOpen={isGlobalDrawerOpen}
      onCloseDrawer={() => setIsGlobalDrawerOpen(false)}
      drawerItems={globalDrawerItems}
      bottomItems={bottomNavItems}
    >

      {shouldShowTestModeEntry && screen === 'test-mode' && <TestModePage />}
      {shouldShowTestModeEntry && screen === 'test-ranking' && <TestModeRankingPage />}
      {shouldShowTestModeEntry && screen === 'test-report' && <TestModeReportPage />}
      {!isTestModeRestrictedUser && screen === 'home' && (
        <section className="card">
          {showInstallCard && (
            <article className="summary-item install-card">
              <h3>📲 Instalar aplicativo</h3>
              <p className="info-text">Use a RPC Exchange como app no celular.</p>
              <button className="button-primary" onClick={handleInstallClick} type="button">
                Instalar aplicativo
              </button>
              {installHint && <p className="info-text">{installHint}</p>}
            </article>
          )}

          <section className="mobile-home-summary mobile-only">
            <div className="mobile-hero-card">
              <span className="mobile-hero-kicker">Painel principal</span>
              <div style={{ marginBottom: '10px' }}><BrandLogo size="md" /></div>
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

      {!isTestModeRestrictedUser && screen === 'markets' && <CompaniesPage />}
      {!isTestModeRestrictedUser && screen === 'wallet' && (
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
      {!isTestModeRestrictedUser && screen === 'rpc-market' && <RpcMarketPage initialTradeFlow={rpcMarketAction} onTradeFlowHandled={() => setRpcMarketAction(null)} />}
      {!isTestModeRestrictedUser && screen === 'withdrawals' && <WithdrawalsPage />}
      {!isTestModeRestrictedUser && screen === 'company-request' && <CompanyRequestPage />}
      {!isTestModeRestrictedUser && screen === 'my-projects' && canSeeMyProjects && <ProjectOwnerPanel />}
      {screen === 'admin' && roles.canSeeAdmin && <AdminDashboard currentUserRoles={currentUser?.roles ?? []} onPermissionsUpdated={async () => { const response = await getCurrentUser(); setCurrentUser(response.user); }} />}
      {!isTestModeRestrictedUser && screen === 'broker' && roles.canSeeBroker && <BrokerDashboard />}
    </AppShell>
  );
}
