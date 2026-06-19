import { FormEvent, useEffect, useMemo, useState } from 'react';
import { ConfirmActionModal } from '../components/ConfirmActionModal';
import { api, apiBlob } from '../services/api';
import { translateRole } from '../utils/labels';
import { getOfficialRoleBadge } from '../utils/roleBadges';

type UserRow = {
  id: string;
  name: string;
  email: string;
  characterName?: string | null;
  bankAccountNumber?: string | null;
  discordId?: string | null;
  characterPhone?: string | null;
  approvalStatus: 'PENDING'|'NEEDS_CORRECTION'|'APPROVED'|'REJECTED';
  approvalNote?: string | null;
  financialPermissions?: Array<{ permission: string; revokedAt?: string | null }>;
  roles: string[];
  isBlocked: boolean;
  wallet: {
    availableBalance: string | number;
    lockedBalance: string | number;
    pendingWithdrawalBalance: string | number;
  };
  createdAt: string;
};

const ALL_ROLES = ['USER', 'VIRTUAL_BROKER', 'BUSINESS_OWNER', 'AUDITOR', 'ADMIN', 'COIN_CHIEF_ADMIN', 'SUPER_ADMIN', 'DEVELOPER'];

type AdminUsersPanelProps = {
  currentUserRoles: string[];
  onPermissionsUpdated: () => Promise<void>;
  mode?: 'users' | 'brokers';
};

function getCurrentUserIdFromToken(): string | null {
  const token = localStorage.getItem('token');
  if (!token) return null;

  try {
    const payload = token.split('.')[1] ?? "";
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded)) as { sub?: unknown };
    return typeof parsed.sub === "string" ? parsed.sub : null;
  } catch {
    return null;
  }
}

