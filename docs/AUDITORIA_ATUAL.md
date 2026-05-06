# AUDITORIA_ATUAL

Auditoria consolidada do estado atual da **RPC Exchange**, mantendo o projeto existente (sem recriação do zero).

## Estado atual implementado

- ✅ fluxo mobile;
- ✅ PWA (manifest + service worker), quando habilitado no frontend;
- ✅ interface moderna nas telas principais já entregues;
- ✅ controle visual por perfil (Admin/Corretor/Usuário);
- ✅ autenticação, carteira, ordens, livro de ofertas, matching engine e histórico;
- ✅ carteiras de taxa (`PlatformAccount` e `CompanyRevenueAccount`) com distribuição 50/50 registrada em `FeeDistribution`;
- ✅ módulo de saque manual (`WithdrawalRequest`) com saldo pendente em carteira e decisão administrativa (processar/concluir/rejeitar).

## Histórico técnico/auditoria acumulada

## 1) Parcial e pendências históricas

- ✅ revisão final de nomenclatura pública para RPC Exchange;
- ⚠️ depósito por solicitação direta de usuário ainda não implementado (entrada segue por Admin/Corretor);
- ⚠️ painel admin avançado;
- ⚠️ gráficos avançados (períodos, volume e leitura mais rica);
- ⚠️ ranking de mercados;
- ⚠️ carteira da plataforma (visão administrativa expandida);
- ⚠️ uso/retirada da receita dos projetos;
- ⚠️ possível renomeação interna futura de Company/Shares para Project/Token.

## 2) Próximos passos recomendados (histórico)

- ✅ limpeza de termos antigos no frontend;
- revisar tela de criação para usar "Criar token" e "Solicitar listagem";
- revisar mercados para reforçar pares dinâmicos `TICKER/RPC` e evitar pares fixos/oficiais;
- ✅ linguagem admin como moderação de listagens;
- validar que admin não aparece como criador de token/projeto.

## 3) Implementado em 2026-04-28

- Gestão de usuários e roles via admin.
- Gestão de tokens/mercados via admin.
- Criação manual de token/projeto pelo admin.
- Pausa, reativação e encerramento de mercado com auditoria.
- Exclusão definitiva segura somente sem histórico econômico.

## 4) Auditoria e Relatórios Administrativos

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

## 5) Atualização 2026-04-29 — Impulsão definitiva

- Implementado no código/documentado historicamente: reserva de boost por projeto, histórico de injeções, fonte por carteira pessoal/receita/ajuste admin e logs de auditoria.
- Situação atual de governança: boost/injeção direta continua como **histórico/legado** e risco econômico frente ao roadmap econômico novo.
- Diretriz estratégica atual: **não é prioridade evoluir boost para subir preço diretamente**; a prioridade é fluxo R$ → RPC → token/projeto, recompra real, reserva e distribuição auditável (se mantida).

## 6) Atualização 2026-04-29 — Segurança econômica no matching multi-fill

- **Severidade:** CRÍTICO.
- **Risco identificado:** inconsistência de saldo/bloqueio quando uma ordem executa em múltiplos fills no mesmo loop de matching, por uso de snapshots antigos de wallet/ordem.
- **Correção aplicada:** revisão completa de `runMatching` para recarregar estado atual da ordem taker a cada fill, debitar `availableBalance`/`lockedBalance` com `updateMany` condicionado (`gte`) e `increment/decrement` atômico, validar bloqueios negativos e interromper com erro claro em inconsistência.
- **Proteções garantidas:** sem `availableBalance` negativo, sem `lockedBalance` negativo, sem `lockedCash` negativo, sem `lockedShares` negativo e reembolso consistente da sobra em ordem limite de compra.
- **Regra econômica preservada:** sem alteração na taxa 50/50 e sem alteração da fórmula de preço/matching econômico.

## 7) Fluxos de distribuição de RPC

Fluxo normal:
Tesouraria → Corretor → Jogador

Fluxo administrativo:
Tesouraria → Jogador, com justificativa obrigatória e auditoria

Regras:
- Toda emissão de RPC precisa de motivo.
- Todo envio da tesouraria precisa de motivo.
- Depósito direto ADM → jogador só deve ser usado para evento, correção, premiação ou ajuste administrativo.
- Toda ação deve gerar AdminLog.
- Operações financeiras devem registrar Transaction quando impactarem carteira de usuário.

## 8) Visibilidade pública de projetos desligados

