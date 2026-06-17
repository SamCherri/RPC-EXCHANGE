import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { translateTransferType } from '../utils/labels';

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

export function BrokerDashboard() {
  const [balance, setBalance] = useState<BrokerBalance | null>(null);
  const [history, setHistory] = useState<BrokerHistory | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [userRef, setUserRef] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  async function load() {
    try {
      const [balanceResponse, historyResponse] = await Promise.all([api<BrokerBalance>('/broker/balance'), api<BrokerHistory>('/broker/history')]);
      setBalance(balanceResponse);
      setHistory(historyResponse);
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
      if (targetUserEmail) {
        uniqueTargets.add(`email:${targetUserEmail}`);
      }
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
        <input value={userRef} onChange={(e) => setUserRef(e.target.value)} placeholder="Discord do jogador (com ou sem @)" required />
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Valor em R$" required />
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Observação" required />
        <button className="button-primary" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Processando...' : 'Depositar R$ para usuário'}</button>
      </form>

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
