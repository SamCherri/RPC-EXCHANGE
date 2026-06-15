# <img src="assets/rpc_exchange_icon.png" width="40" height="40" align="center"> RPC Exchange

![RPC Exchange Banner](assets/rpc_exchange_banner.png)

Projeto de **interpretação/simulação** com mercados e tokens virtuais em uma experiência de exchange.

> Ferramenta de interpretação de exchange para RP. Sem dinheiro real, sem cripto real, sem blockchain, sem Pix, sem cartão e sem gateway de pagamento.

## Direção atual do produto

## Fonte de prioridade atual

A priorização oficial está em [docs/ROADMAP_PRIORITARIO.md](docs/ROADMAP_PRIORITARIO.md). Antes de alterar economia, mercado, RPC, projeto, token, admin, simulador ou UX estrutural, leia esse arquivo.

## Fase estratégica atual

A fase estratégica atual é **fechar o ciclo econômico real da RPC Exchange** (caixa institucional, mercado primário correto, recompra real, reserva e distribuição auditável) antes de evoluir para visual premium, gráfico avançado, simulador avançado ou temporadas.


- O app agora usa linguagem visual de **exchange de tokens** (RPC Exchange).
- A moeda base visual da plataforma é **RPC**.
- Os ativos são exibidos como pares de mercado dinâmicos, por exemplo **TOKEN/RPC**, **ABC/RPC** ou **XYZ/RPC**.
- O sistema continua sendo simulação econômica, sem dinheiro real, sem cripto real e sem blockchain.
- Diretriz oficial: [Diretrizes de Produto — RPC Exchange](docs/DIRETRIZES_DE_PRODUTO.md).

## Criação de tokens por usuários

- Tokens/projetos negociáveis são criados pelos próprios usuários da plataforma.
- O usuário cria o projeto/token e envia a solicitação de listagem.
- O admin apenas modera a listagem (aprovar, rejeitar, pausar/suspender).
- A plataforma não cria tokens/projetos próprios negociáveis.
- Cada token aprovado gera um mercado no formato **TICKER/RPC**.
- A RPC é a moeda base operacional da plataforma e **não** é token criado por usuário.

## Banco oficial do projeto

O banco oficial é **PostgreSQL/Postgres** com **Prisma ORM** usando `DATABASE_URL`.

- Provider Prisma: `postgresql`.
- Arquivo: `backend/prisma/schema.prisma`.
- Variável obrigatória: `DATABASE_URL`.

## Estrutura

- `frontend/`: React + Vite + TypeScript (painéis iniciais).
- `frontend/capacitor.config.ts`: configuração do aplicativo Android via Capacitor.
- `backend/`: Fastify + Prisma + TypeScript (API e regras de backend).
- `docs/`: documentação principal da simulação.
- `assets/`: recursos visuais e logotipos da plataforma.

## Documentação técnica

- [Arquitetura da RPC Exchange](docs/ARQUITETURA_BOLSA_RP.md)
- [Auditoria do estado atual](docs/AUDITORIA_ATUAL.md)

## Requisitos

- Node.js 20+
- PostgreSQL 15+

## Variáveis de ambiente

Use `.env.example` como referência.

### Backend

- `NODE_ENV`
- `PORT` (Railway injeta automaticamente em produção)
- `DATABASE_URL` (PostgreSQL)
- `JWT_SECRET`
- `WEB_ORIGIN` (origens permitidas no CORS, separadas por vírgula)

### Frontend

- `VITE_API_URL` (URL pública do backend)

Para o APK Android, `VITE_API_URL` deve ser uma URL pública com HTTPS. O backend
continua hospedado separadamente e não é incluído no APK.

## Aplicativo Android (Capacitor)

O aplicativo Android empacota somente o frontend da RPC Exchange. A API Fastify,
o Prisma e o PostgreSQL continuam online no serviço de backend.

### Configurar a API usada pelo APK

No GitHub:

