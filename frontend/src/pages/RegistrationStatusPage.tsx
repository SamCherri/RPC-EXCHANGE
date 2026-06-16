import { FormEvent, useEffect, useState } from 'react';
import { api } from '../services/api';

type Status = { approvalStatus: string; approvalReason?: string | null; reviewedAt?: string | null; lastSubmittedAt?: string | null };

async function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}

export function RegistrationStatusPage({ onLogout }: { onLogout: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [name, setName] = useState('');
  const [characterName, setCharacterName] = useState('');
  const [discord, setDiscord] = useState('');
  const [gamePhone, setGamePhone] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function load() {
    try {
      const data = await api<Status>('/auth/registration-status');
      setStatus(data);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }

  useEffect(() => { load(); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || loading) return;
    setLoading(true);
    setMessage('');
    try {
      await api('/auth/registration-resubmit', { method: 'PUT', body: JSON.stringify({ name, characterName, discord, gamePhone, evidence: { fileName: file.name, mimeType: file.type, dataBase64: await fileToBase64(file) } }) });
      setMessage('Cadastro reenviado para análise.');
      await load();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return <section className="card">
    <h2>Cadastro em análise</h2>
    <p className="info-text">Seu acesso econômico fica bloqueado até aprovação manual da administração.</p>
    {status && <div className="nested-card"><p><strong>Status:</strong> {status.approvalStatus}</p>{status.approvalReason && <p><strong>Motivo:</strong> {status.approvalReason}</p>}</div>}
    {message && <p className={`status-message ${message.includes('reenviado') ? 'success' : 'error'}`}>{message}</p>}
    {status && ['CORRECTION_REQUIRED', 'REJECTED'].includes(status.approvalStatus) && <form className="form-grid nested-card" onSubmit={submit}>
      <h3>Corrigir e reenviar</h3>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome" required minLength={3} />
      <input value={characterName} onChange={(e) => setCharacterName(e.target.value)} placeholder="Nome do personagem" required minLength={3} />
      <input value={discord} onChange={(e) => setDiscord(e.target.value)} placeholder="Discord" required minLength={2} />
      <input value={gamePhone} onChange={(e) => setGamePhone(e.target.value)} placeholder="Telefone SunCity" required minLength={3} />
      <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
      <button className="button-primary" disabled={loading || !file}>{loading ? 'Reenviando...' : 'Reenviar cadastro'}</button>
    </form>}
    <button className="button-secondary" type="button" onClick={onLogout}>Sair</button>
  </section>;
}
