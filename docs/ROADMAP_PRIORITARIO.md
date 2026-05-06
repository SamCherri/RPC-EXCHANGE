# ROADMAP PRIORITÁRIO — UZUMAKI INTERPRISE / RPC EXCHANGE

## Decisão estratégica

A prioridade atual do projeto é fechar o ciclo econômico real da RPC Exchange antes de avançar visual premium, gráfico avançado, simulador avançado ou temporadas.

O objetivo é transformar o MVP em um Beta fechado com economia RP completa, segura, auditável e sustentável.

Regra central:

Empresa gera lucro dentro do RP
→ dono compra/recebe R$ fictício no site pelo fluxo normal
→ dono compra RPC no mercado RPC/R$
→ dono usa RPC real já existente na carteira para comprar/injetar/recomprar token do projeto
→ preço só muda por compra executada na oferta inicial ou por trade real no mercado secundário
→ tudo fica registrado, auditável e separado da carteira pessoal do dono.

## Regras econômicas permanentes

1. A RPC Exchange é simulação RP.
2. Não existe dinheiro real, cripto real, blockchain, Pix, cartão, gateway de pagamento ou promessa de lucro real.
3. RPC é a moeda base operacional da plataforma.
4. Tokens/projetos são criados por usuários e aprovados/moderados pela administração.
5. A plataforma não deve criar tokens próprios negociáveis como regra normal.
6. Admin pode criar token manual apenas como exceção administrativa auditada para evento, correção ou teste.
7. Mercado primário e mercado secundário devem ser tratados separadamente.
8. Oferta criada não altera preço.
9. Oferta executada altera preço.
10. Compra da oferta inicial pode alterar preço conforme regra transparente.
11. No mercado secundário, preço oficial só muda por trade real.
12. Injeção de RPC não deve subir gráfico automaticamente.
13. Recompra deve executar contra ordens reais do livro.
14. Moedas recompradas devem ir para reserva institucional do projeto, não para carteira pessoal do dono.
15. Lucro da empresa dentro do RP não vira RPC automática.
16. Lucro RP externo não cria crédito institucional livre.
17. Dono/fundador não pode criar crédito institucional confirmado do nada.
18. Se o dono quiser injetar no projeto, ele precisa usar RPC já existente na própria carteira.
19. O caixa institucional do projeto só deve receber saldo rastreável: taxas já implementadas, transferência real de RPC, recompra/reserva futura ou ajuste administrativo excepcional auditado.
20. Nenhum usuário comum ou dono de projeto pode criar crédito institucional livre.
21. Injeção de RPC não altera gráfico sozinha.
22. Preço só muda por compra executada na oferta inicial ou trade real no mercado secundário.
23. Saldo institucional do projeto deve ficar separado do saldo pessoal do fundador.
24. Test Mode é laboratório isolado e não pode afetar saldo real, RPC real, mercado real ou tokens reais.

## Prioridade 1 — Fechar ciclo econômico real da Exchange

### PR 1 — Fluxo de capital R$ → RPC → token/projeto

Objetivo:
Garantir que a entrada de capital para projetos passe pelo fluxo econômico normal, sem criar crédito institucional livre.

Implementar futuramente:
- documentação e UX clara do fluxo R$ fictício → RPC → compra de token;
- confirmação de que RPC usada para injetar no projeto precisa existir na carteira do usuário/dono;
- transferência rastreável de RPC da carteira pessoal para o caixa institucional do projeto, se o produto decidir permitir aporte institucional;
- histórico de aportes com motivo obrigatório;
- autor, IP e user-agent quando disponível;
- separação entre saldo pessoal do dono e saldo institucional do projeto;
- logs administrativos/econômicos;
- auditoria básica.

Não deve:
- criar RPC automática a partir de lucro RP;
- permitir crédito institucional livre por dono/fundador;
- alterar preço da moeda;
- criar trade;
- criar recompra;
- distribuir lucro;
- mexer em supply;
- mexer no simulador.

Critério de aceite:
O sistema deixa claro e auditável que capital do projeto entra por saldo existente: R$ fictício → RPC → compra/injeção, sem creditar a carteira pessoal do dono e sem criar preço falso.

### PR 2 — Mercado primário correto

Objetivo:
Consolidar a regra da oferta inicial.