1. Abra o repositório e clique em **Settings**.
2. Acesse **Secrets and variables > Actions**.
3. Abra a aba **Variables**.
4. Clique em **New repository variable**.
5. Use o nome `VITE_API_URL`.
6. Informe a URL pública HTTPS do backend, sem `/api` no final. Exemplo:
   `https://seu-backend.up.railway.app`.

O build Android falha de propósito se a variável estiver vazia, usar HTTP ou
apontar para `localhost`, evitando distribuir um APK que não consiga acessar a
API.

### Gerar e sincronizar localmente

Com Android Studio/JDK instalados e a URL pública configurada:

```bash
export VITE_API_URL="https://seu-backend.up.railway.app"
npm install
npm run build:android --workspace frontend
cd frontend
npx cap add android
npx cap sync android
```

O comando `npx cap add android` é necessário somente na primeira geração da
plataforma. Para atualizações seguintes, use:

```bash
export VITE_API_URL="https://seu-backend.up.railway.app"
npm run android:sync --workspace frontend
```

### Baixar o APK gerado automaticamente

1. No GitHub, abra a aba **Actions**.
2. Selecione o workflow **Android Debug APK**.
3. Abra a execução mais recente concluída com sucesso.
4. Na seção **Artifacts**, baixe `rpc-exchange-debug-apk`.
5. Extraia o arquivo compactado para obter `app-debug.apk`.

O workflow roda automaticamente em pushes para `main` ou `master` e também pode
ser iniciado pelo botão **Run workflow**. O artifact fica disponível por 30
dias. Esse é um APK de depuração para testes e instalação manual; publicação na
Google Play exige posteriormente assinatura e configuração de uma versão
release.

## Setup local

```bash
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate:dev --workspace backend
npm run prisma:seed
npm run dev
```

## Scripts principais

```bash
npm run install:all         # instala dependências dos workspaces
npm run lint                # lint dos workspaces
npm run typecheck           # validação TypeScript dos workspaces
npm run prisma:generate     # gera Prisma Client (backend)
npm run prisma:migrate      # aplica migrations em produção (backend)
npm run prisma:seed         # popula dados iniciais (backend)
npm run build               # build backend + frontend
npm run start:backend       # sobe backend em produção
```

## Fase implementada atual (estado técnico)

Implementado nesta fase:

1. Solicitação de projetos por usuários autenticados, com validações de percentuais, taxas e ticker único.
2. Limites administrativos fixos no backend (documentados para virar configuração dinâmica futuramente):
   - taxa máxima de compra: 5%;
   - taxa máxima de venda: 5%;
   - oferta pública mínima: 10%;
   - percentual máximo do dono: 90%.
3. Fluxo administrativo de projetos:
   - listar pendentes;
   - aprovar;
   - rejeitar;
   - suspender.
4. Aprovação de projeto gera automaticamente:
   - posição inicial de tokens do dono;
   - estoque da oferta inicial;
   - logs administrativos e operação de auditoria.
5. Compra de tokens do lançamento inicial:
   - cálculo de custo bruto, taxa e custo total;
   - bloqueio por saldo insuficiente;
   - bloqueio por falta de tokens na oferta;
   - atualização de carteira e holdings;
   - registro em `Transaction`, `CompanyOperation` e `AdminLog`.
6. Dashboard do usuário atualizado com holdings e projetos investidos.
7. Livro de ofertas com ordens limitadas de compra e venda entre usuários.
8. Ordens a mercado (compra e venda) com execução parcial e proteção de slippage.
9. Matching engine simples:
   - compra limitada cruza menor preço vendedor (FIFO por empate);
   - venda limitada cruza maior preço comprador (FIFO por empate);
   - ordens a mercado consomem livro respeitando tolerância.
10. Bloqueio de recursos:
    - compra limitada bloqueia saldo em carteira (`availableBalance -> lockedBalance`);
    - venda limitada bloqueia tokens (retiradas da holding até execução/cancelamento).
