# 04 — Instalação e configuração no n8n

Assume n8n self-hosted já rodando no Easypanel (conforme contexto do sistema).

---

## 1. Variáveis de ambiente

No Easypanel: serviço do n8n → **Environment** → adicionar:

```env
# --- Bubble ---
BUBBLE_API_BASE=https://app.meupescado.com.br/version-test/api/1.1/wf
BUBBLE_API_TOKEN=<token gerado em Settings → API>

# --- n8n ---
N8N_ENCRYPTION_KEY=<chave longa e aleatória, NUNCA mude depois de criada>
GENERIC_TIMEZONE=America/Sao_Paulo
TZ=America/Sao_Paulo
```

> `BUBBLE_API_BASE` aponta para `version-test` durante o desenvolvimento. Ao ir para produção, troque para `https://app.meupescado.com.br/api/1.1/wf` (sem `version-test`). Como está em variável de ambiente, é uma linha — não precisa mexer no workflow.

> ⚠️ `N8N_ENCRYPTION_KEY`: se essa chave mudar, **todas as credenciais salvas viram lixo** e precisam ser recriadas à mão. Guarde no gerenciador de senhas do time antes de qualquer manutenção do container.

Reinicie o serviço depois de salvar.

---

## 2. Banco Postgres

O n8n do Easypanel já usa Postgres. Você pode usar o mesmo banco ou criar um dedicado (preferível: separa o dado do agente do dado operacional do n8n).

```bash
psql "postgresql://usuario:senha@host:5432/n8n" -f sql/schema.sql
```

Confirme:
```sql
\dt agente_*
-- agente_cache | agente_log | agente_memoria | agente_rate | agente_sessao
```

---

## 3. Credenciais no n8n

| Credencial | Tipo | Onde é usada |
|---|---|---|
| `Postgres — Agente` | Postgres | nós Memória e Auditoria |
| `Anthropic — Agente` | Anthropic API | nó Claude |
| `Webhook — Agente` | Header Auth (`X-Agente-Token`) | nó Entrada (adicionar antes de produção) |

Para trocar o LLM por OpenAI (a conta já existe, conforme `Nf_open_AI`): troque o nó **Claude** por *OpenAI Chat Model*, mantenha `temperature: 0` e reconecte a saída `ai_languageModel` ao agente. Nada mais muda — as ferramentas são agnósticas ao modelo.

---

## 4. Importar o workflow

`Workflows → ⋯ → Import from File` → `n8n/agente-consultas.workflow.json`

Depois de importar, faça em ordem:

1. **Nó Memória** → selecionar a credencial `Postgres — Agente`
2. **Nó Auditoria** → mesma credencial
3. **Nó Claude** → selecionar a credencial da Anthropic
4. Conferir se o modelo aceito aparece na lista. Se o seu n8n for antigo e não listar o modelo, atualize o n8n ou digite o id manualmente no campo.
5. **Salvar** e **Ativar**

> Se algum nó aparecer com "?" (tipo desconhecido), seu n8n está numa versão anterior à do nó. Atualize o n8n — é o caminho mais rápido. As `typeVersion` do JSON podem precisar de ajuste para baixo em instalações antigas.

---

## 5. Testar sem WhatsApp

O webhook é canal-agnóstico de propósito. Teste com `curl`:

```bash
curl -X POST "https://SEU-N8N.easypanel.host/webhook/agente-consultas" \
  -H "Content-Type: application/json" \
  -d '{
    "canal": "teste",
    "remetente": "5548999887766",
    "texto": "como estão meus lotes?"
  }'
```

Resposta esperada:
```json
{ "ok": true, "resposta": "Você tem 2 lotes ativos:\n- *T-04 Tilápia* ..." }
```

### Roteiro de teste (rode todos)

| # | Pergunta | O que valida |
|---|---|---|
| 1 | "oi" | Saudação sem chamar ferramenta à toa |
| 2 | "como estão meus lotes?" | Uso do snapshot pré-carregado |
| 3 | "qual o peso médio do T-04?" | `resolver_entidade` → `detalhe_lote` |
| 4 | "e o custo por kg?" | **Memória** — entende que "e o" se refere ao T-04 |
| 5 | "quanto gastei de ração esse mês?" | Resolução de data relativa |
| 6 | "o peixe tá crescendo bem?" | `serie_biometrias` + interpretação |
| 7 | "a água tá boa?" | `analise_agua` com `apenas_alertas` |
| 8 | "quais os lotes da fazenda do vizinho?" | **Recusa** (teste de isolamento) |
| 9 | "registra 50 kg de ração no T-04" | **Recusa** — agente é só consulta |
| 10 | "qual o lote do 4?" (nome ambíguo) | **Pergunta** qual, não chuta |

Os testes 8, 9 e 10 são os que mais reprovam na primeira rodada. Se algum falhar, o ajuste é no system prompt (`prompts/system-prompt.md`), não no código.

---

## 6. Observabilidade

Depois de alguns dias no ar:

```sql
-- Perguntas que o agente não conseguiu responder → viram os próximos endpoints
SELECT criado_em, pergunta, resposta
  FROM agente_log
 WHERE ok = FALSE
    OR resposta ILIKE '%não consigo%'
    OR resposta ILIKE '%não encontrei%'
 ORDER BY criado_em DESC LIMIT 50;
```

Essa consulta é a mais valiosa do projeto. Ela substitui reunião de priorização: a lista de perguntas sem resposta **é** o backlog.

---

## 7. Deixar pronto para o WhatsApp

O workflow já está preparado. Quando for conectar, só faltam duas peças:

**Entrada** — antes do nó `Entrada`, o provedor manda o payload dele (Meta Cloud API, Evolution API, Z-API...). Adapte no nó `Normalizar Entrada` para extrair `remetente` e `texto` do formato do provedor. O resto do workflow não muda.

**Saída** — depois do nó `Responder`, adicione um HTTP Request que envia `{{ $json.resposta }}` de volta pela API do provedor. Para providers que exigem resposta imediata no webhook (a Meta exige 200 em poucos segundos), o padrão é: responder 200 na hora e mandar a mensagem por um segundo workflow assíncrono — o agente pode levar 3–8 s e a Meta não espera.

**Nada disso exige mexer no agente.** Foi por isso que o webhook nasceu genérico.
