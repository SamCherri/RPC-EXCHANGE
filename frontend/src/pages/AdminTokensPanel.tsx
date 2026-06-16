import { FormEvent, useEffect, useMemo, useState } from 'react';
import { AdminActionModal } from '../components/AdminActionModal';
import { ConfirmActionModal } from '../components/ConfirmActionModal';
import { api } from '../services/api';
import { translateCompanyStatus } from '../utils/labels';

type TokenRow = {
  id: string;
  name: string;
  ticker: string;
  sector: string;
  status: string;
  founder: { id: string; name: string; email: string };
  currentPrice: string | number;
  totalTokens: number;
  availableTokens: number;
};

type TokenModalState =
  | { type: 'suspend' | 'reactivate' | 'close'; tokenId: string }
  | { type: 'owner'; tokenId: string }
  | { type: 'forceDelete'; token: TokenRow }
  | null;

export function AdminTokensPanel({ currentUserRoles }: { currentUserRoles: string[] }) {
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [modalState, setModalState] = useState<TokenModalState>(null);
  const [isSubmittingModal, setIsSubmittingModal] = useState(false);
  const [deleteTokenId, setDeleteTokenId] = useState<string | null>(null);
  const [deleteTokenConfirmText, setDeleteTokenConfirmText] = useState('');
  const [isDeletingToken, setIsDeletingToken] = useState(false);
  const isSuperAdmin = useMemo(() => currentUserRoles.map((role) => role.toUpperCase()).includes('SUPER_ADMIN'), [currentUserRoles]);

  const emptyForm = { founderEmail: '', name: '', ticker: '', description: '', sector: '', totalTokens: '', ownerSharePercent: '', publicOfferPercent: '', initialPrice: '', buyFeePercent: '', sellFeePercent: '' };
  const [form, setForm] = useState(emptyForm);

  async function loadTokens() {
    setError('');
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    const query = params.toString() ? `?${params.toString()}` : '';
    const data = await api<{ tokens: TokenRow[] }>(`/admin/tokens${query}`);
    setTokens(data.tokens);
  }

  useEffect(() => { loadTokens().catch((err) => setError((err as Error).message)); }, []);

  async function createToken(event: FormEvent) {
    event.preventDefault();
    setError(''); setMessage('');
    try { await api('/admin/tokens', { method: 'POST', body: JSON.stringify(form) }); setForm(emptyForm); setMessage('Token criado com sucesso.'); await loadTokens();
    } catch (err) { setError((err as Error).message); }
  }

  async function approveOrRejectToken(id: string, action: 'approve' | 'reject') {
    setError(''); setMessage('');
    try { await api(`/admin/companies/${id}/${action}`, { method: 'POST' }); setMessage(action === 'approve' ? 'Listagem aprovada com sucesso.' : 'Listagem rejeitada com sucesso.'); await loadTokens();
    } catch (err) { setError((err as Error).message); }
  }

  async function submitTokenAction(values: Record<string, string>) {
    if (!modalState) return;
    setIsSubmittingModal(true);
    setError('');
    setMessage('');
    try {
      if (modalState.type === 'owner') {
        const founderRef = values.founderRef?.trim() ?? '';
        const ownerPayload = {
          founderRef,
          ...(founderRef.includes('@') && !founderRef.startsWith('@') ? { founderEmail: founderRef } : {}),
          reason: values.reason,
        };
        await api(`/admin/tokens/${modalState.tokenId}/owner`, { method: 'PATCH', body: JSON.stringify(ownerPayload) });
        setMessage('Dono alterado com sucesso.');
      } else if (modalState.type === 'forceDelete') {
        await api(`/admin/companies/${modalState.token.id}/force-delete`, {
          method: 'DELETE',
          body: JSON.stringify({ reason: values.reason, confirmation: values.confirmation }),
        });
        setMessage('Projeto/token excluído definitivamente.');
      } else {
        await api(`/admin/tokens/${modalState.tokenId}/${modalState.type}`, { method: 'PATCH', body: JSON.stringify({ reason: values.reason }) });
        setMessage('Ação executada com sucesso.');
      }
      setModalState(null);
      await loadTokens();
    } finally {
      setIsSubmittingModal(false);
    }
  }

  function openDeleteTokenModal(id: string) {
    setDeleteTokenId(id);
    setDeleteTokenConfirmText('');
  }

  function closeDeleteTokenModal() {
    if (isDeletingToken) return;
    setDeleteTokenId(null);
    setDeleteTokenConfirmText('');
  }

  async function confirmDeleteToken() {
    if (!deleteTokenId) return;
    setError('');
    setMessage('');
    setIsDeletingToken(true);
    try {
      await api(`/admin/tokens/${deleteTokenId}`, { method: 'DELETE' });
      setMessage('Token removido definitivamente.');
      closeDeleteTokenModal();
      await loadTokens();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsDeletingToken(false);
    }
  }

  return (
    <section className="nested-card">
      <h3>Tokens/Mercados</h3>
      {message && <p className="status-message">{message}</p>}
      {error && <p className="status-message error">{error}</p>}
      <form className="form-grid two-cols" onSubmit={(event) => { event.preventDefault(); loadTokens(); }}>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por ticker/nome" />
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">Todos os status</option><option value="ACTIVE">{translateCompanyStatus('ACTIVE')}</option><option value="SUSPENDED">{translateCompanyStatus('SUSPENDED')}</option><option value="CLOSED">{translateCompanyStatus('CLOSED')}</option><option value="REJECTED">{translateCompanyStatus('REJECTED')}</option><option value="BANKRUPT">{translateCompanyStatus('BANKRUPT')}</option>
        </select>
        <button className="button-primary" type="submit">Filtrar mercados</button>
      </form>

      <h3 className="nested-card">Criar token manualmente</h3>
      <form className="form-grid two-cols" onSubmit={createToken}>{/* unchanged */}
        <input value={form.founderEmail} onChange={(event) => setForm((prev) => ({ ...prev, founderEmail: event.target.value }))} placeholder="E-mail do dono do projeto" required />
        <input value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="Nome do projeto" required />
        <input value={form.ticker} onChange={(event) => setForm((prev) => ({ ...prev, ticker: event.target.value.toUpperCase() }))} placeholder="Código do token" required />
        <input value={form.sector} onChange={(event) => setForm((prev) => ({ ...prev, sector: event.target.value }))} placeholder="Categoria" required />
        <textarea value={form.description} onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))} placeholder="Descrição do projeto" required />
        <input value={form.totalTokens} onChange={(event) => setForm((prev) => ({ ...prev, totalTokens: event.target.value }))} placeholder="Total de tokens" required />
        <input value={form.ownerSharePercent} onChange={(event) => setForm((prev) => ({ ...prev, ownerSharePercent: event.target.value }))} placeholder="Percentual do criador" required />
        <input value={form.publicOfferPercent} onChange={(event) => setForm((prev) => ({ ...prev, publicOfferPercent: event.target.value }))} placeholder="Percentual para lançamento" required />
        <input value={form.initialPrice} onChange={(event) => setForm((prev) => ({ ...prev, initialPrice: event.target.value }))} placeholder="Preço inicial" required />
        <input value={form.buyFeePercent} onChange={(event) => setForm((prev) => ({ ...prev, buyFeePercent: event.target.value }))} placeholder="Taxa compra (%)" required />
        <input value={form.sellFeePercent} onChange={(event) => setForm((prev) => ({ ...prev, sellFeePercent: event.target.value }))} placeholder="Taxa venda (%)" required />
        <button className="button-success" type="submit">Criar token</button>
      </form>

      <div className="mobile-card-list nested-card">{tokens.map((token) => (<article key={token.id} className="summary-item compact-card"><strong>{token.name} ({token.ticker})</strong><p>Status: {translateCompanyStatus(token.status)}</p><p>Dono: {token.founder.name} ({token.founder.email})</p><p>Preço atual: {token.currentPrice}</p><p>Total tokens: {token.totalTokens} · Disponível: {token.availableTokens}</p><div className="action-grid">{token.status === 'PENDING' && <><button className="button-success" type="button" onClick={() => approveOrRejectToken(token.id, 'approve')}>Aprovar listagem</button><button className="button-danger" type="button" onClick={() => approveOrRejectToken(token.id, 'reject')}>Rejeitar listagem</button></>}{token.status === 'ACTIVE' && <><button className="button-primary" type="button" onClick={() => setModalState({ type: 'suspend', tokenId: token.id })}>Pausar mercado</button><button className="button-danger" type="button" onClick={() => setModalState({ type: 'close', tokenId: token.id })}>Encerrar mercado</button><button className="button-primary" type="button" onClick={() => setModalState({ type: 'owner', tokenId: token.id })}>Trocar dono</button></>}{token.status === 'SUSPENDED' && <><button className="button-success" type="button" onClick={() => setModalState({ type: 'reactivate', tokenId: token.id })}>Reativar mercado</button><button className="button-danger" type="button" onClick={() => setModalState({ type: 'close', tokenId: token.id })}>Encerrar mercado</button><button className="button-primary" type="button" onClick={() => setModalState({ type: 'owner', tokenId: token.id })}>Trocar dono</button></>}{token.status === 'CLOSED' && <><button className="button-danger" type="button" onClick={() => openDeleteTokenModal(token.id)} disabled={isDeletingToken}>Excluir definitivamente</button><p className="info-text">A exclusão só é permitida se o backend confirmar ausência de histórico econômico.</p>{isSuperAdmin && <><button className="button-danger" type="button" onClick={() => setModalState({ type: 'forceDelete', token })}>Excluir teste definitivamente</button><p className="info-text">Ação irreversível para limpeza de dados de teste com histórico.</p></>}</>}</div></article>))}</div>
      <ConfirmActionModal
        open={Boolean(deleteTokenId)}
        title="Excluir token definitivamente"
        description="Esta ação só é permitida para mercados sem histórico econômico e remove o token em definitivo."
        danger
        requireConfirmText="CONFIRMAR"
        confirmTextValue={deleteTokenConfirmText}
        isLoading={isDeletingToken}
        confirmLabel="Excluir definitivamente"
        onCancel={closeDeleteTokenModal}
        onConfirm={confirmDeleteToken}
        extraFields={
          <label className="admin-modal-field">
            <span>Confirmação *</span>
            <input
              type="text"
              value={deleteTokenConfirmText}
              onChange={(event) => setDeleteTokenConfirmText(event.target.value)}
              placeholder="Digite CONFIRMAR"
              disabled={isDeletingToken}
              required
            />
          </label>
        }
      />
      {modalState && (
        <AdminActionModal
          title={modalState.type === 'suspend' ? 'Suspender projeto' : modalState.type === 'reactivate' ? 'Reativar projeto' : modalState.type === 'close' ? 'Encerrar projeto' : modalState.type === 'forceDelete' ? 'Excluir teste definitivamente' : 'Trocar dono do projeto'}
          description={modalState.type === 'suspend' ? 'Informe o motivo da suspensão. O projeto sairá das telas comuns.' : modalState.type === 'reactivate' ? 'Informe o motivo da reativação. O projeto voltará às telas comuns se estiver ativo.' : modalState.type === 'close' ? 'Esta ação encerra o mercado/projeto. Confirme com um motivo claro.' : modalState.type === 'forceDelete' ? `Esta ação apagará o projeto ${modalState.token.name} (${modalState.token.ticker}) e todo histórico vinculado. Use apenas para dados de teste.` : 'Informe Discord, telefone ou ID do novo dono e o motivo da alteração.'}
          confirmLabel={modalState.type === 'owner' ? 'Trocar dono' : modalState.type === 'suspend' ? 'Suspender projeto' : modalState.type === 'reactivate' ? 'Reativar projeto' : modalState.type === 'forceDelete' ? 'Excluir teste definitivamente' : 'Encerrar projeto'}
          danger={modalState.type === 'close' || modalState.type === 'forceDelete'}
          fields={modalState.type === 'owner' ? [{ name: 'founderRef', label: 'Discord, telefone ou ID do novo dono', type: 'text', required: true, placeholder: '@discord ou telefone' }, { name: 'reason', label: 'Motivo', type: 'textarea', required: true, placeholder: 'Descreva o motivo da alteração' }] : modalState.type === 'forceDelete' ? [{ name: 'reason', label: 'Motivo (mínimo 10 caracteres)', type: 'textarea', required: true, placeholder: 'Descreva detalhadamente o motivo da exclusão de teste', minLength: 10 }, { name: 'confirmation', label: 'Confirmação', type: 'text', required: true, placeholder: 'Digite EXCLUIR DEFINITIVAMENTE', pattern: '^EXCLUIR DEFINITIVAMENTE$' }] : [{ name: 'reason', label: 'Motivo', type: 'textarea', required: true, placeholder: 'Descreva o motivo' }]}
          onCancel={() => setModalState(null)}
          onConfirm={submitTokenAction}
          isSubmitting={isSubmittingModal}
        />
      )}
    </section>
  );
}
