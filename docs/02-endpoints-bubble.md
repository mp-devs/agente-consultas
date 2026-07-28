# 02 — Contrato dos endpoints `ia_*` no Bubble

Especificação de cada backend workflow que o agente consome. O passo a passo de **como criar** no editor do Bubble está em `03-passo-a-passo-bubble.md`.

---

## Convenções gerais

**Método:** todos `POST`, em `https://app.meupescado.com.br/api/1.1/wf/{nome}`
(em `version-test`: `https://app.meupescado.com.br/version-test/api/1.1/wf/{nome}`)

**Autenticação:** header `Authorization: Bearer <API_TOKEN>` (token de API criado em *Settings → API → Generate a new API token*). Os workflows ficam com *"This workflow can be run without authentication"* **DESMARCADO**.

**Parâmetro obrigatório em todos:** `fk_empresa` (texto, unique id da `fazenda`). Injetado pelo n8n a partir da sessão — nunca vem do LLM.

**Envelope de resposta.** O Bubble embrulha o retorno automaticamente:

```json
{ "status": "success", "response": { ...seu payload... } }
```

O n8n lê `$json.response`. Padronize o payload interno como:

```json
{
  "ok": true,
  "dados": [ ... ] | { ... },
  "meta": { "total": 12, "truncado": false, "gerado_em": "2026-07-28T14:30:00Z" }
}
```

**Regras de formatação (aplicar em TODO endpoint):**
- Datas: `:formatted as` → `YYYY-MM-DD` (ou `YYYY-MM-DD HH:mm` quando a hora importa)
- Números: arredondar na origem (`:rounded to 2` para R$, `:rounded to 0` para gramas/unidades)
- Nunca devolver campo vazio — omita ou mande `0`/`"—"`
- Nunca devolver `unique id` de coisas que o produtor não vai referenciar

---

## Prioridades

| Prioridade | Endpoints | Cobertura estimada das perguntas |
|---|---|---|
| **P0** — construir primeiro | `ia_auth_identificar`, `ia_resolver_entidade`, `ia_listar_lotes`, `ia_detalhe_lote` | ~55% |
| **P1** — segunda leva | `ia_serie_biometrias`, `ia_consumo_racao`, `ia_analise_agua`, `ia_estoque` | ~85% |
| **P2** — terceira leva | `ia_mortalidade`, `ia_financeiro_resumo`, `ia_despescas` | ~95% |

Recomendo colocar o **P0 no ar e testar com 3–5 produtores reais** antes de construir o P1. O log de auditoria (`agente_log`) vai mostrar quais perguntas o agente não conseguiu responder — e essa lista é melhor guia de priorização do que qualquer palpite nosso.

---

## P0.1 — `ia_auth_identificar`

Identifica o produtor pelo telefone do WhatsApp. **Este é o único endpoint chamado antes da autenticação**, e é o portão de todo o resto.

**Request**
```json
{ "telefone": "5548999887766" }
```
> Só dígitos, com DDI. A normalização é feita no n8n (ver `05-seguranca-multitenant.md`).

**Lógica no Bubble**
1. `Do a search for user` onde o campo de WhatsApp (normalizado, só dígitos) = `telefone`. **Máximo 1 resultado.**
2. Se não achar → `{ "ok": false, "motivo": "nao_encontrado" }`
3. Se achar, montar a lista de empresas do usuário a partir de `fk_lista_empresas`, filtrando as ativas.
4. Devolver também um **snapshot dos lotes ativos** — otimização importante: evita a primeira chamada de ferramenta em ~40% das conversas (ver `prompts/system-prompt.md`).

**Response**
```json
{
  "ok": true,
  "dados": {
    "fk_user": "1699...x...",
    "nome": "João Silva",
    "idioma": "pt",
    "empresas": [
      { "fk_empresa": "1699...a...", "nome": "Fazenda Boa Vista", "ativa": true },
      { "fk_empresa": "1699...b...", "nome": "Sítio das Águas", "ativa": true }
    ],
    "empresa_padrao": "1699...a...",
    "permissoes": ["producao", "financeiro"],
    "snapshot_lotes": [
      { "lote": "T-04 Tilápia", "viveiro": "V4", "especie": "Tilápia", "fase": "Engorda", "dias": 87 },
      { "lote": "C-11 Camarão", "viveiro": "V11", "especie": "Camarão", "fase": "Engorda", "dias": 42 }
    ]
  }
}
```

