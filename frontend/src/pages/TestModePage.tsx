import { useEffect, useMemo, useRef, useState } from 'react';
import { api, getCurrentUser } from '../services/api';
import { TestModeReportForm } from '../components/TestModeReportForm';
import { MarketLineChart, type MarketChartPoint } from '../components/MarketLineChart';
import { ActionButton } from '../components/ActionButton';
import { EconomicNotice } from '../components/EconomicNotice';
import { StatusMessage } from '../components/StatusMessage';
import { PageShell } from '../components/ui/PageShell';
import { MetricCard } from '../components/ui/MetricCard';
import { InfoCallout } from '../components/ui/InfoCallout';
import { EmptyState } from '../components/ui/EmptyState';
import { BottomSheet } from '../components/layout/BottomSheet';

type Wallet = { fiatBalance: string; rpcBalance: string; userId?: string };
type Market = { currentPrice: string; fiatReserve: string; rpcReserve: string; updatedAt?: string };
type Trade = { id: string; side: 'BUY' | 'SELL' | 'BUY_RPC' | 'SELL_RPC'; fiatAmount: string; rpcAmount: string; unitPrice?: string; priceAfter?: string; priceBefore?: string; createdAt: string };
type LeaderboardRow = { userId: string; name?: string | null; characterName?: string | null; fiatBalance: string; rpcBalance: string; estimatedTotalFiat: string };
type Quote = { estimatedRpcAmount?: string; estimatedFiatAmount?: string; effectiveUnitPrice: string; estimatedPriceAfter: string; feeAmount?: string; feePercent?: string; grossFiatAmount?: string; netFiatAmount?: string };
type BotTickResponse = { skipped?: boolean; message?: string; side?: 'BUY' | 'SELL'; fiatAmount?: string; rpcAmount?: string; priceBefore?: string; priceAfter?: string; currentPrice?: string };