11. Cancelamento de ordem limitada liberando saldo/tokens bloqueados.
12. Registro de trades na tabela `Trade`.
13. Atualização de preço atual do projeto pelo último trade executado.
14. Registro de auditoria (`Transaction`, `CompanyOperation`, `AdminLog`) no fluxo de negociação.
15. Distribuição de taxas implementada com regra fixa 50/50:
    - 50% da taxa para carteira da plataforma (`PlatformAccount`);
    - 50% da taxa para carteira de receita do projeto (`CompanyRevenueAccount`).
16. Carteira de receita do projeto criada automaticamente na aprovação do projeto.
17. Registro detalhado de distribuição em `FeeDistribution` para oferta inicial e trades de mercado.
18. Endpoints admin para consulta da receita da plataforma e dos projetos.
19. Saque manual de RPC com fluxo de pendência:
    - usuário solicita saque;
    - saldo sai de `availableBalance` e vai para `pendingWithdrawalBalance`;
    - admin marca processamento/conclui/rejeita;
    - conclusão remove RPC pendente definitivamente;
    - rejeição ou cancelamento devolve RPC para saldo disponível.
20. Nova tabela `WithdrawalRequest` com status:
    - `PENDING`, `PROCESSING`, `COMPLETED`, `REJECTED`, `CANCELED`.
21. Novo campo em carteira:
    - `pendingWithdrawalBalance`.

## Endpoints principais do estado atual

Mercados/Projetos:
- `POST /api/companies/request`
- `GET /api/companies`
- `GET /api/companies/:id`
- `GET /api/admin/companies/pending`
- `POST /api/admin/companies/:id/approve`
- `POST /api/admin/companies/:id/reject`
- `POST /api/admin/companies/:id/suspend`

Tokens e carteira:
- `POST /api/companies/:id/buy-initial-offer`
- `GET /api/me/holdings`
- `GET /api/withdrawals/me`
- `POST /api/withdrawals`
- `POST /api/withdrawals/:id/cancel`

Mercado secundário:
- `POST /api/market/orders` (ordem limitada BUY/SELL)
- `GET /api/market/orders/me`
- `GET /api/market/companies/:companyId/order-book`
- `POST /api/market/orders/:id/cancel`
- `POST /api/market/companies/:companyId/buy-market`
- `POST /api/market/companies/:companyId/sell-market`
- `GET /api/market/companies/:companyId/trades`

Admin (taxas):
- `GET /api/admin/platform-account`
- `GET /api/admin/company-revenue-accounts`
- `GET /api/admin/withdrawals`
- `POST /api/admin/withdrawals/:id/mark-processing`
- `POST /api/admin/withdrawals/:id/complete`
- `POST /api/admin/withdrawals/:id/reject`

## Observações importantes da simulação

- Este projeto é exclusivamente uma simulação/interpretação fictícia para RP.
- Não há dinheiro real, criptoativo real, blockchain, Pix, cartão, gateway de pagamento, investimento real ou promessa de lucro real.
- Não foi implementado nesta fase:
  - retirada de receita do projeto;
  - dividendos/reinvestimento;
  - configuração dinâmica de percentual de taxa;
  - gráfico candlestick.

- Taxas de compra e venda são sempre fictícias e divididas em 50% plataforma / 50% projeto.
- A carteira do projeto nasce apenas na aprovação administrativa do projeto.
- Retirada da receita do projeto ainda não foi implementada nesta fase.

## Deploy no Railway

Passo a passo simples para quem não é técnico:

### 1) Criar o projeto

1. Entre no Railway e clique em **New Project**.
2. Conecte este repositório (`SamCherri/Uzumaki-Interprise`).

### 2) Criar serviço PostgreSQL

1. Dentro do projeto, clique em **Add Service**.
2. Escolha **Database > PostgreSQL**.
3. O Railway cria automaticamente a variável `DATABASE_URL` do Postgres.

### 3) Criar serviço Backend

