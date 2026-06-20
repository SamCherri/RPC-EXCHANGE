function translateValue(value: string | undefined, labels: Record<string, string>) {
  if (!value) return '-';
  return labels[value] ?? value;
}

export function translateCompanyStatus(status?: string) {
  return translateValue(status, {
    PENDING: 'Pendente',
    APPROVED: 'Aprovado',
    ACTIVE: 'Ativo',
    REJECTED: 'Rejeitado',
    SUSPENDED: 'Suspenso',
    BANKRUPT: 'Falido',
    CLOSED: 'Encerrado',
  });
}

export function translateOrderStatus(status?: string) {
  return translateValue(status, {
    OPEN: 'Aberta',
    PARTIALLY_FILLED: 'Parcialmente executada',
    FILLED: 'Executada',
    CANCELED: 'Cancelada',
    REJECTED: 'Rejeitada',
  });
}

export function translateOrderType(type?: string) {
  return translateValue(type, {
    BUY: 'Compra',
    SELL: 'Venda',
  });
}

export function translateOrderMode(mode?: string) {
  return translateValue(mode, {
    LIMIT: 'Limitada',
    MARKET: 'A mercado',
  });
}

export function translateDepositStatus(status?: string) {
  return translateValue(status, {
    PENDING: 'Pendente',
    PROCESSING: 'Em processamento',
    COMPLETED: 'Concluído',
    REJECTED: 'Rejeitado',
    CANCELED: 'Cancelado',
  });
}

export function translateDepositMethod(method?: string) {
  return translateValue(method, {
    PLATFORM: 'Plataforma/Administração',
    BROKER: 'Corretor Virtual',
  });
}

export function translateWithdrawalStatus(status?: string) {
  return translateValue(status, {
    PENDING: 'Pendente',
    PROCESSING: 'Em processamento',
    COMPLETED: 'Concluído',
    REJECTED: 'Rejeitado',
    CANCELED: 'Cancelado',
  });
}

export function translateRole(role?: string) {
  return translateValue(role, {
    USER: 'Usuário',
    DEVELOPER: 'Desenvolvedor',
    ADMIN: 'Admin',
    SUPER_ADMIN: 'Super Admin',
    COIN_CHIEF_ADMIN: 'ADM Chefe da Moeda',
    VIRTUAL_BROKER: 'Corretor virtual',
    BUSINESS_OWNER: 'Dono de projeto',
    AUDITOR: 'Auditor',
  });
}

export function translateTransferType(type?: string) {
  return translateValue(type, {
    ISSUANCE_TO_TREASURY: 'Emissão para tesouraria',
    TREASURY_TO_BROKER: 'Tesouraria para corretor',
    BROKER_TO_USER: 'Corretor para usuário',
    USER_TRADE: 'Negociação entre usuários',
    ADJUSTMENT: 'Ajuste',
  });
}

export function translateBoostSource(source?: string) {
  return translateValue(source, {
    PERSONAL_WALLET: 'Carteira pessoal',
    PROJECT_REVENUE: 'Receita do projeto',
    ADMIN_ADJUSTMENT: 'Ajuste administrativo',
  });
}

export function translateAdminAction(action?: string) {
  return translateValue(action, {
    CREATE_ACCOUNT: 'Cadastro de conta',
    LOGIN: 'Login',
    COIN_ISSUANCE: 'Emissão de RPC',
    TREASURY_TRANSFER_TO_BROKER: 'Envio da tesouraria para corretor',
    TREASURY_TRANSFER_TO_USER: 'Envio da tesouraria para jogador',
    BROKER_TRANSFER_TO_USER: 'Envio do corretor para usuário',
    ADMIN_USER_ROLES_UPDATED: 'Permissões de usuário atualizadas',
    ADMIN_USER_BLOCKED: 'Usuário bloqueado',
    ADMIN_USER_UNBLOCKED: 'Usuário desbloqueado',
    COMPANY_APPROVED: 'Projeto aprovado',
    COMPANY_REJECTED: 'Projeto rejeitado',
    COMPANY_SUSPENDED: 'Projeto suspenso',
    COMPANY_REACTIVATED: 'Projeto reativado',
    COMPANY_CLOSED: 'Projeto encerrado',
    COMPANY_OWNER_CHANGED: 'Dono do projeto alterado',
    COMPANY_INITIAL_OFFER_BUY: 'Compra no lançamento inicial',
    PROJECT_BOOST: 'Impulsão de projeto',
    MARKET_ORDER_CREATE: 'Ordem criada',
    MARKET_ORDER_CANCEL: 'Ordem cancelada',
    MARKET_TRADE_EXECUTED: 'Trade executado',
    WITHDRAWAL_REQUEST_CREATED: 'Saque solicitado',
    WITHDRAWAL_COMPLETED: 'Saque concluído',
    WITHDRAWAL_REJECTED: 'Saque rejeitado',
    DEPOSIT_REQUEST_CREATED: 'Depósito solicitado',
    DEPOSIT_REQUEST_CANCELED_BY_USER: 'Depósito cancelado pelo usuário',
    DEPOSIT_MARKED_PROCESSING: 'Depósito em processamento',
    FIAT_DEPOSIT_COMPLETED: 'Depósito via plataforma concluído',
    BROKER_DEPOSIT_COMPLETED: 'Depósito via corretor concluído',
    DEPOSIT_REJECTED: 'Depósito rejeitado',
  });
}
