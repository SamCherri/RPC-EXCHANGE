import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Button } from '../components/ui/Button';
import { ActionButton } from '../components/ActionButton';
import { EconomicNotice } from '../components/EconomicNotice';
import { ImpactPreviewCard } from '../components/ImpactPreviewCard';
import { StatusMessage } from '../components/StatusMessage';
import { ConfirmEconomicAction } from '../components/ConfirmEconomicAction';
import { api } from '../services/api';
import { formatCurrency, formatPercent, formatPrice, formatSignedPrice } from '../utils/formatters';
import { MarketLineChart, type MarketChartPoint } from '../components/MarketLineChart';
import { OrderBook } from '../components/OrderBook';
import { PageShell } from '../components/ui/PageShell';
import { MetricCard } from '../components/ui/MetricCard';
import { InfoCallout } from '../components/ui/InfoCallout';
import { EmptyState } from '../components/ui/EmptyState';

type MarketState = { currentPrice: string; fiatReserve: string; rpcReserve: string; totalFiatVolume: string; totalRpcVolume: string; totalBuys: number; totalSells: number; updatedAt: string; };
type Trade = { id: string; side: 'BUY_RPC' | 'SELL_RPC'; fiatAmount: string; rpcAmount: string; unitPrice: string; priceBefore: string; priceAfter: string; createdAt: string; };
type BuyQuote = { grossFiatAmount: string; netFiatAmount: string; feeAmount: string; feePercent: number; estimatedRpcAmount: string; effectiveUnitPrice: string };
type SellQuote = { grossFiatAmount: string; netFiatAmount: string; feeAmount: string; feePercent: number; estimatedFiatAmount: string; grossEstimatedFiatAmount: string; effectiveUnitPrice: string };
type LimitOrder = { id: string; side: 'BUY_RPC' | 'SELL_RPC'; status: 'OPEN' | 'FILLED' | 'CANCELED' | 'REJECTED'; limitPrice: string; fiatAmount?: string; rpcAmount?: string; lockedFiatAmount: string; lockedRpcAmount: string; createdAt: string; executedAt?: string; canceledAt?: string };
type OrderBook = { buyOrders: LimitOrder[]; sellOrders: LimitOrder[] };
type Timeframe = '1H' | '24H' | '7D' | '30D' | 'ALL';
type RpcMarketTab = 'preco' | 'livro' | 'ordens' | 'trades' | 'dados';
type TradeFlow = 'buy' | 'sell' | null;
type RpcTradeMode = 'market' | 'limit';
type PendingConfirmation = 'buy-market' | 'sell-market' | null;

const timeframes: { key: Timeframe; label: string; hours: number | null }[] = [
  { key: '1H', label: '1H', hours: 1 },
  { key: '24H', label: '24H', hours: 24 },
  { key: '7D', label: '7D', hours: 24 * 7 },
  { key: '30D', label: '30D', hours: 24 * 30 },
  { key: 'ALL', label: 'ALL', hours: null },
];

const RPC_MARKET_TRADES_LIMIT = 200;
const TRADES_LOAD_FALLBACK_MESSAGE = 'Não foi possível carregar o histórico de trades agora. O preço atual continua disponível.';
const OPTIONAL_DATA_FALLBACK_MESSAGE = 'Alguns dados secundários (livro/ordens/trades) não puderam ser carregados agora.';

