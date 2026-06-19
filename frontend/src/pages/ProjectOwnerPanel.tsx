import { FormEvent, useEffect, useState } from 'react';
import { api } from '../services/api';
import { formatCurrency, formatPrice } from '../utils/formatters';
import { translateBoostSource, translateCompanyStatus } from '../utils/labels';

type Entry = { id: string; amountRpc: string; reason: string; createdAt: string };
type Company = { id: string; name: string; ticker: string; status: string; currentPrice: string; fictitiousMarketCap: string; boostAccount?: { rpcBalance: string; totalInjectedRpc: string }; revenueAccount?: { balance: string }; capitalFlowEntries?: Entry[] };

export function ProjectOwnerPanel() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [walletRpcBalance, setWalletRpcBalance] = useState(0);
  const [selectedId, setSelectedId] = useState('');
  const [amountRpc, setAmountRpc] = useState('');
  const [reason, setReason] = useState('');
  const [boostAmountRpc, setBoostAmountRpc] = useState('');
  const [boostReason, setBoostReason] = useState('');
  const [boostSource, setBoostSource] = useState<'PERSONAL_WALLET' | 'PROJECT_REVENUE'>('PERSONAL_WALLET');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isSubmittingCapitalFlow, setIsSubmittingCapitalFlow] = useState(false);
  const [isSubmittingLegacyBoost, setIsSubmittingLegacyBoost] = useState(false);
  const [capitalFlowIdempotencyKey, setCapitalFlowIdempotencyKey] = useState('');

  const load = async () => {
    const response = await api<{ walletRpcAvailableBalance: string | number; companies: Company[] }>('/project-capital-flow/my-projects');
    setWalletRpcBalance(Number(response.walletRpcAvailableBalance ?? 0));
    setCompanies(response.companies);
    setSelectedId((prev) => response.companies.find((company) => company.id === prev)?.id ?? response.companies[0]?.id ?? '');
  };

  useEffect(() => { load().catch((err) => setError((err as Error).message)); }, []);
  useEffect(() => { setCapitalFlowIdempotencyKey(''); }, [selectedId, amountRpc, reason]);

  async function submitCapitalFlow(event: FormEvent) {
    event.preventDefault();
    if (isSubmittingCapitalFlow) return;
    setIsSubmittingCapitalFlow(true);
    try {
      const idempotencyKey = capitalFlowIdempotencyKey || crypto.randomUUID();
      if (!capitalFlowIdempotencyKey) setCapitalFlowIdempotencyKey(idempotencyKey);
      await api(`/project-capital-flow/companies/${selectedId}/contribute`, { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ amountRpc, reason, idempotencyKey }) });
      setMessage('Aporte RPC realizado com sucesso no caixa institucional do projeto.');
      setAmountRpc('');
      setReason('');
      setCapitalFlowIdempotencyKey('');
      await load();
    } catch (err) { setError((err as Error).message); } finally { setIsSubmittingCapitalFlow(false); }
  }

  async function submitLegacyBoost(event: FormEvent) {
    event.preventDefault();
    if (isSubmittingLegacyBoost) return;
    setIsSubmittingLegacyBoost(true);
    try {
      const response = await api<{ message: string; priceBefore: string; priceAfter: string }>(`/project-boosts/companies/${selectedId}/boost`, { method: 'POST', body: JSON.stringify({ amountRpc: boostAmountRpc, source: boostSource, reason: boostReason }) });
      setMessage(`${response.message} Preço antes: ${formatPrice(Number(response.priceBefore))} | depois: ${formatPrice(Number(response.priceAfter))}`);
      setBoostAmountRpc('');
      setBoostReason('');
      await load();
    } catch (err) { setError((err as Error).message); } finally { setIsSubmittingLegacyBoost(false); }
  }

  return <section className="card"><h2>Meus Projetos</h2>{error && <p className="status-message error">{error}</p>}{message && <p className="status-message success">{message}</p>}<p className="info-text">Para injetar no seu projeto, primeiro você precisa ter RPC na carteira. O fluxo correto é: R$ fictício → RPC → aporte no projeto.</p><p className="info-text">Este aporte usa RPC real já existente na sua carteira. Este aporte não altera o preço do token.</p><p className="info-text">O preço só muda por compra executada na oferta inicial ou trade real no mercado secundário.</p><p><strong>Saldo RPC disponível na carteira:</strong> {formatCurrency(walletRpcBalance)} RPC</p>{companies.length === 0 && <p className="info-text">Você ainda não possui projetos ativos.</p>}<div className="mobile-card-list">{companies.map((c) => <article key={c.id} className="summary-item compact-card"><strong>{c.ticker} - {c.name}</strong><p>Status: {translateCompanyStatus(c.status)}</p><p>Preço: {formatPrice(Number(c.currentPrice))} RPC</p><p>Market cap: {formatCurrency(Number(c.fictitiousMarketCap))}</p><p>Caixa RPC do projeto: {formatCurrency(Number(c.revenueAccount?.balance ?? 0))}</p><p>Últimos aportes: {c.capitalFlowEntries?.length ?? 0}</p><p>Reserva boost (legado): {formatCurrency(Number(c.boostAccount?.rpcBalance ?? 0))}</p></article>)}</div>{selectedId && <><form onSubmit={submitCapitalFlow} className="form-grid"><h3>Aporte RPC no projeto (novo fluxo)</h3><select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} required>{companies.map((c) => <option key={c.id} value={c.id}>{c.ticker} - {c.name}</option>)}</select><input value={amountRpc} onChange={(e) => setAmountRpc(e.target.value)} placeholder="Valor RPC" required /><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo do aporte (mínimo 10 caracteres)" minLength={10} required /><button className="button-primary" type="submit" disabled={isSubmittingCapitalFlow}>{isSubmittingCapitalFlow ? 'Enviando aporte...' : 'Aportar RPC no projeto'}</button></form><form onSubmit={submitLegacyBoost} className="form-grid"><h3>Impulsão legada (manter compatibilidade)</h3><select value={boostSource} onChange={(e) => setBoostSource(e.target.value as 'PERSONAL_WALLET' | 'PROJECT_REVENUE')}><option value="PERSONAL_WALLET">{translateBoostSource('PERSONAL_WALLET')}</option><option value="PROJECT_REVENUE">{translateBoostSource('PROJECT_REVENUE')}</option></select><input value={boostAmountRpc} onChange={(e) => setBoostAmountRpc(e.target.value)} placeholder="Valor RPC (boost legado)" required /><input value={boostReason} onChange={(e) => setBoostReason(e.target.value)} placeholder="Motivo do boost legado" required /><button className="button-secondary" type="submit" disabled={isSubmittingLegacyBoost}>{isSubmittingLegacyBoost ? 'Enviando boost...' : 'Executar impulsão legada'}</button></form></>}</section>;
}
