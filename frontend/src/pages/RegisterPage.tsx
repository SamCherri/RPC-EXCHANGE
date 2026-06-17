import { FormEvent, useState } from 'react';
import { BrandLogo } from '../components/BrandLogo';
import { api } from '../services/api';

type RegisterPageProps = {
  onSwitchLogin?: () => void;
};

export function RegisterPage({ onSwitchLogin }: RegisterPageProps) {
  const [name, setName] = useState('');
  const [characterName, setCharacterName] = useState('');
  const [discordId, setDiscordId] = useState('');
  const [characterPhone, setCharacterPhone] = useState('');
  const [screenshot, setScreenshot] = useState<{ mimeType: 'image/png'|'image/jpeg'|'image/webp'; fileName?: string; data: string } | null>(null);
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsLoading(true);
    try {
      if (!screenshot) throw new Error('Envie o screenshot obrigatório do cadastro.');
      if (password !== passwordConfirmation) throw new Error('A confirmação de senha não confere.');
      await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, characterName, discordId, characterPhone, password, passwordConfirmation, screenshot }),
      });
      setMessage('✓ Conta criada com sucesso! Redirecionando para login...');
      setTimeout(() => {
        setName('');
        setCharacterName('');
        setDiscordId('');
        setCharacterPhone('');
        setScreenshot(null);
        setPassword('');
        setPasswordConfirmation('');
        if (onSwitchLogin) onSwitchLogin();
      }, 1500);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <section className="auth-panel nested-card">
      <div className="auth-header">
        <BrandLogo size="md" subtitle />
        <h2>Criar conta</h2>
        <p className="auth-subtitle">Junte-se à comunidade RPC Exchange</p>
      </div>

      <form onSubmit={handleSubmit} className="auth-form">
        <label>
          <span className="label-text">Nome completo</span>
          <input 
            placeholder="Seu nome" 
            value={name} 
            onChange={(event) => setName(event.target.value)} 
            disabled={isLoading}
            required 
          />
        </label>

        <label>
          <span className="label-text">Nome do personagem (RP)</span>
          <input 
            placeholder="Nome do seu personagem" 
            value={characterName} 
            onChange={(event) => setCharacterName(event.target.value)} 
            disabled={isLoading}
            required 
            minLength={3} 
          />
        </label>

        <label>
          <span className="label-text">Discord</span>
          <input placeholder="Ex.: usuario#0001 ou ID do Discord" value={discordId} onChange={(event) => setDiscordId(event.target.value)} disabled={isLoading} required minLength={2} />
        </label>

        <label>
          <span className="label-text">Telefone do personagem</span>
          <input placeholder="Ex.: 555-0199" value={characterPhone} onChange={(event) => setCharacterPhone(event.target.value)} disabled={isLoading} required minLength={3} />
          <small className="label-hint">Telefone fictício usado dentro do RP.</small>
        </label>

        <label>
          <span className="label-text">Screenshot obrigatório</span>
          <input type="file" accept="image/png,image/jpeg,image/webp" disabled={isLoading} required onChange={(event) => { const file = event.target.files?.[0]; if (!file) { setScreenshot(null); return; } const reader = new FileReader(); reader.onload = () => setScreenshot({ mimeType: file.type as 'image/png'|'image/jpeg'|'image/webp', fileName: file.name, data: String(reader.result) }); reader.readAsDataURL(file); }} />
          <small className="label-hint">Use imagem PNG, JPG ou WEBP. O envio é analisado pela administração.</small>
        </label>

        <label>
          <span className="label-text">Senha</span>
          <input 
            placeholder="Mínimo 8 caracteres" 
            type="password" 
            value={password} 
            onChange={(event) => setPassword(event.target.value)} 
            disabled={isLoading}
            required 
            minLength={8} 
          />
          <small className="label-hint">Use uma senha forte com números e símbolos</small>
        </label>

        <label>
          <span className="label-text">Confirmar senha</span>
          <input 
            placeholder="Digite a senha novamente" 
            type="password" 
            value={passwordConfirmation} 
            onChange={(event) => setPasswordConfirmation(event.target.value)} 
            disabled={isLoading}
            required 
            minLength={8} 
          />
        </label>

        <button className="button-primary" type="submit" disabled={isLoading}>
          {isLoading ? 'Criando conta...' : 'Cadastrar'}
        </button>
      </form>

      {message && (
        <p className={`auth-message ${message.includes('sucesso') ? 'success' : 'error'}`}>
          {message}
        </p>
      )}

      {onSwitchLogin && (
        <div className="auth-footer">
          <p>Já tem conta? <button className="link-button" type="button" onClick={onSwitchLogin}>Ir para login</button></p>
        </div>
      )}
    </section>
  );
}
