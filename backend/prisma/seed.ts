import { Prisma, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

function normalizeSeedDiscord(discordId: string) {
  return discordId.trim().replace(/^@+/, '').replace(/\s+/g, '').toLowerCase();
}

function isTrustedPlatformOwnerCandidate(user: { approvalStatus: string; roles: Array<{ role: { key: string } }> }) {
  const trustedBootstrapRoles = new Set(['SUPER_ADMIN', 'ADMIN', 'COIN_CHIEF_ADMIN']);
  return user.approvalStatus === 'APPROVED' && user.roles.some((item) => trustedBootstrapRoles.has(item.role.key));
}

async function fillMissingDiscordId(userId: string, discordId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { discordId: true } });
  if (!user || user.discordId) return;
  await prisma.user.update({ where: { id: userId }, data: { discordId: normalizeSeedDiscord(discordId) } });
}

async function seedDemoData(params: {
  userRoleId: string;
  brokerRoleId: string;
}) {
  const { userRoleId, brokerRoleId } = params;

  const demoEmailLegacy = 'jogador@bolsavirtual.local';
  const demoEmail = 'jogador@rpc.exchange.local';
  const demoRpc = await prisma.user.findUnique({ where: { email: demoEmail } });
  const demoLegacy = await prisma.user.findUnique({ where: { email: demoEmailLegacy } });

  // usuário demo base (RPC Exchange), reaproveitando conta legada quando existir
  const userDemo = demoRpc
    ? demoRpc
    : demoLegacy
      ? await prisma.user.update({
          where: { id: demoLegacy.id },
          data: {
            email: demoEmail,
            name: demoLegacy.name || 'Jogador Demo',
            discordId: demoLegacy.discordId ? normalizeSeedDiscord(demoLegacy.discordId) : 'jogador-demo',
          },
        })
      : await prisma.user.upsert({
          where: { email: demoEmail },
          update: {},
          create: {
            name: 'Jogador Demo',
            email: demoEmail,
            discordId: 'jogador-demo',
            passwordHash: await bcrypt.hash('Jogador123!', 10),
            wallet: { create: {} },
          },
        });

  await fillMissingDiscordId(userDemo.id, demoLegacy?.discordId ?? 'jogador-demo');

  await prisma.wallet.upsert({
    where: { userId: userDemo.id },
    update: {},
    create: { userId: userDemo.id },
  });

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: userDemo.id, roleId: userRoleId } },
    update: {},
    create: { userId: userDemo.id, roleId: userRoleId },
  });

  const companyDemo = await prisma.company.upsert({
    where: { ticker: 'DEMO3' },
    update: {},
    create: {
      name: 'Token Demo',
      ticker: 'DEMO3',
      description: 'Projeto demo para validar lançamento inicial de tokens.',
      sector: 'Tecnologia',
      founderUserId: userDemo.id,
      status: 'ACTIVE',
      totalShares: 100000,
      circulatingShares: 0,
      ownerSharePercent: 40,
      publicOfferPercent: 60,
      ownerShares: 40000,
      publicOfferShares: 60000,
      availableOfferShares: 60000,
      initialPrice: 1,
      currentPrice: 1,
      buyFeePercent: 1,
      sellFeePercent: 1,
      fictitiousMarketCap: 100000,
      approvedAt: new Date(),
    },
  });

  await prisma.companyHolding.upsert({
    where: { userId_companyId: { userId: userDemo.id, companyId: companyDemo.id } },
    update: {},
    create: {
      userId: userDemo.id,
      companyId: companyDemo.id,
      shares: 40000,
      averageBuyPrice: 1,
      estimatedValue: 40000,
    },
  });

  await prisma.companyInitialOffer.upsert({
    where: { companyId: companyDemo.id },
    update: {},
    create: {
      companyId: companyDemo.id,
      totalShares: 60000,
      availableShares: 60000,
    },
  });

  await prisma.companyRevenueAccount.upsert({
    where: { companyId: companyDemo.id },
    update: {},
    create: { companyId: companyDemo.id },
  });

  const brokerDemo = await prisma.user.upsert({
    where: { email: 'corretor@rpc.exchange.local' },
    update: {},
    create: {
      name: 'Corretor Demo',
      email: 'corretor@rpc.exchange.local',
      discordId: 'corretor-demo',
      passwordHash: await bcrypt.hash('Corretor123!', 10),
      wallet: { create: {} },
    },
  });

  await fillMissingDiscordId(brokerDemo.id, 'corretor-demo');

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: brokerDemo.id, roleId: brokerRoleId } },
    update: {},
    create: { userId: brokerDemo.id, roleId: brokerRoleId },
  });

  await prisma.brokerAccount.upsert({
    where: { userId: brokerDemo.id },
    update: {},
    create: { userId: brokerDemo.id },
  });
}

