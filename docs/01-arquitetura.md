# 01 — Arquitetura: como o n8n acessa os dados do Bubble

> Decisão técnica central do projeto. Leia antes de qualquer implementação.

---

## 1. As 4 opções avaliadas

| # | Abordagem | Latência típica | Custo (Bubble WU) | Agregação/Join | Veredito |
|---|---|---|---|---|---|
| A | **Data API genérica** `/api/1.1/obj/{tipo}` | 1–3 s por página de 100 | Alto (paga por item lido, N+1 nos `fk_`) | ❌ Nenhuma | ❌ Descartado |
| B | **Endpoints de intenção** (backend workflows dedicados) `/api/1.1/wf/{nome}` | 0,4–2 s, 1 chamada | Médio, controlável | ✅ Feita no Bubble | ✅ **Fase 1** |
| C | **Read-model em Postgres** na VPS, sincronizado do Bubble | 10–80 ms, SQL puro | ~zero na consulta (só no sync) | ✅ SQL completo | ✅ **Fase 2** |
| D | Xano como camada de consulta | Baixa | Zero WU | ✅ | ⚠️ Só se já espelhar dados; hoje o Xano é usado para relatórios, não como réplica |

### Por que a Data API genérica está descartada

Pergunta real do produtor: *"qual o custo por kg do meu lote de tilápia do viveiro 4?"*

Com a Data API isso vira:
1. `GET /obj/viveiros?constraints=[fk_empresa,nome]` → acha o viveiro
2. `GET /obj/lote?constraints=[fk_viveiro]` → acha o lote
3. `GET /obj/custos2?constraints=[fk_lote]` → paginado, N páginas
4. `GET /obj/pesagem?constraints=[fk_lote]` → paginado, para pegar biomassa
5. Somar tudo no n8n

**~40 requisições, 15–40 s, e o JSON bruto do Bubble traz os 55 campos do `lote`** — inclusive campos `_EXCLUIR` e legado do AppGyver. Isso estoura o contexto do LLM, queima WU e dá resposta lenta no WhatsApp. Além disso, a Data API expõe o schema inteiro: qualquer bug de constraint vaza dado de outra empresa.

### Por que endpoints de intenção (B) é o caminho da Fase 1

O time já domina esse padrão — são **263 backend workflows** no app hoje, incluindo os `ff_*`/`_flutterflow` que servem o app de campo. É exatamente a mesma técnica: um endpoint que responde uma pergunta de negócio, já agregado, com JSON enxuto.

A mesma pergunta acima vira **1 chamada, ~700 ms, ~350 tokens de resposta**:

```json
POST /api/1.1/wf/ia_detalhe_lote
{ "fk_empresa": "...", "fk_lote": "..." }
→ { "lote":"T-04 Tilápia", "dias_cultivo":87, "peso_medio_g":412,
    "biomassa_kg":8240, "custo_total":31890.40, "custo_kg":3.87,
    "fca_acum":1.42, "sobrevivencia_pct":91.3, "preco_kg":7.20 }
```

---

## 2. Arquitetura recomendada (Fase 1)

```
WhatsApp (depois)                    ┌──────────────────────────────┐
      │                              │  Bubble — app.meupescado     │
      ▼                              │                              │
┌──────────────┐   POST /wf/ia_*     │  Backend Workflows "ia_*"    │
│     n8n      │────────────────────►│  (endpoints de intenção,     │
│   (VPS)      │◄────────────────────│   já agregados e filtrados   │
│              │   JSON enxuto       │   por fk_empresa)            │
│ ┌──────────┐ │                     └──────────────────────────────┘
│ │ Webhook  │ │
│ │    ↓     │ │                     ┌──────────────────────────────┐
│ │  AUTH    │─┼────────────────────►│ Postgres (VPS)               │
│ │    ↓     │ │                     │ • sessão / tenant ativo      │
│ │ CONTEXTO │ │                     │ • memória de conversa        │
│ │    ↓     │ │                     │ • rate limit + auditoria     │
│ │ AI AGENT │ │                     │ • cache de respostas (TTL)   │
│ │    ↓     │ │                     └──────────────────────────────┘
│ │ RESPOSTA │ │
│ └──────────┘ │                     ┌──────────────────────────────┐
└──────────────┘────────────────────►│ LLM (Claude / OpenAI)        │
                                     └──────────────────────────────┘
```