Implementar futuramente:
- política de oferta inicial;
- curva de preço transparente;
- limite por jogador, se necessário;
- encerramento da oferta inicial;
- transição clara para mercado secundário;
- logs e operações auditáveis.

Regra:
Compra da oferta inicial pode mover preço.
Oferta inicial parada não move preço.
Depois da oferta inicial, preço só muda por trade real no mercado secundário.

### PR 3 — Mercado secundário seguro

Objetivo:
Reforçar que o preço oficial no secundário só muda com execução real de ordens, com proteção operacional e auditável.

Implementar futuramente:
- validações adicionais de saldo bloqueado e execução parcial;
- proteção anti-manipulação e anti-self-trade;
- trilha de auditoria para eventos de matching;
- monitoramento de inconsistências críticas.

Regra:
Preço no secundário só muda por trade real, nunca por injeção administrativa.

### PR 4 — Caixa institucional rastreável do projeto

Objetivo:
Consolidar caixa institucional separado e rastreável para cada projeto.

Implementar futuramente:
- entradas permitidas: taxas do projeto, transferência real de RPC e ajuste administrativo excepcional auditado;
- entradas proibidas: lucro RP externo virando RPC automática e crédito livre do fundador;
- histórico de entradas e saídas;
- motivo obrigatório em toda movimentação sensível;
- origem rastreável do saldo institucional;
- logs administrativos/econômicos.

Não deve:
- alterar preço;
- criar trade;
- criar ordem;
- mexer em supply.

### PR 5 — Programa de recompra com RPC existente

Objetivo:
Permitir que projetos usem RPC institucional rastreável para recomprar o próprio token.

Implementar futuramente:
- usar apenas RPC existente e rastreável;
- execução contra ordens reais de venda;
- bloqueio de self-trade;
- expiração;
- renovação;
- saldo não usado voltando para caixa/reserva do projeto;
- logs de execução e governança.

Regra:
Preço só sobe se houver trade real executado.

### PR 6 — Reserva de tokens recomprados

Objetivo:
Criar reserva institucional para tokens recomprados.

Implementar futuramente:
- tokens recomprados saem dos vendedores;
- entram na reserva institucional do projeto;
- não vão para carteira pessoal do dono;
- podem futuramente ser queimados, mantidos bloqueados, usados em evento ou nova oferta controlada.

### PR 7 — Distribuição para holders, se mantida

Objetivo:
Permitir distribuição auditável de RPC para holders, se a política for mantida.

Implementar futuramente:
- uso exclusivo de RPC existente no caixa institucional;
- snapshot de holders;
- cálculo proporcional;
- extrato para usuário;
- logs administrativos/econômicos;
- proteção contra manipulação.

### PR 8 — Política da RPC

Objetivo:
Consolidar RPC como moeda base controlada.

Implementar futuramente:
- RPC não é infinita;
- supply planejado;
- circulação;
- tesouraria;
- emissão;
- logs obrigatórios;
- painel e alertas de emissão.

### PR 9 — Auditoria econômica

Objetivo:
Detectar inconsistências econômicas e reforçar governança.

Alertas futuros:
- saldo negativo;
- ordem aberta sem saldo travado;
- preço alterado sem trade;
- crédito institucional sem origem rastreável;
- programa de recompra vencido;
- saldo preso sem destino;
- self-trade;
- emissão sem log;
- admin mexendo em saldo sem motivo.

### PR 10 — Simulador do ciclo completo

Objetivo:
Depois de fechar a economia real, evoluir o Test Mode para simular o ciclo completo.

Simular futuramente:
- R$ → RPC → token/projeto;
- oferta inicial;
- mercado secundário;
- recompra;
- reserva;
- distribuição, se mantida;
- venda em massa;
- baixa liquidez;
- entrada/saída de baleia.

### PR 11 — UX funcional

Objetivo:
Melhorar clareza e segurança de uso antes do visual premium.

Implementar futuramente:
- mensagens claras;
- anti-clique duplo;
- preview de impacto;
- aviso de risco;
- explicação de R$ → RPC → token;
- explicação de mercado primário/secundário;
- explicação de recompra/reserva/distribuição.

### PR 12 — Visual premium

Objetivo:
Somente depois da economia estar fechada.

Implementar futuramente:
- gráfico premium;
- livro de ordens premium;
- dashboard refinado;
- melhorias mobile;
- animações.

## Ordem oficial atual

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

