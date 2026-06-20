import { useEffect, useState } from 'react';
import { ConfirmActionModal } from '../components/ConfirmActionModal';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { api, apiBlob } from '../services/api';
import { translateDepositMethod, translateDepositStatus } from '../utils/labels';

type Status = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'REJECTED' | 'CANCELED';
type Method = 'PLATFORM' | 'BROKER';

type Deposit = {
  id: string;
  code: string;
  amount: string;
  method: Method;
  status: Status;
  userNote?: string | null;
  hasScreenshot?: boolean;
  screenshotFileName?: string | null;
  screenshotSize?: number | null;
  createdAt: string;
  user: { id: string; name: string; email: string; characterName?: string | null; bankAccountNumber?: string | null };
  brokerUser?: { id: string; name: string; email: string; characterName?: string | null; discordId?: string | null } | null;
};

export function AdminDepositsPanel() {
  const [items, setItems] = useState<Deposit[]>([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [method, setMethod] = useState('');
  const [code, setCode] = useState('');
  const [userRef, setUserRef] = useState('');
  const [modalAction, setModalAction] = useState<{ id: string; endpoint: 'mark-processing' | 'complete' | 'reject'; method: Method } | null>(null);
  const [adminNote, setAdminNote] = useState('');
  const [confirmTextValue, setConfirmTextValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function load() {
    try {
      const qs = new URLSearchParams();
      if (status) qs.set('status', status);
      if (method) qs.set('method', method);
      if (code) qs.set('code', code);
      if (userRef) qs.set('userRef', userRef);
      const response = await api<{ deposits: Deposit[] }>(`/admin/deposits${qs.toString() ? `?${qs}` : ''}`);
      setItems(response.deposits);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => { load(); }, []);

  function openActionModal(item: Deposit, endpoint: 'mark-processing' | 'complete' | 'reject') {
    setModalAction({ id: item.id, endpoint, method: item.method });
    setAdminNote('');
    setConfirmTextValue('');
  }

  function closeActionModal() {
    if (isSubmitting) return;
    setModalAction(null);
    setAdminNote('');
    setConfirmTextValue('');
  }

  async function confirmAction() {
    if (!modalAction) return;
    setIsSubmitting(true);
    setError('');
    try {
      await api(`/admin/deposits/${modalAction.id}/${modalAction.endpoint}`, {
        method: 'POST',
        body: JSON.stringify({ adminNote: adminNote.trim() }),
      });
      closeActionModal();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function openScreenshot(id: string) {
    setError('');
    const previewWindow = window.open('about:blank', '_blank');
    if (previewWindow) {
      previewWindow.document.title = 'Carregando print do depósito';
      previewWindow.document.body.textContent = 'Carregando print do depósito...';
    }
    try {
      const blob = await apiBlob(`/admin/deposits/${id}/screenshot`);
      const url = URL.createObjectURL(blob);
      if (previewWindow) {
        previewWindow.location.href = url;
      } else {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `deposit-${id}`;
        anchor.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      if (previewWindow) previewWindow.close();
      setError((err as Error).message);
    }
  }

  return (
    <section className="nested-card">
      <h3>💵 Depósitos</h3>
      <p className="info-text">Aprovação manual de R$ fictício/RP. Não há pagamento real automático.</p>
      {error && <p className="status-message error">{error}</p>}

      <div className="form-grid">
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">Todos status</option>
          <option value="PENDING">Pendente</option>
          <option value="PROCESSING">Processando</option>
          <option value="COMPLETED">Concluído</option>
          <option value="REJECTED">Rejeitado</option>
          <option value="CANCELED">Cancelado</option>
        </select>
        <select value={method} onChange={(event) => setMethod(event.target.value)}>
          <option value="">Todos métodos</option>
          <option value="PLATFORM">Plataforma</option>
          <option value="BROKER">Corretor</option>
        </select>
        <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="Código" />
        <input value={userRef} onChange={(event) => setUserRef(event.target.value)} placeholder="Usuário/email/personagem" />
        <Button variant="secondary" onClick={load}>Filtrar</Button>
      </div>

      {items.length === 0 && <p className="empty-state">Nenhum pedido de depósito encontrado.</p>}
      <div className="mobile-card-list">
        {items.map((item) => (
          <article key={item.id} className="summary-item compact-card">
            <p><strong>Código:</strong> {item.code}</p>
            <p><strong>Usuário:</strong> {item.user.name} — {item.user.email}</p>
            <p><strong>Personagem:</strong> {item.user.characterName ?? 'Sem personagem'}</p>
            <p><strong>Valor:</strong> {item.amount} R$</p>
            <p><strong>Método:</strong> {translateDepositMethod(item.method)}</p>
            {item.brokerUser && <p><strong>Corretor:</strong> {item.brokerUser.name} ({item.brokerUser.email})</p>}
            <p><strong>Status:</strong> <Badge variant={item.status === 'COMPLETED' ? 'success' : item.status === 'REJECTED' || item.status === 'CANCELED' ? 'danger' : item.status === 'PROCESSING' ? 'warning' : 'info'}>{translateDepositStatus(item.status)}</Badge></p>
            <p><strong>Observação:</strong> {item.userNote || 'Sem observação'}</p>
            <p><strong>Data:</strong> {new Date(item.createdAt).toLocaleString('pt-BR')}</p>
            <p><strong>Comprovante:</strong> {item.hasScreenshot ? `📎 Enviado${item.screenshotFileName ? ` (${item.screenshotFileName})` : ''}` : 'Não enviado'}</p>

            <div className="action-grid">
              {item.hasScreenshot && <Button variant="secondary" onClick={() => openScreenshot(item.id)} disabled={isSubmitting}>Ver print</Button>}
              {!['COMPLETED', 'REJECTED', 'CANCELED'].includes(item.status) && item.method === 'PLATFORM' && item.status === 'PENDING' && (
                <Button variant="secondary" onClick={() => openActionModal(item, 'mark-processing')} disabled={isSubmitting}>Marcar processamento</Button>
              )}
              {!['COMPLETED', 'REJECTED', 'CANCELED'].includes(item.status) && item.method === 'PLATFORM' && (
                <Button variant="success" onClick={() => openActionModal(item, 'complete')} disabled={isSubmitting}>Aprovar/concluir</Button>
              )}
              {!['COMPLETED', 'REJECTED', 'CANCELED'].includes(item.status) && (
                <Button variant="danger" onClick={() => openActionModal(item, 'reject')} disabled={isSubmitting}>Rejeitar</Button>
              )}
            </div>
            {item.method === 'BROKER' && !['COMPLETED', 'REJECTED', 'CANCELED'].includes(item.status) && (
              <p className="info-text">Depósito via corretor: admin pode rejeitar; conclusão/processamento ficam com o corretor atribuído.</p>
            )}
          </article>
        ))}
      </div>

      <ConfirmActionModal
        open={Boolean(modalAction)}
        title={modalAction?.endpoint === 'complete' ? 'Concluir depósito' : modalAction?.endpoint === 'reject' ? 'Rejeitar depósito' : 'Marcar processamento'}
        description={modalAction?.endpoint === 'complete' ? 'Confirme apenas após validar o depósito fictício/RP. O saldo será creditado ao usuário.' : modalAction?.endpoint === 'reject' ? 'Rejeita sem alterar saldo.' : 'Atualiza o status sem alterar saldo.'}
        danger={modalAction?.endpoint !== 'mark-processing'}
        requireConfirmText={modalAction?.endpoint === 'mark-processing' ? undefined : 'CONFIRMAR'}
        confirmTextValue={confirmTextValue}
        isLoading={isSubmitting}
        confirmLabel="Confirmar"
        onCancel={closeActionModal}
        onConfirm={confirmAction}
        extraFields={<>
          <label className="admin-modal-field">
            <span>Nota admin</span>
            <textarea value={adminNote} onChange={(event) => setAdminNote(event.target.value)} disabled={isSubmitting} />
          </label>
          {modalAction?.endpoint !== 'mark-processing' && (
            <label className="admin-modal-field">
              <span>Confirmação *</span>
              <input value={confirmTextValue} onChange={(event) => setConfirmTextValue(event.target.value)} placeholder="Digite CONFIRMAR" disabled={isSubmitting} />
            </label>
          )}
        </>}
      />
    </section>
  );
}