export function TestModePage() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [market, setMarket] = useState<Market | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [me, setMe] = useState<{ id: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [tradeAmount, setTradeAmount] = useState('100');
  const [buyQuote, setBuyQuote] = useState<Quote | null>(null);
  const [sellQuote, setSellQuote] = useState<Quote | null>(null);
  const [showQuoteDetails, setShowQuoteDetails] = useState(false);
  const [isBuying, setIsBuying] = useState(false);
  const [isSelling, setIsSelling] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  const isInitialLoadDoneRef = useRef(false);
  const [lastBotTick, setLastBotTick] = useState<BotTickResponse | null>(null);
  const [botTickHistory, setBotTickHistory] = useState<BotTickResponse[]>([]);

  async function loadAll() {
    setLoading(true);
    setError('');
    try {
      const w = await api<Wallet>('/test-mode/me');
      const [m, t, l, meData] = await Promise.all([
        api<Market>('/test-mode/market'),
        api<{ trades: Trade[] }>('/test-mode/trades?limit=200'),
        api<{ leaderboard: LeaderboardRow[] }>('/test-mode/leaderboard'),
        getCurrentUser().catch(() => null),
      ]);
      setWallet(w);
      setMarket(m);
      setTrades(t.trades ?? []);
      setLeaderboard((l.leaderboard ?? []).sort((a, b) => Number(b.estimatedTotalFiat) - Number(a.estimatedTotalFiat)));
      setMe(w.userId ? { id: w.userId } : meData?.user ? { id: meData.user.id } : null);
    } catch (e) {
      setError((e as Error).message || 'Falha ao carregar Modo Teste.');
    } finally {
      setLoading(false);
      isInitialLoadDoneRef.current = true;
    }
  }

  useEffect(() => { void loadAll(); }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!isInitialLoadDoneRef.current || document.visibilityState !== 'visible') return;
      void api<BotTickResponse>('/test-mode/bot-tick', { method: 'POST' })
        .then((tick) => {
          if (tick.skipped) return setLastBotTick(tick);
          setLastBotTick(tick);
          setBotTickHistory((items) => [...items, tick].slice(-50));
          return loadAll();
        })
        .catch(() => undefined);
    }, 30000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const fiat = Number(tradeAmount);
    if (!fiat || fiat <= 0) return setBuyQuote(null);
    void api<Quote>(`/test-mode/quote-buy?fiatAmount=${encodeURIComponent(String(fiat))}`).then(setBuyQuote).catch(() => setBuyQuote(null));
  }, [tradeAmount]);

  useEffect(() => {
    const rpc = Number(tradeAmount);
    if (!rpc || rpc <= 0) return setSellQuote(null);
    void api<Quote>(`/test-mode/quote-sell?rpcAmount=${encodeURIComponent(String(rpc))}`).then(setSellQuote).catch(() => setSellQuote(null));
  }, [tradeAmount]);

  const initialReference = 10_000;
  const total = useMemo(() => wallet && market ? Number(wallet.fiatBalance) + Number(wallet.rpcBalance) * Number(market.currentPrice) : 0, [wallet, market]);
  const estimatedResult = total - initialReference;
  const estimatedPercent = (estimatedResult / initialReference) * 100;
  const playerRankIndex = leaderboard.findIndex((row) => row.userId === me?.id);
  const playerStatus = estimatedResult > 0 ? 'No lucro' : estimatedResult < 0 ? 'No prejuízo' : 'Neutro';
  const chartTrades = useMemo(() => [...trades].reverse(), [trades]);

  const chartPoints = useMemo<MarketChartPoint[]>(() => {
    if (!market) return [];
    const tradePrices = chartTrades.map((t) => Number(t.priceAfter ?? t.unitPrice ?? market.currentPrice)).filter((v) => Number.isFinite(v) && v > 0);
    const botPrices = botTickHistory.map((tick) => Number(tick.priceAfter ?? tick.currentPrice ?? market.currentPrice)).filter((v) => Number.isFinite(v) && v > 0);
    const marketPrice = Number(market.currentPrice);
    const points = [...tradePrices, ...botPrices];
    if (Number.isFinite(marketPrice) && marketPrice > 0) points.push(marketPrice);

    const base = Number.isFinite(marketPrice) && marketPrice > 0 ? marketPrice : 1;
    if (points.length === 0) {
      const now = new Date().toISOString();
      return [{ timestamp: now, price: base }, { timestamp: now, price: base }];
    }

    return points.map((price, index) => ({
      timestamp: new Date(Date.now() - (points.length - 1 - index) * 30_000).toISOString(),
      price,
    }));
  }, [chartTrades, botTickHistory, market]);

  async function handleBuy() {
    if (isBuying) return;
    try {
      setIsBuying(true);
      setError('');
      await api('/test-mode/buy', { method: 'POST', body: JSON.stringify({ fiatAmount: Number(tradeAmount) }) });
      setMessage('Compra de teste realizada. Confira seu patrimônio e sua posição no ranking.');
      await loadAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsBuying(false);
    }
  }

  async function handleSell() {
    if (isSelling) return;
    try {
      setIsSelling(true);
      setError('');
      await api('/test-mode/sell', { method: 'POST', body: JSON.stringify({ rpcAmount: Number(tradeAmount) }) });
      setMessage('Venda de teste realizada. Confira seu patrimônio e sua posição no ranking.');
      await loadAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsSelling(false);
    }
  }

  return (
    <PageShell title="Modo Teste" subtitle="Laboratório isolado. Não altera saldos, tokens ou mercados reais.">
      <section className="card market-page market-shell testmode-shell">
        <header className="premium-panel page-hero-compact testmode-hero">
          <div className="testmode-hero-top">
            <h3>Modo Teste</h3>
            <span className="status-badge status-badge-warning">Laboratório isolado</span>
          </div>
          <p className="info-text">Ambiente para testar estratégias com mercado simulado e taxa de 1% por operação.</p>
          <InfoCallout title="Aviso econômico" tone="warning">
            <p>Sem Pix, cartão, blockchain, cripto real ou promessa de lucro. Este modo não altera a economia real.</p>
          </InfoCallout>
          <EconomicNotice />
          <button type="button" className="quick-pill" onClick={() => setShowTutorial((v) => !v)}>{showTutorial ? 'Fechar tutorial' : 'Tutorial rápido'}</button>
          {showTutorial && (
            <section className="compact-callout">
              <ol className="info-text">
                <li>Compre RPC teste em baixa.</li>
                <li>Venda RPC teste em alta.</li>
                <li>Acompanhe patrimônio e ranking.</li>
              </ol>
            </section>
          )}
        </header>

        {loading && <p>Carregando dados do modo teste...</p>}
        {error && <StatusMessage type="error" message={error} />}
        {message && <StatusMessage type="success" message={message} />}
        {lastBotTick?.skipped && <p className="info-text">Aguardando próxima janela de simulação.</p>}

        <div className="market-stats-row metric-grid">
          <MetricCard label="Saldo R$ teste" value={`R$ ${Number(wallet?.fiatBalance ?? 0).toFixed(2)}`} />
          <MetricCard label="Saldo RPC teste" value={`${Number(wallet?.rpcBalance ?? 0).toFixed(2)} RPC`} />
          <MetricCard label="Patrimônio" value={`R$ ${total.toFixed(2)}`} status={estimatedResult >= 0 ? 'positive' : 'negative'} />
          <MetricCard label="Resultado" value={`${estimatedResult >= 0 ? '+' : '-'}R$ ${Math.abs(estimatedResult).toFixed(2)}`} status={estimatedResult >= 0 ? 'positive' : 'negative'} />
          <MetricCard label="Percentual" value={`${estimatedPercent >= 0 ? '+' : ''}${estimatedPercent.toFixed(2)}%`} status={estimatedResult >= 0 ? 'positive' : 'negative'} />
          <MetricCard label="Status" value={playerStatus} status={estimatedResult >= 0 ? 'positive' : 'negative'} />
        </div>

        <section className="card market-tab-panel">
          <h4>Negociar no Modo Teste</h4>
          <label htmlFor="test-mode-trade-amount">Valor da operação</label>
          <input id="test-mode-trade-amount" type="number" inputMode="decimal" min="0" step="0.01" value={tradeAmount} onChange={(e) => setTradeAmount(e.target.value)} />
          <p className="info-text">Compra: R$ {tradeAmount || '0'} → {buyQuote?.estimatedRpcAmount ?? '-'} RPC • Taxa: {buyQuote?.feeAmount ? `R$ ${buyQuote.feeAmount}` : '-'}</p>
          <p className="info-text">Venda: {tradeAmount || '0'} RPC → R$ {sellQuote?.estimatedFiatAmount ?? '-'} • Taxa: {sellQuote?.feeAmount ? `R$ ${sellQuote.feeAmount}` : '-'}</p>
          <div className="quick-actions">
            <ActionButton variant="success" disabled={!buyQuote} loading={isBuying} loadingText="Comprando..." onClick={handleBuy}>Comprar RPC de teste</ActionButton>
            <ActionButton variant="danger" disabled={!sellQuote} loading={isSelling} loadingText="Vendendo..." onClick={handleSell}>Vender RPC de teste</ActionButton>
          </div>
          <button type="button" className="quick-pill" onClick={() => setShowQuoteDetails((v) => !v)}>{showQuoteDetails ? 'Ocultar detalhes' : 'Ver detalhes da cotação'}</button>
          <BottomSheet open={showQuoteDetails} title="Detalhes da cotação" onClose={() => setShowQuoteDetails(false)}>
            <div className="summary-item compact-callout">
              <strong>Detalhes da cotação</strong>
              <p className="info-text">Compra: entrada R$ {tradeAmount || '0'} → recebe {buyQuote?.estimatedRpcAmount ?? '-'} RPC</p>
              <p className="info-text">Taxa compra: {buyQuote?.feeAmount ? `R$ ${buyQuote.feeAmount}` : '-'}</p>
              <p className="info-text">Preço efetivo compra: {buyQuote?.effectiveUnitPrice ?? '-'}</p>
              <p className="info-text">Preço após compra: {buyQuote?.estimatedPriceAfter ?? '-'}</p>
              <p className="info-text">Venda: entrada {tradeAmount || '0'} RPC → recebe R$ {sellQuote?.estimatedFiatAmount ?? '-'}</p>
              <p className="info-text">Taxa venda: {sellQuote?.feeAmount ? `R$ ${sellQuote.feeAmount}` : '-'}</p>
              <p className="info-text">Preço efetivo venda: {sellQuote?.effectiveUnitPrice ?? '-'}</p>
              <p className="info-text">Preço após venda: {sellQuote?.estimatedPriceAfter ?? '-'}</p>
            </div>
          </BottomSheet>
        </section>

        {lastBotTick && !lastBotTick.skipped && (
          <article className="summary-item compact-callout">
            <strong>Última movimentação simulada</strong>
            <p className="info-text">{lastBotTick.side} • preço {lastBotTick.priceBefore} → {lastBotTick.priceAfter}</p>
          </article>
        )}

        <section className="card market-tab-panel">
          <h4>Preço RPC/R$ (teste)</h4>
          <div className="chart-wrap chart-wrap-highlight modern-chart-shell">
            <MarketLineChart points={chartPoints} currentPrice={Number(market?.currentPrice ?? 0)} timeframe="24H" emptyMessage="Sem dados suficientes para o gráfico de teste." />
          </div>
        </section>

        <section className="card market-tab-panel">
          <h4>Últimos trades</h4>
          {trades.length === 0 ? <EmptyState title="Sem negociações" description="Sem negociações no momento." /> : (
            <div className="mobile-card-list">
              {trades.slice(0, 10).map((trade) => {
                const isBuy = trade.side === 'BUY' || trade.side === 'BUY_RPC';
                return (
                  <article key={trade.id} className="summary-item compact-card">
                    <p><strong>{isBuy ? 'COMPRA' : 'VENDA'}</strong> · {new Date(trade.createdAt).toLocaleString('pt-BR')}</p>
                    <p>RPC: {trade.rpcAmount} • Total R$: {trade.fiatAmount}</p>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="card market-tab-panel">
          <h4>Ranking por patrimônio estimado</h4>
          {playerRankIndex >= 0 && <p className="info-text"><strong>Você está em #{playerRankIndex + 1}.</strong></p>}
          {leaderboard.length === 0 ? <EmptyState title="Ranking vazio" description="Nenhum jogador no ranking ainda." /> : (
            <div className="mobile-card-list">
              {leaderboard.slice(0, 10).map((row, idx) => (
                <article key={row.userId} className="summary-item compact-card">
                  <p><strong>#{idx + 1} · {row.characterName ?? row.name ?? 'Jogador'} {row.userId === me?.id ? '(Você)' : ''}</strong></p>
                  <p>Patrimônio estimado: R$ {row.estimatedTotalFiat}</p>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="card market-tab-panel">
          <p className="info-text">Reporte qualquer inconsistência para auditoria do modo teste.</p>
          <TestModeReportForm className="nested-card" />
        </section>
      </section>
    </PageShell>
  );
}
