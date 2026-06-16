import { FormEvent, useEffect, useState } from 'react';
import { api } from '../services/api';

type PermissionsResponse = { permissions: string[]; users: Array<{ id: string; name: string; discord: string; grantedPermissions: Array<{ permission: { key: string }; reason?: string | null }> }> };

export function AdminFinancialPermissionsPanel() {
  const [data, setData] = useState<PermissionsResponse | null>(null);
  const [userId, setUserId] = useState('');
  const [permissionKey, setPermissionKey] = useState('registration.review');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function load() { try { setData(await api<PermissionsResponse>('/admin/financial-permissions')); } catch (error) { setMessage((error as Error).message); } }
  useEffect(() => { load(); }, []);

  async function submit(event: FormEvent, mode: 'grant' | 'revoke') {
    event.preventDefault();
    setLoading(true);
    try {
      await api(`/admin/financial-permissions/${mode}`, { method: 'POST', body: JSON.stringify({ userId, permissionKey, reason }) });
      setMessage(mode === 'grant' ? 'Permissão concedida.' : 'Permissão retirada.');
      await load();
    } catch (error) { setMessage((error as Error).message); } finally { setLoading(false); }
  }

  return <section className="nested-card"><h3>Permissões financeiras</h3><p className="info-text">Somente SUPER_ADMIN pode conceder ou retirar permissões granulares.</p>{message && <p className="status-message">{message}</p>}<form className="form-grid"><input value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="ID do usuário" required /><select value={permissionKey} onChange={(e) => setPermissionKey(e.target.value)}>{(data?.permissions ?? ['registration.review']).map((key) => <option key={key}>{key}</option>)}</select><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo" required minLength={3} /><button className="button-primary" disabled={loading} onClick={(e) => submit(e, 'grant')}>Conceder</button><button className="button-danger" disabled={loading} onClick={(e) => submit(e, 'revoke')}>Retirar</button></form><div className="mobile-card-list">{data?.users.map((user) => <article key={user.id} className="summary-item compact-card"><strong>{user.name}</strong><p>Discord: {user.discord}</p><p>ID: {user.id}</p><p>Permissões: {user.grantedPermissions.map((item) => item.permission.key).join(', ')}</p></article>)}</div></section>;
}