### Princípios não-negociáveis dos endpoints `ia_*`

1. **Pré-agregado, nunca bruto.** O endpoint devolve `custo_kg`, não a lista de custos. O agente não pagina, não soma, não faz join. Se o LLM precisa calcular, o endpoint está errado.
2. **JSON enxuto.** Só os campos que o produtor pode perguntar. Nomes curtos e legíveis (`peso_medio_g`, não `Peso Médio (gramas) - Calculado`). Sem nulos, sem campos legado.
3. **Teto rígido de linhas.** Todo endpoint que lista tem `limit` (padrão 20, máx 200) e devolve `meta.truncado: true` quando cortou. O agente é instruído a avisar o produtor em vez de fingir que viu tudo.
4. **`fk_empresa` vem do servidor, nunca do LLM.** É injetado pelo n8n a partir da sessão autenticada. O modelo não tem esse parâmetro nas suas ferramentas. (Ver `05-seguranca-multitenant.md`.)
5. **Datas em ISO 8601** (`2026-07-28`), já no fuso da fazenda. O Bubble precisa de `:formatted as` para isso — detalhe fácil de esquecer.
6. **Idempotente e só-leitura.** Nenhum endpoint `ia_*` escreve no banco. Registro de manejo por linguagem natural é outro projeto, com outro conjunto de endpoints e confirmação explícita.

---

## 3. Fase 2 — read-model em Postgres (quando e por quê)

A Fase 1 resolve bem **"estado atual"**: lotes ativos, última biometria, saldo de estoque, contas a vencer. Esses são result sets pequenos e o Bubble responde rápido.

Ela **não** resolve bem perguntas analíticas de histórico:

- *"compare o FCA dos meus últimos 5 ciclos de camarão"*
- *"em que mês do ano passado tive mais mortalidade?"*
- *"qual viveiro me dá o melhor custo por kg historicamente?"*

Isso varre milhares de `pesagem`/`nutrição`/`custosfilho`. No Bubble, um `Do a search for` desse tamanho é lento **e cobra WU proporcional ao volume varrido** — é o pior custo/benefício possível de rodar sob demanda, a cada pergunta de cliente.

**Solução:** espelhar só as tabelas analíticas quentes num Postgres na VPS (o mesmo do n8n) e deixar o agente rodar SQL parametrizado sobre elas.

Tabelas a espelhar (8, não as ~120):

`lote` · `viveiros` · `pesagem` · `nutricao` · `arracoamento` · `analiseagua` · `despesca` · `fluxocaixa`

**Sync incremental** via cron no n8n, usando o campo `Modified Date` do Bubble como cursor — a Data API genérica, que é ruim para consulta interativa, é ótima para sync em lote noturno/horário. Detalhes e DDL em `06-roadmap-read-model.md` e `sql/schema.sql`.

> **Não comece pela Fase 2.** Ela só se paga depois que você souber, pelos logs de auditoria da Fase 1, quais perguntas analíticas os produtores realmente fazem. Construir o espelho antes disso é otimização prematura de 8 tabelas.

---

## 4. Camada de cache (barata e com alto retorno)

Perguntas repetem muito: "como estão meus lotes?" é feita várias vezes por dia pelo mesmo produtor.

Cache no Postgres, chave = `hash(fk_empresa + nome_ferramenta + params)`, TTL por natureza do dado:

| Ferramenta | TTL | Racional |
|---|---|---|
| `ia_listar_lotes` | 10 min | Muda com manejo do dia |
| `ia_detalhe_lote` | 10 min | Idem |
| `ia_serie_biometrias` | 6 h | Biometria é semanal/quinzenal |
| `ia_analise_agua` | 30 min | Pode ter leitura IoT frequente |
| `ia_financeiro_resumo` | 30 min | |
| `ia_estoque` | 5 min | Baixa a cada trato |
| `ia_despescas` | 1 h | |

Isso corta tipicamente 50–70% das chamadas ao Bubble sem nenhuma percepção de dado velho pelo produtor.

---

## 5. Resumo da decisão

**Fase 1 (agora):** endpoints de intenção `ia_*` no Bubble + agente no n8n + Postgres para sessão/memória/cache/auditoria.

**Fase 2 (depois de rodar em produção):** read-model Postgres para perguntas analíticas de histórico, sincronizado por cron.

**Nunca:** Data API genérica como fonte de consulta interativa do agente.