async function main() {
  const roleKeys = [
    ['USER', 'Usuário comum'],
    ['BUSINESS_OWNER', 'Empresário'],
    ['VIRTUAL_BROKER', 'Corretor virtual'],
    ['AUDITOR', 'Auditor'],
    ['ADMIN', 'Administrador'],
    ['COIN_CHIEF_ADMIN', 'ADM Chefe da Moeda'],
    ['SUPER_ADMIN', 'Super Admin'],
    ['DEVELOPER', 'Desenvolvedor'],
  ];

  for (const [key, name] of roleKeys) {
    await prisma.role.upsert({ where: { key }, update: {}, create: { key, name } });
  }

  const permissionKeys = [
    'auth.login',
    'auth.register',
    'wallet.read',
    'company.create',
    'company.approve',
    'coin.issue',
    'coin.transfer.treasury_to_broker',
    'coin.transfer.broker_to_user',
    'admin.logs.read',
    'admin.dashboard.read',
  ];

  for (const key of permissionKeys) {
    await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
  }

  const developerRole = await prisma.role.findUniqueOrThrow({ where: { key: 'DEVELOPER' } });
  const superAdminRole = await prisma.role.findUniqueOrThrow({ where: { key: 'SUPER_ADMIN' } });
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { key: 'ADMIN' } });
  const userRole = await prisma.role.findUniqueOrThrow({ where: { key: 'USER' } });

  const coinChiefRole = await prisma.role.findUniqueOrThrow({ where: { key: 'COIN_CHIEF_ADMIN' } });
  const brokerRole = await prisma.role.findUniqueOrThrow({ where: { key: 'VIRTUAL_BROKER' } });

  const adminEmailLegacy = 'admin@bolsavirtual.local';
  const adminEmail = 'admin@rpc.exchange.local';
  const passwordHash = await bcrypt.hash('Admin1234!', 10);

  const adminLegacy = await prisma.user.findUnique({ where: { email: adminEmailLegacy } });

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      name: adminLegacy?.name ?? 'Super Admin Inicial',
      email: adminEmail,
      discordId: adminLegacy?.discordId ? normalizeSeedDiscord(adminLegacy.discordId) : 'admin-rpc',
      passwordHash,
      wallet: { create: {} },
    },
  });

  await fillMissingDiscordId(admin.id, adminLegacy?.discordId ?? 'admin-rpc');

  await prisma.userRole.upsert({ where: { userId_roleId: { userId: admin.id, roleId: superAdminRole.id } }, update: {}, create: { userId: admin.id, roleId: superAdminRole.id } });
  await prisma.userRole.upsert({ where: { userId_roleId: { userId: admin.id, roleId: adminRole.id } }, update: {}, create: { userId: admin.id, roleId: adminRole.id } });
  await prisma.userRole.upsert({ where: { userId_roleId: { userId: admin.id, roleId: coinChiefRole.id } }, update: {}, create: { userId: admin.id, roleId: coinChiefRole.id } });

  const ownerDiscordId = process.env.PLATFORM_OWNER_DISCORD_ID ? normalizeSeedDiscord(process.env.PLATFORM_OWNER_DISCORD_ID) : '';
  const ownerEmail = process.env.PLATFORM_OWNER_EMAIL?.trim().toLowerCase() ?? '';
  if (ownerDiscordId || ownerEmail) {
    const owner = await prisma.user.findFirst({
      where: ownerDiscordId
        ? { discordId: { equals: ownerDiscordId, mode: 'insensitive' } }
        : { email: { equals: ownerEmail, mode: 'insensitive' } },
      include: { roles: { include: { role: true } } },
    });

    if (!owner) {
      console.warn('[seed] PLATFORM_OWNER configurado, mas nenhum usuário correspondente foi encontrado. Nenhum DEVELOPER foi atribuído.');
    } else if (!isTrustedPlatformOwnerCandidate(owner)) {
      console.warn('[seed] PLATFORM_OWNER corresponde a uma conta sem aprovação e role administrativa previamente confiável. Nenhum DEVELOPER foi atribuído.');
    } else {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.wallet.upsert({ where: { userId: owner.id }, update: {}, create: { userId: owner.id } });
        const requiredOwnerRoles = [developerRole, superAdminRole, adminRole, coinChiefRole, userRole];
        for (const role of requiredOwnerRoles) {
          await tx.userRole.upsert({
            where: { userId_roleId: { userId: owner.id, roleId: role.id } },
            update: {},
            create: { userId: owner.id, roleId: role.id },
          });
        }
        await tx.userRole.deleteMany({ where: { roleId: developerRole.id, userId: { not: owner.id } } });
        await tx.adminLog.create({
          data: {
            userId: owner.id,
            action: 'DEVELOPER_BOOTSTRAP_ASSIGNED',
            entity: `User:${owner.id}`,
            current: JSON.stringify({ roles: requiredOwnerRoles.map((role) => role.key), ownerDiscordId: ownerDiscordId || null, ownerEmail: ownerEmail || null }),
            reason: 'Bootstrap seguro do dono técnico via variável de ambiente.',
          },
        });
      });
      console.log('[seed] DEVELOPER atribuído ao dono configurado e removido de qualquer outro usuário.');
    }
  } else {
    console.log('[seed] PLATFORM_OWNER_DISCORD_ID/PLATFORM_OWNER_EMAIL não configurado; nenhum usuário foi promovido a DEVELOPER.');
  }

  const platformAccount = await prisma.platformAccount.findFirst();
  if (!platformAccount) {
    await prisma.platformAccount.create({ data: {} });
  }

  const treasuryExists = await prisma.treasuryAccount.findFirst();
  if (!treasuryExists) {
    await prisma.treasuryAccount.create({ data: {} });
  }

  const activeCompanies = await prisma.company.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true },
  });

  for (const company of activeCompanies) {
    await prisma.companyRevenueAccount.upsert({
      where: { companyId: company.id },
      update: {},
      create: { companyId: company.id },
    });
  }

  if (process.env.SEED_DEMO_DATA === 'true') {
    console.log('Seed demo habilitado: criando dados de demonstração.');
    await seedDemoData({
      userRoleId: userRole.id,
      brokerRoleId: brokerRole.id,
    });
  } else {
    console.log('Seed demo desabilitado: criando apenas dados essenciais.');
  }
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