export function RpcMarketPage({ initialTradeFlow, onTradeFlowHandled }: { initialTradeFlow?: 'buy' | 'sell' | null; onTradeFlowHandled?: () => void }) {
  const [market, setMarket] = useState<MarketState | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  type WalletView = { fiatAvailableBalance: string; rpcAvailableBalance: string; fiatLockedBalance?: string; rpcLockedBalance?: string; };
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [fiatAmount, setFiatAmount] = useState('');
  const [rpcAmount, setRpcAmount] = useState('');
  const [buyQuote, setBuyQuote] = useState<BuyQuote | null>(null);
  const [sellQuote, setSellQuote] = useState<SellQuote | null>(null);
  const [buyQuoteError, setBuyQuoteError] = useState('');
  const [sellQuoteError, setSellQuoteError] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<RpcMarketTab>('preco');
  const [tradeFlow, setTradeFlow] = useState<TradeFlow>(null);
  const [activeTimeframe, setActiveTimeframe] = useState<Timeframe>('24H');
  const [orderBook, setOrderBook] = useState<OrderBook>({ buyOrders: [], sellOrders: [] });
  const [myOrders, setMyOrders] = useState<LimitOrder[]>([]);
  const [tradeMode, setTradeMode] = useState<RpcTradeMode>('market');
  const [limitFiatAmount, setLimitFiatAmount] = useState('');
  const [limitRpcAmount, setLimitRpcAmount] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [favorite, setFavorite] = useState<boolean>(() => localStorage.getItem('rpc-exchange-rpc-market-favorite') === '1');
  const [isBuying, setIsBuying] = useState(false);
  const [isSelling, setIsSelling] = useState(false);
  const [isCreatingLimitOrder, setIsCreatingLimitOrder] = useState(false);
  const [cancelingOrderId, setCancelingOrderId] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation>(null);

  async function load() {
    setIsLoading(true);
    setError('');
    try {
      const [marketData, me, tradesResult, orderBookResult, myOrdersResult] = await Promise.all([
        api<MarketState>('/rpc-market'),
        api<{ wallet: WalletView }>('/auth/me'),
        api<{ trades: Trade[] }>(`/rpc-market/trades?limit=${RPC_MARKET_TRADES_LIMIT}`)
          .then((data) => ({ ok: true as const, data }))
          .catch(() => ({ ok: false as const })),
        api<OrderBook>('/rpc-market/order-book')
          .then((data) => ({ ok: true as const, data }))
          .catch(() => ({ ok: false as const })),
        api<{ orders: LimitOrder[] }>('/rpc-market/orders/me')
          .then((data) => ({ ok: true as const, data }))
          .catch(() => ({ ok: false as const })),
      ]);
      setMarket(marketData);
      setWallet(me.wallet);

      if (tradesResult.ok) setTrades(tradesResult.data.trades);
      else setTrades([]);

      if (orderBookResult.ok) setOrderBook(orderBookResult.data);
      else setOrderBook({ buyOrders: [], sellOrders: [] });

      if (myOrdersResult.ok) setMyOrders(myOrdersResult.data.orders);
      else setMyOrders([]);

      if (!tradesResult.ok || !orderBookResult.ok || !myOrdersResult.ok) {
        setError(OPTIONAL_DATA_FALLBACK_MESSAGE);
      }
      return true;
    } catch {
      setError('Não foi possível carregar os dados principais do mercado RPC/R$ agora.');
      return false;
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!initialTradeFlow) return;
    setTradeFlow(initialTradeFlow);
    setTradeMode('market');
    onTradeFlowHandled?.();
  }, [initialTradeFlow, onTradeFlowHandled]);

  useEffect(() => {
    const id = setTimeout(async () => {
      if (!fiatAmount || Number(fiatAmount) < 0.01) return setBuyQuote(null);
      try {
        const quote = await api<BuyQuote>(`/rpc-market/quote-buy?fiatAmount=${encodeURIComponent(fiatAmount)}`);
        setBuyQuote(quote);
        setBuyQuoteError('');
      } catch (err) {
        setBuyQuote(null);
        setBuyQuoteError((err as Error).message);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [fiatAmount]);

  useEffect(() => {
    const id = setTimeout(async () => {
      if (!rpcAmount || Number(rpcAmount) < 0.01) return setSellQuote(null);
      try {
        const quote = await api<SellQuote>(`/rpc-market/quote-sell?rpcAmount=${encodeURIComponent(rpcAmount)}`);
        setSellQuote(quote);
        setSellQuoteError('');
      } catch (err) {
        setSellQuote(null);
        setSellQuoteError((err as Error).message);
      }
    }, 250);
    return () => clearTimeout(id);
  }, [rpcAmount]);

  const filteredTrades = useMemo(() => {
    const config = timeframes.find((item) => item.key === activeTimeframe);
    if (!config?.hours) return trades;
    const minDate = Date.now() - config.hours * 60 * 60 * 1000;
    return trades.filter((trade) => new Date(trade.createdAt).getTime() >= minDate);
  }, [activeTimeframe, trades]);

  const chartMetrics = useMemo(() => {
    const ordered = [...filteredTrades].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const normalized = ordered
      .map((trade) => ({ ...trade, price: Number(trade.priceAfter || trade.unitPrice || 0), fiat: Number(trade.fiatAmount || 0), rpc: Number(trade.rpcAmount || 0) }))
      .filter((trade) => Number.isFinite(trade.price) && trade.price > 0);

    const prices = normalized.map((item) => item.price);
    const currentPrice = Number(market?.currentPrice ?? 0) || 0;
    const basePrice = currentPrice > 0 ? currentPrice : prices[0] ?? 1;
    const first = prices[0] ?? basePrice;
    const last = prices[prices.length - 1] ?? basePrice;

    return {
      first,
      last,
      variationAbs: last - first,
      variationPercent: first > 0 ? ((last - first) / first) * 100 : 0,
      tradeCount: normalized.length,
      fiatVolume: normalized.reduce((acc, trade) => acc + trade.fiat, 0),
      rpcVolume: normalized.reduce((acc, trade) => acc + trade.rpc, 0),
      max: prices.length ? Math.max(...prices) : basePrice,
      min: prices.length ? Math.min(...prices) : basePrice,
      emptyReason: normalized.length === 0 ? 'Ainda não há negociações neste período.' : normalized.length === 1 ? 'Histórico insuficiente neste período.' : undefined,
    };
  }, [filteredTrades, market?.currentPrice]);

  const chartPoints = useMemo<MarketChartPoint[]>(() => filteredTrades
    .map((trade) => ({
      timestamp: trade.createdAt,
      price: Number(trade.priceAfter || trade.unitPrice || 0),
      volume: Number(trade.fiatAmount || 0),
      tradeCount: 1,
    }))
    .filter((trade) => Number.isFinite(trade.price) && trade.price > 0), [filteredTrades]);

  async function confirmBuy() {
    setError('');
    setMessage('');
    if (isBuying) return;
    setIsBuying(true);
    try {
      const response = await api<{ message: string }>('/rpc-market/buy', { method: 'POST', body: JSON.stringify({ fiatAmount }) });
      setMessage(response.message);
      setFiatAmount('');
      setBuyQuote(null);
      setTradeFlow(null);
      setPendingConfirmation(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsBuying(false);
    }
  }

  async function confirmSell() {
    setError('');
    setMessage('');
    if (isSelling) return;
    setIsSelling(true);
    try {
      const response = await api<{ message: string }>('/rpc-market/sell', { method: 'POST', body: JSON.stringify({ rpcAmount }) });
      setMessage(response.message);
      setRpcAmount('');
      setSellQuote(null);
      setTradeFlow(null);
      setPendingConfirmation(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSelling(false);
    }
  }

  function onBuy(event: FormEvent) {
    event.preventDefault();
    if (!buyQuote || Number(fiatAmount) < 0.01 || isBuying) return;
    setPendingConfirmation('buy-market');
  }

  function onSell(event: FormEvent) {
    event.preventDefault();
    if (!sellQuote || Number(rpcAmount) < 0.01 || isSelling) return;
    setPendingConfirmation('sell-market');
  }


  async function onCreateLimitOrder(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (isCreatingLimitOrder) return;
    setIsCreatingLimitOrder(true);
    try {
      if (tradeFlow === 'buy') {
        await api('/rpc-market/orders', { method: 'POST', body: JSON.stringify({ side: 'BUY_RPC', fiatAmount: Number(limitFiatAmount), limitPrice: Number(limitPrice) }) });
        setMessage('Ordem limite de compra criada com sucesso.');
        setLimitFiatAmount('');
      } else {
        await api('/rpc-market/orders', { method: 'POST', body: JSON.stringify({ side: 'SELL_RPC', rpcAmount: Number(limitRpcAmount), limitPrice: Number(limitPrice) }) });
        setMessage('Ordem limite de venda criada com sucesso.');
        setLimitRpcAmount('');
      }
      setLimitPrice('');
      setTradeFlow(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsCreatingLimitOrder(false);
    }
  }

  async function onCancelOrder(orderId: string) {
    setError('');
    setMessage('');
    if (cancelingOrderId) return;
    setCancelingOrderId(orderId);
    try {
      await api(`/rpc-market/orders/${orderId}/cancel`, { method: 'POST' });
      setMessage('Ordem cancelada com sucesso.');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCancelingOrderId(null);
    }
  }

  const variationAbs = chartMetrics.variationAbs;
  const variationPercent = chartMetrics.variationPercent;

  return (
    <PageShell title="Mercado RPC/R$" subtitle="Simulação RP com execução e confirmação de segurança."><section className="card market-page market-shell market-page-v2">
      <div className="trade-screen market-mobile-shell">
        <header className="card trade-header market-pair-header market-compact-header market-asset-header market-full-width">
          <div className="market-compact-top">
                        <p className="company-emoji">💴 RPC/R$</p>
            <span className="summary-label">Ativo</span>
            <button type="button" className="small-button" onClick={() => { const v=!favorite; setFavorite(v); localStorage.setItem('rpc-exchange-rpc-market-favorite', v ? '1' : '0'); }}>{favorite ? "★" : "☆"}</button>
          </div>
          <div className="market-price-overview">
            <h3 className="trade-price-big">R$ {formatPrice(Number(market?.currentPrice ?? 0))}</h3>
            <p className={variationPercent >= 0 ? 'positive-change' : 'negative-change'}>
              {variationPercent >= 0 ? '▲' : '▼'} {formatPercent(Math.abs(variationPercent))}% ({formatSignedPrice(variationAbs)})
            </p>
          </div>
          <div className="market-stats-row market-mini-stats">
            <MetricCard label="Preço atual" value={`R$ ${formatPrice(Number(market?.currentPrice ?? 0))}`} />
            <MetricCard label="Máx" value={`R$ ${formatPrice(chartMetrics.max)}`} />
            <MetricCard label="Mín" value={`R$ ${formatPrice(chartMetrics.min)}`} />
            <MetricCard label="Volume R$" value={formatCurrency(chartMetrics.fiatVolume)} />
            <MetricCard label="Volume RPC" value={formatCurrency(chartMetrics.rpcVolume)} />
            <MetricCard label="Saldo RPC" value={formatCurrency(Number(wallet?.rpcAvailableBalance ?? 0))} />
          </div>
        </header>

        <InfoCallout title="Simulação RP" tone="info"><p>R$ e RPC são fictícios e sem conversão real.</p></InfoCallout><EconomicNotice />
        {error && <StatusMessage type="error" message={error} />}
        {message && <StatusMessage type="success" message={message} />}

        <nav className="market-top-tabs market-mobile-tabs market-full-width">
          <button className={activeTab === 'preco' ? 'quick-pill active' : 'quick-pill'} onClick={() => setActiveTab('preco')}>Preço</button>
          <button className={activeTab === 'livro' ? 'quick-pill active' : 'quick-pill'} onClick={() => setActiveTab('livro')}>Livro</button>
          <button className={activeTab === 'ordens' ? 'quick-pill active' : 'quick-pill'} onClick={() => setActiveTab('ordens')}>Ordens</button>
          <button className={activeTab === 'trades' ? 'quick-pill active' : 'quick-pill'} onClick={() => setActiveTab('trades')}>Trades</button>
          <button className={activeTab === 'dados' ? 'quick-pill active' : 'quick-pill'} onClick={() => setActiveTab('dados')}>Dados</button>
        </nav>

        {activeTab === 'preco' && <section className="card nested-card market-price-tab market-tab-panel market-full-width">
          <h4>Preço RPC/R$</h4>
          <div className="chart-timeframes">{timeframes.map((tf) => <button key={tf.key} className={activeTimeframe === tf.key ? 'quick-pill active' : 'quick-pill'} onClick={() => setActiveTimeframe(tf.key)}>{tf.label}</button>)}</div>
          <div className="chart-wrap chart-wrap-highlight modern-chart-shell market-chart-card rpc-chart-shell">
            {isLoading && <div className="chart-empty-elegant"><strong>Carregando gráfico...</strong><span>Buscando dados do mercado RPC/R$.</span></div>}
            {!isLoading && <MarketLineChart points={chartPoints} currentPrice={Number(market?.currentPrice ?? 0)} timeframe={activeTimeframe} emptyMessage="Sem dados suficientes para o gráfico." />}
          </div>
          <div className="chart-meta market-price-card"><div><span>Atual</span><strong>R$ {formatPrice(Number(market?.currentPrice ?? 0))}</strong></div><div><span>Máximo</span><strong>R$ {formatPrice(chartMetrics.max)}</strong></div><div><span>Mínimo</span><strong>R$ {formatPrice(chartMetrics.min)}</strong></div><div><span>Volume R$</span><strong>{formatCurrency(chartMetrics.fiatVolume)}</strong></div><div><span>Volume RPC</span><strong>{formatCurrency(chartMetrics.rpcVolume)}</strong></div><div><span>Trades no período</span><strong>{chartMetrics.tradeCount}</strong></div></div>
          {!isLoading && chartMetrics.emptyReason && <EmptyState title="Sem histórico suficiente" description={chartMetrics.emptyReason} />}
        </section>}

        {activeTab === 'livro' && <section className="card nested-card market-tab-panel market-full-width"><h4>Livro de ordens RPC/R$</h4><p className="info-text">RPC/R$ ainda usa liquidez automática para execução. O livro mostra ordens limite pendentes.</p><div className="order-book-grid"><div className="summary-item"><span className="summary-label">Reserva RPC</span><strong>{formatCurrency(Number(market?.rpcReserve ?? 0))} RPC</strong></div><div className="summary-item"><span className="summary-label">Reserva R$</span><strong>R$ {formatCurrency(Number(market?.fiatReserve ?? 0))}</strong></div></div><OrderBook buyOrders={orderBook.buyOrders.map((o) => { const price = Number(o.limitPrice || 0); const fiat = Number(o.lockedFiatAmount || o.fiatAmount || 0); const quantity = price > 0 ? fiat / price : 0; return { id: o.id, price, quantity, total: fiat }; })} sellOrders={orderBook.sellOrders.map((o) => { const price = Number(o.limitPrice || 0); const quantity = Number(o.lockedRpcAmount || o.rpcAmount || 0); return { id: o.id, price, quantity, total: price * quantity }; })} currentPrice={Number(market?.currentPrice ?? 0)} quoteSymbol="R$" baseSymbol="RPC" emptyMessage="Sem ordens abertas neste livro." /></section>}

        {activeTab === 'ordens' && <section className="card nested-card market-tab-panel market-full-width"><h4>Minhas ordens RPC/R$</h4>{myOrders.length===0?<EmptyState title="Sem ordens" description="Nenhuma ordem RPC/R$ criada ainda." />:<div className="mobile-card-list">{myOrders.map((order)=><article key={order.id} className="summary-item compact-card market-order-card"><p><strong>{order.side==='BUY_RPC'?'COMPRA':'VENDA'}</strong> · {order.status}</p><p>Preço limite: R$ {formatPrice(Number(order.limitPrice||0))}</p><p>Valor: {order.side==='BUY_RPC'?`R$ ${formatCurrency(Number(order.fiatAmount??0))}`:`${formatCurrency(Number(order.rpcAmount??0))} RPC`}</p><p>Travado: {order.side==='BUY_RPC'?`R$ ${formatCurrency(Number(order.lockedFiatAmount??0))}`:`${formatCurrency(Number(order.lockedRpcAmount??0))} RPC`}</p><p>Criada: {new Date(order.createdAt).toLocaleString('pt-BR')}</p>{order.executedAt && <p>Executada: {new Date(order.executedAt).toLocaleString('pt-BR')}</p>}{order.canceledAt && <p>Cancelada: {new Date(order.canceledAt).toLocaleString('pt-BR')}</p>}{order.status==='OPEN' && <ActionButton type="button" className="small-button" onClick={() => void onCancelOrder(order.id)} loading={cancelingOrderId === order.id} loadingText="Cancelando..." disabled={cancelingOrderId !== null && cancelingOrderId !== order.id}>Cancelar</ActionButton>}</article>)}</div>}</section>}

        {activeTab === 'trades' && <section className="card nested-card market-tab-panel market-full-width"><h4>Últimos trades RPC/R$</h4><div className="mobile-card-list">{trades.length === 0 && <EmptyState title="Sem negociações" description="Sem negociações ainda." />}{trades.slice(0, 20).map((trade) => <article key={trade.id} className="summary-item compact-card market-order-card"><p><strong>{trade.side === 'BUY_RPC' ? 'COMPRA' : 'VENDA'}</strong> · {new Date(trade.createdAt).toLocaleTimeString('pt-BR')}</p><p>Preço: R$ {formatPrice(Number(trade.unitPrice))}</p><p>Quantidade: {formatCurrency(Number(trade.rpcAmount))} RPC</p><p>Total: R$ {formatCurrency(Number(trade.fiatAmount))}</p></article>)}</div></section>}

        {activeTab === 'dados' && <section className="card nested-card market-tab-panel market-full-width"><h4>Dados do mercado</h4><div className="market-data-grid"><div className="summary-item"><span className="summary-label">Preço atual</span><strong>R$ {formatPrice(Number(market?.currentPrice ?? 0))}</strong></div><div className="summary-item"><span className="summary-label">Reserva RPC</span><strong>{formatCurrency(Number(market?.rpcReserve ?? 0))} RPC</strong></div><div className="summary-item"><span className="summary-label">Reserva R$</span><strong>R$ {formatCurrency(Number(market?.fiatReserve ?? 0))}</strong></div><div className="summary-item"><span className="summary-label">Volume total R$</span><strong>{formatCurrency(Number(market?.totalFiatVolume ?? 0))}</strong></div><div className="summary-item"><span className="summary-label">Volume total RPC</span><strong>{formatCurrency(Number(market?.totalRpcVolume ?? 0))}</strong></div><div className="summary-item"><span className="summary-label">Total compras</span><strong>{market?.totalBuys ?? 0}</strong></div><div className="summary-item"><span className="summary-label">Total vendas</span><strong>{market?.totalSells ?? 0}</strong></div><div className="summary-item"><span className="summary-label">Atualizado em</span><strong>{market?.updatedAt ? new Date(market.updatedAt).toLocaleString('pt-BR') : '--'}</strong></div><div className="summary-item"><span className="summary-label">Saldo R$ disponível</span><strong>{formatCurrency(Number(wallet?.fiatAvailableBalance ?? 0))}</strong></div><div className="summary-item"><span className="summary-label">Saldo R$ travado</span><strong>{formatCurrency(Number(wallet?.fiatLockedBalance ?? 0))}</strong></div><div className="summary-item"><span className="summary-label">Saldo RPC disponível</span><strong>{formatCurrency(Number(wallet?.rpcAvailableBalance ?? 0))}</strong></div><div className="summary-item"><span className="summary-label">Saldo RPC travado</span><strong>{formatCurrency(Number(wallet?.rpcLockedBalance ?? 0))}</strong></div></div></section>}

        <div className="mobile-trade-actions"><Button variant="success" onClick={() => setTradeFlow('buy')}>Comprar</Button><Button variant="danger" onClick={() => setTradeFlow('sell')}>Vender</Button></div>

        {tradeFlow && <div className="trade-panel-backdrop" onClick={() => setTradeFlow(null)}><div className="trade-bottom-sheet market-trade-sheet" onClick={(event) => event.stopPropagation()}><div className="market-sheet-handle" aria-hidden="true" /><div className="trade-panel-header"><h4>{tradeFlow === 'buy' ? 'Comprar RPC' : 'Vender RPC'}</h4><button type="button" className="small-button" onClick={() => setTradeFlow(null)}>Fechar</button></div><nav className="quick-actions"><button type="button" className={tradeMode === 'market' ? 'quick-pill active' : 'quick-pill'} onClick={() => setTradeMode('market')}>Mercado</button><button type="button" className={tradeMode === 'limit' ? 'quick-pill active' : 'quick-pill'} onClick={() => setTradeMode('limit')}>Limite</button></nav>
          {tradeFlow === 'buy' && tradeMode === 'market' && <form onSubmit={onBuy}><p className="market-sheet-balance-row">Saldo R$ disponível: {formatCurrency(Number(wallet?.fiatAvailableBalance ?? 0))}</p><input value={fiatAmount} onChange={(e) => setFiatAmount(e.target.value)} placeholder="Entrada em R$" required /><ImpactPreviewCard title="Preview da compra RPC" items={[{ label: 'Entrada', value: `R$ ${formatCurrency(Number(fiatAmount || 0))}` },{ label: 'Saída estimada', value: `${formatCurrency(Number(buyQuote?.estimatedRpcAmount ?? 0))} RPC` },{ label: 'Preço médio estimado', value: `R$ ${formatPrice(Number(buyQuote?.effectiveUnitPrice ?? 0))}` },{ label: 'Taxa estimada', value: `R$ ${formatCurrency(Number(buyQuote?.feeAmount ?? 0))} (${buyQuote?.feePercent ?? 1}%)` },{ label: 'Saldo disponível', value: `R$ ${formatCurrency(Number(wallet?.fiatAvailableBalance ?? 0))}` }]} warnings={["Execução depende da liquidez atual e pode variar no momento do envio."]} />{buyQuoteError && <p className="info-text">{buyQuoteError}</p>}<ActionButton variant="success" type="submit" loading={isBuying} loadingText="Comprando..." disabled={!buyQuote || Number(fiatAmount) < 0.01}>Comprar agora</ActionButton></form>}
          {tradeFlow === 'sell' && tradeMode === 'market' && <form onSubmit={onSell}><p className="market-sheet-balance-row">Saldo RPC disponível: {formatCurrency(Number(wallet?.rpcAvailableBalance ?? 0))}</p><input value={rpcAmount} onChange={(e) => setRpcAmount(e.target.value)} placeholder="Entrada em RPC" required /><ImpactPreviewCard title="Preview da venda RPC" items={[{ label: 'Entrada', value: `${formatCurrency(Number(rpcAmount || 0))} RPC` },{ label: 'Saída estimada (líquida)', value: `R$ ${formatCurrency(Number(sellQuote?.estimatedFiatAmount ?? 0))}` },{ label: 'Preço médio estimado', value: `R$ ${formatPrice(Number(sellQuote?.effectiveUnitPrice ?? 0))}` },{ label: 'Taxa estimada', value: `R$ ${formatCurrency(Number(sellQuote?.feeAmount ?? 0))} (${sellQuote?.feePercent ?? 1}%)` },{ label: 'Saldo disponível', value: `${formatCurrency(Number(wallet?.rpcAvailableBalance ?? 0))} RPC` }]} warnings={["Execução depende da liquidez atual e pode ocorrer com variação de preço."]} />{sellQuoteError && <p className="info-text">{sellQuoteError}</p>}<ActionButton variant="danger" type="submit" loading={isSelling} loadingText="Vendendo..." disabled={!sellQuote || Number(rpcAmount) < 0.01}>Vender agora</ActionButton></form>}
          {tradeFlow === 'buy' && tradeMode === 'limit' && <form onSubmit={onCreateLimitOrder}><p className="market-sheet-balance-row">Saldo R$ disponível: {formatCurrency(Number(wallet?.fiatAvailableBalance ?? 0))}</p><input value={limitFiatAmount} onChange={(e) => setLimitFiatAmount(e.target.value)} placeholder="Entrada em R$" required /><input value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} placeholder="Preço limite" required /><p className="info-text">O preço limite considera a taxa da Exchange. Executa se o preço efetivo total for menor ou igual ao limite.</p><ActionButton variant="success" type="submit" loading={isCreatingLimitOrder} loadingText="Enviando..." disabled={Number(limitFiatAmount) < 0.01 || Number(limitPrice) <= 0}>Criar ordem de compra</ActionButton></form>}
          {tradeFlow === 'sell' && tradeMode === 'limit' && <form onSubmit={onCreateLimitOrder}><p className="market-sheet-balance-row">Saldo RPC disponível: {formatCurrency(Number(wallet?.rpcAvailableBalance ?? 0))}</p><input value={limitRpcAmount} onChange={(e) => setLimitRpcAmount(e.target.value)} placeholder="Entrada em RPC" required /><input value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} placeholder="Preço limite" required /><p className="info-text">O preço limite considera a taxa da Exchange. Executa se o preço líquido for maior ou igual ao limite.</p><ActionButton variant="danger" type="submit" loading={isCreatingLimitOrder} loadingText="Enviando..." disabled={Number(limitRpcAmount) < 0.01 || Number(limitPrice) <= 0}>Criar ordem de venda</ActionButton></form>}
        </div></div>}
      </div>

        <ConfirmEconomicAction
          open={pendingConfirmation === 'buy-market'}
          title="Confirmar compra de RPC"
          description="Revise o impacto estimado antes de confirmar a compra."
          confirmText="Confirmar compra"
          loading={isBuying}
          onCancel={() => setPendingConfirmation(null)}
          onConfirm={() => void confirmBuy()}
        >
          <ImpactPreviewCard title="Impacto estimado" items={[{ label: 'Entrada', value: `R$ ${formatCurrency(Number(fiatAmount || 0))}` }, { label: 'Saída', value: `${formatCurrency(Number(buyQuote?.estimatedRpcAmount ?? 0))} RPC` }, { label: 'Taxa', value: `R$ ${formatCurrency(Number(buyQuote?.feeAmount ?? 0))}` }]} warnings={["Não é dinheiro real. Operação em simulação RP."]} />
        </ConfirmEconomicAction>
        <ConfirmEconomicAction
          open={pendingConfirmation === 'sell-market'}
          title="Confirmar venda de RPC"
          description="Revise o impacto estimado antes de confirmar a venda."
          confirmText="Confirmar venda"
          loading={isSelling}
          onCancel={() => setPendingConfirmation(null)}
          onConfirm={() => void confirmSell()}
        >
          <ImpactPreviewCard title="Impacto estimado" items={[{ label: 'Entrada', value: `${formatCurrency(Number(rpcAmount || 0))} RPC` }, { label: 'Saída', value: `R$ ${formatCurrency(Number(sellQuote?.estimatedFiatAmount ?? 0))}` }, { label: 'Taxa', value: `R$ ${formatCurrency(Number(sellQuote?.feeAmount ?? 0))}` }]} warnings={["Não é dinheiro real. Operação em simulação RP."]} />
        </ConfirmEconomicAction>
    </section></PageShell>
  );
}
