type MetricCardProps = {
  label?: string;
  title?: string;
  value: string;
  helper?: string;
  subtitle?: string;
  trend?: string;
  status?: 'positive' | 'negative' | 'neutral';
  variant?: 'default' | 'premium' | 'warning';
};

export function MetricCard({ label, title, value, helper, subtitle, trend, status = 'neutral', variant = 'default' }: MetricCardProps) {
  const resolvedLabel = label ?? title ?? '';
  const resolvedHelper = helper ?? subtitle;
  return (
    <article className={`metric-card metric-card-${status} metric-card-variant-${variant}`}>
      <span className="metric-card-label">{resolvedLabel}</span>
      <strong className="metric-card-value">{value}</strong>
      {resolvedHelper ? <p className="metric-card-helper">{resolvedHelper}</p> : null}
      {trend ? <p className="metric-card-trend">{trend}</p> : null}
    </article>
  );
}
