import type { PrismaClient } from '@prisma/client';

export async function resetTestDatabase(prisma: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('resetTestDatabase não pode rodar em produção.');
  }

  if (!process.env.TEST_DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL é obrigatório para reset de banco de teste.');
  }

  await prisma.$transaction([
    prisma.supportTicketMessage.deleteMany(),
    prisma.supportTicket.deleteMany(),
    prisma.feeDistribution.deleteMany(),
    prisma.trade.deleteMany(),
    prisma.marketOrder.deleteMany(),
    prisma.rpcLimitOrder.deleteMany(),
    prisma.rpcExchangeTrade.deleteMany(),
    prisma.rpcMarketState.deleteMany(),

    prisma.companyCapitalFlowEntry.deleteMany(),
    prisma.companyBoostInjection.deleteMany(),
    prisma.companyBoostAccount.deleteMany(),
    prisma.companyRevenueAccount.deleteMany(),
    prisma.companyOperation.deleteMany(),
    prisma.companyHolding.deleteMany(),
    prisma.companyInitialOffer.deleteMany(),

    prisma.coinTransfer.deleteMany(),
    prisma.coinIssuance.deleteMany(),
    prisma.transaction.deleteMany(),
    prisma.withdrawalRequest.deleteMany(),
    prisma.adminLog.deleteMany(),
    prisma.registrationProof.deleteMany(),

    prisma.brokerAccount.deleteMany(),
    prisma.wallet.deleteMany(),
    prisma.userFinancialPermission.deleteMany(),
    prisma.testModeReport.deleteMany(),
    prisma.testModeTrade.deleteMany(),
    prisma.testModeWallet.deleteMany(),

    prisma.userRole.deleteMany(),
    prisma.rolePermission.deleteMany(),

    prisma.company.deleteMany(),
    prisma.user.deleteMany(),
    prisma.permission.deleteMany(),
    prisma.role.deleteMany(),

    prisma.testModeMarketState.deleteMany(),
    prisma.systemModeConfig.deleteMany(),
    prisma.platformAccount.deleteMany(),
    prisma.treasuryAccount.deleteMany(),
  ]);
}
