# ARQUITETURA_RPC_EXCHANGE

## 1) Visão geral

A **RPC Exchange** é uma plataforma de **simulação econômica** com experiência visual de exchange de tokens entre usuários, mantendo escopo totalmente fictício/simulado.

Escopo obrigatório da simulação:
- sem dinheiro real;
- sem cripto real;
- sem blockchain;
- sem saque real;
- sem Pix;
- sem cartão;
- sem gateway de pagamento;
- sem promessa de lucro.

Todo o funcionamento é interno à plataforma e serve apenas para experiência de jogo/simulação.

> Referências como Binance, HollaEx Kit, OpenDAX/Peatio, OpenCEX e OpenDAX BaseApp são **apenas conceituais** (arquitetura, fluxo, telas e módulos), sem cópia direta de código e sempre com verificação de licença.

---

## 2) Stack

- **Frontend:** React + Vite + TypeScript
- **Backend:** Node.js + TypeScript + Fastify
- **Banco de dados:** PostgreSQL
- **ORM:** Prisma
- **Autenticação:** JWT
- **Deploy:** Railway
- **Diretriz de interface:** mobile-first

---

## 3) Módulos principais

### Módulos atuais (núcleo já existente)
- Usuários
- Roles/permissões
- Carteira
- Tesouraria
- Corretores virtuais
- Projetos/Mercados
- Tokens
- Livro de ofertas
- Ordens
- Matching engine
- Trades
- Histórico
- Painel admin

### Módulos desejados/expansão
- Logs administrativos mais avançados
- Gráficos mais completos
- PWA/app instalável

---

## 4) Fluxo econômico oficial

1. Admin cria moeda de simulação (RPC) na tesouraria.
2. Admin vende RPC para corretor dentro do RP.
3. No site, admin envia RPC para corretor.
4. Corretor vende RPC para jogador dentro do RP.
5. No site, corretor envia RPC para usuário.
6. Usuário cria projeto/token e solicita listagem.
7. Admin aprova, rejeita, pausa ou suspende listagens (moderação).
8. Aprovado, o sistema cria mercado no formato **TICKER/RPC**.
9. Usuários negociam tokens no mercado (oferta inicial e mercado secundário).
10. Usuário cria ordens de compra/venda (com taxas de trade).
11. Matching engine executa ordens/trades compatíveis.
12. Toda taxa cobrada é distribuída em 50% plataforma e 50% projeto.
13. Usuário solicita saque no site.
14. Valor é bloqueado em `pendingWithdrawalBalance`.
15. Admin paga o usuário dentro do RP.
16. Admin conclui saque no site (ou rejeita, quando necessário).
17. Na conclusão, o RPC pendente é removido definitivamente do sistema; na rejeição/cancelamento, o valor retorna ao saldo disponível.
18. Carteiras/holdings são atualizadas.
19. Logs e registros operacionais são armazenados (`Transaction`, `CompanyOperation`, `AdminLog`, `FeeDistribution`, `WithdrawalRequest`).

Regra estrutural:
- A plataforma não cria tokens/projetos próprios negociáveis.
- RPC é moeda base operacional e não token criado por usuário.

---


## Fluxo econômico completo desejado

Empresa gera lucro dentro do RP
→ dono compra/recebe R$ fictício no site pelo fluxo normal da economia
→ dono compra RPC no mercado RPC/R$
→ dono usa RPC real já existente para comprar/injetar no token/projeto
→ usuários negociam tokens em oferta inicial ou mercado secundário
→ projeto pode futuramente recomprar, distribuir ou reservar usando saldo rastreável
→ holders ganham por valorização real ou distribuição auditável
→ logs e auditoria acompanham tudo.

Regras de segurança deste fluxo:
- lucro RP externo não vira RPC automática;
- dono/fundador não cria crédito institucional livre;
- injeção de RPC não sobe gráfico sozinha;
- preço só muda por compra executada na oferta inicial ou trade real no mercado secundário;
- não permitir crédito institucional livre sem origem rastreável.

Componentes obrigatórios desse fluxo:
- R$ fictício/site como etapa de entrada;
- mercado RPC/R$;
- Tesouraria RPC;
- corretores/jogadores;
- oferta inicial;
- mercado secundário;
- transferência real de RPC para aporte/injeção;
- caixa institucional rastreável do projeto;
- receita por taxas;
- recompra com RPC existente;
- distribuição para holders;
- reserva de tokens recomprados;
- auditoria;
- Test Mode isolado.

## 5) Fluxo de taxas implementado (fase atual)

1. Existe uma carteira única da plataforma (`PlatformAccount`) para receitas de taxas.
2. Cada empresa ativa possui carteira de receita (`CompanyRevenueAccount`).
3. A carteira da empresa nasce no ato de aprovação administrativa (não na solicitação).
4. A distribuição de taxa usa regra fixa de código: 50% plataforma / 50% empresa.
5. A distribuição gera registro em `FeeDistribution` dentro da mesma transação econômica da operação origem.
6. Retirada da receita da empresa ainda não está implementada.

