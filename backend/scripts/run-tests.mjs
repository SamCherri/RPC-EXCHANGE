import { spawnSync } from 'node:child_process';

function run(args, env = process.env) {
  const result = spawnSync('npx', ['tsx', '--test', ...args], { stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['tests/mobile-auth-migration-seed.test.ts']);

if (!process.env.TEST_DATABASE_URL) {
  console.warn('TEST_DATABASE_URL não configurado; testes de integração com banco foram pulados para evitar uso acidental de produção.');
  process.exit(0);
}

run([
  'tests/critical-economic-security.test.ts',
  'tests/security-production.test.ts',
  'tests/rpc-market-simulation.test.ts',
]);
