import { FormEvent, useEffect, useState } from 'react';
import { api } from '../services/api';
import { AdminWithdrawalsPanel } from './AdminWithdrawalsPanel';
import { AdminUsersPanel } from './AdminUsersPanel';
import { AdminTokensPanel } from './AdminTokensPanel';
import { AdminAuditPanel } from './AdminAuditPanel';
import { AdminEconomicAlertsPanel } from './AdminEconomicAlertsPanel';
import { AdminMarketHealthPanel } from './AdminMarketHealthPanel';
import { AdminReportsPanel } from './AdminReportsPanel';
import { AdminSupportPanel } from './AdminSupportPanel';
import { SideDrawer, SideDrawerItem } from '../components/SideDrawer';
import { ConfirmActionModal } from '../components/ConfirmActionModal';

type Overview = { users: number; companies: number; logs: number; treasuryBalance: string | number };
type PlatformAccount = { balance: string | number; totalReceivedFees: string | number; totalWithdrawn: string | number; updatedAt: string | null };
type RpcLiquidityState = { currentPrice: string; fiatReserve: string; rpcReserve: string; totalFiatVolume: string; totalRpcVolume: string; totalBuys: number; totalSells: number; updatedAt: string };
type CompanyRevenueAccount = {
  companyId: string;
  ticker: string;
  companyName: string;
  balance: string | number;
  totalReceivedFees: string | number;
  totalWithdrawn: string | number;
};
type ActiveTab = 'overview' | 'users' | 'brokers' | 'tokens' | 'withdrawals' | 'treasury' | 'liquidity' | 'revenues' | 'audit' | 'reports' | 'support' | 'economic-alerts' | 'market-health';

type AdminConfirmAction =
  | 'issuance'
  | 'broker-transfer'
  | 'user-deposit'
  | 'platform-withdraw'
  | 'liquidity-inject'
  | 'liquidity-withdraw';

type AdminDashboardProps = {
  currentUserRoles: string[];
  onPermissionsUpdated: () => Promise<void>;
};