Regras:
- Rotas públicas de mercado só aceitam projetos `ACTIVE`.
- Projetos `SUSPENDED`, `CLOSED`, `REJECTED`, `BANKRUPT` e `PENDING` ficam ocultos das telas comuns.
- Histórico permanece preservado no banco.
- Admin consulta histórico por auditoria e relatórios, não por rotas públicas.
- Esta regra evita que usuários acessem projetos desligados diretamente pelo ID.

## 9) Feedback de preço na compra inicial

Regras:
- Compra no lançamento inicial altera `Company.currentPrice`.
- Compra no lançamento inicial não cria `Trade`.
- A API retorna `priceBefore`, `priceAfter` e `priceIncrease`.
- O frontend exibe preço antes/depois para evitar confusão visual.
- O gráfico continua usando `initialPrice`, `trades` e `currentPrice`.

## 10) Seed de produção e seed demo

Regras:
- Seed padrão cria apenas roles, permissões, admin inicial e contas essenciais.
- Dados demo só são criados com `SEED_DEMO_DATA=true`.
- Produção não deve criar usuários demo nem token DEMO3 automaticamente.
- Para ambiente de testes/desenvolvimento, usar `npm run prisma:seed:demo --workspace backend`.
- Em produção/Railway, usar `npm run prisma:seed --workspace backend`, se necessário.

## 11) Modais administrativos

Regras:
- Ações administrativas sensíveis não devem usar `window.prompt`.
- Suspender, reativar, encerrar e trocar dono devem usar formulário controlado.
- Motivo deve ser obrigatório quando a ação exigir auditoria.
- Modais devem mostrar erro sem perder dados digitados.
- A UX deve funcionar bem no mobile.

## 12) Retirada auditada do lucro da Exchange

Regras:
- A conta da Exchange acumula taxas da plataforma.
- SUPER_ADMIN e COIN_CHIEF_ADMIN podem transferir saldo da PlatformAccount para carteira administrativa.
- Toda retirada exige motivo.
- Toda retirada gera Transaction e AdminLog.
- O saldo é fictício/RP.
- Não existe dinheiro real, Pix, gateway, blockchain ou saque real.
- A taxa 50/50 não é alterada por este fluxo.

## 13) Sincronização de usuário atual

- Cadastro e login normalizam e-mail com `trim().toLowerCase()`.
- `GET /auth/me` retorna dados atuais do usuário e roles vindas do banco.
- O frontend deve usar `/auth/me` como fonte principal de permissões visuais.
- JWT continua servindo para autenticação, mas roles antigas não devem ser a única fonte visual.
- Alteração de cargos pode exigir recarregamento da tela se não houver atualização em tempo real.

## 14) Auditoria de transações por usuário

Regras:
- Filtros por userId devem ser aplicados antes da paginação.
- A contagem total deve refletir os filtros reais.
- A rota não deve filtrar items em memória depois da paginação.
- Se userId e walletId forem enviados juntos, a wallet precisa pertencer ao usuário.
- Relatórios da plataforma devem expor totalWithdrawn quando disponível.

## 15) Relatórios por usuário e corretor

Regras:
- Relatório por usuário consolida wallet, transações, transferências, saques, ordens e holdings.
- Relatório por corretor consolida BrokerAccount e transferências de RPC.
- Filtros from/to devem ser aplicados antes dos cálculos agregados.
- Relatórios administrativos não alteram saldos nem regras econômicas.
- Nenhum dado sensível como passwordHash deve ser exposto.

## 16) Exportação CSV administrativa

- Exportações CSV são somente leitura.
- Exportações não alteram saldos, ordens, saques ou taxas.
- Exportações respeitam filtros enviados.
- Exportações são limitadas a 5000 registros por tipo para evitar arquivos gigantes.
- Relatórios por usuário e corretor exigem userId.
- CSV não expõe passwordHash nem dados sensíveis desnecessários.

## 17) Testes automatizados críticos

Regras:
- Testes críticos cobrem matching multi-fill, exportação CSV/permissões, compra inicial (com ajuste de preço sem Trade), tesouraria→corretor→jogador, depósito ADM direto em jogador, retirada do lucro da Exchange e bloqueio de rotas públicas para projeto desligado.
- Testes de integração devem usar `TEST_DATABASE_URL`.
- Testes nunca devem rodar contra banco de produção.
- Nenhuma regra econômica deve ser alterada apenas para facilitar teste.
- Matching multi-fill deve continuar protegido contra saldos negativos.

## 18) Como rodar testes críticos pelo GitHub Actions

1. No GitHub do repositório, abra **Settings > Secrets and variables > Actions**.
2. Crie o secret **`TEST_DATABASE_URL`** com a URL de um **banco de teste** (nunca produção).
3. Vá para a aba **Actions**.
4. Selecione o workflow **Backend Critical Tests**.
5. Clique em **Run workflow** para executar manualmente.
6. Abra os logs para validar `prisma generate`, `migrate deploy` e os testes críticos.

