import { useEffect, useState } from 'react';
import { BrandLogo } from '../components/BrandLogo';
import { api } from '../services/api';

type Status = { status: 'PENDING'|'NEEDS_CORRECTION'|'APPROVED'|'REJECTED'; note?: string | null; hasScreenshot: boolean; screenshotUpdatedAt?: string | null; financialPermissions: string[] };

export function RegistrationStatusPage({ onLogout, onReload, onOpenSupport }: { onLogout: () => void; onReload: () => void; onOpenSupport: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  async function load() {
    const data = await api<Status>('/registration/status');
    setStatus(data);
  }

  useEffect(() => { void load(); }, []);

  async function resend(file: File) {
    setIsLoading(true);
    setMessage('');
    try {
      const reader = new FileReader();
      const data = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Não foi possível ler a imagem.'));
        reader.readAsDataURL(file);
      });
      await api('/registration/screenshot', { method: 'PUT', body: JSON.stringify({ screenshot: { mimeType: file.type, fileName: file.name, data } }) });
      setMessage('Screenshot reenviado. Seu cadastro voltou para análise.');
      await load();
      onReload();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setIsLoading(false);
    }
  }

  const statusLabel = status?.status === 'PENDING' ? 'Em análise' : status?.status === 'NEEDS_CORRECTION' ? 'Precisa de correção' : status?.status === 'REJECTED' ? 'Rejeitado' : 'Aprovado';
  const badgeClass = status?.status === 'APPROVED' ? 'success' : status?.status === 'REJECTED' ? 'danger' : status?.status === 'NEEDS_CORRECTION' ? 'warning' : 'info';

  return <main className="container auth-shell"><section className="card auth-panel status-card">
    <header className="auth-header">
      <BrandLogo size="md" subtitle />
      <span className={`status-badge ${badgeClass}`}>{status ? statusLabel : 'Carregando'}</span>
      <h2>Status do cadastro</h2>
      <p className="auth-subtitle">A administração precisa aprovar sua conta antes de liberar as áreas econômicas.</p>
    </header>
    {!status && <p className="empty-state">Carregando status do cadastro...</p>}
    {status && <>
      <div className="summary-grid nested-card">
        <div className="summary-item"><span className="summary-label">Situação</span><strong className="summary-value">{statusLabel}</strong></div>
        <div className="summary-item"><span className="summary-label">Screenshot</span><strong className="summary-value">{status.hasScreenshot ? 'Recebido' : 'Pendente'}</strong>{status.screenshotUpdatedAt ? <p className="info-text">Atualizado em {new Date(status.screenshotUpdatedAt).toLocaleString('pt-BR')}</p> : null}</div>
      </div>
      {status.note && <p className="status-message warning"><strong>Observação da administração:</strong> {status.note}</p>}
      {status.status !== 'APPROVED' && <p className="info-text">Enquanto o cadastro não for aprovado, rotas econômicas ficam bloqueadas no backend.</p>}
      {(status.status === 'NEEDS_CORRECTION' || !status.hasScreenshot) && <label className="admin-modal-field nested-card"><span>Reenviar screenshot para análise</span><input type="file" accept="image/png,image/jpeg,image/webp" disabled={isLoading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void resend(file); }} /><small className="label-hint">PNG, JPG ou WEBP. O cadastro volta para análise após o envio.</small></label>}
      {status.status === 'APPROVED' && <button className="button-primary" onClick={onReload}>Entrar na plataforma</button>}
    </>}
    {message && <p className={`status-message ${message.includes('reenviado') ? 'success' : 'error'}`}>{message}</p>}
    <div className="status-actions">
      <button className="button-secondary" type="button" onClick={onOpenSupport}>💬 Falar com suporte</button>
      <button className="button-secondary" type="button" onClick={onLogout}>Sair</button>
    </div>
  </section></main>;
}
