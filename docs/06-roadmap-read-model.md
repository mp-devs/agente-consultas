# 06 — Fase 2: read-model em Postgres

> **Não comece por aqui.** Este documento existe para você saber para onde a arquitetura cresce — e reconhecer o momento de dar esse passo.

---

## Quando puxar o gatilho

Três sinais, e você precisa de pelo menos dois:

1. O log (`agente_log`) mostra perguntas analíticas recorrentes que o agente não responde: comparação entre ciclos, tendência histórica, ranking de viveiros.
2. O consumo de Workload Units do Bubble atribuível ao agente começa a pesar na fatura.
3. Algum endpoint `ia_*` passa de 3 s consistentemente e não dá para materializar mais nada.

Antes disso, o read-model é 8 tabelas de complexidade para resolver um problema que você ainda não tem.

---

## O que muda

**Hoje (Fase 1):** o agente pergunta ao Bubble, o Bubble varre e agrega.

**Fase 2:** um cron sincroniza as tabelas quentes para o Postgres da VPS. O agente ganha uma ferramenta a mais — consulta analítica em SQL — e continua usando os endpoints `ia_*` para o estado atual.

```
Bubble (verdade)  ──sync incremental──►  Postgres (réplica de leitura)
      ▲                                        ▲
      │ ia_* (estado atual)                    │ SQL (histórico, agregação)
      └──────────── n8n / agente ──────────────┘
```

O ponto importante: **as duas fontes coexistem**. Estado atual continua vindo do Bubble (sempre fresco). Histórico vem da réplica (rápido e barato). Nenhum endpoint `ia_*` é jogado fora.

---

## Tabelas a espelhar

Só as analíticas quentes — 8, não as ~120:

| Tabela Bubble | Por que espelhar |
|---|---|
| `lote` | Chave de tudo; junta com todo o resto |
| `viveiros` | Dimensão para agrupamento |
| `pesagem` | Série de biometria — muitas linhas, muita agregação |
| `nutrição` | Consumo de ração — a tabela que mais cresce |
| `arracoamento` | Planejado × realizado |
| `analiseagua` | Série temporal de parâmetros |
| `despesca` | Fechamento de ciclo, margem |
| `fluxocaixa` | Custo e receita por período |

Todas ganham `fk_empresa` como coluna e **índice composto** `(fk_empresa, data)` — as duas dimensões de toda consulta.

---

## Como sincronizar

A Data API genérica do Bubble, que é ruim para consulta interativa, é **ótima** para sync em lote — é exatamente o caso de uso para o qual ela foi feita.

**Estratégia:** incremental por `Modified Date`.

1. Tabela `sync_cursor (tabela, ultimo_modified, ultima_execucao)`
2. Cron no n8n (de hora em hora, ou 15 em 15 min para as mais quentes)
3. Para cada tabela: `GET /api/1.1/obj/{tipo}?constraints=[{"key":"Modified Date","constraint_type":"greater than","value":"<cursor>"}]&limit=100&cursor=N`
4. Paginar até esgotar
5. `INSERT ... ON CONFLICT (bubble_id) DO UPDATE` no Postgres
6. Avançar o cursor **só depois** do batch inteiro gravar com sucesso

**Cuidados que economizam retrabalho:**

- **Deleções não aparecem** nesse sync — um registro apagado no Bubble fica órfão na réplica. Solução: soft delete no Bubble (o sistema já usa `deleted`/`_EXCLUIR`) e sincronizar a flag. Se houver hard delete em algum fluxo, precisa de uma reconciliação semanal por contagem.
- **Cursor com folga.** Use `ultimo_modified - 5 minutos` como ponto de partida. Escritas concorrentes durante o batch podem ficar entre as páginas e sumir. Reprocessar 5 min é barato; perder registro é caro.
- **Carga inicial separada.** O primeiro sync de `nutrição` pode ser centenas de milhares de linhas. Faça uma vez, com paginação lenta, fora do horário de pico — e só então ligue o incremental.
- **Alerta de atraso.** Se `ultima_execucao` ficar > 2 h no passado, avise alguém. Réplica silenciosamente desatualizada é pior que réplica ausente: o agente responde com confiança um dado velho.

---

## Nova ferramenta do agente

Duas opções, em ordem de segurança:

**Opção A — views parametrizadas (recomendada).** Você cria N views/funções SQL para as perguntas analíticas que o log mostrou. O agente escolhe qual chamar e passa parâmetros. Mesma filosofia dos endpoints `ia_*`, só que rodando em SQL rápido. Sem risco de SQL injection, sem risco de query que derruba o banco.

**Opção B — text-to-SQL.** O agente escreve SQL. Mais flexível, muito mais arriscado. Se for por esse caminho, o mínimo inegociável:

- Usuário Postgres **somente leitura**, com acesso apenas às 8 tabelas espelhadas
- `SET statement_timeout = '5s'` na sessão
- `fk_empresa = '<da sessão>'` injetado via **RLS (Row Level Security)** no Postgres — não como string concatenada no WHERE. RLS é aplicada pelo banco e não tem como o SQL gerado escapar dela.
- Rejeitar tudo que não seja `SELECT` por parsing, antes de executar
- `LIMIT` obrigatório injetado
- Log de toda query gerada

> Comece pela A. A opção B só se justifica quando as perguntas analíticas forem tão variadas que criar views vire gargalo — e mesmo assim, com RLS ligada.

---

## Custo estimado

Praticamente nulo em infraestrutura: o Postgres já existe na VPS, e as 8 tabelas de uma base de 300 fazendas devem ficar na casa de poucos GB.

O custo real é de **manutenção**: mudou um campo no Bubble, o sync quebra. Por isso o escopo enxuto de 8 tabelas importa — é a diferença entre uma manutenção ocasional e um segundo sistema para cuidar.