Regras de segurança:
- Nunca usar banco de produção nos testes.
- O workflow falha com mensagem clara se `TEST_DATABASE_URL` não estiver configurado.
- O workflow roda somente manualmente (`workflow_dispatch`) para evitar execução acidental.

## 19) Mercado mobile-first

Regras:
- Tela de mercado deve priorizar uso em celular.
- Gráfico deve melhorar leitura de pequenas variações sem alterar valores reais.
- Livro de ofertas deve mostrar compra/venda de forma clara.
- Compra/venda devem exibir estimativas de total e taxa antes da ação.
- Estados vazios e erros devem ser amigáveis.
- Nenhuma regra econômica deve ser alterada pelo frontend.

## Decisões legadas

- Referências e mecânicas de boost/injeção com efeito direto de preço são tratadas como **legado/risco econômico**.
- Essas referências permanecem como histórico técnico e não como direção prioritária atual.

## Nova prioridade econômica

A prioridade oficial atual é fechar o ciclo econômico real da Exchange, nesta ordem:
1. Fluxo de capital R$ → RPC → token/projeto.
2. Mercado primário correto.
3. Mercado secundário seguro.
4. Caixa institucional rastreável do projeto.
5. Programa de recompra com RPC existente.
6. Reserva de tokens recomprados.
7. Distribuição para holders, se mantida.
8. Política da RPC.
9. Auditoria econômica.
10. Simulador do ciclo completo.
11. UX funcional.
12. Visual premium.

Fonte oficial: `docs/ROADMAP_PRIORITARIO.md`.


## Atualização 2026-05-03 — PR 1 fluxo de capital
- Implementado aporte de RPC da carteira do fundador para o caixa institucional via `CompanyRevenueAccount` com histórico em `CompanyCapitalFlowEntry`.
- Aporte não altera preço, não cria Trade e não cria MarketOrder.


## Atualização 2026-05-04 — Mercado primário (PR 2)
- Compra inicial usa apenas RPC já existente na carteira do comprador com débito atômico condicionado a saldo.
- Oferta inicial é consumida com proteção anti-oversell por atualização atômica condicionada a disponibilidade.
- Compra executada pode mover preço (`priceBefore` -> `priceAfter`), mas oferta parada não move preço.
- Compra inicial gera `CompanyOperation`, `Transaction` e `FeeDistribution` (quando taxa > 0).
- Compra inicial não cria `Trade` e não cria `MarketOrder`.
- Fluxo não altera Test Mode, supply da RPC, matching engine do secundário ou boost legado.

## Atualização 2026-05-04 — PR 3 mercado secundário seguro
- Ordem criada no secundário não altera `Company.currentPrice`.
- Ordem cancelada no secundário não altera `Company.currentPrice`.
- `Company.currentPrice` no secundário só muda após `Trade` real executado.
- Self-trade bloqueado no matching.
- Locks de RPC/tokens reforçados para criação/cancelamento/execução parcial.
- Auditoria de execução parcial e consistência de locks reforçada em testes críticos.


## Atualização 2026-05-04 — PR 4 caixa institucional rastreável
- Caixa institucional separado e consultável por projeto via `CompanyRevenueAccount` + `CompanyCapitalFlowEntry`.
- Entradas permitidas reforçadas: aporte real da carteira RPC do fundador e receitas/taxas já rastreadas.
- Entradas proibidas mantidas: crédito livre sem origem, lucro RP externo virando RPC automático.
- Motivo obrigatório e trilha de auditoria mantidos no aporte do fundador.
- Sem impacto em preço/trade/order/supply.

## Atualização 2026-05-04 — PR 5 recompra institucional
- Recompra usa somente RPC institucional já existente em `CompanyRevenueAccount`.
- Recompra executa apenas contra ordens SELL reais com `Trade` registrado.
- `Company.currentPrice` só muda no ato da execução real.
- Saldo não utilizado retorna ao caixa institucional no cancelamento.
- Tokens recomprados vão para `ProjectTokenReserve`, não para carteira pessoal do fundador.

- Nesta PR 5, execução de recompra institucional está configurada como **isenta de taxa de trade** (buyFee/sellFee = 0), com política de taxas podendo evoluir em PR futuro auditado.

