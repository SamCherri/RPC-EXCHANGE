export function StatusBadge({ type, children }: { type: 'success' | 'warning' | 'danger' | 'neutral' | 'info'; children: string }) {
  return <span className={`status-badge status-badge-${type}`}>{children}</span>;
}
