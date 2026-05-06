import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { Button } from '../components/ui/Button';
import { formatCurrency, formatPercent, formatPrice } from '../utils/formatters';
import { translateCompanyStatus, translateOrderMode, translateOrderStatus, translateOrderType } from '../utils/labels';
import { MarketLineChart, type MarketChartPoint } from '../components/MarketLineChart';
import { OrderBook } from '../components/OrderBook';
import { InfoCallout } from '../components/ui/InfoCallout';
import { EmptyState } from '../components/ui/EmptyState';

type Company = {
  id: string;
  name: string;
  ticker: string;
  sector: string;
  description: string;
  initialPrice: string;
  currentPrice: string;
  availableOfferShares: number;
  totalShares: number;
  ownerSharePercent: string;
  publicOfferPercent: string;
  buyFeePercent: string;
  sellFeePercent: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED' | 'REJECTED' | 'BANKRUPT' | 'PENDING';
};

type Holding = { companyId: string; quantity: number };

type MarketOrder = {
  id: string;
  companyId: string;
  type: 'BUY' | 'SELL';
  mode: 'LIMIT' | 'MARKET';
  quantity: number;
  remainingQuantity: number;
  limitPrice: string | null;
  status: 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED';
  createdAt: string;
};

type Trade = { id: string; quantity: number; unitPrice: string; createdAt: string };
type DetailTab = 'preco' | 'livro' | 'ordens' | 'trades' | 'dados';
type MarketListTab = 'mercado' | 'destaques';
type TradeFlow = 'buy' | 'sell' | null;
type BuyMode = 'initial' | 'limit' | 'market';
type SellMode = 'limit' | 'market';
type Timeframe = 'Time' | '15m' | '1h' | '4h' | '1D';


type InitialOfferBuyResponse = {
  companyId?: string;
  ticker?: string;
  quantity?: number;
  priceBefore?: string | number;
  priceAfter?: string | number;
  priceIncrease?: string | number;
  grossAmount?: string | number;
  feeAmount?: string | number;
  totalAmount?: string | number;
  availableSharesBefore?: number;
  availableSharesAfter?: number;
  buyerRpcBalanceBefore?: string | number;
  buyerRpcBalanceAfter?: string | number;
  holdingSharesAfter?: number;
  currentPrice?: string | number;
};

type ChartData = {
  points: MarketChartPoint[];
  minPrice: number;
  maxPrice: number;
  initialPrice: number;
  currentPrice: number;
  variationAbsolute: number;
  variationPercent: number;
  lastPrice: number;
  note: string;
};


function getPriceChangePercent(company: Company) {
  const initial = Number(company.initialPrice);
  const current = Number(company.currentPrice);
  if (!Number.isFinite(initial) || initial <= 0 || !Number.isFinite(current)) return 0;
  return ((current - initial) / initial) * 100;
}