## Atualização 2026-05-04 — PR 6 política da reserva de recompra
- Tokens recomprados permanecem em `ProjectTokenReserve` institucional e não são creditados em `CompanyHolding` pessoal do fundador.
- Política padrão da reserva definida como `HOLD_LOCKED`, com tokens bloqueados para uso futuro governado.
- Entradas da reserva continuam vinculadas a `ProjectBuybackProgram` e `ProjectBuybackExecution`.
- Sem queima, distribuição, reoferta, criação de ordem, criação de trade adicional ou alteração de supply/preço fora da execução real de recompra.
- Auditoria read-only adicionada para monitorar inconsistências de reserva sem autocorreção.


## Atualização 2026-05-04 — PR 7 distribuição auditável para holders
- Distribuição usa apenas RPC existente em `CompanyRevenueAccount`, com débito no ato da criação do programa e sem criação de RPC nova.
- Snapshot de holders elegíveis é gravado de forma imutável no programa, com cálculo proporcional por shares e fundador excluído por padrão (`excludeFounder=true`).
- Execução cria `Transaction` individual por holder, registra pagamentos e marca snapshots como `PAID`, com proteção de reexecução por status.
- Sobra por arredondamento e cancelamento retornam saldo ao caixa institucional, sem impacto em preço, Trade, MarketOrder, supply, reserva e Test Mode.

- Na PR 7, fundador permanece sempre excluído nesta etapa; tentativa de incluir founder (`excludeFounder=false`) é bloqueada com erro 400.
- Snapshots sem pagamento elegível (valor <= 0 ou wallet ausente) são marcados como `SKIPPED`, evitando `COMPLETED` com pendências `PENDING`.


## Atualização 2026-05-06 — PR 8 Política de supply da RPC
- RPC reafirmada como moeda fictícia interna (sem dinheiro real, Pix, cartão, gateway, blockchain ou saque real).
- Adicionado resumo read-only de supply/circulação com rastreio de rpcAvailable/rpcLocked das carteiras, tesouraria, corretoras, conta da exchange, caixa institucional e reserva ativa de recompra.
- Auditoria read-only adicionada para detectar inconsistências de supply/circulação e metadados obrigatórios de emissão/transferência.
- Test Mode permanece isolado e não entra no cálculo da RPC real.

- Saques atuais de WithdrawalRequest são tratados como fluxo fiat/R$ fictício (`fiatWithdrawn`) e não reduzem supply RPC real.

## Atualização 2026-05-06 — PR 9 auditoria econômica consolidada
- Implementado serviço consolidado `economic-audit-service` (somente leitura), com severidades `CRITICAL/HIGH/MEDIUM/WARNING`, categorias e filtros.
- Implementadas rotas administrativas read-only: `/api/admin/economic-audit` e `/api/admin/economic-audit/summary`.
- Auditoria consolidada reaproveita checks da política de RPC via `auditRpcSupplyConsistency()`.
- Nenhum endpoint da auditoria executa correção automática ou mutação econômica.
- Interpretação: cada issue retorna código, severidade, categoria, entidade, mensagem e ação recomendada.

## Atualização 2026-05-06 — Simulador econômico isolado (PR 10)
- Adicionado simulador de ciclo econômico em Test Mode com execução persistida por run e trilha por steps.
- Garantia de isolamento: simulação não altera `Wallet`, `Company`, `Trade`, `MarketOrder`, `ProjectTokenReserve`, `ProjectBuybackProgram`, `ProjectHolderDistributionProgram` e `RpcMarketState` reais.
- Cenários disponíveis: baseline completo, baixa liquidez, entrada/saída de baleia, venda em massa, recompra sem liquidez e tentativa de self-trade.
- Limitações atuais: replay de run não implementado; UX avançada e visual premium ficam para etapas futuras.


## Atualização 2026-05-06 — PR 11 UX funcional e proteção anti-erro
- UX com proteção anti-clique duplo reforçada em ações econômicas sensíveis via botão de ação com `loading` + `disabled`.
- Avisos econômicos padronizados reforçando que R$ e RPC são fictícios e que não existe dinheiro real, Pix, cartão, gateway, cripto real ou blockchain.
- Preview de impacto introduzido em fluxo de mercado RPC/R$ para compra com estimativas de entrada, taxa, preço e risco de liquidez.
- Separação real/simulado reforçada no Test Mode com aviso explícito de isolamento econômico.


## Atualização 2026-05-06 — PR 12 visual premium inicial
- Camada visual premium inicial adicionada no frontend com tokens globais e componentes de design system reutilizáveis.
- Sem impacto econômico: não altera saldo, preço, Trade, MarketOrder, CompanyHolding ou taxa 50/50.
- Sem backend e sem migration nesta etapa.
- Avisos econômicos e de simulação RP preservados nos fluxos existentes.