---

## 6) Regras de segurança

- Não permitir saldo negativo de moeda fictícia.
- Não permitir tokens negativos.
- Toda operação financeira deve ocorrer em transação atômica.
- Toda ação administrativa deve gerar log.
- Admin não pode alterar saldo sem justificativa registrada.
- Rotas administrativas exigem role/permissão adequada.
- Frontend não deve exibir áreas Admin/Corretor para usuários sem permissão.

---

## 7) Matching engine

Regras operacionais da simulação:

- Ordem de compra cruza com a menor ordem de venda compatível.
- Ordem de venda cruza com a maior ordem de compra compatível.
- Execução parcial é permitida quando houver liquidez parcial.
- Cada execução gera registro de trade.
- Atualização de carteiras e holdings ocorre em transação Prisma para consistência.

---

## 8) Interface (diretriz de UX)

- Estratégia **mobile-first**.
- Tela pública limitada a login/cadastro.
- Home logada simples e objetiva.
- Mercados apresentados em cards com pares TICKER/RPC.
- Tela do ativo/projeto focada no token (sem excesso de distrações).
- Gráfico em destaque.
- Botões **Comprar**/**Vender** grandes e claros.
- Livro, ordens e histórico em abas.
- Linguagem simples para usuário comum (evitar jargão técnico quando possível).

---

## 9) PWA

Objetivo da fase de PWA:

- permitir instalar no celular como aplicativo;
- incluir `manifest`;
- incluir `service worker`;
- adicionar botão **"Instalar aplicativo"**;
- manter escopo sem APK e sem publicação em Play Store nesta fase.

## Atualização 2026-04-28 — Ferramentas administrativas avançadas
- Rotas `/api/admin/users*` para gerenciamento de usuários, roles e bloqueio.
- Rotas `/api/admin/tokens*` para criação manual de mercado, pausa, reativação, encerramento e exclusão segura.
- Mercado CLOSED cancela ordens abertas com liberação de saldo/tokens bloqueados e bloqueia novas ordens.

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



### Carteiras econômicas separadas
- Carteira pessoal
- Receita do projeto
- Reserva institucional do projeto
- Reserva de tokens recomprados
- Conta da Exchange

- Fluxo de aporte institucional implementado: fundador usa RPC existente da carteira pessoal para transferir ao caixa institucional do projeto com rastreabilidade e sem impacto direto em preço.


## Atualização 2026-05-04 — Mercado primário reforçado
- Compra da oferta inicial ocorre em transação atômica, com validação de saldo RPC e de disponibilidade da oferta.
- Débito da wallet RPC e consumo da oferta usam atualização condicional para bloquear saldo negativo e oversell concorrente.
- Compra inicial atualiza holding, circulação, preço e market cap, gerando `CompanyOperation` + `Transaction` + `FeeDistribution` quando aplicável.
- Compra inicial não gera `Trade` nem `MarketOrder`; secundário continua responsável por formação de preço via trade real fora da oferta inicial.

## Atualização 2026-05-04 — Mercado secundário seguro (PR 3)
- Ordens LIMIT entram no livro com lock de saldo/tokens sem mover preço.
- Cancelamento libera somente lock remanescente e não altera preço.
- Ordem MARKET executa somente com contraparte real no livro; sem liquidez retorna erro claro.
- `Company.currentPrice` no secundário atualiza somente por `Trade` executado.
- Matching com bloqueio de self-trade e suporte a execução parcial consistente.


## Atualização 2026-05-04 — Caixa institucional rastreável (PR 4)
- Serviço de resumo institucional por projeto com saldo, extrato recente, totais por tipo/origem e inconsistências read-only.
- Consulta por fundador e perfis administrativos de auditoria.
- Endpoint administrativo read-only para varredura de contas institucionais.
- Fluxo de aporte do fundador continua debitando RPC existente na carteira pessoal e creditando o caixa institucional sem alterar preço e sem criar ordens/trades.

## Atualização 2026-05-04 — Recompra institucional (PR 5)
- Introduzido programa de recompra com reserva de orçamento via `ProjectBuybackProgram`.
- Execução percorre ordens SELL reais elegíveis por preço (menor preço primeiro), com proteção básica anti-self-trade do fundador.
- Cada execução gera `Trade`, `ProjectBuybackExecution` e entrada em `ProjectTokenReserveEntry`.
- Reserva mínima de tokens recomprados registrada em `ProjectTokenReserve` (política avançada deixada para PR 6).


## Atualização 2026-05-04 — Reserva institucional de tokens recomprados (PR 6)
- A reserva institucional de recompra foi formalizada com política `HOLD_LOCKED` e bloqueio padrão (`locked = true`).
- Consulta por projeto exibe quantidade reservada, custo total em RPC, custo médio e histórico de entradas por execução/programa.
- Perfis administrativos de auditoria possuem visão read-only consolidada com alertas de inconsistência.
- Sem endpoints de burn, sell, distribute, transfer ou reoffer nesta etapa.


## Atualização 2026-05-04 — PR 7 distribuição auditável para holders
- Distribuição usa apenas RPC existente em `CompanyRevenueAccount`, com débito no ato da criação do programa e sem criação de RPC nova.
- Snapshot de holders elegíveis é gravado de forma imutável no programa, com cálculo proporcional por shares e fundador excluído por padrão (`excludeFounder=true`).
- Execução cria `Transaction` individual por holder, registra pagamentos e marca snapshots como `PAID`, com proteção de reexecução por status.
- Sobra por arredondamento e cancelamento retornam saldo ao caixa institucional, sem impacto em preço, Trade, MarketOrder, supply, reserva e Test Mode.


## Atualização 2026-05-06 — Política da RPC (PR 8)
- Implementado serviço administrativo read-only para consolidar circulação da RPC com fontes econômicas reais do banco.
- Cálculo inclui: wallets RPC reais (rpcAvailable/rpcLocked), tesouraria, corretoras, PlatformAccount, CompanyRevenueAccount e orçamento ativo reservado em recompra.
- Cálculo exclui acumuladores históricos (ex.: BrokerAccount.receivedTotal) para evitar dupla contagem.
- Auditoria econômica read-only reporta inconsistências sem autocorreção automática.

- Saques atuais de WithdrawalRequest são tratados como fluxo fiat/R$ fictício (`fiatWithdrawn`) e não reduzem supply RPC real.

## Atualização 2026-05-06 — Auditoria econômica consolidada (PR 9)
- Camada de auditoria econômica consolidada no backend (`economic-audit-service.ts`) para detecção read-only de inconsistências críticas.
- Exposição por endpoints admin com filtros e resumo por severidade/categoria.
- Governança: acesso restrito a `SUPER_ADMIN`, `COIN_CHIEF_ADMIN`, `AUDITOR` e `ADMIN` (padrão administrativo atual).
- Escopo: detectar e reportar; não corrige saldo, não cria Trade/Order/Transaction, não altera preço/supply/Test Mode.

## Simulador econômico em Test Mode

### O que faz
- Executa simulações isoladas do ciclo R$ fictício → RPC → oferta inicial → secundário → recompra → reserva → distribuição.
- Persiste execução em `TestModeSimulationRun` e trilha detalhada em `TestModeSimulationStep`.
- Gera resumo final com métricas e warnings por cenário.

### O que não faz
- Não altera economia real da plataforma.
- Não cria `Trade` real nem `MarketOrder` real.
- Não altera `Wallet`, `Company`, `RpcMarketState` ou programas econômicos reais.

### Separação de dados
- Dados de simulação ficam em tabelas próprias de Test Mode para evitar mistura de contexto econômico.
- Rotas restritas a perfis administrativos/auditoria com autenticação.

### Interpretação do relatório
- `summary`: métricas agregadas de preço, volume, recompras, reserva e distribuição simuladas.
- `steps`: sequência auditável com estado anterior/posterior e issues de cada etapa.
- `warnings`: alertas de risco (liquidez, self-trade bloqueado, pressão de venda etc.).


## UX funcional e proteção contra erro humano

Componentes introduzidos:
- `ActionButton`: evita duplo clique com `loading` e `disabled` automático em ações sensíveis.
- `EconomicNotice`: aviso padrão sobre natureza fictícia da simulação RP.
- `ImpactPreviewCard`: resumo de antes/depois e impacto estimado.
- `StatusMessage`: feedback padronizado de sucesso/erro/aviso.
- `ConfirmEconomicAction`: confirmação explícita para operações sensíveis (base reutilizável).

Telas impactadas nesta etapa:
- Mercado RPC/R$ (`RpcMarketPage`) com aviso econômico, preview de impacto e mensagens padronizadas.
- Test Mode (`TestModePage`) com aviso explícito de isolamento da economia real.
- Auditoria econômica (`AdminEconomicAlertsPanel`) com linguagem read-only mais clara.

Limitações e pendências:
- Esta etapa não implementa visual premium, gráfico premium nem livro de ordens premium.
- Cobertura dos novos componentes será expandida gradualmente para todos os fluxos sensíveis restantes.


## Design system visual inicial
- Introduzidos tokens visuais globais (cores, radius, shadow, spacing e tipografia base) em `frontend/src/styles.css`.
- Componentes visuais reutilizáveis criados: `PageShell`, `PremiumCard`, `SectionHeader`, `StatusBadge`, `EmptyState`, `LoadingState` e `InfoCallout`, além da evolução de `MetricCard`.
- Objetivo: consistência visual premium inicial, manutenção de mobile-first e reaproveitamento sem alterar lógica econômica.
- Limites desta PR: sem refactor econômico, sem backend/migration, sem gráfico premium avançado e sem livro de ordens premium completo.