export function AdminDashboard({ currentUserRoles, onPermissionsUpdated }: AdminDashboardProps) {
  const [tab, setTab] = useState<ActiveTab>('overview');
  const [data, setData] = useState<Overview | null>(null);
  const [platformAccount, setPlatformAccount] = useState<PlatformAccount | null>(null);
  const [liquidity, setLiquidity] = useState<RpcLiquidityState | null>(null);
  const [companyRevenueAccounts, setCompanyRevenueAccounts] = useState<CompanyRevenueAccount[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const [pendingAdminAction, setPendingAdminAction] = useState<AdminConfirmAction | null>(null);
  const [adminPassword, setAdminPassword] = useState('');
  const [adminConfirmText, setAdminConfirmText] = useState('');
  const [adminModalLoading, setAdminModalLoading] = useState(false);

  const [issuanceAmount, setIssuanceAmount] = useState('');
  const [issuanceReason, setIssuanceReason] = useState('');
  const [brokerRef, setBrokerRef] = useState('');
  const [brokerAmount, setBrokerAmount] = useState('');
  const [brokerReason, setBrokerReason] = useState('');
  const [userDepositRef, setUserDepositRef] = useState('');
  const [userDepositAmount, setUserDepositAmount] = useState('');
  const [userDepositReason, setUserDepositReason] = useState('');
  const [platformWithdrawRef, setPlatformWithdrawRef] = useState('');
  const [platformWithdrawAmount, setPlatformWithdrawAmount] = useState('');
  const [platformWithdrawReason, setPlatformWithdrawReason] = useState('');
  const [isAdminDrawerOpen, setIsAdminDrawerOpen] = useState(false);
  const [injectFiat, setInjectFiat] = useState('');
  const [injectRpc, setInjectRpc] = useState('');
  const [injectReason, setInjectReason] = useState('');
  const [withdrawFiat, setWithdrawFiat] = useState('');
  const [withdrawRpc, setWithdrawRpc] = useState('');
  const [withdrawReason, setWithdrawReason] = useState('');
  const [liquidityError, setLiquidityError] = useState('');
  const roles = currentUserRoles.map((role) => role.toUpperCase());
  const canWithdrawPlatformProfit = roles.includes('SUPER_ADMIN') || roles.includes('COIN_CHIEF_ADMIN') || roles.includes('DEVELOPER');
  const canIssueRpc = roles.includes('SUPER_ADMIN') || roles.includes('COIN_CHIEF_ADMIN') || roles.includes('DEVELOPER');
  const canManageRpcLiquidity = roles.includes('SUPER_ADMIN') || roles.includes('COIN_CHIEF_ADMIN') || roles.includes('DEVELOPER');

  async function load() {
    try {
      const [overview, platform, companyRevenue] = await Promise.all([
        api<Overview>('/admin/overview'),
        api<PlatformAccount>('/admin/platform-account'),
        api<{ accounts: CompanyRevenueAccount[] }>('/admin/company-revenue-accounts'),
      ]);
      setData(overview);
      setPlatformAccount(platform);
      setCompanyRevenueAccounts(companyRevenue.accounts);
      if (canManageRpcLiquidity) {
        try {
          const liquidityState = await api<RpcLiquidityState>('/admin/rpc-market/liquidity');
          setLiquidity(liquidityState);
          setLiquidityError('');
        } catch (liquidityErr) {
          setLiquidity(null);
          setLiquidityError((liquidityErr as Error).message || 'Não foi possível carregar os dados de liquidez no momento.');
        }
      } else {
        setLiquidity(null);
        setLiquidityError('');
      }
      setError('');
      setMessage('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => { load(); }, [canManageRpcLiquidity]);
  useEffect(() => {
    if (!canManageRpcLiquidity && tab === 'liquidity') setTab('overview');
  }, [canManageRpcLiquidity, tab]);

  const adminTabLabels: Record<ActiveTab, string> = {
    overview: 'Visão geral',
    users: 'Usuários',
    brokers: 'Corretores',
    tokens: 'Tokens/Mercados',
    withdrawals: 'Saques',
    treasury: 'Tesouraria administrativa',
    liquidity: 'Liquidez RPC/R$',
    revenues: 'Receitas',
    audit: 'Auditoria',
    reports: 'Relatórios',
    support: 'Suporte',
    'economic-alerts': 'Alertas econômicos',
    'market-health': 'Saúde dos Mercados',
  };



  function formatNumberPtBr(value: string | number) {
    const parsed = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
    if (!Number.isFinite(parsed)) return String(value);
    return parsed.toLocaleString('pt-BR');
  }

  const adminDrawerItems: SideDrawerItem[] = [
    { key: 'overview', label: 'Visão geral', active: tab === 'overview', onClick: () => setTab('overview') },
    { key: 'users', label: 'Usuários', active: tab === 'users', onClick: () => setTab('users') },
    { key: 'brokers', label: 'Corretores', active: tab === 'brokers', onClick: () => setTab('brokers') },
    { key: 'tokens', label: 'Tokens/Mercados', active: tab === 'tokens', onClick: () => setTab('tokens') },
    { key: 'withdrawals', label: 'Saques', active: tab === 'withdrawals', onClick: () => setTab('withdrawals') },
    { key: 'treasury', label: 'Tesouraria administrativa', active: tab === 'treasury', onClick: () => setTab('treasury') },
    { key: 'revenues', label: 'Receitas', active: tab === 'revenues', onClick: () => setTab('revenues') },
    { key: 'audit', label: 'Auditoria', active: tab === 'audit', onClick: () => setTab('audit') },
    { key: 'reports', label: 'Relatórios', active: tab === 'reports', onClick: () => setTab('reports') },
    { key: 'support', label: 'Suporte', active: tab === 'support', onClick: () => setTab('support') },
    { key: 'economic-alerts', label: 'Alertas econômicos', active: tab === 'economic-alerts', onClick: () => setTab('economic-alerts') },
    { key: 'market-health', label: 'Saúde dos Mercados', active: tab === 'market-health', onClick: () => setTab('market-health') },
  ];
  if (canManageRpcLiquidity) {
    adminDrawerItems.splice(6, 0, { key: 'liquidity', label: 'Liquidez RPC/R$', active: tab === 'liquidity', onClick: () => setTab('liquidity') });
  }

  async function submitIssuance(event: FormEvent) {
    event.preventDefault();
    setPendingAdminAction('issuance');
  }

  async function submitBrokerTransfer(event: FormEvent) {
    event.preventDefault();
    setPendingAdminAction('broker-transfer');
  }

  async function submitPlatformWithdraw(event: FormEvent) {
    event.preventDefault();
    setPendingAdminAction('platform-withdraw');
  }

  async function submitUserDeposit(event: FormEvent) {
    event.preventDefault();
    setPendingAdminAction('user-deposit');
  }

  function clearAdminConfirmState() {
    setPendingAdminAction(null);
    setAdminPassword('');
    setAdminConfirmText('');
  }

  function closeAdminConfirmModal() {
    if (adminModalLoading) return;
    clearAdminConfirmState();
  }

  function adminActionRequiresConfirm(action: AdminConfirmAction | null) {
    return action !== null && action !== 'liquidity-inject';
  }

  function getAdminActionTitle(action: AdminConfirmAction | null) {
    switch (action) {
      case 'issuance': return 'Confirmar emissão de RPC';
      case 'broker-transfer': return 'Confirmar envio de R$ ao corretor';
      case 'user-deposit': return 'Confirmar depósito de R$ no jogador';
      case 'platform-withdraw': return 'Confirmar retirada de lucro da Exchange';
      case 'liquidity-inject': return 'Confirmar adição de liquidez';
      case 'liquidity-withdraw': return 'Confirmar remoção de liquidez';
      default: return 'Confirmar ação administrativa';
    }
  }

  function getAdminActionDescription(action: AdminConfirmAction | null) {
    switch (action) {
      case 'issuance': return 'Essa ação cria RPC na tesouraria administrativa e altera o balanço da simulação.';
      case 'broker-transfer': return 'Essa ação transfere R$ da tesouraria para um corretor autorizado.';
      case 'user-deposit': return 'Essa ação deposita R$ diretamente na carteira de um jogador.';
      case 'platform-withdraw': return 'Essa ação transfere lucro da conta da Exchange para uma carteira administrativa.';
      case 'liquidity-inject': return 'Essa ação adiciona liquidez ao mercado RPC/R$ e altera as reservas.';
      case 'liquidity-withdraw': return 'Essa ação remove liquidez do mercado RPC/R$ e pode impactar reservas/preço.';
      default: return 'Revise os dados antes de confirmar.';
    }
  }

  async function confirmPendingAdminAction() {
    if (!pendingAdminAction) return;
    setError('');
    setMessage('');
    setAdminModalLoading(true);

    if (!adminPassword.trim()) {
      setError('Confirme sua senha para continuar.');
      setAdminModalLoading(false);
      return;
    }

    try {
      switch (pendingAdminAction) {
        case 'issuance':
          await api('/admin/treasury/issuance', { method: 'POST', body: JSON.stringify({ amount: issuanceAmount, reason: issuanceReason, adminPassword }) });
          setIssuanceAmount(''); setIssuanceReason(''); setMessage('RPC emitido na tesouraria com sucesso.'); break;
        case 'broker-transfer':
          await api('/admin/treasury/transfer-to-broker', { method: 'POST', body: JSON.stringify({ brokerRef, amount: brokerAmount, reason: brokerReason, adminPassword }) });
          setBrokerRef(''); setBrokerAmount(''); setBrokerReason(''); setMessage('R$ enviado ao corretor com sucesso.'); break;
        case 'user-deposit':
          await api('/admin/treasury/transfer-to-user', { method: 'POST', body: JSON.stringify({ userRef: userDepositRef, amount: userDepositAmount, reason: userDepositReason, adminPassword }) });
          setUserDepositRef(''); setUserDepositAmount(''); setUserDepositReason(''); setMessage('R$ depositado na carteira do jogador com sucesso.'); break;
        case 'platform-withdraw':
          await api('/admin/platform-account/withdraw-to-admin', { method: 'POST', body: JSON.stringify({ adminRef: platformWithdrawRef, amount: platformWithdrawAmount, reason: platformWithdrawReason, adminPassword }) });
          setPlatformWithdrawRef(''); setPlatformWithdrawAmount(''); setPlatformWithdrawReason(''); setMessage('Lucro da Exchange transferido com sucesso.'); break;
        case 'liquidity-inject':
          await api('/admin/rpc-market/liquidity/inject', { method: 'POST', body: JSON.stringify({ fiatAmount: injectFiat || undefined, rpcAmount: injectRpc || undefined, reason: injectReason, adminPassword }) });
          setInjectFiat(''); setInjectRpc(''); setInjectReason(''); setMessage('Liquidez adicionada com sucesso.'); break;
        case 'liquidity-withdraw':
          await api('/admin/rpc-market/liquidity/withdraw', { method: 'POST', body: JSON.stringify({ fiatAmount: withdrawFiat || undefined, rpcAmount: withdrawRpc || undefined, reason: withdrawReason, adminPassword }) });
          setWithdrawFiat(''); setWithdrawRpc(''); setWithdrawReason(''); setMessage('Liquidez removida com sucesso.'); break;
      }
      clearAdminConfirmState();
      await load();
    } catch (err) { setError((err as Error).message); } finally { setAdminModalLoading(false); }
  }

  return (
    <section className="card">
      <h2>🛠️ Painel Admin</h2>
      {error && <p className="status-message error">{error}</p>}
      {message && <p className="status-message success">{message}</p>}

      <div className="admin-mobile-menu-row mobile-only">
        <button className="admin-menu-trigger" type="button" onClick={() => setIsAdminDrawerOpen(true)} aria-label="Abrir menu admin">
          <span className="menu-icon">☰</span>
          <span>Menu Admin</span>
        </button>

        <div className="admin-current-tab">
          <small>Aba atual</small>
          <strong>{adminTabLabels[tab]}</strong>
        </div>
      </div>

      <SideDrawer title="Menu Admin" subtitle="Acesso rápido às abas" open={isAdminDrawerOpen} onClose={() => setIsAdminDrawerOpen(false)} items={adminDrawerItems} />

      <nav className="pill-nav nested-card admin-nav desktop-only">
        <button className={tab === 'overview' ? 'pill active' : 'pill'} onClick={() => setTab('overview')}>Visão geral</button>
        <button className={tab === 'users' ? 'pill active' : 'pill'} onClick={() => setTab('users')}>Usuários</button>
        <button className={tab === 'brokers' ? 'pill active' : 'pill'} onClick={() => setTab('brokers')}>Corretores</button>
        <button className={tab === 'tokens' ? 'pill active' : 'pill'} onClick={() => setTab('tokens')}>Tokens/Mercados</button>
        <button className={tab === 'withdrawals' ? 'pill active' : 'pill'} onClick={() => setTab('withdrawals')}>Saques</button>
        <button className={tab === 'treasury' ? 'pill active' : 'pill'} onClick={() => setTab('treasury')}>Tesouraria</button>
        {canManageRpcLiquidity && <button className={tab === 'liquidity' ? 'pill active' : 'pill'} onClick={() => setTab('liquidity')}>Liquidez RPC/R$</button>}
        <button className={tab === 'revenues' ? 'pill active' : 'pill'} onClick={() => setTab('revenues')}>Receitas</button>
        <button className={tab === 'audit' ? 'pill active' : 'pill'} onClick={() => setTab('audit')}>Auditoria</button>
        <button className={tab === 'reports' ? 'pill active' : 'pill'} onClick={() => setTab('reports')}>Relatórios</button>
        <button className={tab === 'support' ? 'pill active' : 'pill'} onClick={() => setTab('support')}>Suporte</button>
        <button className={tab === 'economic-alerts' ? 'pill active' : 'pill'} onClick={() => setTab('economic-alerts')}>Alertas econômicos</button>
        <button className={tab === 'market-health' ? 'pill active' : 'pill'} onClick={() => setTab('market-health')}>Saúde dos Mercados</button>
      </nav>

      {tab === 'overview' && data && (
        <div className="admin-overview-grid nested-card">
          <article className="admin-metric-card">
            <span className="admin-metric-icon" aria-hidden="true">👥</span>
            <span className="admin-metric-label">Usuários</span>
            <strong className="admin-metric-value">{formatNumberPtBr(data.users)}</strong>
            <small className="admin-metric-description">Contas cadastradas</small>
          </article>
          <article className="admin-metric-card">
            <span className="admin-metric-icon" aria-hidden="true">🪙</span>
            <span className="admin-metric-label">Mercados</span>
            <strong className="admin-metric-value">{formatNumberPtBr(data.companies)}</strong>
            <small className="admin-metric-description">Tokens listados</small>
          </article>
          <article className="admin-metric-card">
            <span className="admin-metric-icon" aria-hidden="true">📜</span>
            <span className="admin-metric-label">Logs</span>
            <strong className="admin-metric-value">{formatNumberPtBr(data.logs)}</strong>
            <small className="admin-metric-description">Eventos registrados</small>
          </article>
          <article className="admin-metric-card">
            <span className="admin-metric-icon" aria-hidden="true">🏦</span>
            <span className="admin-metric-label">Tesouraria</span>
            <strong className="admin-metric-value">{formatNumberPtBr(data.treasuryBalance)} R$</strong>
            <small className="admin-metric-description">Saldo administrativo</small>
          </article>
          <button className="admin-quick-action-card" type="button" onClick={() => setTab('treasury')}>
            <span className="admin-quick-action-icon" aria-hidden="true">🪙</span>
            <span className="admin-quick-action-content">
              <strong>Tesouraria administrativa</strong>
              <small>Acessar emissão e transferências administrativas.</small>
            </span>
            <span className="admin-quick-action-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      )}

      {tab === 'users' && <AdminUsersPanel currentUserRoles={currentUserRoles} onPermissionsUpdated={onPermissionsUpdated} mode="users" />}
      {tab === 'brokers' && <AdminUsersPanel currentUserRoles={currentUserRoles} onPermissionsUpdated={onPermissionsUpdated} mode="brokers" />}
      {tab === 'tokens' && <AdminTokensPanel currentUserRoles={currentUserRoles} />}
      {tab === 'withdrawals' && <AdminWithdrawalsPanel />}

      {tab === 'treasury' && (
        <>
          <h3 className="nested-card">Emitir RPC na Tesouraria</h3>
          <p className="info-text">Cria nova moeda RPC fictícia na tesouraria do sistema. Use apenas para controle administrativo do RP.</p>
          {canIssueRpc ? (
          <form onSubmit={submitIssuance} className="form-grid">
            <input value={issuanceAmount} onChange={(e) => setIssuanceAmount(e.target.value)} placeholder="Quantidade" required />
            <input value={issuanceReason} onChange={(e) => setIssuanceReason(e.target.value)} placeholder="Motivo" required />
            <button className="button-primary" type="submit" disabled={Boolean(pendingAdminAction) || adminModalLoading}>Emitir RPC</button>
          </form>
          ) : (
            <p className="status-message error">Você pode acessar a tesouraria, mas apenas SUPER_ADMIN, DEVELOPER ou ADM Chefe da Moeda pode emitir RPC.</p>
          )}

          <h3 className="nested-card">Enviar R$ para corretor</h3>
          <p className="info-text">Para evitar erro, prefira usar o Discord exato quando houver nomes parecidos.</p>
          <form onSubmit={submitBrokerTransfer} className="form-grid">
            <input value={brokerRef} onChange={(e) => setBrokerRef(e.target.value)} placeholder="Discord do corretor (com ou sem @)" required />
            <input value={brokerAmount} onChange={(e) => setBrokerAmount(e.target.value)} placeholder="Valor em R$" required />
            <input value={brokerReason} onChange={(e) => setBrokerReason(e.target.value)} placeholder="Observação" required />
            <button className="button-primary" type="submit" disabled={Boolean(pendingAdminAction) || adminModalLoading}>Enviar R$ ao corretor</button>
          </form>

          <h3 className="nested-card">Depositar R$ em jogador</h3>
          <p className="info-text">Para evitar erro, prefira usar o Discord exato quando houver nomes parecidos.</p>
          <form onSubmit={submitUserDeposit} className="form-grid">
            <input value={userDepositRef} onChange={(e) => setUserDepositRef(e.target.value)} placeholder="Discord do jogador (com ou sem @)" required />
            <input value={userDepositAmount} onChange={(e) => setUserDepositAmount(e.target.value)} placeholder="Valor em R$" required />
            <input value={userDepositReason} onChange={(e) => setUserDepositReason(e.target.value)} placeholder="Motivo" required />
            <button className="button-primary" type="submit" disabled={Boolean(pendingAdminAction) || adminModalLoading}>Depositar R$ no jogador</button>
          </form>
        </>
      )}



      {tab === 'liquidity' && canManageRpcLiquidity && (
        <>
          <h3 className="nested-card">Liquidez RPC/R$</h3>
          <p className="info-text">Adicionar R$ tende a valorizar RPC. Adicionar RPC tende a desvalorizar RPC. Adicionar ambos proporcionalmente aumenta liquidez sem alterar muito o preço. Esta ação é administrativa e registrada em log.</p>
          {liquidityError && <p className="status-message error">{liquidityError}</p>}
          {liquidity && <div className="summary-grid"><div className="summary-item"><span className="summary-label">Reserva R$</span><strong>{liquidity.fiatReserve}</strong></div><div className="summary-item"><span className="summary-label">Reserva RPC</span><strong>{liquidity.rpcReserve}</strong></div><div className="summary-item"><span className="summary-label">Preço atual</span><strong>{liquidity.currentPrice}</strong></div><div className="summary-item"><span className="summary-label">Última atualização</span><strong>{new Date(liquidity.updatedAt).toLocaleString('pt-BR')}</strong></div><div className="summary-item"><span className="summary-label">Total compras</span><strong>{liquidity.totalBuys}</strong></div><div className="summary-item"><span className="summary-label">Total vendas</span><strong>{liquidity.totalSells}</strong></div><div className="summary-item"><span className="summary-label">Volume R$</span><strong>{liquidity.totalFiatVolume}</strong></div><div className="summary-item"><span className="summary-label">Volume RPC</span><strong>{liquidity.totalRpcVolume}</strong></div></div>}
          <h4 className="nested-card">Adicionar liquidez</h4>
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); setPendingAdminAction('liquidity-inject'); }}>
            <input value={injectFiat} onChange={(e) => setInjectFiat(e.target.value)} placeholder="Valor R$" type="number" step="0.01" min="0" inputMode="decimal" />
            <input value={injectRpc} onChange={(e) => setInjectRpc(e.target.value)} placeholder="Valor RPC" type="number" step="0.01" min="0" inputMode="decimal" />
            <input value={injectReason} onChange={(e) => setInjectReason(e.target.value)} placeholder="Motivo" required minLength={10} />
            <button className="button-primary" type="submit" disabled={Boolean(pendingAdminAction) || adminModalLoading}>Confirmar adição</button>
          </form>
          <h4 className="nested-card">Remover liquidez</h4>
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); setPendingAdminAction('liquidity-withdraw'); }}>
            <input value={withdrawFiat} onChange={(e) => setWithdrawFiat(e.target.value)} placeholder="Valor R$" type="number" step="0.01" min="0" inputMode="decimal" />
            <input value={withdrawRpc} onChange={(e) => setWithdrawRpc(e.target.value)} placeholder="Valor RPC" type="number" step="0.01" min="0" inputMode="decimal" />
            <input value={withdrawReason} onChange={(e) => setWithdrawReason(e.target.value)} placeholder="Motivo" required minLength={10} />
            <button className="button-danger" type="submit" disabled={Boolean(pendingAdminAction) || adminModalLoading}>Confirmar remoção</button>
          </form>
        </>
      )}

      {tab === 'revenues' && (
        <>
          <h3 className="nested-card">Receita da Plataforma</h3>
          {platformAccount && (
            <div className="summary-grid">
              <div className="summary-item"><span className="summary-label">Saldo</span><strong className="summary-value">{platformAccount.balance}</strong></div>
              <div className="summary-item"><span className="summary-label">Taxas recebidas</span><strong className="summary-value">{platformAccount.totalReceivedFees}</strong></div>
              <div className="summary-item"><span className="summary-label">Total retirado</span><strong className="summary-value">{platformAccount.totalWithdrawn}</strong></div>
            </div>
          )}



          {canWithdrawPlatformProfit && (
            <>
              <h3 className="nested-card">Retirar lucro da Exchange</h3>
              <p className="info-text">Para evitar erro, prefira usar o Discord exato quando houver nomes parecidos.</p>
              <form onSubmit={submitPlatformWithdraw} className="form-grid">
                <input
                  value={platformWithdrawRef}
                  onChange={(e) => setPlatformWithdrawRef(e.target.value)}
                  placeholder="Discord do administrador (com ou sem @)"
                  
                  required
                />
                <input
                  value={platformWithdrawAmount}
                  onChange={(e) => setPlatformWithdrawAmount(e.target.value)}
                  placeholder="Valor em R$"
                  required
                />
                <input
                  value={platformWithdrawReason}
                  onChange={(e) => setPlatformWithdrawReason(e.target.value)}
                  placeholder="Motivo"
                  required
                />
                <button className="button-primary" type="submit" disabled={Boolean(pendingAdminAction) || adminModalLoading}>
                  Transferir lucro
                </button>
              </form>
            </>
          )}

          <h3 className="nested-card">Receita dos projetos/tokens</h3>
          <div className="mobile-card-list">
            {companyRevenueAccounts.map((account) => (
              <article key={account.companyId} className="summary-item compact-card">
                <strong>{account.companyName} ({account.ticker})</strong>
                <p>Saldo: {account.balance}</p>
                <p>Total de taxas: {account.totalReceivedFees}</p>
                <p>Total retirado: {account.totalWithdrawn}</p>
              </article>
            ))}
          </div>
        </>
      )}

      {tab === 'audit' && <AdminAuditPanel />}
      {tab === 'reports' && <AdminReportsPanel />}
      {tab === 'support' && <AdminSupportPanel />}
      {tab === 'economic-alerts' && <AdminEconomicAlertsPanel />}
      {tab === 'market-health' && <AdminMarketHealthPanel />}


      <ConfirmActionModal
        open={Boolean(pendingAdminAction)}
        title={getAdminActionTitle(pendingAdminAction)}
        description={getAdminActionDescription(pendingAdminAction)}
        danger={adminActionRequiresConfirm(pendingAdminAction)}
        requireConfirmText={adminActionRequiresConfirm(pendingAdminAction) ? 'CONFIRMAR' : undefined}
        confirmTextValue={adminConfirmText}
        isLoading={adminModalLoading}
        confirmLabel="Confirmar ação"
        cancelLabel="Cancelar"
        onCancel={closeAdminConfirmModal}
        onConfirm={confirmPendingAdminAction}
        extraFields={
          <>
            <input
              type="password"
              value={adminPassword}
              onChange={(event) => setAdminPassword(event.target.value)}
              placeholder="Senha do administrador"
              autoComplete="current-password"
            />
            {adminActionRequiresConfirm(pendingAdminAction) && (
              <input
                value={adminConfirmText}
                onChange={(event) => setAdminConfirmText(event.target.value)}
                placeholder="Digite CONFIRMAR"
              />
            )}
          </>
        }
      />
    </section>
  );
}
