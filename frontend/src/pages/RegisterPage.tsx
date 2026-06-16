import { FormEvent, useState } from 'react';
import { BrandLogo } from '../components/BrandLogo';
import { api } from '../services/api';

type RegisterPageProps = {
  onSwitchLogin?: () => void;
};

export function RegisterPage({ onSwitchLogin }: RegisterPageProps) {
  const [name, setName] = useState('');
  const [characterName, setCharacterName] = useState('');
  const [discord, setDiscord] = useState('');
  const [gamePhone, setGamePhone] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsLoading(true);
    try {
      await api('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, characterName, discord, gamePhone, password }),
      });
      setMessage('✓ Conta criada com sucesso! Redirecionando para login...');
      setTimeout(() => {
        setName('');
        setCharacterName('');
        setDiscord('');
        setGamePhone('');
        setPassword('');
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
          <input 
            placeholder="Seu Discord no RP" 
            value={discord} 
            onChange={(event) => setDiscord(event.target.value)} 
            disabled={isLoading}
            required 
            minLength={2} 
          />
          <small className="label-hint">Será usado como identificador principal para entrar no app.</small>
        </label>

        <label>
          <span className="label-text">Telefone do jogo</span>
          <input 
            placeholder="Ex.: 000-000" 
            value={gamePhone} 
            onChange={(event) => setGamePhone(event.target.value)} 
            disabled={isLoading}
            required 
            minLength={3} 
          />
          <small className="label-hint">Número do personagem dentro do RP.</small>
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
