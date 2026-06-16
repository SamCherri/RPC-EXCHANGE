import { FormEvent, useEffect, useState } from 'react';
import { api, CurrentUserResponse, getCurrentUser } from '../services/api';

type ProfilePageProps = {
  onProfileUpdated?: (user: CurrentUserResponse['user']) => void;
};

export function ProfilePage({ onProfileUpdated }: ProfilePageProps) {
  const [name, setName] = useState('');
  const [characterName, setCharacterName] = useState('');
  const [discord, setDiscord] = useState('');
  const [gamePhone, setGamePhone] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [passwordMessage, setPasswordMessage] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCurrentUser().then(({ user }) => {
      setName(user.name ?? '');
      setCharacterName(user.characterName ?? '');
      setDiscord(user.discord ?? '');
      setGamePhone(user.gamePhone ?? '');
      setLoading(false);
    }).catch((error: Error) => { setMessage(error.message); setLoading(false); });
  }, []);

  async function submitProfile(event: FormEvent) {
    event.preventDefault();
    setMessage('');
    const response = await api<{ user: CurrentUserResponse['user'] }>('/auth/profile', { method: 'PUT', body: JSON.stringify({ name, characterName, discord, gamePhone }) });
    onProfileUpdated?.(response.user);
    setMessage('Perfil atualizado com sucesso.');
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    setPasswordMessage('');
    await api('/auth/change-password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword, confirmPassword }) });
    setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
    setPasswordMessage('Senha alterada com sucesso.');
  }

  if (loading) return <section className="card"><p className="info-text">Carregando perfil...</p></section>;

  return <section className="card">
    <h2>👤 Perfil do jogador</h2>
    <p className="info-text">Edite seus dados caso tenha digitado algo errado. Esta tela não altera cargos, saldo, carteira, ordens, mercado ou permissões.</p>
    <form className="form-grid nested-card" onSubmit={submitProfile}>
      <label>Nome<input value={name} onChange={(e) => setName(e.target.value)} required minLength={3} /></label>
      <label>Nome do personagem<input value={characterName} onChange={(e) => setCharacterName(e.target.value)} required minLength={3} /></label>
      <label>Discord<input value={discord} onChange={(e) => setDiscord(e.target.value)} required minLength={2} /></label>
      <label>Telefone do jogo<input value={gamePhone} onChange={(e) => setGamePhone(e.target.value)} required minLength={3} /></label>
      <button className="button-primary" type="submit">Editar perfil</button>
    </form>
    {message && <p className={`status-message ${message.includes('sucesso') ? 'success' : 'error'}`}>{message}</p>}

    <h3>Alterar senha</h3>
    <form className="form-grid nested-card" onSubmit={submitPassword}>
      <label>Senha atual<input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required minLength={8} /></label>
      <label>Nova senha<input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} /></label>
      <label>Confirmar nova senha<input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={8} /></label>
      <button className="button-secondary" type="submit">Alterar senha</button>
    </form>
    {passwordMessage && <p className={`status-message ${passwordMessage.includes('sucesso') ? 'success' : 'error'}`}>{passwordMessage}</p>}
  </section>;
}