**Notas de implementação**
- O campo de WhatsApp no `user` provavelmente tem máscara (`(48) 99988-7766`). Crie um campo derivado `whats_normalizado` (só dígitos, com DDI) e preencha-o com um `bulk_` de migração + um database trigger em alterações. Buscar com `:formatted` no search é impossível no Bubble — **precisa ser campo indexado**.
- `permissoes`: derive dos option sets `Permissões_Usuario` / `modulos`. Se o usuário não tem o módulo financeiro, o n8n não carrega as ferramentas financeiras.

---

## P0.2 — `ia_resolver_entidade`

Traduz o jeito que o produtor fala para o ID real. Sem isso, o agente erra sempre que o produtor diz *"o viveiro do fundo"* ou *"aquele lote da tilápia"*.

**Request**
```json
{ "fk_empresa": "...", "tipo": "lote" | "viveiro" | "insumo" | "fornecedor", "termo": "tilapia do 4" }
```

**Lógica**
- Busca por `:contains` no nome, case-insensitive, dentro da empresa. Devolve até 5 candidatos ordenados por relevância (match exato primeiro, depois ativos, depois recentes).

**Response**
```json
{
  "ok": true,
  "dados": [
    { "id": "1699...x...", "nome": "T-04 Tilápia", "extra": "Viveiro V4 · Engorda · 87 dias", "ativo": true }
  ],
  "meta": { "total": 1 }
}
```

> **Padrão de uso pelo agente:** se `total > 1`, o agente pergunta ao produtor qual dos candidatos — não escolhe sozinho. Isso está no system prompt.

---

## P0.3 — `ia_listar_lotes`

O endpoint mais usado. Panorama da produção.

**Request**
```json
{ "fk_empresa": "...", "status": "ativo" | "todos" | "finalizado",
  "especie": "peixe" | "camarao" | null, "fk_viveiro": null, "limit": 20 }
```

**Response**
```json
{
  "ok": true,
  "dados": [
    {
      "id": "1699...x...",
      "lote": "T-04 Tilápia",
      "viveiro": "V4",
      "especie": "Tilápia",
      "fase": "Engorda",
      "povoamento": "2026-05-02",
      "dias_cultivo": 87,
      "pop_atual": 21400,
      "sobrevivencia_pct": 91.3,
      "peso_medio_g": 412,
      "biomassa_kg": 8816,
      "custo_kg": 3.87,
      "previsao_despesca": "2026-09-15"
    }
  ],
  "meta": { "total": 6, "truncado": false }
}
```

**Cuidado de performance:** não recalcule biomassa/custo dentro do loop. Esses valores já existem materializados no `lote` (campos de biomassa, custo total/ajustado, população atual). Se algum não estiver materializado, **materialize com database trigger** em vez de calcular no endpoint — senão esse endpoint fica lento e caro exatamente por ser o mais chamado.

---

## P0.4 — `ia_detalhe_lote`

Ficha completa de um lote. É o "zoom" depois do `ia_listar_lotes`.

**Request**
```json
{ "fk_empresa": "...", "fk_lote": "1699...x..." }
```

**Response**
```json
{
  "ok": true,
  "dados": {
    "lote": "T-04 Tilápia", "viveiro": "V4", "especie": "Tilápia", "fase": "Engorda",
    "povoamento": "2026-05-02", "dias_cultivo": 87,
    "pop_inicial": 23400, "pop_atual": 21400, "sobrevivencia_pct": 91.3,
    "peso_medio_g": 412, "biomassa_kg": 8816,
    "gmd_g": 4.6, "fca_acum": 1.42,
    "racao_total_kg": 12520, "racao_custo": 24800.00,
    "custo_total": 34118.00, "custo_kg": 3.87,
    "preco_kg": 7.20, "faturamento_esperado": 63475.20,
    "ultima_biometria": "2026-07-24",
    "previsao_despesca": "2026-09-15", "peso_alvo_g": 800
  }
}
```

---

## P1.1 — `ia_serie_biometrias`

Histórico de crescimento. Alimenta perguntas de tendência ("o peixe está crescendo bem?").

**Request**
```json
{ "fk_empresa": "...", "fk_lote": "...", "limit": 12 }
```

**Response**
```json
{
  "ok": true,
  "dados": [
    { "data": "2026-07-24", "dias": 83, "peso_medio_g": 412, "gmd_g": 4.6, "biomassa_kg": 8816, "fca": 1.42 },
    { "data": "2026-07-10", "dias": 69, "peso_medio_g": 348, "gmd_g": 4.4, "biomassa_kg": 7480, "fca": 1.38 }
  ],
  "meta": { "total": 9, "truncado": false }
}
```
> Ordem **decrescente** por data (mais recente primeiro) e `limit` baixo. A pergunta quase sempre é sobre o presente; mandar 40 biometrias só gasta contexto.

---

## P1.2 — `ia_consumo_racao`

