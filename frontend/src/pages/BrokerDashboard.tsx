import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api, apiBlob } from '../services/api';
import { translateDepositStatus, translateTransferType } from '../utils/labels';

type BrokerBalance = { available: string; receivedTotal: string };
type BrokerTransfer = {
  id: string;
  type: string;
  amount: string;
  reason: string;
  createdAt: string;
  receiverId?: string | null;
  receiverEmail?: string | null;
  targetUserEmail?: string | null;
};
type BrokerHistory = { transfers: BrokerTransfer[] };
type BrokerDeposit = {
  id: string;
  code: string;
  amount: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'REJECTED' | 'CANCELED';
  userNote?: string | null;
  hasScreenshot?: boolean;
  screenshotFileName?: string | null;
  screenshotSize?: number | null;
  createdAt: string;
  user: { name: string; email: string; characterName?: string | null };
};

function moeda(value: number) {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function BrokerDashboard() {
  const [balance, setBalance] = useState<BrokerBalance | null>(null);
  const [history, setHistory] = useState<BrokerHistory | null>(null);
  const [deposits, setDeposits] = useState<BrokerDeposit[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [userRef, setUserRef] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  async function load() {
    try {
      const [balanceResponse, historyResponse, depositsResponse] = await Promise.all([
        api<BrokerBalance>('/broker/balance'),
        api<BrokerHistory>('/broker/history'),
        api<{ deposits: BrokerDeposit[] }>('/broker/deposits'),
      ]);
      setBalance(balanceResponse);
      setHistory(historyResponse);
      setDeposits(depositsResponse.deposits);
      setError('');
      setMessage('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => { load(); }, []);

  const transfers = history?.transfers ?? [];
  const sentTransfers = useMemo(() => transfers.filter((item) => item.type === 'BROKER_TO_USER'), [transfers]);
  const totalTransfers = sentTransfers.length;

  const servedUsers = useMemo(() => {
    const uniqueTargets = new Set<string>();
    for (const transfer of sentTransfers) {
      if (transfer.receiverId) {
        uniqueTargets.add(`id:${transfer.receiverId}`);
        continue;
      }
      const receiverEmail = transfer.receiverEmail?.trim().toLowerCase();
      if (receiverEmail) {
        uniqueTargets.add(`email:${receiverEmail}`);
        continue;
      }
      const targetUserEmail = transfer.targetUserEmail?.trim().toLowerCase();
      if (targetUserEmail) uniqueTargets.add(`email:${targetUserEmail}`);
    }
    return uniqueTargets.size > 0 ? uniqueTargets.size : null;
  }, [sentTransfers]);

  async function submitTransfer(event: FormEvent) {
    event.preventDefault();
    setError('');
    setMessage('');
    setIsSubmitting(true);
    try {
      await api('/broker/transfer-to-user', { method: 'POST', body: JSON.stringify({ userRef, amount, reason }) });
      setUserRef('');
      setAmount('');
      setReason('');
      await load();
      setMessage('Depósito em R$ enviado ao usuário com sucesso.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function processDeposit(id: string, endpoint: 'mark-processing' | 'complete' | 'reject') {
    setError('');
    setMessage('');
    setIsSubmitting(true);
    try {
      await api(`/broker/deposits/${id}/${endpoint}`, {
        method: 'POST',
        body: JSON.stringify({ adminNote: endpoint === 'complete' ? 'Concluído pelo corretor virtual.' : undefined }),
      });
      await load();
      setMessage(endpoint === 'complete' ? 'Depósito concluído e debitado do seu saldo de corretor.' : endpoint === 'reject' ? 'Depósito rejeitado.' : 'Depósito marcado em processamento.');
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
      const blob = await apiBlob(`/broker/deposits/${id}/screenshot`);
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
    <section className="card">
      <h2>🤝 Painel Corretor</h2>
      {error && <p className="status-message error">{error}</p>}
      {message && <p className="status-message success">{message}</p>}

      {balance && (
        <div className="summary-grid">
          <div className="summary-item"><span className="summary-label">Saldo R$</span><strong className="summary-value">{balance.available}</strong></div>
          <div className="summary-item"><span className="summary-label">Total R$ recebido</span><strong className="summary-value">{balance.receivedTotal}</strong></div>
          <div className="summary-item"><span className="summary-label">Usuários atendidos</span><strong className="summary-value">{servedUsers ?? 'Indisponível'}</strong></div>
          <div className="summary-item"><span className="summary-label">Total de envios</span><strong className="summary-value">{totalTransfers}</strong></div>
        </div>
      )}

      <h3 className="nested-card">Depositar R$ para usuário</h3>
      <p className="info-text">Deposite crédito R$ para o jogador dentro do RP.</p>
      <p className="info-text">Limites não configurados.</p>
      <form onSubmit={submitTransfer} className="form-grid">
        <input value={userRef} onChange={(event) => setUserRef(event.target.value)} placeholder="Discord do jogador (com ou sem @)" required />
        <input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Valor em R$" required />
        <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Observação" required />
        <button className="button-primary" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Processando...' : 'Depositar R$ para usuário'}</button>
      </form>

      <h3 className="nested-card">Solicitações de depósito</h3>
      <p className="info-text">Concluir uma solicitação usa o saldo disponível do corretor. Se o saldo for insuficiente, o backend bloqueia a ação.</p>
      {deposits.length === 0 && <p className="empty-state">Nenhuma solicitação atribuída a você.</p>}
      <div className="mobile-card-list">
        {deposits.map((item) => (
          <article key={item.id} className="summary-item compact-card">
            <p><strong>Código:</strong> {item.code}</p>
            <p><strong>Jogador:</strong> {item.user.name} — {item.user.characterName ?? item.user.email}</p>
            <p><strong>Valor:</strong> {moeda(Number(item.amount))} R$</p>
            <p><strong>Status:</strong> {translateDepositStatus(item.status)}</p>
            <p><strong>Data:</strong> {new Date(item.createdAt).toLocaleString('pt-BR')}</p>
            <p><strong>Observação:</strong> {item.userNote || 'Sem observação'}</p>
            <p><strong>Comprovante:</strong> {item.hasScreenshot ? `📎 Enviado${item.screenshotFileName ? ` (${item.screenshotFileName})` : ''}` : 'Não enviado'}</p>
            <div className="action-grid">
              {item.hasScreenshot && <button className="button-secondary" type="button" onClick={() => openScreenshot(item.id)} disabled={isSubmitting}>Ver print</button>}
              {!['COMPLETED', 'REJECTED', 'CANCELED'].includes(item.status) && (
                <>
                  {item.status === 'PENDING' && <button className="button-secondary" type="button" onClick={() => processDeposit(item.id, 'mark-processing')} disabled={isSubmitting}>Marcar processamento</button>}
                  <button className="button-primary" type="button" onClick={() => processDeposit(item.id, 'complete')} disabled={isSubmitting}>Concluir</button>
                  <button className="button-danger" type="button" onClick={() => processDeposit(item.id, 'reject')} disabled={isSubmitting}>Rejeitar</button>
                </>
              )}
            </div>
          </article>
        ))}
      </div>

      <h3 className="nested-card">Histórico de envios</h3>
      {transfers.length === 0 && <p className="empty-state">Sem envios registrados.</p>}
      <div className="mobile-card-list">
        {transfers.slice(0, 8).map((item) => (
          <article key={item.id} className="summary-item compact-card">
            <p><strong>{translateTransferType(item.type)}</strong></p>
            <p>R$: {item.amount}</p>
            <p>Motivo: {item.reason}</p>
            <p>{new Date(item.createdAt).toLocaleString('pt-BR')}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
