import { useEffect, useState } from 'react';
import { api } from '../services/api';

type Issue = { severity: 'CRITICAL' | 'WARNING'; code: string; title: string; description: string; entity?: string; entityId?: string; userId?: string; expected?: string; actual?: string };
type Section = { status: 'OK' | 'WARNING' | 'CRITICAL'; issues: Issue[]; metrics: Record<string, unknown> };
type Report = { status: 'OK' | 'WARNING' | 'CRITICAL'; summary: { totalIssues: number; criticalIssues: number; warningIssues: number }; generatedAt: string; sections: { rpcMarket: Section; companyMarket: Section } };

export function AdminMarketHealthPanel() {
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    try {
      const result = await api<Report>('/admin/market-health');
      setData(result); setError('');
    } catch (err) { setError((err as Error).message); }
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  const badge = (s: string) => s === 'CRITICAL' ? '🔴 CRÍTICO' : s === 'WARNING' ? '🟡 ALERTA' : '🟢 OK';
  const sections = data ? [
    { key: 'rpcMarket', title: 'RPC/R$', payload: data.sections.rpcMarket },
    { key: 'companyMarket', title: 'Empresas/Tokens', payload: data.sections.companyMarket },
  ] : [];

  return <section className="card market-tab-panel"><div className="quick-actions"><h3>Saúde dos Mercados</h3><button className="button-primary" onClick={() => load()} disabled={loading}>{loading ? 'Atualizando...' : 'Atualizar análise'}</button></div>
    {error && <p className="error-text">{error}</p>}
    {data && <><div className="order-book-grid"><article className="summary-item"><span>Status geral</span><strong>{badge(data.status)}</strong></article><article className="summary-item"><span>Total de problemas</span><strong>{data.summary.totalIssues}</strong></article><article className="summary-item"><span>Críticos</span><strong>{data.summary.criticalIssues}</strong></article><article className="summary-item"><span>Alertas</span><strong>{data.summary.warningIssues}</strong></article></div>
      <p className="info-text">Gerado em: {new Date(data.generatedAt).toLocaleString('pt-BR')}</p>
      {sections.map((s) => <section className="nested-card" key={s.key}><h4>{s.title} · {badge(s.payload.status)}</h4><pre className="info-text" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(s.payload.metrics, null, 2)}</pre>{s.payload.issues.length === 0 && <p className="empty-state">Sem inconsistências detectadas.</p>}<div className="mobile-card-list">{s.payload.issues.map((issue, idx) => <article className="summary-item" key={`${s.key}-${issue.code}-${idx}`}><p><strong>{issue.severity} · {issue.code}</strong></p><p>{issue.title}</p><p className="info-text">{issue.description}</p><p className="info-text">{issue.entity} {issue.entityId ? `#${issue.entityId}` : ''} {issue.userId ? `· user ${issue.userId}` : ''}</p>{issue.expected || issue.actual ? <p className="info-text">Esperado: {issue.expected ?? '-'} | Atual: {issue.actual ?? '-'}</p> : null}</article>)}</div></section>)}
    </>}
  </section>;
}
