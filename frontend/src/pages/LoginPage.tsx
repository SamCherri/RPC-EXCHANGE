import { FormEvent, useState } from 'react';
import { BrandLogo } from '../components/BrandLogo';
import { api } from '../services/api';

type LoginPageProps = {
  onSuccess?: (token: string) => void;
  onSwitchRegister?: () => void;
};

export function LoginPage({ onSuccess, onSwitchRegister }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsLoading(true);
    try {
      const result = await api<{ token: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      localStorage.setItem('token', result.token);
      setMessage('Login realizado com sucesso.');
      onSuccess?.(result.token);
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
        <h2>Bem-vindo à RPC Exchange</h2>
        <p className="auth-subtitle">Simulação econômica para Roleplay</p>
      </div>

      <form onSubmit={handleSubmit} className="auth-form">
        <label>
          <span className="label-text">E-mail</span>
          <input 
            placeholder="seu.email@exemplo.com" 
            type="email" 
            value={email} 
            onChange={(event) => setEmail(event.target.value)} 
            disabled={isLoading}
            required 
          />
        </label>
        
        <label>
          <span className="label-text">Senha</span>
          <input 
            placeholder="••••••••" 
            type="password" 
            value={password} 
            onChange={(event) => setPassword(event.target.value)} 
            disabled={isLoading}
            required 
          />
        </label>

        <button className="button-primary" type="submit" disabled={isLoading}>
          {isLoading ? 'Entrando...' : 'Entrar'}
        </button>
      </form>

      {message && (
        <p className={`auth-message ${message.includes('sucesso') ? 'success' : 'error'}`}>
          {message}
        </p>
      )}

      {onSwitchRegister && (
        <div className="auth-footer">
          <p>Novo por aqui? <button className="link-button" type="button" onClick={onSwitchRegister}>Criar cadastro</button></p>
        </div>
      )}
    </section>
  );
}
