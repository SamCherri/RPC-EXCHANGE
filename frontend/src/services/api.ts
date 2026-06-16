const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem('token');
  const headers = new Headers(init?.headers ?? {});

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  if (init?.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_URL}/api${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.message ?? 'Erro inesperado na API.');
  }

  if (response.status === 204 || response.status === 205) {
    return undefined as T;
  }

  const raw = await response.text();
  if (!raw.trim()) {
    return undefined as T;
  }

  return JSON.parse(raw) as T;
}


export type CurrentUserResponse = {
  user: {
    id: string;
    name: string;
    email?: string | null;
    discord: string;
    characterName?: string | null;
    gamePhone: string;
    roles: string[];
    approvalStatus?: 'PENDING' | 'CORRECTION_REQUIRED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
    approvalReason?: string | null;
    isBlocked: boolean;
    createdAt: string;
  };
  wallet: null | {
    fiatAvailableBalance: string | number;
    fiatLockedBalance: string | number;
    fiatPendingWithdrawalBalance: string | number;
    rpcAvailableBalance: string | number;
    rpcLockedBalance: string | number;
    availableBalance: string | number;
    lockedBalance: string | number;
    pendingWithdrawalBalance: string | number;
  };
};

export function getCurrentUser() {
  return api<CurrentUserResponse>('/auth/me');
}
