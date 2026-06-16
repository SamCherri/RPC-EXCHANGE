import { useEffect, useState } from 'react';
import { api } from '../services/api';

type PendingRegistration = {
  id: string;
  name: string;
  characterName: string | null;
  discord: string;
  gamePhone: string;
  approvalStatus: string;
  approvalReason?: string | null;
  registrationEvidences: Array<{ id: string; mimeType: string; sizeBytes: number; sha256: string }>;
};

export function AdminRegistrationsPanel() {
  const [users, setUsers] = useState<PendingRegistration[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [reasonById, setReasonById] = useState<Record<string, string>>({});
  const [evidenceLoadingId, setEvidenceLoadingId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const data = await api<{ users: PendingRegistration[] }>('/admin/registrations/pending');
      setUsers(data.users);
      setMessage('');
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function decide(id: string, action: 'approve' | 'reject' | 'request-correction' | 'suspend') {
    const reason = reasonById[id]?.trim() ?? '';
    if (action !== 'approve' && !reason) { setMessage('Informe o motivo.'); return; }
    setLoading(true);
    try {
      await api(`/admin/registrations/${id}/${action}`, { method: 'POST', body: action === 'approve' ? undefined : JSON.stringify({ reason }) });
      setMessage('Ação registrada com sucesso.');
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function openEvidence(evidenceId: string) {
    const previewWindow = window.open('about:blank', '_blank', 'noopener,noreferrer');
    setEvidenceLoadingId(evidenceId);
    try {
      const token = localStorage.getItem('token');
      const baseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:3333';
      const response = await fetch(`${baseUrl}/api/auth/registration-evidence/${evidenceId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message ?? 'Falha ao abrir comprovante.');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      if (previewWindow) {
        previewWindow.location.href = url;
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage('');
    } catch (error) {
      previewWindow?.close();
      setMessage((error as Error).message);
    } finally {
      setEvidenceLoadingId(null);
    }
  }

  return (
    <section className="nested-card">
      <h3>Cadastros SunCity</h3>
      <p className="info-text">Revise o comprovante antes de aprovar. Rejeição/correção exigem motivo.</p>
      {message && <p className="status-message">{message}</p>}
      {loading && <p className="info-text">Carregando...</p>}
      <div className="mobile-card-list">
        {users.map((user) => {
          const evidence = user.registrationEvidences[0];
          return (
            <article className="summary-item compact-card" key={user.id}>
              <strong>{user.name}</strong>
              <p>Personagem: {user.characterName}</p>
              <p>Discord: {user.discord}</p>
              <p>Telefone: {user.gamePhone}</p>
              <p>Status: {user.approvalStatus}</p>
              {evidence && (
                <button className="button-secondary" type="button" onClick={() => openEvidence(evidence.id)} disabled={evidenceLoadingId === evidence.id}>
                  {evidenceLoadingId === evidence.id ? 'Abrindo comprovante...' : 'Ver comprovante'}
                </button>
              )}
              <textarea
                placeholder="Motivo para rejeição/correção/suspensão"
                value={reasonById[user.id] ?? ''}
                onChange={(e) => setReasonById((prev) => ({ ...prev, [user.id]: e.target.value }))}
              />
              <div className="action-grid">
                <button className="button-success" disabled={loading} onClick={() => decide(user.id, 'approve')}>Aprovar</button>
                <button className="button-secondary" disabled={loading} onClick={() => decide(user.id, 'request-correction')}>Solicitar correção</button>
                <button className="button-danger" disabled={loading} onClick={() => decide(user.id, 'reject')}>Rejeitar</button>
              </div>
            </article>
          );
        })}
        {users.length === 0 && <p className="empty-state">Nenhum cadastro pendente.</p>}
      </div>
    </section>
  );
}
