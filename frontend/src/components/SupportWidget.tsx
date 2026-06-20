import { FormEvent, useEffect, useState } from 'react';
import { api } from '../services/api';

type Ticket = { id: string; category: string; title: string; status: string; createdAt: string; messages?: Array<{ id: string; message: string; createdAt: string; author?: { name: string } }> };
const categories = ['BUG', 'SUGGESTION', 'COMPLAINT', 'QUESTION', 'BALANCE_ISSUE', 'REGISTRATION_ISSUE', 'OTHER'];
const labels: Record<string,string> = { BUG:'Bug', SUGGESTION:'Sugestão', COMPLAINT:'Reclamação', QUESTION:'Dúvida', BALANCE_ISSUE:'Problema de saldo', REGISTRATION_ISSUE:'Problema de cadastro', OTHER:'Outro' };
const MAX_BYTES = 2 * 1024 * 1024;

type SupportWidgetProps = {
  open: boolean;
  onClose: () => void;
};

export function SupportWidget({ open, onClose }: SupportWidgetProps) {
  function closeSupport() {
    onClose();
  }
  const [category, setCategory] = useState('QUESTION');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [screen, setScreen] = useState('');
  const [platform, setPlatform] = useState('');
  const [screenshot, setScreenshot] = useState<{ mimeType: string; fileName: string; data: string } | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  async function loadTickets() {
    const data = await api<{ tickets: Ticket[] }>('/support/my-tickets');
    setTickets(data.tickets);
  }

  useEffect(() => { if (open) loadTickets().catch((err) => setError((err as Error).message)); }, [open]);

  async function handleFile(file?: File) {
    setError(''); setScreenshot(null);
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setError('Print inválido. Use PNG, JPG ou WEBP.'); return; }
    if (file.size > MAX_BYTES) { setError('Print grande demais. Limite máximo: 2 MB.'); return; }
    const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',').pop() ?? ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
    setScreenshot({ mimeType: file.type, fileName: file.name, data });
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setSuccess(''); setLoading(true);
    try {
      await api('/support/tickets', { method: 'POST', body: JSON.stringify({ category, title, message, screen, platform, screenshot }) });
      setSuccess('Chamado enviado. A equipe poderá responder pela central.');
      setTitle(''); setMessage(''); setScreen(''); setPlatform(''); setScreenshot(null);
      await loadTickets();
    } catch (err) { setError((err as Error).message); } finally { setLoading(false); }
  }

  return <>
    {open && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="card support-modal">
        <div className="support-modal-header"><h2>Central de Suporte privada</h2><button className="button-secondary small-button" onClick={closeSupport}>Fechar</button></div>
        <p className="info-text">Seu chamado é privado. Apenas você e a equipe administrativa autorizada conseguem visualizar.</p>
        {error && <p className="status-message error">{error}</p>}{success && <p className="status-message success">{success}</p>}
        <form className="form-grid" onSubmit={submit}>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((item) => <option key={item} value={item}>{labels[item]}</option>)}</select>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título do chamado" minLength={5} maxLength={120} required />
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Explique o que aconteceu" minLength={10} maxLength={4000} required />
          <input value={screen} onChange={(e) => setScreen(e.target.value)} placeholder="Tela onde aconteceu (opcional)" />
          <input value={platform} onChange={(e) => setPlatform(e.target.value)} placeholder="Plataforma: celular, PC, navegador... (opcional)" />
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => handleFile(e.target.files?.[0])} />
          {screenshot && <small>Print anexado: {screenshot.fileName}</small>}
          <button className="button-primary" disabled={loading}>{loading ? 'Enviando...' : 'Enviar chamado'}</button>
        </form>
        <h3>Meus chamados</h3>
        <div className="mobile-card-list">{tickets.length === 0 ? <p className="info-text">Nenhum chamado enviado ainda.</p> : tickets.map((ticket) => <button key={ticket.id} className="summary-item compact-card support-ticket-card" onClick={async () => { const data = await api<{ ticket: Ticket }>(`/support/my-tickets/${ticket.id}`); setSelected(data.ticket); }}><strong>{ticket.title}</strong><span>{labels[ticket.category] ?? ticket.category} • {ticket.status}</span><small>{new Date(ticket.createdAt).toLocaleString('pt-BR')}</small></button>)}</div>
        {selected && <div className="nested-card"><h3>{selected.title}</h3><p>Status: <strong>{selected.status}</strong></p>{selected.messages?.length ? selected.messages.map((msg) => <p key={msg.id}><strong>{msg.author?.name ?? 'Equipe'}:</strong> {msg.message}</p>) : <p className="info-text">Ainda não há resposta da equipe.</p>}</div>}
      </section>
    </div>}
  </>;
}
