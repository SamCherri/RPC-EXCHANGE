import { useEffect, useState } from 'react';
import { api } from '../services/api';

type Status = { status: 'PENDING'|'NEEDS_CORRECTION'|'APPROVED'|'REJECTED'; note?: string | null; hasScreenshot: boolean; screenshotUpdatedAt?: string | null; financialPermissions: string[] };

export function RegistrationStatusPage({ onLogout, onReload }: { onLogout: () => void; onReload: () => void }) {
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

  return <main className="app-shell"><section className="nested-card auth-panel">
    <h2>Status do cadastro</h2>
    {!status && <p className="info-text">Carregando status...</p>}
    {status && <>
      <p><strong>Situação:</strong> {status.status === 'PENDING' ? 'Em análise' : status.status === 'NEEDS_CORRECTION' ? 'Precisa de correção' : status.status === 'REJECTED' ? 'Rejeitado' : 'Aprovado'}</p>
      <p><strong>Screenshot:</strong> {status.hasScreenshot ? 'Recebido' : 'Pendente'}{status.screenshotUpdatedAt ? ` em ${new Date(status.screenshotUpdatedAt).toLocaleString('pt-BR')}` : ''}</p>
      {status.note && <p className="status-message warning"><strong>Observação da administração:</strong> {status.note}</p>}
      {status.status !== 'APPROVED' && <p className="info-text">Enquanto o cadastro não for aprovado, rotas econômicas ficam bloqueadas no backend.</p>}
      {(status.status === 'NEEDS_CORRECTION' || !status.hasScreenshot) && <label className="admin-modal-field"><span>Reenviar screenshot</span><input type="file" accept="image/png,image/jpeg,image/webp" disabled={isLoading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void resend(file); }} /></label>}
      {status.status === 'APPROVED' && <button className="button-primary" onClick={onReload}>Entrar na plataforma</button>}
    </>}
    {message && <p className={`status-message ${message.includes('reenviado') ? 'success' : 'error'}`}>{message}</p>}
    <button className="button-secondary" onClick={onLogout}>Sair</button>
  </section></main>;
}