**Request**
```json
{ "fk_empresa": "...", "fk_lote": null, "data_inicio": "2026-07-01", "data_fim": "2026-07-28", "agrupar_por": "lote" | "marca" | "dia" }
```

**Response**
```json
{
  "ok": true,
  "dados": [
    { "chave": "T-04 Tilápia", "racao_kg": 3120, "custo": 6240.00, "custo_kg_racao": 2.00 }
  ],
  "meta": { "total": 3, "periodo": "2026-07-01 a 2026-07-28", "racao_kg_total": 7840, "custo_total": 15680.00 }
}
```
> Os totais vão em `meta` para o agente não ter que somar. Se ele somar, ele erra.

---

## P1.3 — `ia_analise_agua`

**Request**
```json
{ "fk_empresa": "...", "fk_viveiro": null, "limit": 10, "apenas_alertas": false }
```

**Response**
```json
{
  "ok": true,
  "dados": [
    {
      "viveiro": "V4", "data": "2026-07-27 06:30",
      "parametros": [
        { "nome": "Oxigênio", "valor": 3.1, "un": "mg/L", "faixa": "4.0–8.0", "status": "baixo" },
        { "nome": "pH", "valor": 7.4, "un": "", "faixa": "6.5–8.5", "status": "ok" }
      ],
      "alertas": 1
    }
  ],
  "meta": { "total": 4 }
}
```
> **Só devolva os parâmetros efetivamente preenchidos.** São 47 parâmetros configuráveis em `parametrosanaliseagua`; mandar todos, a maioria vazia, é desperdício puro de contexto. `apenas_alertas: true` filtra só o que está fora da faixa — é o modo que o agente usa quando o produtor pergunta "está tudo bem na água?".

---

## P1.4 — `ia_estoque`

**Request**
```json
{ "fk_empresa": "...", "categoria": null, "apenas_baixo": false, "limit": 30 }
```

**Response**
```json
{
  "ok": true,
  "dados": [
    { "insumo": "Ração 32% 4mm", "marca": "Nutripiscis", "saldo": 480, "un": "kg", "minimo": 500, "status": "abaixo_minimo", "custo_medio": 2.05 }
  ],
  "meta": { "total": 18, "itens_abaixo_minimo": 3 }
}
```

---

## P2.1 — `ia_mortalidade`

```json
{ "fk_empresa": "...", "fk_lote": null, "data_inicio": "...", "data_fim": "...", "agrupar_por": "lote" | "dia" }
```
```json
{ "ok": true,
  "dados": [ { "chave": "T-04 Tilápia", "qtd": 340, "pct_pop": 1.6, "custo_estimado": 1315.80 } ],
  "meta": { "total": 2, "qtd_total": 512 } }
```

## P2.2 — `ia_financeiro_resumo`

```json
{ "fk_empresa": "...", "data_inicio": "...", "data_fim": "...", "visao": "resumo" | "categoria" | "a_vencer" }
```
```json
{ "ok": true,
  "dados": { "entradas": 84200.00, "saidas": 61340.00, "saldo": 22860.00,
             "por_categoria": [ { "categoria": "Ração", "valor": 31200.00, "tipo": "saida" } ],
             "a_vencer_7d": 8400.00, "vencidas": 1200.00 },
  "meta": { "periodo": "2026-07-01 a 2026-07-28" } }
```
> ⚠️ Só carregue esta ferramenta no agente se `permissoes` incluir `financeiro`. Um funcionário de campo não deve ver o fluxo de caixa da fazenda.

## P2.3 — `ia_despescas`

```json
{ "fk_empresa": "...", "data_inicio": "...", "data_fim": "...", "fk_lote": null }
```
```json
{ "ok": true,
  "dados": [ { "data": "2026-07-12", "lote": "T-02 Tilápia", "tipo": "parcial",
               "biomassa_kg": 4210, "peso_medio_g": 780, "preco_kg": 7.10,
               "valor": 29891.00, "custo_kg": 3.92, "margem_kg": 3.18 } ],
  "meta": { "total": 3, "biomassa_total_kg": 11840, "valor_total": 84064.00 } }
```

---

## Checklist de aceite por endpoint

Antes de considerar um endpoint pronto:

- [ ] Responde em < 2 s com dados de uma fazenda grande real (não a de teste)
- [ ] Payload < 4 KB no caso típico
- [ ] Rejeita `fk_empresa` de outra empresa (teste explícito de vazamento — ver `05`)
- [ ] Datas em ISO, números arredondados, sem campos vazios
- [ ] `meta.truncado` funciona quando estoura o `limit`
- [ ] Testado em `version-test` **e** `version-live`
