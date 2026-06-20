import { FormEvent, useEffect, useState } from 'react';
import { api, apiBlob } from '../services/api';
import { translateDepositMethod, translateDepositStatus } from '../utils/labels';

type DepositStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'REJECTED' | 'CANCELED';
type DepositMethod = 'PLATFORM' | 'BROKER';

type Deposit = {
  id: string;
  code: string;
  amount: string;
  method: DepositMethod;
  status: DepositStatus;
  userNote?: string | null;
  adminNote?: string | null;
  hasScreenshot?: boolean;
  screenshotFileName?: string | null;
  screenshotSize?: number | null;
  createdAt: string;
  brokerUser?: { id: string; name: string; characterName?: string | null; discordId?: string | null } | null;
};

type Broker = { id: string; name: string; characterName?: string | null; discordId?: string | null };
type ScreenshotPayload = { mimeType: string; fileName: string; data: string; size: number };

const ALLOWED_SCREENSHOT_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

function moeda(value: number) {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function makeIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `deposit-${Date.now()}`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}

export function DepositsPage() {
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<DepositMethod>('PLATFORM');
  const [brokerUserId, setBrokerUserId] = useState('');
  const [brokerRef, setBrokerRef] = useState('');
  const [userNote, setUserNote] = useState('');
  const [screenshot, setScreenshot] = useState<ScreenshotPayload | null>(null);
  const [fileError, setFileError] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cancelingId, setCancelingId] = useState<string | null>(null);

  async function load() {
    try {
      const [depositResponse, brokerResponse] = await Promise.all([
        api<{ deposits: Deposit[] }>('/deposits/me'),
        api<{ brokers: Broker[] }>('/deposits/brokers'),
      ]);
      setDeposits(depositResponse.deposits);
      setBrokers(brokerResponse.brokers);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleFile(file?: File) {
    setFileError('');
    if (!file) return;
    if (!ALLOWED_SCREENSHOT_TYPES.includes(file.type)) {
      setScreenshot(null);
      setFileError('Envie apenas PNG, JPG/JPEG ou WEBP.');
      return;
    }
    if (file.size > MAX_SCREENSHOT_BYTES) {
      setScreenshot(null);
      setFileError('Arquivo grande demais. Limite máximo: 2 MB.');
      return;
    }
    try {
      const data = await readFileAsDataUrl(file);
      setScreenshot({ mimeType: file.type, fileName: file.name, data, size: file.size });
    } catch (err) {
      setScreenshot(null);
      setFileError((err as Error).message);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError('');
    setMessage('');

    const idempotencyKey = makeIdempotencyKey();
    try {
      const created = await api<Deposit>('/deposits', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          amount,
          method,
          brokerUserId: method === 'BROKER' && brokerUserId ? brokerUserId : undefined,
          brokerRef: method === 'BROKER' && !brokerUserId ? brokerRef : undefined,
          userNote,
          idempotencyKey,
          screenshot: screenshot ? { mimeType: screenshot.mimeType, fileName: screenshot.fileName, data: screenshot.data } : undefined,
        }),
      });
      setMessage(`Depósito solicitado com sucesso. Código: ${created.code}. Aguarde aprovação; nenhum saldo foi creditado automaticamente.`);
      setAmount('');
      setUserNote('');
      setBrokerRef('');
      setBrokerUserId('');
      setScreenshot(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function cancel(id: string) {
    if (cancelingId) return;
    setCancelingId(id);
    setError('');
    try {
      await api(`/deposits/${id}/cancel`, { method: 'POST' });
      setMessage('Depósito cancelado. Nenhum saldo foi alterado.');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCancelingId(null);
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
      const blob = await apiBlob(`/deposits/${id}/screenshot`);
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
      <h2>💵 Solicitar depósito</h2>
      <p className="info-text">Depósito de R$ fictício/RP. Não é pagamento real automático. Não existe Pix, cartão, banco ou gateway.</p>
      <p className="info-text">Print opcional. Use apenas como comprovante RP/manual. O envio não aprova o depósito automaticamente.</p>
      {error && <p className="status-message error">{error}</p>}
      {message && <p className="status-message success">{message}</p>}

      <form onSubmit={submit} className="form-grid nested-card">
        <input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Valor em R$" required inputMode="decimal" />
        <select value={method} onChange={(event) => setMethod(event.target.value as DepositMethod)}>
          <option value="PLATFORM">Plataforma/Administração</option>
          <option value="BROKER">Corretor Virtual</option>
        </select>
        {method === 'BROKER' && (
          <>
            <select value={brokerUserId} onChange={(event) => setBrokerUserId(event.target.value)}>
              <option value="">Selecionar corretor disponível</option>
              {brokers.map((broker) => (
                <option key={broker.id} value={broker.id}>{broker.name}{broker.characterName ? ` — ${broker.characterName}` : ''}{broker.discordId ? ` (@${broker.discordId})` : ''}</option>
              ))}
            </select>
            <input value={brokerRef} onChange={(event) => setBrokerRef(event.target.value)} placeholder="Ou informe Discord/nome/código do corretor" disabled={Boolean(brokerUserId)} />
          </>
        )}
        <input value={userNote} onChange={(event) => setUserNote(event.target.value)} placeholder="Observação para o responsável" />
        <label className="admin-modal-field">
          <span>Enviar print/comprovante opcional</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => handleFile(event.target.files?.[0])} />
          <small className="label-hint">PNG, JPG/JPEG ou WEBP até 2 MB. Não aprova o depósito automaticamente.</small>
        </label>
        {fileError && <p className="status-message error">{fileError}</p>}
        {screenshot && (
          <div className="nested-card">
            <p><strong>Arquivo:</strong> {screenshot.fileName}</p>
            <p><strong>Tamanho:</strong> {moeda(screenshot.size / 1024)} KB</p>
            <button className="button-secondary" type="button" onClick={() => setScreenshot(null)}>Remover arquivo</button>
          </div>
        )}
        <button className="button-primary" disabled={isSubmitting}>{isSubmitting ? 'Enviando...' : 'Solicitar depósito'}</button>
      </form>

      <h3 className="nested-card">Meus depósitos</h3>
      <div className="mobile-card-list">
        {deposits.length === 0 && <p className="empty-state">Nenhum depósito solicitado até agora.</p>}
        {deposits.map((item) => (
          <article key={item.id} className="summary-item compact-card">
            <p><strong>Código:</strong> {item.code}</p>
            <p><strong>Valor:</strong> {moeda(Number(item.amount))} R$</p>
            <p><strong>Método:</strong> {translateDepositMethod(item.method)}</p>
            <p><strong>Status:</strong> {translateDepositStatus(item.status)}</p>
            {item.brokerUser && <p><strong>Corretor:</strong> {item.brokerUser.name}</p>}
            <p><strong>Data:</strong> {new Date(item.createdAt).toLocaleString('pt-BR')}</p>
            <p><strong>Observação:</strong> {item.userNote || 'Sem observação'}</p>
            {item.hasScreenshot && <p>📎 Comprovante enviado</p>}
            <div className="action-grid">
              {item.hasScreenshot && <button className="button-secondary" type="button" onClick={() => openScreenshot(item.id)}>Ver print</button>}
              {item.status === 'PENDING' && (
                <button className="button-danger" type="button" onClick={() => cancel(item.id)} disabled={cancelingId !== null}>
                  {cancelingId === item.id ? 'Cancelando...' : 'Cancelar'}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