1. Clique em **Add Service > GitHub Repo** e selecione este repositório.
2. Configure **Root Directory** para `backend`.
3. Configure os comandos:
   - **Build Command:** `npm install && npm run prisma:generate && npm run build`
   - **Start Command:** `npm run start`
4. Variáveis do backend:
   - `DATABASE_URL` = valor do Postgres (copiar/colar da aba Variables ou Reference Variable)
   - `JWT_SECRET` = segredo forte
   - `WEB_ORIGIN` = URL pública do frontend (ex.: `https://seu-frontend.up.railway.app`)
   - `PORT` = não precisa fixar; Railway injeta automaticamente

### 4) Criar serviço Frontend

1. Clique em **Add Service > GitHub Repo**.
2. Configure **Root Directory** para `frontend`.
3. Comandos:
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm run preview -- --port $PORT`
4. Variável do frontend:
   - `VITE_API_URL` = URL pública do backend (ex.: `https://seu-backend.up.railway.app`)

### 5) Ajustar CORS (backend)

No backend, `WEB_ORIGIN` controla quem pode acessar a API. Se tiver mais de uma origem, use vírgula.

Exemplo:

```env
WEB_ORIGIN="https://seu-frontend.up.railway.app,https://www.seudominio.com"
```

### 6) Rodar migration e seed

No backend em produção, rode **separadamente**:

```bash
npm run prisma:migrate
```

Depois, execute o seed **apenas uma vez no bootstrap inicial**:

```bash
npm run prisma:seed
```

### 7) Validar funcionamento

1. Abrir frontend.
2. Cadastrar usuário.
3. Fazer login.
4. Solicitar projeto ou comprar tokens do projeto demo.
5. Confirmar que backend responde em `/health`.

## Observações finais

- Não commitar `.env` real com segredos.
- Em produção, preferir variáveis no painel do Railway.
- Se `npm install` falhar por bloqueio externo (ex.: erro 403 de registry), registrar o incidente na PR.

## Admin avançado (RPC Exchange)

- Novo painel admin em abas: Visão geral, Usuários, Corretores, Tokens/Mercados, Saques, Tesouraria, Receitas e Logs.
- Gestão de usuários: busca, bloqueio/desbloqueio e edição de roles (USER, VIRTUAL_BROKER, BUSINESS_OWNER, ADMIN e SUPER_ADMIN com proteção).
- Gestão de mercados: criação manual de token, troca de responsável, pausar, reativar, encerrar e exclusão definitiva segura.
- Encerramento é o fluxo recomendado para mercados com histórico econômico.
- Exclusão definitiva só é permitida sem histórico econômico.
- Todas as ações administrativas geram AdminLog.

## Auditoria e Relatórios Administrativos

- Implementado painel de Auditoria avançada (logs, transações, transferências, saques, ordens e trades) somente leitura.
- Implementado painel de Relatórios com visão geral financeira, conta da plataforma e receitas por projeto/token.
- Filtros básicos: busca, status/tipo (quando aplicável), período e paginação (padrão 20, máximo 100).
- Segurança: acesso restrito a ADMIN, SUPER_ADMIN e COIN_CHIEF_ADMIN.

### Implementado
- Auditoria avançada.
- Relatórios administrativos.
- Histórico de transferências.
- Histórico de transações.
- Histórico de saques.
- Histórico de ordens.
- Histórico de trades.

### Pendente
- Exportação CSV/PDF.
- Filtros avançados por intervalo com calendário.
- Gráficos administrativos.
- Relatório por corretor.
- Relatório por usuário.
- Notificações.


## Nota sobre mecânicas legadas
- Referências antigas sobre “boost” ou “injeção” como mecanismo de subir preço diretamente devem ser tratadas como **legado/risco econômico**.
- A diretriz prioritária atual é: preço de mercado secundário só muda por trade real e recompra deve executar contra ordens reais.
- Veja a decisão oficial em `docs/ROADMAP_PRIORITARIO.md`.