function normalizeChartData(trades: Trade[], initialPrice: number, currentPrice: number): ChartData {
  const ordered = [...trades].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const safeInitialPrice = Number.isFinite(initialPrice) && initialPrice > 0 ? initialPrice : 1;
  const safeCurrentPrice = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : safeInitialPrice;
  const tradePoints: MarketChartPoint[] = ordered
    .map((trade) => ({
      timestamp: trade.createdAt,
      price: Number(trade.unitPrice),
      volume: Number(trade.quantity),
    }))
    .filter((point) => Number.isFinite(point.price) && point.price > 0);

  const points: MarketChartPoint[] = [
    { timestamp: ordered[0]?.createdAt ?? new Date().toISOString(), price: safeInitialPrice },
    ...tradePoints,
  ];

  if (points.length === 0 || points[points.length - 1].price !== safeCurrentPrice) {
    points.push({ timestamp: new Date().toISOString(), price: safeCurrentPrice });
  }

  if (points.length === 1) points.push({ ...points[0] });

  const prices = points.map((point) => point.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const variationAbsolute = safeCurrentPrice - safeInitialPrice;
  const variationPercent = safeInitialPrice === 0 ? 0 : (variationAbsolute / safeInitialPrice) * 100;
  const note = trades.length === 0 ? 'Aguardando primeiras negociações' : 'Preço formado com base nas negociações reais do período.';

  return { points, minPrice, maxPrice, initialPrice: safeInitialPrice, currentPrice: safeCurrentPrice, variationAbsolute, variationPercent, lastPrice: points[points.length - 1].price, note };
}


const FAVORITES_STORAGE_KEY = 'rpc-exchange-market-favorites';
const PENDING_COMPANY_MARKET_KEY = 'rpc-exchange-open-company-market-id';

function readFavoriteMarketIds() {
  if (typeof window === 'undefined') return [];
  try {
    const value = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function buildTimeframeStart(timeframe: Timeframe) {
  const now = Date.now();
  if (timeframe === '15m') return now - 15 * 60 * 1000;
  if (timeframe === '1h') return now - 60 * 60 * 1000;
  if (timeframe === '4h') return now - 4 * 60 * 60 * 1000;
  if (timeframe === '1D') return now - 24 * 60 * 60 * 1000;
  return null;
}

export function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selected, setSelected] = useState<Company | null>(null);
  const [walletBalance, setWalletBalance] = useState(0);
  const [holdingQty, setHoldingQty] = useState(0);
  const [book, setBook] = useState<{ buyOrders: MarketOrder[]; sellOrders: MarketOrder[] }>({ buyOrders: [], sellOrders: [] });
  const [myOrders, setMyOrders] = useState<MarketOrder[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);

  const [activeTab, setActiveTab] = useState<DetailTab>('preco');
  const [marketListTab, setMarketListTab] = useState<MarketListTab>('mercado');
  const [search, setSearch] = useState('');
  const [tradeFlow, setTradeFlow] = useState<TradeFlow>(null);
  const [buyMode, setBuyMode] = useState<BuyMode>('initial');
  const [sellMode, setSellMode] = useState<SellMode>('limit');

  const [initialQty, setInitialQty] = useState('');
  const [limitQty, setLimitQty] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [marketBuyQty, setMarketBuyQty] = useState('');
  const [marketSellQty, setMarketSellQty] = useState('');
  const [marketBuySlip, setMarketBuySlip] = useState('5');
  const [marketSellSlip, setMarketSellSlip] = useState('5');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [activeTimeframe, setActiveTimeframe] = useState<Timeframe>('Time');
  const [favoriteMarketIds, setFavoriteMarketIds] = useState<string[]>(() => readFavoriteMarketIds());
  const [isBuyingInitial, setIsBuyingInitial] = useState(false);
  const [isSubmittingLimitOrder, setIsSubmittingLimitOrder] = useState(false);
  const [isSubmittingMarketOrder, setIsSubmittingMarketOrder] = useState(false);
  const [cancelingOrderId, setCancelingOrderId] = useState<string | null>(null);
  
  async function loadCompanies() {
    const response = await api<{ companies: Omit<Company, 'description'>[] }>('/companies');
    setCompanies(response.companies.filter((company) => company.status === 'ACTIVE').map((item) => ({ ...item, description: '' })));
  }

  async function loadWalletAndHolding(companyId?: string) {
    const response = await api<{ wallet: { rpcAvailableBalance: string; rpcLockedBalance: string }; holdings: Holding[] }>('/me/holdings');
    setWalletBalance(Number(response.wallet.rpcAvailableBalance));
    setHoldingQty(response.holdings.find((h) => h.companyId === companyId)?.quantity ?? 0);
  }

  async function loadCompanyDetails(companyId: string) {
    const response = await api<{ company: Company }>(`/companies/${companyId}`);
    setSelected(response.company);
  }

  async function loadMarket(companyId: string) {
    try {
      const [orderBook, my, lastTrades] = await Promise.all([
        api<{ buyOrders: MarketOrder[]; sellOrders: MarketOrder[] }>(`/market/companies/${companyId}/order-book`),
        api<{ orders: MarketOrder[] }>('/market/orders/me'),
        api<{ trades: Trade[] }>(`/market/companies/${companyId}/trades`),
      ]);
      setBook(orderBook);
      setMyOrders(my.orders.filter((order) => order.companyId === companyId));
      setTrades(lastTrades.trades);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('Mercado não disponível')) {
        setSelected(null);
        setBook({ buyOrders: [], sellOrders: [] });
        setTrades([]);
        setMyOrders([]);
        setTradeFlow(null);
        setError('Este mercado não está mais disponível.');
        return;
      }
      throw err;
    }
  }



  async function refreshMarketScreen(companyId?: string) {
    if (!companyId) return;
    await Promise.all([
      loadCompanyDetails(companyId),
      loadWalletAndHolding(companyId),
      loadCompanies(),
      loadMarket(companyId),
    ]);
  }

  useEffect(() => {
    (async () => {
      try {
        await loadCompanies();
        await loadWalletAndHolding();
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, []);

  useEffect(() => {
    const pendingCompanyId = localStorage.getItem(PENDING_COMPANY_MARKET_KEY);
    if (!pendingCompanyId || companies.length === 0) return;
    localStorage.removeItem(PENDING_COMPANY_MARKET_KEY);
    const companyExists = companies.some((company) => company.id === pendingCompanyId);
    if (!companyExists) {
      setError('Este ativo não possui mercado disponível no momento.');
      return;
    }
    void selectCompany(pendingCompanyId);
  }, [companies]);


  useEffect(() => {
    if (!selected) return;
    loadMarket(selected.id).catch((err) => setError((err as Error).message));
  }, [selected?.id]);

  async function selectCompany(id: string) {
    try {
      setError('');
      setMessage('');
      setTradeFlow(null);
      setActiveTab('preco');
      await refreshMarketScreen(id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function buyInitialOffer(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    try {
      setIsBuyingInitial(true);
      if (selected.status !== 'ACTIVE') throw new Error('Mercado pausado. Não é possível comprar no lançamento inicial.');
      const response = await api<InitialOfferBuyResponse>(`/companies/${selected.id}/buy-initial-offer`, {
        method: 'POST',
        body: JSON.stringify({ quantity: Number(initialQty) }),
      });
      setInitialQty('');

      const priceBefore = Number(response.priceBefore);
      const priceAfter = Number(response.priceAfter);
      const priceIncrease = Number(response.priceIncrease);

      if (Number.isFinite(priceBefore) && Number.isFinite(priceAfter)) {
        let successMessage = `Compra concluída. Preço: ${formatPrice(priceBefore)} RPC → ${formatPrice(priceAfter)} RPC.`;
        if (Number.isFinite(priceIncrease) && priceIncrease > 0) {
          successMessage += ` Variação: +${formatPrice(priceIncrease)} RPC.`;
        }
        setMessage(successMessage);
      } else {
        setMessage('Compra concluída. O preço atual foi atualizado.');
      }

      setError('');
      await refreshMarketScreen(selected.id);
    } catch (err) {
      setError(`Não foi possível comprar tokens: ${(err as Error).message}`);
    } finally {
      setIsBuyingInitial(false);
    }
  }

  async function createLimitOrder(type: 'BUY' | 'SELL', event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    try {
      setIsSubmittingLimitOrder(true);
      if (selected.status !== 'ACTIVE') throw new Error('Mercado pausado. Não é possível criar ordens.');
      await api('/market/orders', {
        method: 'POST',
        body: JSON.stringify({ companyId: selected.id, type, mode: 'LIMIT', quantity: Number(limitQty), limitPrice: Number(limitPrice) }),
      });
      setLimitQty('');
      setLimitPrice('');
      setMessage('Ordem criada no livro. O preço só muda quando houver execução.');
      setError('');
      await refreshMarketScreen(selected.id);
    } catch (err) {
      setError(`Não foi possível criar ordem: ${(err as Error).message}`);
    } finally {
      setIsSubmittingLimitOrder(false);
    }
  }

  async function sendMarket(type: 'BUY' | 'SELL') {
    if (!selected) return;
    const quantity = Number(type === 'BUY' ? marketBuyQty : marketSellQty);
    const slippagePercent = Number(type === 'BUY' ? marketBuySlip : marketSellSlip);
    try {
      setIsSubmittingMarketOrder(true);
      if (selected.status !== 'ACTIVE') throw new Error('Mercado pausado. Não é possível negociar agora.');
      await api(`/market/companies/${selected.id}/${type === 'BUY' ? 'buy-market' : 'sell-market'}`, {
        method: 'POST',
        body: JSON.stringify({ quantity, slippagePercent }),
      });
      if (type === 'BUY') setMarketBuyQty('');
      if (type === 'SELL') setMarketSellQty('');
      setMessage(type === 'BUY' ? 'Compra realizada com sucesso.' : 'Venda realizada com sucesso.');
      setError('');
      await refreshMarketScreen(selected.id);
    } catch (err) {
      const baseError = (err as Error).message;
      if (baseError.includes('Não há liquidez suficiente no livro para executar esta ordem.')) {
        setError('Não há liquidez suficiente no livro para executar esta ordem.');
      } else {
        setError(`Não foi possível enviar ordem agora: ${baseError}`);
      }
    } finally {
      setIsSubmittingMarketOrder(false);
    }
  }

  async function cancelOrder(orderId: string) {
    if (!selected) return;
    try {
      setCancelingOrderId(orderId);
      await api(`/market/orders/${orderId}/cancel`, { method: 'POST' });
      setMessage('Ordem cancelada. O preço não foi alterado.');
      await refreshMarketScreen(selected.id);
    } catch (err) {
      setError(`Falha ao cancelar ordem: ${(err as Error).message}`);
    } finally {
      setCancelingOrderId(null);
    }
  }

  const buyFee = Number(selected?.buyFeePercent ?? '0');
  const sellFee = Number(selected?.sellFeePercent ?? '0');
  const limitSubtotal = (Number(limitQty) || 0) * (Number(limitPrice) || 0);
  const limitTotalBuy = limitSubtotal * (1 + buyFee / 100);
  const limitNetSell = limitSubtotal * (1 - sellFee / 100);

  const bestAsk = useMemo(() => (book.sellOrders.length > 0 ? Number(book.sellOrders[0].limitPrice ?? 0) : Number(selected?.currentPrice ?? 0)), [book.sellOrders, selected?.currentPrice]);
  const bestBid = useMemo(() => (book.buyOrders.length > 0 ? Number(book.buyOrders[0].limitPrice ?? 0) : Number(selected?.currentPrice ?? 0)), [book.buyOrders, selected?.currentPrice]);
  const filteredTrades = useMemo(() => {
    const start = buildTimeframeStart(activeTimeframe);
    if (!start) return trades;
    return trades.filter((trade) => new Date(trade.createdAt).getTime() >= start);
  }, [activeTimeframe, trades]);
  const chartData = useMemo(
    () => normalizeChartData(filteredTrades, Number(selected?.initialPrice ?? 1), Number(selected?.currentPrice ?? selected?.initialPrice ?? 1)),
    [filteredTrades, selected?.currentPrice, selected?.initialPrice]
  );
  const totalBuyStrength = useMemo(() => book.buyOrders.reduce((sum, order) => sum + order.remainingQuantity, 0), [book.buyOrders]);
  const totalSellStrength = useMemo(() => book.sellOrders.reduce((sum, order) => sum + order.remainingQuantity, 0), [book.sellOrders]);
  const totalStrength = totalBuyStrength + totalSellStrength;
  const buyStrengthPercent = totalStrength > 0 ? (totalBuyStrength / totalStrength) * 100 : 0;
  const sellStrengthPercent = totalStrength > 0 ? (totalSellStrength / totalStrength) * 100 : 0;
  const totalTradeVolume = useMemo(() => filteredTrades.reduce((sum, trade) => sum + trade.quantity, 0), [filteredTrades]);

  const visibleCompanies = useMemo(() => companies.filter((company) => `${company.name} ${company.ticker}`.toLowerCase().includes(search.toLowerCase())), [companies, search]);
  const featuredCompanies = useMemo(() => companies.slice(0, 3), [companies]);

  return (
    <section className="card market-page market-shell">
      <InfoCallout title="Mercado RP" tone="info"><p>Ativos e preços são da simulação RP. Não há dinheiro real, Pix, cartão ou blockchain.</p></InfoCallout>
      {!selected && (
        <>
          <h2>🪙 Mercados de moedas</h2>
          <input className="market-search-input" placeholder="Buscar moeda ou ticker" value={search} onChange={(e) => setSearch(e.target.value)} />
          <nav className="quick-actions nested-card">
            <button className={marketListTab === 'mercado' ? 'quick-pill active' : 'quick-pill'} onClick={() => setMarketListTab('mercado')}>Mercado</button>
            <button className={marketListTab === 'destaques' ? 'quick-pill active' : 'quick-pill'} onClick={() => setMarketListTab('destaques')}>Destaques</button>
          </nav>
          <p className="info-text">Negocie moedas criadas por usuários usando RPC.</p>
          {error && <p className="status-message error">{error}</p>}
          {companies.length === 0 && <EmptyState title="Sem moedas listadas" description="Nenhuma moeda listada ainda." />}
          <ul className="company-list">
            {(marketListTab === 'destaques' ? featuredCompanies.filter((company) => `${company.name} ${company.ticker}`.toLowerCase().includes(search.toLowerCase())) : visibleCompanies).map((company) => (
              <li key={company.id} className="card company-visual-card finance-card market-list-card">
                <div className="market-list-card-top">
                  <p className="company-emoji">🪙 {company.ticker}/RPC</p>
                  <span className="compact-status">{translateCompanyStatus(company.status)}</span>
                </div>
                <div className="market-list-card-middle">
                  <strong>{company.name}</strong>
                  <p className="info-text market-sector-text">Setor: {company.sector}</p>
                  <p className="price-highlight">{formatPrice(Number(company.currentPrice || company.initialPrice))} RPC</p>
                  {(() => { const changePercent = getPriceChangePercent(company); return <p className={changePercent >= 0 ? 'positive-change' : 'negative-change'}>{changePercent >= 0 ? '▲' : '▼'} {formatPercent(Math.abs(changePercent))}%</p>; })()}
                </div>
                <div className="market-list-card-footer">
                  <p className="info-text">Moedas disponíveis: {company.availableOfferShares.toLocaleString('pt-BR')}</p>
                  <button className="button-primary market-open-cta" onClick={() => selectCompany(company.id)}>Abrir mercado</button>
                </div>
              </li>
            ))}
          </ul>
          {(marketListTab === 'mercado' ? visibleCompanies : featuredCompanies.filter((company) => `${company.name} ${company.ticker}`.toLowerCase().includes(search.toLowerCase()))).length === 0 && (
            <EmptyState title="Busca sem resultados" description="Nenhuma moeda encontrada para essa busca." />
          )}
        </>
      )}

      {selected && (
        <div className="trade-screen market-mobile-shell">
          <header className="card trade-header market-pair-header market-compact-header market-asset-header">
            <div className="market-pair-title">
              <button className="back-button" onClick={() => setSelected(null)}>←</button>
              <strong>{selected.ticker}/RPC</strong>
              <span className="compact-status">{translateCompanyStatus(selected.status)}</span>
              <button
                type="button"
                className={favoriteMarketIds.includes(selected.id) ? 'favorite-market-button active' : 'favorite-market-button'}
                title={favoriteMarketIds.includes(selected.id) ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
                aria-label={favoriteMarketIds.includes(selected.id) ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
                onClick={() => {
                  const isFavorite = favoriteMarketIds.includes(selected.id);
                  const next = isFavorite ? favoriteMarketIds.filter((id) => id !== selected.id) : [...favoriteMarketIds, selected.id];
                  setFavoriteMarketIds(next);
                  localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(next));
                }}
              >
                {favoriteMarketIds.includes(selected.id) ? '★' : '☆'}
              </button>
            </div>
            <div className="market-price-overview market-compact-price">
              <p className="trade-price-big">{formatPrice(Number(selected.currentPrice))} RPC</p>
              <p className={chartData.variationPercent >= 0 ? 'positive-change' : 'negative-change'}>
                {chartData.variationPercent >= 0 ? '▲' : '▼'} {formatPercent(Math.abs(chartData.variationPercent))}%
              </p>
            </div>
            <div className="market-stats-row market-mini-stats">
              <div className="market-mini-stat-card"><span className="market-mini-stat-label">Máx</span><strong>{formatPrice(chartData.maxPrice)}</strong></div>
              <div className="market-mini-stat-card"><span className="market-mini-stat-label">Mín</span><strong>{formatPrice(chartData.minPrice)}</strong></div>
              <div className="market-mini-stat-card"><span className="market-mini-stat-label">Volume</span><strong>{totalTradeVolume > 0 ? totalTradeVolume.toLocaleString('pt-BR') : 'Sem volume'}</strong></div>
              <div className="market-mini-stat-card"><span className="market-mini-stat-label">Tokens</span><strong>{holdingQty}</strong></div>
            </div>
          </header>

          {error && <p className="status-message error">{error}</p>}
          {message && <p className="status-message success">{message}</p>}


          <nav className="market-top-tabs market-mobile-tabs nested-card" aria-label="Abas do mercado">
            <button className={activeTab === 'preco' ? 'quick-pill active' : 'quick-pill'} onClick={() => setActiveTab('preco')}>Preço</button>
            <button className={activeTab === 'livro' ? 'quick-pill active' : 'quick-pill'} onClick={() => setActiveTab('livro')}>Livro</button>
            <button className={activeTab === 'ordens' ? 'quick-pill active' : 'quick-pill'} onClick={() => setActiveTab('ordens')}>Ordens</button>
            <button className={activeTab === 'trades' ? 'quick-pill active' : 'quick-pill'} onClick={() => setActiveTab('trades')}>Trades</button>
            <button className={activeTab === 'dados' ? 'quick-pill active' : 'quick-pill'} onClick={() => setActiveTab('dados')}>Dados</button>
          </nav>

          {activeTab === 'dados' && <section className="card nested-card market-data-grid market-tab-panel"><h4>Dados</h4><article className="market-data-section"><h5>Moeda</h5><div className="market-data-item"><span className="market-data-label">Categoria</span><strong className="market-data-value">{selected.sector}</strong></div><div className="market-data-item"><span className="market-data-label">Status</span><strong className="market-data-value">{translateCompanyStatus(selected.status)}</strong></div><div className="market-data-item"><span className="market-data-label">Descrição</span><p className="market-data-value">{selected.description || 'Moeda listada para negociação em ambiente RP.'}</p></div></article><article className="market-data-section"><h5>Preço</h5><div className="market-data-item"><span className="market-data-label">Preço inicial</span><strong className="market-data-value">{formatPrice(Number(selected.initialPrice))}</strong></div><div className="market-data-item"><span className="market-data-label">Market cap fictício</span><strong className="market-data-value">{formatCurrency(Number(selected.currentPrice) * selected.totalShares)} RPC</strong></div></article><article className="market-data-section"><h5>Taxas</h5><div className="market-data-item"><span className="market-data-label">Taxa compra</span><strong className="market-data-value">{buyFee}%</strong></div><div className="market-data-item"><span className="market-data-label">Taxa venda</span><strong className="market-data-value">{sellFee}%</strong></div></article><article className="market-data-section"><h5>Oferta</h5><div className="market-data-item"><span className="market-data-label">Supply total</span><strong className="market-data-value">{selected.totalShares.toLocaleString('pt-BR')}</strong></div><div className="market-data-item"><span className="market-data-label">Oferta disponível</span><strong className="market-data-value">{selected.availableOfferShares.toLocaleString('pt-BR')}</strong></div></article><article className="market-data-section"><h5>Minha posição</h5><div className="market-data-item"><span className="market-data-label">Saldo RPC</span><strong className="market-data-value">{formatCurrency(walletBalance)} RPC</strong></div><div className="market-data-item"><span className="market-data-label">Moedas em carteira</span><strong className="market-data-value">{holdingQty}</strong></div></article></section>}

          {activeTab === 'preco' && (
            <section className="card nested-card market-price-tab market-tab-panel">
              <h4>📈 Gráfico</h4>
              <div className="chart-timeframes">
                {(['Time', '15m', '1h', '4h', '1D'] as Timeframe[]).map((tf) => (
                  <button
                    key={tf}
                    className={activeTimeframe === tf ? 'quick-pill active' : 'quick-pill'}
                    onClick={() => setActiveTimeframe(tf)}
                    type="button"
                  >
                    {tf}
                  </button>
                ))}
              </div>
              <div className="chart-wrap chart-wrap-highlight modern-chart-shell market-chart-card">
                <MarketLineChart points={chartData.points} currentPrice={chartData.currentPrice} timeframe={activeTimeframe === '1D' ? '24H' : activeTimeframe === '4h' ? '7D' : '24H'} emptyMessage="Sem dados suficientes para o gráfico." />
              </div>
              <div className="chart-meta market-price-card"><div><span>Atual</span><strong>{formatPrice(chartData.lastPrice)}</strong></div><div><span>Máximo</span><strong>{formatPrice(chartData.maxPrice)}</strong></div><div><span>Mínimo</span><strong>{formatPrice(chartData.minPrice)}</strong></div></div>
              <div className="volume-mini-chart">
                {filteredTrades.length === 0 && <EmptyState title="Sem volume" description="Sem volume ainda neste intervalo." />}
                {filteredTrades.length > 0 && <div className="volume-bars">{filteredTrades.map((trade) => {
                  const max = Math.max(...filteredTrades.map((item) => item.quantity));
                  const height = max > 0 ? Math.max(6, (trade.quantity / max) * 60) : 6;
                  return <div key={trade.id} style={{ height: `${height}px` }} title={`Qtd ${trade.quantity}`} />;
                })}</div>}
              </div>
              {chartData.note && <p className="info-text chart-empty-note">{chartData.note}</p>}
              {filteredTrades.length === 0 && <div className="chart-empty-elegant"><strong>Aguardando negociações no período</strong><span>Altere o intervalo para visualizar trades mais antigos.</span></div>}
            </section>
          )}
          {activeTab === 'livro' && (
            <section className="card nested-card market-book-tab market-tab-panel">
              <h4>📊 Livro de ofertas</h4>
              <div className="book-strength-bar">
                <div className="book-strength-buy" style={{ width: `${buyStrengthPercent}%` }}>Compradores {Math.round(buyStrengthPercent)}%</div>
                <div className="book-strength-sell" style={{ width: `${sellStrengthPercent}%` }}>Vendedores {Math.round(sellStrengthPercent)}%</div>
              </div>
              <OrderBook
                buyOrders={book.buyOrders.map((order) => {
                  const price = Number(order.limitPrice ?? 0);
                  return { id: order.id, price, quantity: order.remainingQuantity, total: price * order.remainingQuantity };
                })}
                sellOrders={book.sellOrders.map((order) => {
                  const price = Number(order.limitPrice ?? 0);
                  return { id: order.id, price, quantity: order.remainingQuantity, total: price * order.remainingQuantity };
                })}
                currentPrice={Number(selected.currentPrice)}
                quoteSymbol=""
                baseSymbol={selected.ticker}
                emptyMessage="Sem ofertas no livro deste ativo."
              />
            </section>
          )}

          {activeTab === 'ordens' && (
            <section className="card nested-card market-tab-panel">
              <h4>🧾 Minhas ordens</h4>
              {myOrders.length === 0 && <EmptyState title="Sem ordens" description="Você ainda não possui ordens neste mercado." />}
              <div className="mobile-card-list">{myOrders.map((order) => (<article key={order.id} className="summary-item compact-card market-order-card"><p><strong>{translateOrderType(order.type)}</strong> · {translateOrderMode(order.mode)}</p><p>Quantidade: {order.quantity} · Restante: {order.remainingQuantity}</p><p>Status: {translateOrderStatus(order.status)}</p><p>Preço: {order.limitPrice ? formatPrice(Number(order.limitPrice)) : 'Agora'}</p>{(order.status === 'OPEN' || order.status === 'PARTIALLY_FILLED') && order.mode === 'LIMIT' && <Button variant="danger" onClick={() => cancelOrder(order.id)} disabled={cancelingOrderId === order.id}>{cancelingOrderId === order.id ? 'Cancelando...' : 'Cancelar ordem'}</Button>}</article>))}</div>
            </section>
          )}

          {activeTab === 'trades' && (
            <section className="card nested-card market-tab-panel">
              <h4>🕒 Negociações recentes</h4>
              {filteredTrades.length === 0 && <EmptyState title="Sem histórico" description="Sem histórico de negociações para este intervalo." />}
              <div className="mobile-card-list">{filteredTrades.map((trade) => (<article key={trade.id} className="summary-item compact-card market-order-card"><p><strong>Preço:</strong> {formatPrice(Number(trade.unitPrice))}</p><p><strong>Quantidade:</strong> {trade.quantity}</p><p><strong>Data/hora:</strong> {new Date(trade.createdAt).toLocaleString('pt-BR')}</p></article>))}</div>
            </section>
          )}

          {tradeFlow && (
            <div className="trade-panel-backdrop" onClick={() => setTradeFlow(null)}>
              <section className="trade-bottom-sheet market-trade-sheet" onClick={(event) => event.stopPropagation()}>
                <div className="market-sheet-handle" aria-hidden="true" />
                <div className="trade-panel-header">
                  <h4>{tradeFlow === 'buy' ? '🟢 Comprar moedas' : '🔴 Vender moedas'}</h4>
                  <button className="back-button" onClick={() => setTradeFlow(null)}>Fechar</button>
                </div>

                <div className="market-sheet-balance-row">
                  <div className="market-sheet-mini-card"><span>Saldo RPC</span><strong>{formatCurrency(walletBalance)} RPC</strong></div>
                  <div className="market-sheet-mini-card"><span>Moedas em carteira</span><strong>{holdingQty}</strong></div>
                </div>

                {tradeFlow === 'buy' && (
                  <div className="market-sheet-section">
                    <nav className="quick-actions">
                      <button className={buyMode === 'initial' ? 'quick-pill active' : 'quick-pill'} onClick={() => setBuyMode('initial')}>Comprar moedas</button>
                      <button className={buyMode === 'limit' ? 'quick-pill active' : 'quick-pill'} onClick={() => setBuyMode('limit')}>Definir preço</button>
                      <button className={buyMode === 'market' ? 'quick-pill active' : 'quick-pill'} onClick={() => setBuyMode('market')}>Comprar agora</button>
                    </nav>
                    {buyMode === 'initial' && (
                      <form onSubmit={buyInitialOffer}>
                        <p className="info-text">Esta compra é feita direto da oferta inicial do projeto.</p>
                        <p className="info-text">A compra executada pode alterar o preço conforme a curva de lançamento.</p>
                        <p className="info-text">Oferta parada não altera preço. Depois da oferta inicial, preço só muda por trade real no mercado secundário.</p>
                        <p className="info-text">Oferta disponível: {selected.availableOfferShares.toLocaleString('pt-BR')} • Preço atual: {formatPrice(Number(selected.currentPrice))} RPC</p>
                        <input type="number" min="1" value={initialQty} onChange={(e) => setInitialQty(e.target.value)} placeholder="Quantidade de moedas" required />
                        <Button variant="success" type="submit" disabled={isBuyingInitial}>{isBuyingInitial ? 'Comprando...' : 'Comprar moedas'}</Button>
                      </form>
                    )}
                    {buyMode === 'limit' && <form onSubmit={(event) => createLimitOrder('BUY', event)}><input type="number" min="1" value={limitQty} onChange={(e) => setLimitQty(e.target.value)} placeholder="Quantidade de moedas" required /><input type="number" min="0.01" step="0.01" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} placeholder="Preço por moeda" required /><div className="summary-item"><p>Subtotal: {formatCurrency(limitSubtotal)}</p><p>Taxa: {buyFee}%</p><p>Total estimado: {formatCurrency(limitTotalBuy)}</p></div><Button variant="success" type="submit" disabled={isSubmittingLimitOrder}>{isSubmittingLimitOrder ? 'Enviando...' : 'Definir preço de compra'}</Button></form>}
                    {buyMode === 'market' && <div><input type="number" min="1" value={marketBuyQty} onChange={(e) => setMarketBuyQty(e.target.value)} placeholder="Quantidade de moedas" /><input type="number" min="0" max="100" value={marketBuySlip} onChange={(e) => setMarketBuySlip(e.target.value)} placeholder="Variação máxima (%)" /><Button variant="success" onClick={() => sendMarket('BUY')} disabled={isSubmittingMarketOrder}>{isSubmittingMarketOrder ? 'Comprando...' : 'Comprar agora'}</Button><p className="info-text">Preço agora: {formatPrice(bestAsk)}</p></div>}
                  </div>
                )}

                {tradeFlow === 'sell' && (
                  <div className="market-sheet-section">
                    <nav className="quick-actions">
                      <button className={sellMode === 'limit' ? 'quick-pill active' : 'quick-pill'} onClick={() => setSellMode('limit')}>Definir preço</button>
                      <button className={sellMode === 'market' ? 'quick-pill active' : 'quick-pill'} onClick={() => setSellMode('market')}>Vender agora</button>
                    </nav>
                    {sellMode === 'limit' && <form onSubmit={(event) => createLimitOrder('SELL', event)}><input type="number" min="1" value={limitQty} onChange={(e) => setLimitQty(e.target.value)} placeholder="Quantidade de moedas" required /><input type="number" min="0.01" step="0.01" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} placeholder="Preço por moeda" required /><div className="summary-item"><p>Subtotal: {formatCurrency(limitSubtotal)}</p><p>Taxa: {sellFee}%</p><p>Total estimado: {formatCurrency(limitNetSell)}</p></div><Button variant="danger" type="submit" disabled={isSubmittingLimitOrder}>{isSubmittingLimitOrder ? 'Enviando...' : 'Definir preço de venda'}</Button></form>}
                    {sellMode === 'market' && <div><input type="number" min="1" value={marketSellQty} onChange={(e) => setMarketSellQty(e.target.value)} placeholder="Quantidade de moedas" /><input type="number" min="0" max="100" value={marketSellSlip} onChange={(e) => setMarketSellSlip(e.target.value)} placeholder="Variação máxima (%)" /><Button variant="danger" onClick={() => sendMarket('SELL')} disabled={isSubmittingMarketOrder}>{isSubmittingMarketOrder ? 'Vendendo...' : 'Vender agora'}</Button><p className="info-text">Preço agora: {formatPrice(bestBid)}</p></div>}
                  </div>
                )}
              </section>
            </div>
          )}
          <div className="mobile-trade-actions market-bottom-actions">
            <button className="button-success" disabled={selected.status !== 'ACTIVE'} onClick={() => { setTradeFlow('buy'); setBuyMode('initial'); }}>Comprar</button>
            <button className="button-danger" disabled={selected.status !== 'ACTIVE'} onClick={() => { setTradeFlow('sell'); setSellMode('limit'); }}>Vender</button>
          </div>
        </div>
      )}
    </section>
  );
}