## Regra para Codex e agentes

Antes de implementar qualquer coisa relacionada a economia, mercado, RPC, projeto, token, simulador, admin, UX estrutural ou roadmap, ler:

1. AGENTS.md
2. docs/CODEX_SKILLS.md
3. docs/ROADMAP_PRIORITARIO.md
4. docs/ARQUITETURA_BOLSA_RP.md
5. docs/AUDITORIA_ATUAL.md

Em caso de conflito:
- código atual vence conversa antiga;
- ROADMAP_PRIORITARIO.md vence docs antigas;
- regra de segurança econômica vence visual;
- não criar preço falso;
- não criar volume falso;
- não criar liquidez falsa;
- não criar crédito institucional livre sem origem rastreável.

- [~] PR 1 — Fluxo de capital R$ → RPC → token/projeto (implementação parcial: fluxo base + testes iniciais; ajustes adicionais podem evoluir em follow-up).
- [x] PR 2 — Mercado primário correto (compra da oferta inicial reforçada com débito atômico de RPC, proteção anti-oversell, atualização de holding/oferta/circulação e trilha auditável sem Trade/MarketOrder).

- [x] PR 3 — Mercado secundário seguro (preço no secundário reforçado para mudar somente por Trade real, com bloqueio de self-trade, lock consistente e validações de liquidez/cancelamento).

## Atualização 2026-05-04 — PR 4 caixa institucional rastreável
- Implementado resumo auditável do caixa institucional por projeto com saldo, histórico recente, totais por tipo/origem e inconsistências básicas read-only.
- Implementado endpoint admin somente leitura para listar caixas institucionais com alertas básicos.
- Sem impacto em preço, Trade, MarketOrder, CompanyHolding, supply, mercado primário/secundário, matching, Test Mode e boost legado.

## Atualização 2026-05-04 — PR 5 programa de recompra
- Implementado programa de recompra com orçamento em RPC institucional existente, reservado no ato da criação.
- Execução ocorre somente contra ordens SELL reais no livro secundário, com criação de Trade e atualização de preço apenas por execução real.
- Tokens recomprados são enviados para reserva institucional mínima (`ProjectTokenReserve`), nunca para holding pessoal do fundador.
- Cancelamento devolve saldo não utilizado para `CompanyRevenueAccount`.
- Política avançada da reserva permanece para PR 6.


## Atualização 2026-05-04 — PR 6 reserva institucional de tokens recomprados
- Implementada política formal da reserva institucional com `HOLD_LOCKED` como padrão e flags de bloqueio para uso futuro governado.
- Implementadas consultas read-only por fundador e por perfis de auditoria (`SUPER_ADMIN`, `COIN_CHIEF_ADMIN`, `AUDITOR`) com histórico de entradas e custo médio.
- Implementada auditoria read-only de inconsistências da reserva (somatórios, vínculos com execução/programa e validações de integridade).
- Não implementado nesta PR: queima, distribuição, reoferta controlada e venda/transferência de tokens reservados.

- [~] PR 7 — Distribuição para holders, se mantida (implementação base auditável com snapshot, execução idempotente e devolução de sobra; UI avançada pode evoluir em follow-up).


## Atualização 2026-05-06 — PR 8 Política da RPC
- ✅ Parcialmente implementada: governança read-only de supply/circulação da RPC com endpoints administrativos.
- ✅ Serviço de snapshot soma RPC de wallet (rpcAvailable/rpcLocked), tesouraria, corretoras, conta da exchange, caixa institucional e reserva ativa de recompra sem usar acumuladores históricos nem saque fiat/legado.
- ✅ Auditoria read-only de inconsistências econômicas (saldos negativos, emissão/transferência sem metadados e distribuição acima do budget).
- ⚠️ Edição de política (planned/max supply) mantida como pendência para etapa futura.

- Saques atuais de WithdrawalRequest são tratados como fluxo fiat/R$ fictício (`fiatWithdrawn`) e não reduzem supply RPC real.


## Atualização 2026-05-06 — PR 9 auditoria econômica
- [~] Implementação base entregue: serviço consolidado read-only, endpoints admin de relatório e resumo, integração com auditoria da política RPC e testes iniciais dedicados.
- [ ] Pendências: ampliação da cobertura para todos os cenários de alerta planejados e painel visual avançado (PR 11).
