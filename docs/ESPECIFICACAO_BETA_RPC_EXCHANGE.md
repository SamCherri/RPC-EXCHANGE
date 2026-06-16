# Especificação Beta — RPC Exchange / SunCity RP

## 1. Escopo e identidade

A RPC Exchange é uma simulação econômica para RP dentro do SunCity. Não existe dinheiro real, criptomoeda real, blockchain, Pix, cartão, gateway de pagamento ou promessa de lucro real. O dinheiro citado nos fluxos é dinheiro virtual do SunCity ou saldo interno fictício da plataforma.

Moedas internas:
- **RPC**: moeda operacional interna da Exchange.
- **R$ digital fictício**: saldo interno que representa valor de simulação/RP.

Não existe integração direta com o servidor SunCity. Toda comprovação é manual por screenshot e revisão administrativa.

## 2. Cadastro e aprovação

O cadastro do Beta deve solicitar apenas:
- nome;
- nome do personagem;
- Discord;
- telefone do personagem no SunCity;
- senha;
- screenshot da conta SunCity mostrando nome do personagem e telefone.

O Discord é o identificador principal de login. E-mail e `bankAccountNumber` ficam apenas como campos legados temporários para compatibilidade e não devem aparecer no fluxo público normal.

Após o cadastro, o usuário fica com `approvalStatus = PENDING`. Ele pode autenticar apenas para acompanhar o status e corrigir dados, mas não pode acessar carteira econômica, mercado, saques, projetos, corretor ou operações financeiras enquanto não estiver `APPROVED`.

Estados:
- `PENDING`: aguardando análise.
- `CORRECTION_REQUIRED`: administrador solicitou correção com motivo obrigatório.
- `APPROVED`: liberado para usar os fluxos normais.
- `REJECTED`: rejeitado com motivo obrigatório.
- `SUSPENDED`: suspenso administrativamente.

## 3. Evidência de cadastro

O screenshot é obrigatório. Regras:
- aceitar PNG, JPEG ou WEBP;
- validar MIME real por assinatura do arquivo;
- tamanho máximo configurável por `REGISTRATION_EVIDENCE_MAX_BYTES`;
- gerar SHA-256;
- armazenar por abstração de storage;
- não expor URL pública permanente;
- acesso autenticado somente pelo dono ou administração autorizada;
- registrar auditoria de acesso administrativo.

Implementação atual: `DatabaseEvidenceStorage`, que armazena os bytes em tabela própria no PostgreSQL para não depender de diretório efêmero do Railway. Migração futura recomendada: trocar a implementação pela interface S3-compatible, mantendo `storageKey`, hash e metadados.

## 4. Perfil

O usuário pode editar nome simples diretamente. Mudanças sensíveis criam solicitação pendente:
- nome do personagem;
- Discord;
- telefone do jogo.

Enquanto a solicitação está pendente, os dados atuais continuam válidos. Isso evita que a alteração de Discord bloqueie o login durante análise.

## 5. Administração e permissões granulares

Somente `SUPER_ADMIN` representa a autoridade técnica/desenvolvedor nesta fase.

Permissões granulares previstas:
- `registration.review`;
- `finance.rpc_purchase.review`;
- `finance.broker_purchase.review`;
- `finance.withdrawal.review`.

Somente `SUPER_ADMIN` pode conceder ou retirar permissões financeiras/de revisão. A concessão/remoção gera `AdminLog`. Um administrador não pode revisar a própria solicitação de cadastro ou alteração sensível.

## 6. RPC — política econômica documentada para PRs futuras

- Supply máximo inicial planejado: **10.000.000.000.000 RPC**.
- Circulação inicial planejada: até **500.000.000.000 RPC**.
- Reserva bloqueada da Tesouraria: **9.500.000.000.000 RPC**.
- Jogadores começam com 0 RPC.
- Somente o desenvolvedor pode emitir RPC.
- Nenhuma emissão pode ultrapassar o supply máximo.
- Toda emissão exige motivo e auditoria.
- Preço inicial: **1 RPC = 1 R$ digital**.
- Preço posterior deve ser formado por negócios reais executados.

Esta PR **não implementa** supply de 10 trilhões nem altera emissão existente.

## 7. Mercado RPC/R$ futuro

Modelo futuro definido:
- usuários compram e vendem RPC usando R$ digital;
- venda de RPC credita R$ digital;
- compra de RPC consome R$ digital;
- preço oficial é o último negócio executado;
- ordens paradas não alteram preço;
- proibido preço, volume ou liquidez falsos;
- proibido self-trade;
- Tesouraria pode fornecer liquidez por ordens oficiais auditadas;
- matching real entre ordens;
- AMM/reserva automática atual deve ser substituído em PR posterior.

Esta PR **não altera** o matching RPC/R$.

## 8. Compra direta de RPC futura

Jogador comum:
1. transfere dinheiro virtual do SunCity para a conta definida pelo grupo;
2. cria solicitação no app;
3. envia screenshot;
4. administração financeira autorizada confere;
5. se aprovado, recebe RPC pelo preço de mercado;
6. se rejeitado, recebe motivo.

Corretor:
1. transfere dinheiro virtual do SunCity;
2. cria solicitação;
3. envia screenshot;
4. administração autorizada confere;
5. recebe RPC com desconto de 10% sobre preço de venda ao jogador;
6. RPC entra na carteira exclusiva do corretor.

Este fluxo será implementado em PR posterior.

## 9. Saques no Beta

- jogador vende RPC no mercado e recebe R$ digital;
- solicita saque para receber dinheiro no SunCity;
- R$ digital fica bloqueado imediatamente;
- administração financeira autorizada processa;
- pagamento é feito manualmente no SunCity;
- administrador anexa screenshot do pagamento;
- saque é aprovado sempre integralmente;
- usuário pode cancelar enquanto `PENDING`;
- cancelamento/rejeição devolve valor integral;
- rejeição exige motivo;
- saque no Beta não terá taxa;
- mercado RPC/R$ pode manter taxa própria.

## 10. Projetos/tokens futuros

- formulário atual de solicitação deve ser preservado;
- custo futuro: **5.000.000 RPC**, configurável pelo desenvolvedor;
- saldo deve ser suficiente;
- valor fica bloqueado ao solicitar;
- rejeição devolve integralmente;
- aprovação envia para Tesouraria oficial da RPC Exchange;
- Tesouraria não é carteira pessoal de administrador;
- toda movimentação exige log e motivo.

Este custo não é implementado nesta PR.

## 11. PRs recomendadas após esta etapa

1. Completar fluxo financeiro de compra direta de RPC com screenshots e permissões financeiras.
2. Reconstruir mercado RPC/R$ com matching real e self-trade protection.
3. Implementar política de supply máximo, reserva bloqueada e emissão controlada.
4. Implementar custo configurável de criação de projeto/token.
5. Evoluir storage para S3-compatible em produção.
