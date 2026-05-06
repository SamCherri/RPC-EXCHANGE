import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { PremiumCard } from '../components/ui/PremiumCard';
import { SectionHeader } from '../components/ui/SectionHeader';
import { StatusBadge } from '../components/ui/StatusBadge';
import { EmptyState } from '../components/ui/EmptyState';
import { LoadingState } from '../components/ui/LoadingState';

type AlertSeverity = 'CRITICAL' | 'WARNING';

type EconomicAlert = {
  code: string;
  severity: AlertSeverity;
  title: string;
  description: string;
  entity: string;
  entityId: string;
  userId?: string;
  details: Record<string, unknown>;
};

type EconomicAlertsResponse = {
  summary: { total: number; critical: number; warning: number };
  alerts: EconomicAlert[];
};

export function AdminEconomicAlertsPanel() {
  const [data, setData] = useState<EconomicAlertsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function loadAlerts() {
    setLoading(true);
    setError('');
    try { setData(await api<EconomicAlertsResponse>('/admin/economic-alerts')); }
    catch (err) { setError((err as Error).message || 'Falha ao carregar alertas econômicos.'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void loadAlerts(); }, []);

  return (
    <section className="stack-md">
      <SectionHeader
        title="Alertas econômicos"
        description="Painel somente leitura de inconsistências econômicas da RPC Exchange."
        action={<button className="button-secondary" onClick={loadAlerts} disabled={loading}>{loading ? 'Atualizando...' : 'Atualizar alertas'}</button>}
      />

      {loading && <LoadingState text="Carregando alertas econômicos..." />}
      {error && <p className="error-text">{error}</p>}

      <div className="summary-grid">
        <PremiumCard className="summary-item compact-card"><strong>Total</strong><p>{data?.summary.total ?? 0}</p></PremiumCard>
        <PremiumCard className="summary-item compact-card"><strong>Críticos</strong><p>{data?.summary.critical ?? 0}</p></PremiumCard>
        <PremiumCard className="summary-item compact-card"><strong>Avisos</strong><p>{data?.summary.warning ?? 0}</p></PremiumCard>
      </div>

      {data && data.alerts.length === 0 && !loading && (
        <EmptyState title="Sem alertas" description="Nenhuma inconsistência econômica encontrada. Este painel é somente leitura e não executa correções automáticas." />
      )}

      <div className="stack-sm">
        {data?.alerts.map((alert) => (
          <PremiumCard key={`${alert.code}-${alert.entityId}-${alert.userId ?? 'na'}`} className="summary-item">
            <strong><StatusBadge type={alert.severity === 'CRITICAL' ? 'danger' : 'warning'}>{alert.severity}</StatusBadge> • {alert.title}</strong>
            <p>{alert.description}</p>
            <p><strong>Entidade:</strong> {alert.entity} ({alert.entityId})</p>
            {alert.userId && <p><strong>Usuário:</strong> {alert.userId}</p>}
            <p><strong>Código:</strong> {alert.code}</p>
            <details><summary>Detalhes técnicos</summary><pre>{JSON.stringify(alert.details, null, 2)}</pre></details>
          </PremiumCard>
        ))}
      </div>
    </section>
  );
}