export function AdminUsersPanel({ currentUserRoles, onPermissionsUpdated, mode = 'users' }: AdminUsersPanelProps) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editingRoles, setEditingRoles] = useState<string[]>(['USER']);
  const [actionModal, setActionModal] = useState<{ userId: string; mode: 'block' | 'unblock' } | null>(null);
  const [actionReason, setActionReason] = useState('');
  const [actionConfirmText, setActionConfirmText] = useState('');
  const [isSubmittingAction, setIsSubmittingAction] = useState(false);
  const [approvalNote, setApprovalNote] = useState('Cadastro aprovado pela administração.');

  async function loadUsers() {
    setLoading(true);
    try {
      const query = search ? `?search=${encodeURIComponent(search)}` : '';
      const data = await api<{ users: UserRow[] }>(`/admin/users${query}`);
      setUsers(data.users);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canReviewRegistrations = currentUserRoles.some((role) => ['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'].includes(role.toUpperCase()));
  const brokers = useMemo(() => users.filter((user) => user.roles.includes('VIRTUAL_BROKER')), [users]);

  function toggleRole(role: string) {
    setEditingRoles((prev) => {
      if (role === 'USER') return prev;
      return prev.includes(role) ? prev.filter((item) => item !== role) : [...prev, role];
    });
  }

  function startEditingRoles(user: UserRow) {
    setEditingUserId(user.id);
    setEditingRoles(Array.from(new Set(['USER', ...user.roles])));
    setSuccess('');
  }

  async function saveRoles(event: FormEvent) {
    event.preventDefault();
    if (!editingUserId) return;

    await api(`/admin/users/${editingUserId}/roles`, {
      method: 'PATCH',
      body: JSON.stringify({ roles: Array.from(new Set(['USER', ...editingRoles.filter((role) => role !== 'DEVELOPER')])) }),
    });

    const currentUserId = getCurrentUserIdFromToken();
    if (currentUserId && editingUserId === currentUserId) {
      await onPermissionsUpdated();
      setSuccess('Suas permissões foram alteradas. Recarregue a página para atualizar o menu.');
    } else {
      setSuccess('Permissões atualizadas com sucesso. Alterações são registradas em auditoria.');
    }

    setEditingUserId(null);
    await loadUsers();
  }

  function openBlockModal(userId: string, mode: 'block' | 'unblock') {
    setActionModal({ userId, mode });
    setActionReason('');
    setActionConfirmText('');
  }

  function closeBlockModal() {
    if (isSubmittingAction) return;
    setActionModal(null);
    setActionReason('');
    setActionConfirmText('');
  }

  async function confirmBlockAction() {
    if (!actionModal) return;
    if (!actionReason.trim()) {
      setError('Informe o motivo para continuar.');
      return;
    }

    setIsSubmittingAction(true);
    setError('');
    try {
      await api(`/admin/users/${actionModal.userId}/${actionModal.mode}`, {
        method: 'PATCH',
        body: JSON.stringify({ reason: actionReason.trim() }),
      });
      closeBlockModal();
      await loadUsers();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmittingAction(false);
    }
  }



  async function reviewRegistration(user: UserRow, status: 'APPROVED'|'NEEDS_CORRECTION'|'REJECTED') {
    setError(''); setSuccess('');
    try {
      await api(`/admin/users/${user.id}/approval`, { method: 'PATCH', body: JSON.stringify({ status, note: approvalNote }) });
      setSuccess('Status de cadastro atualizado.');
      await loadUsers();
    } catch (err) { setError((err as Error).message); }
  }

  async function openRegistrationProof(user: UserRow) {
    setError('');
    try {
      const blob = await apiBlob(`/admin/users/${user.id}/registration-proof`);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err) { setError((err as Error).message); }
  }

  async function saveFinancialPermissions(user: UserRow, permissions: string[]) {
    setError(''); setSuccess('');
    try {
      await api(`/admin/users/${user.id}/financial-permissions`, { method: 'PATCH', body: JSON.stringify({ permissions, reason: 'Concessão granular pelo SUPER_ADMIN' }) });
      setSuccess('Permissões financeiras atualizadas.');
      await loadUsers();
    } catch (err) { setError((err as Error).message); }
  }

  async function removeBrokerRole(user: UserRow) {
    const nextRoles = user.roles.filter((role) => role !== 'VIRTUAL_BROKER');
    await api(`/admin/users/${user.id}/roles`, {
      method: 'PATCH',
      body: JSON.stringify({ roles: Array.from(new Set(['USER', ...nextRoles])) }),
    });
    await loadUsers();
  }

  return (
    <section className="nested-card">
      <h3>{mode === 'brokers' ? 'Corretores autorizados' : 'Usuários'}</h3>
      <p className="info-text">{mode === 'brokers' ? 'Usuários com permissão de corretor virtual.' : 'Alterações de permissões são registradas em auditoria.'}</p>

      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          loadUsers();
        }}
      >
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={mode === 'brokers' ? 'Buscar por conta RP/personagem/nome/e-mail' : 'Buscar por conta RP/personagem/nome/e-mail'} />
        <button className="button-primary" type="submit">{mode === 'brokers' ? 'Buscar corretores' : 'Buscar usuários'}</button>
      </form>

      {canReviewRegistrations && <label className="admin-modal-field"><span>Nota de aprovação/correção</span><input value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} /></label>}
      {error && <p className="status-message error">{error}</p>}
      {success && <p className="status-message success">{success}</p>}
      {loading && <p className="info-text">Carregando usuários...</p>}

      {mode === 'users' && (
        <div className="mobile-card-list">
          {users.map((user) => (
          <article key={user.id} className="summary-item compact-card">
            <strong>Usuário: {user.name}</strong>
            {getOfficialRoleBadge(user.roles) && <span className="official-badge">{getOfficialRoleBadge(user.roles)}</span>}
            <p>Personagem: {user.characterName ?? 'Sem personagem'}</p>
            <p>Conta RP: {user.bankAccountNumber ?? 'Sem conta RP'}</p>
            <p className="info-text">Email técnico: {user.email}</p>
            <p>Status: {user.isBlocked ? 'Bloqueado' : 'Ativo'} · Cadastro: {user.approvalStatus}</p>
            <p>Discord: {user.discordId ?? 'Não informado'} · Telefone RP: {user.characterPhone ?? 'Não informado'}</p>
            {user.approvalNote && <p className="status-message warning">Correção/status: {user.approvalNote}</p>}
            <p>Cargos: {user.roles.map((role) => translateRole(role)).join(', ')}</p>
            <p>Disponível: {user.wallet.availableBalance}</p>
            <p>Bloqueado: {user.wallet.lockedBalance}</p>
            <p>Pendente saque: {user.wallet.pendingWithdrawalBalance}</p>
            <div className="action-grid">
              <button type="button" className="button-primary" onClick={() => startEditingRoles(user)}>Editar cargos</button>
              {canReviewRegistrations && <>
                <button type="button" className="button-secondary" onClick={() => openRegistrationProof(user)}>Abrir screenshot</button>
                <button type="button" className="button-success" onClick={() => reviewRegistration(user, 'APPROVED')}>Aprovar cadastro</button>
                <button type="button" className="button-secondary" onClick={() => reviewRegistration(user, 'NEEDS_CORRECTION')}>Pedir correção</button>
              </>}
              <button type="button" className="button-primary" onClick={() => saveFinancialPermissions(user, ['RPC_MARKET_TRADE','COMPANY_MARKET_TRADE','PROJECT_CREATE','WITHDRAWAL_REQUEST','BROKER_TRANSFER'])}>Conceder permissões financeiras</button>
              {user.isBlocked ? (
                <button type="button" className="button-success" onClick={() => openBlockModal(user.id, 'unblock')} disabled={isSubmittingAction}>Desbloquear</button>
              ) : (
                <button type="button" className="button-danger" onClick={() => openBlockModal(user.id, 'block')} disabled={isSubmittingAction}>Bloquear</button>
              )}
            </div>

            {editingUserId === user.id && (
              <form className="nested-card" onSubmit={saveRoles}>
                {ALL_ROLES.map((role) => (
                  <label key={role} className="role-checkbox-label">
                    <input
                      type="checkbox"
                      checked={editingRoles.includes(role)}
                      disabled={role === 'USER' || role === 'DEVELOPER'}
                      onChange={() => toggleRole(role)}
                    />
                    {translateRole(role)}{role === 'DEVELOPER' ? ' (somente bootstrap seguro)' : ''}
                  </label>
                ))}
                <button className="button-primary" type="submit">Salvar permissões</button>
              </form>
            )}
          </article>
          ))}
        </div>
      )}

      {mode === 'users' && <h3 className="nested-card">Corretores</h3>}
      <div className="mobile-card-list">
        {brokers.map((broker) => (
          <article key={broker.id} className="summary-item compact-card">
            <strong>Usuário: {broker.name}</strong>
            {getOfficialRoleBadge(broker.roles) && <span className="official-badge">{getOfficialRoleBadge(broker.roles)}</span>}
            <p>Personagem: {broker.characterName ?? 'Sem personagem'}</p>
            <p>Conta RP: {broker.bankAccountNumber ?? 'Sem conta RP'}</p>
            <p className="info-text">Email técnico: {broker.email}</p>
            <p>Saldo RPC: {broker.wallet.availableBalance}</p>
            <button className="button-danger" onClick={() => removeBrokerRole(broker)}>
              Remover função de corretor
            </button>
          </article>
        ))}
        {brokers.length === 0 && <p className="empty-state">Nenhum corretor encontrado.</p>}
      </div>
      <ConfirmActionModal
        open={Boolean(actionModal)}
        title={actionModal?.mode === 'block' ? 'Bloquear usuário' : 'Desbloquear usuário'}
        description={actionModal?.mode === 'block' ? 'Esta ação impede o acesso do usuário até novo desbloqueio.' : 'Esta ação libera novamente o acesso do usuário.'}
        danger
        requireConfirmText="CONFIRMAR"
        confirmTextValue={actionConfirmText}
        isLoading={isSubmittingAction}
        confirmLabel={actionModal?.mode === 'block' ? 'Bloquear usuário' : 'Desbloquear usuário'}
        onCancel={closeBlockModal}
        onConfirm={confirmBlockAction}
        extraFields={<>
          <label className="admin-modal-field">
            <span>Motivo *</span>
            <textarea value={actionReason} onChange={(event) => setActionReason(event.target.value)} placeholder={actionModal?.mode === 'block' ? 'Ex: violação de regra administrativa' : 'Ex: revisão concluída'} disabled={isSubmittingAction} required />
          </label>
          <label className="admin-modal-field">
            <span>Confirmação *</span>
            <input type="text" value={actionConfirmText} onChange={(event) => setActionConfirmText(event.target.value)} placeholder="Digite CONFIRMAR" disabled={isSubmittingAction} required />
          </label>
        </>}
      />
    </section>
  );
}
