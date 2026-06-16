import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function findSeedUser(params: { discord: string; emails: string[] }) {
  return prisma.user.findFirst({
    where: {
      OR: [
        { discord: params.discord },
        ...params.emails.map((email) => ({ email })),
      ],
    },
  });
}

async function upsertSeedUser(params: {
  discord: string;
  gamePhone: string;
  email: string;
  legacyEmails?: string[];
  name: string;
  characterName: string;
  passwordHash: string;
  preservePassword?: boolean;
}) {
  const existing = await findSeedUser({ discord: params.discord, emails: [params.email, ...(params.legacyEmails ?? [])] });

  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: {
          name: params.name,
          characterName: params.characterName,
          discord: params.discord,
          gamePhone: params.gamePhone,
          email: params.email,
          passwordHash: params.preservePassword ? existing.passwordHash : params.passwordHash,
        },
      })
    : await prisma.user.create({
        data: {
          name: params.name,
          characterName: params.characterName,
          discord: params.discord,
          gamePhone: params.gamePhone,
          email: params.email,
          passwordHash: params.passwordHash,
          wallet: { create: {} },
        },
      });

  await prisma.wallet.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id },
  });

  return user;
}

async function seedDemoData(params: {
  userRoleId: string;
  brokerRoleId: string;
}) {
  const { userRoleId, brokerRoleId } = params;

  const demoEmailLegacy = 'jogador@bolsavirtual.local';
  const demoEmail = 'jogador@rpc.exchange.local';

  // usuário demo base (RPC Exchange), reaproveitando conta legada quando existir
  const userDemo = await upsertSeedUser({
    discord: 'jogador_demo',
    gamePhone: '000-001',
    email: demoEmail,
    legacyEmails: [demoEmailLegacy],
    name: 'Jogador Demo',
    characterName: 'Jogador_Demo',
    passwordHash: await bcrypt.hash('Jogador123!', 10),
    preservePassword: true,
  });

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

  const brokerDemo = await upsertSeedUser({
    discord: 'corretor_demo',
    gamePhone: '000-002',
    email: 'corretor@rpc.exchange.local',
    legacyEmails: ['corretor@bolsavirtual.local'],
    name: 'Corretor Demo',
    characterName: 'Corretor_Demo',
    passwordHash: await bcrypt.hash('Corretor123!', 10),
    preservePassword: true,
  });

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

  const superAdminRole = await prisma.role.findUniqueOrThrow({ where: { key: 'SUPER_ADMIN' } });
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { key: 'ADMIN' } });
  const userRole = await prisma.role.findUniqueOrThrow({ where: { key: 'USER' } });

  const coinChiefRole = await prisma.role.findUniqueOrThrow({ where: { key: 'COIN_CHIEF_ADMIN' } });
  const brokerRole = await prisma.role.findUniqueOrThrow({ where: { key: 'VIRTUAL_BROKER' } });

  const adminEmailLegacy = 'admin@bolsavirtual.local';
  const adminEmail = 'admin@rpc.exchange.local';

  const admin = await upsertSeedUser({
    discord: 'admin',
    gamePhone: '000-000',
    email: adminEmail,
    legacyEmails: [adminEmailLegacy],
    name: 'Administrador',
    characterName: 'Admin_RPC',
    passwordHash: await bcrypt.hash('Admin1234!', 10),
    preservePassword: true,
  });

  await prisma.userRole.upsert({ where: { userId_roleId: { userId: admin.id, roleId: superAdminRole.id } }, update: {}, create: { userId: admin.id, roleId: superAdminRole.id } });
  await prisma.userRole.upsert({ where: { userId_roleId: { userId: admin.id, roleId: adminRole.id } }, update: {}, create: { userId: admin.id, roleId: adminRole.id } });
  await prisma.userRole.upsert({ where: { userId_roleId: { userId: admin.id, roleId: coinChiefRole.id } }, update: {}, create: { userId: admin.id, roleId: coinChiefRole.id } });


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
