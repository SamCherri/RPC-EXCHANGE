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

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!isInitialLoadDoneRef.current || document.visibilityState !== 'visible') return;
      void api<BotTickResponse>('/test-mode/bot-tick', { method: 'POST' })
        .then((tick) => {
          if (tick.skipped) {
            setLastBotTick(tick);
            return;
          }
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
    if (!fiat || fiat <= 0) {
      setBuyQuote(null);
      return;
    }
    void api<Quote>(`/test-mode/quote-buy?fiatAmount=${encodeURIComponent(String(fiat))}`).then(setBuyQuote).catch(() => setBuyQuote(null));
  }, [tradeAmount]);

  useEffect(() => {
    const rpc = Number(tradeAmount);
    if (!rpc || rpc <= 0) {
      setSellQuote(null);
      return;
    }
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
    const tradePrices = chartTrades
      .map((trade) => Number(trade.priceAfter ?? trade.unitPrice ?? market.currentPrice))
      .filter((value) => Number.isFinite(value) && value > 0);
    const botPrices = botTickHistory
      .map((tick) => Number(tick.priceAfter ?? tick.currentPrice ?? market.currentPrice))
      .filter((value) => Number.isFinite(value) && value > 0);
    const marketPrice = Number(market.currentPrice);
    const points = [...tradePrices, ...botPrices];

    if (Number.isFinite(marketPrice) && marketPrice > 0) {
      points.push(marketPrice);
    }

    const base = Number.isFinite(marketPrice) && marketPrice > 0 ? marketPrice : 1;
    if (points.length === 0) {
      const now = new Date().toISOString();
      return [
        { timestamp: now, price: base },
        { timestamp: now, price: base },
      ];
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


  return <PageShell title="Modo Teste" subtitle="Laboratório isolado da economia real."><section className="card market-page market-shell"><section className="card nested-card market-tab-panel"><div className="quick-actions"><h3>Desafio do Modo Teste</h3><button type="button" className="quick-pill" onClick={() => setShowTutorial((value) => !value)}>{showTutorial ? 'Fechar tutorial' : 'Tutorial'}</button></div><p className="info-text">Seu objetivo é aumentar seu patrimônio estimado em R$ teste comprando RPC quando achar barato e vendendo quando achar caro.</p><p className="info-text"><strong>Patrimônio estimado = saldo R$ teste + RPC teste convertido pelo preço atual.</strong></p><InfoCallout title="Isolamento do Test Mode" tone="warning"><p>Não altera saldo real, RPC real, mercado real ou tokens reais.</p></InfoCallout><EconomicNotice /><p className="info-text">Cada compra e venda possui taxa de teste de 1%.</p>{showTutorial && <section className="nested-card"><h4>Tutorial rápido</h4><ol className="info-text"><li>Confira seu saldo inicial.</li><li>Compre RPC teste.</li><li>Observe o preço e o gráfico.</li><li>Venda RPC teste quando achar que vale a pena.</li><li>Acompanhe seu patrimônio estimado.</li><li>Tente subir no ranking.</li><li>Reporte bugs se algo parecer errado.</li></ol></section>}</section><p className="info-text">O mercado de teste possui movimentações simuladas para ajudar os jogadores a testar lucro, prejuízo e bugs.</p>
    {loading && <p>Carregando dados do modo teste...</p>}{error && <StatusMessage type="error" message={error} />}{message && <StatusMessage type="success" message={message} />}
    {lastBotTick?.skipped && <p className="info-text">Aguardando próxima janela de simulação.</p>}
    {lastBotTick && !lastBotTick.skipped && <article className="card nested-card"><h4>Última movimentação simulada</h4><p>Side: {lastBotTick.side}</p><p>fiatAmount: {lastBotTick.fiatAmount}</p><p>rpcAmount: {lastBotTick.rpcAmount}</p><p>priceBefore: {lastBotTick.priceBefore}</p><p>priceAfter: {lastBotTick.priceAfter}</p><p>currentPrice: {lastBotTick.currentPrice}</p></article>}
    <div className="trade-screen market-mobile-shell">
      <header className="card trade-header market-pair-header"><p className="company-emoji">🧪 Modo Teste RPC/R$</p><h3 className="trade-price-big">R$ {Number(market?.currentPrice ?? 0).toFixed(4)}</h3><div className="market-stats-row">
<div><MetricCard label="Saldo R$ teste" value={`R$ ${Number(wallet?.fiatBalance ?? 0).toFixed(2)}`} /></div>
<div><MetricCard label="Saldo RPC teste" value={`${Number(wallet?.rpcBalance ?? 0).toFixed(2)} RPC`} /></div>
<div><MetricCard label="Patrimônio" value={`R$ ${total.toFixed(2)}`} status={estimatedResult >= 0 ? "positive" : "negative"} /></div>
<div><MetricCard label="Resultado" value={`${estimatedResult >= 0 ? "+" : "-"}R$ ${Math.abs(estimatedResult).toFixed(2)}`} status={estimatedResult >= 0 ? "positive" : "negative"} /></div>
<div><MetricCard label="Percentual" value={`${estimatedPercent >= 0 ? '+' : ''}${estimatedPercent.toFixed(2)}%`} status={estimatedPercent >= 0 ? "positive" : "negative"} /></div>
<div><MetricCard label="Status" value={playerStatus} status={estimatedResult >= 0 ? "positive" : "negative"} /></div>
<div><MetricCard label="Atualizado" value={market?.updatedAt ? new Date(market.updatedAt).toLocaleString('pt-BR') : '--'} /></div></div></header>
      <section className="card nested-card market-tab-panel"><h4>Preço RPC/R$ (teste)</h4><div className="chart-wrap chart-wrap-highlight modern-chart-shell"><MarketLineChart points={chartPoints} currentPrice={Number(market?.currentPrice ?? 0)} timeframe="24H" emptyMessage="Sem dados suficientes para o gráfico de teste." /></div></section>
      <section className="card nested-card market-tab-panel"><h4>Negociar no Modo Teste</h4><div className="form-grid nested-card"><label htmlFor="test-mode-trade-amount">Valor da operação</label><input id="test-mode-trade-amount" type="number" inputMode="decimal" min="0" step="0.01" placeholder="Digite o valor" value={tradeAmount} onChange={(e) => setTradeAmount(e.target.value)} /><p className="info-text">Para comprar, o valor será em R$. Para vender, o valor será em RPC.</p><p className="info-text">Compra estimada: Com R$ {tradeAmount || '0'} você recebe {buyQuote?.estimatedRpcAmount ?? '-'} RPC. Taxa: {buyQuote?.feeAmount ? `R$ ${buyQuote.feeAmount}` : '-'}</p><p className="info-text">Venda estimada: Vendendo {tradeAmount || '0'} RPC você recebe R$ {sellQuote?.estimatedFiatAmount ?? '-'}. Taxa: {sellQuote?.feeAmount ? `R$ ${sellQuote.feeAmount}` : '-'}</p></div><div className="quick-actions"><ActionButton variant="success" disabled={!buyQuote} loading={isBuying} loadingText="Comprando..." onClick={handleBuy}>Comprar RPC de teste</ActionButton><ActionButton variant="danger" disabled={!sellQuote} loading={isSelling} loadingText="Vendendo..." onClick={handleSell}>Vender RPC de teste</ActionButton></div><button type="button" className="quick-pill" onClick={() => setShowQuoteDetails((value) => !value)}>{showQuoteDetails ? 'Ocultar detalhes' : 'Ver detalhes da cotação'}</button>{showQuoteDetails && <div className="summary-item"><p className="info-text"><strong>Compra</strong></p><p className="info-text">Entrada: R$ {tradeAmount || '0'}</p><p className="info-text">Recebe: {buyQuote?.estimatedRpcAmount ?? '-'} RPC</p><p className="info-text">Taxa: {buyQuote?.feeAmount ? `R$ ${buyQuote.feeAmount}` : '-'}</p><p className="info-text">Preço efetivo: {buyQuote?.effectiveUnitPrice ?? '-'}</p><p className="info-text">Preço antes: {Number(market?.currentPrice ?? 0).toFixed(6)}</p><p className="info-text">Preço após compra: {buyQuote?.estimatedPriceAfter ?? '-'}</p><p className="info-text">Variação: {buyQuote ? (Number(buyQuote.estimatedPriceAfter) - Number(market?.currentPrice ?? 0)).toFixed(6) : '-'}</p><p className="info-text"><strong>Venda</strong></p><p className="info-text">Entrada: {tradeAmount || '0'} RPC</p><p className="info-text">Recebe: R$ {sellQuote?.estimatedFiatAmount ?? '-'}</p><p className="info-text">Taxa: {sellQuote?.feeAmount ? `R$ ${sellQuote.feeAmount}` : '-'}</p><p className="info-text">Preço efetivo: {sellQuote?.effectiveUnitPrice ?? '-'}</p><p className="info-text">Preço antes: {Number(market?.currentPrice ?? 0).toFixed(6)}</p><p className="info-text">Preço após venda: {sellQuote?.estimatedPriceAfter ?? '-'}</p><p className="info-text">Variação: {sellQuote ? (Number(sellQuote.estimatedPriceAfter) - Number(market?.currentPrice ?? 0)).toFixed(6) : '-'}</p><p className="info-text">Taxa de teste de 1% aplicada e preço pode variar pela operação.</p></div>}</section>
      <section className="card nested-card market-book-tab market-tab-panel"><h4>Profundidade/liquidez de teste</h4><div className="order-book-grid"><div className="summary-item"><span className="summary-label">Reserva R$ teste</span><strong>R$ {Number(market?.fiatReserve ?? 0).toFixed(2)}</strong></div><div className="summary-item"><span className="summary-label">Reserva RPC teste</span><strong>{Number(market?.rpcReserve ?? 0).toFixed(2)} RPC</strong></div></div></section>
      <section className="card nested-card market-tab-panel"><h4>Últimos trades</h4><div className="mobile-card-list">{trades.length === 0 && <EmptyState title="Sem negociações" description="Sem negociações ainda." />}{trades.slice(0, 20).map((trade) => { const isBuy = trade.side === 'BUY' || trade.side === 'BUY_RPC'; return <article key={trade.id} className="summary-item compact-card"><p><strong>{isBuy ? 'COMPRA' : 'VENDA'}</strong> · {new Date(trade.createdAt).toLocaleString('pt-BR')}</p><p>RPC: {trade.rpcAmount}</p><p>Total R$: {trade.fiatAmount}</p><p>Preço unitário: {trade.unitPrice ?? '-'}</p></article>; })}</div></section>
      <section className="card nested-card market-tab-panel"><h4>Ranking por patrimônio estimado</h4><p className="info-text">Quem termina com mais R$ teste + RPC convertido fica acima.</p><p className="info-text">Patrimônio inicial de referência: R$ 10.000,00.</p>{playerRankIndex >= 0 && <p className="info-text"><strong>Você está em #{playerRankIndex + 1}.</strong></p>}{leaderboard.length === 0 && <EmptyState title="Ranking vazio" description="Nenhum jogador no ranking ainda." />}<div className="mobile-card-list">{leaderboard.map((row, idx) => <article key={row.userId} className="summary-item" style={{ borderColor: row.userId === me?.id ? '#22c55e' : undefined }}><p><strong>Posição #{idx + 1} · {row.characterName ?? row.name ?? 'Jogador'}</strong> {idx < 3 ? '🏆' : ''} {row.userId === me?.id ? '(Você)' : ''}</p><p>Saldo R$ teste: {row.fiatBalance}</p><p>Saldo RPC teste: {row.rpcBalance}</p><p><strong>Patrimônio total estimado: R$ {row.estimatedTotalFiat}</strong></p><p>Resultado: {Number(row.estimatedTotalFiat) - initialReference >= 0 ? '+' : '-'}R$ {Math.abs(Number(row.estimatedTotalFiat) - initialReference).toFixed(2)} ({((Number(row.estimatedTotalFiat) - initialReference) / initialReference * 100 >= 0 ? '+' : '')}{((Number(row.estimatedTotalFiat) - initialReference) / initialReference * 100).toFixed(2)}%)</p></article>)}</div></section>
      <section className="card nested-card market-tab-panel"><p className="info-text">Encontrou saldo estranho, lucro impossível ou erro visual? Reporte para ajudar a melhorar a Exchange.</p><p className="info-text">Este modo simula compra e venda rápida. Ordens limitadas fazem parte do mercado real.</p><TestModeReportForm className="nested-card" /></section>
    </div></section></PageShell>;
}
