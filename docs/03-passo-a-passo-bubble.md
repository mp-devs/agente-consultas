# 03 — Passo a passo no editor do Bubble

Roteiro para a sessão ao vivo. Vamos construir **um endpoint completo juntos** (`ia_listar_lotes`) e os outros seguem o mesmo molde.

---

## Etapa 0 — Preparar o ambiente (10 min, faça antes da sessão)

### 0.1 Habilitar a API de workflows
`Settings → API`
- [x] **Enable Workflow API and Backend Workflows**
- [ ] Enable Data API — **deixe desmarcado** para os tipos que não precisa. Cada tipo exposto aqui é superfície de ataque a mais, e o agente não vai usar a Data API (ver `01-arquitetura.md`).

### 0.2 Gerar o token
`Settings → API → Generate a new API token`
- Nome: `n8n-agente-consultas`
- **Copie agora** — o Bubble não mostra de novo.
- Guarde direto na variável `BUBBLE_API_TOKEN` do n8n. Não passe por WhatsApp, e-mail ou Notion.

### 0.3 Campo de telefone normalizado
Este é o passo mais fácil de esquecer e que trava tudo depois.

O campo de WhatsApp no `user` está com máscara (`(48) 99988-7766`). O Bubble **não consegue** buscar por valor formatado — `Do a search for` só usa o valor cru do campo, indexado. Então:

1. `Data → Data types → user` → novo campo `whats_normalizado` (text)
2. Backend workflow `bulk_normalizar_whats`: para cada `user`, gravar o telefone só com dígitos e DDI 55.
   - No Bubble: `This user's whatsapp:find & replace` com regex `[^0-9]` → `""`, depois um condicional para prefixar `55` se o resultado tiver 10 ou 11 dígitos.
3. Rodar via *Schedule API workflow on a list* para todos os usuários.
4. **Database trigger** em `user`: quando o campo de WhatsApp muda, recalcular `whats_normalizado`. Sem isso, quem trocar de número some do agente.
5. Conferir se ficou único: procure duplicados de `whats_normalizado` antes de ir para produção. Dois usuários com o mesmo telefone = risco de entregar a fazenda errada (ver `05-seguranca-multitenant.md`).

### 0.4 Conferir campos materializados no `lote`
`ia_listar_lotes` precisa entregar rápido. Verifique se estes já existem preenchidos no `lote` (não calculados na hora):

- população atual · biomassa atual · peso médio atual · custo total · custo/kg · sobrevivência % · previsão de despesca

Se algum estiver vazio ou for calculado dentro do endpoint, o endpoint mais chamado do agente vira o mais caro. **O certo é materializar via database trigger** quando a biometria/manejo é registrada — não a cada pergunta do produtor.

---

## Etapa 1 — Criar `ia_listar_lotes` (vamos fazer juntos)

### 1.1 Novo backend workflow
`Backend workflows → New API workflow`

| Configuração | Valor |
|---|---|
| Name | `ia_listar_lotes` |
| Expose as a public API workflow | ✅ **sim** |
| This workflow can be run without authentication | ❌ **NÃO** |
| Ignore privacy rules when running the workflow | ✅ sim |
| Parameter definition | **Manual definition** |
| Response type | JSON object |

> **"Ignore privacy rules" = sim** é intencional: a chamada vem sem usuário logado, então as privacy rules bloqueariam tudo. O isolamento por empresa passa a ser responsabilidade do **passo 1 do workflow**, feito à mão. É exatamente por isso que a validação da Etapa 1.3 é obrigatória e não opcional.

### 1.2 Parâmetros (Manual definition)

| key | type | optional |
|---|---|---|
| `fk_empresa` | text | não |
| `fk_user` | text | não |
| `status` | text | sim |
| `especie` | text | sim |
| `limit` | number | sim |

### 1.3 Passo 1 — validação de acesso (**nunca pule**)

`Add an action → Terminate this workflow`

Condição (termina quando o acesso é inválido):
```
Do a search for user (unique id = fk_user):first item's fk_lista_empresas
   :filtered (unique id = fk_empresa) :count = 0
```

Ou seja: se a empresa pedida **não** está na lista de empresas do usuário, para aqui.

Antes do terminate, retorne o payload de erro:
```json
{ "ok": false, "motivo": "acesso_negado" }
```

### 1.4 Passo 2 — buscar os lotes

`Do a search for lote`:

| Constraint | Valor |
|---|---|
| `fk_empresa` | = `fk_empresa` (parâmetro) ← **obrigatória** |
| status/ativo | = `yes`, quando `status` for vazio ou `"ativo"` |
| espécie | = `especie`, quando o parâmetro vier preenchido |
| `deleted` | ≠ `yes` (cuidado com o legado `_EXCLUIR`) |

Ordenação: data de povoamento decrescente.
`:items until #` = `limit` (padrão 20, teto 200).

### 1.5 Passo 3 — montar a resposta

`Return data from API`. Monte o JSON com os campos do contrato em `02-endpoints-bubble.md`.

Pontos de atenção:
- **Datas:** `:formatted as` → `YYYY-MM-DD`. O padrão do Bubble sai em formato longo e o LLM interpreta errado.
- **Números:** `:rounded to 2` para R$, `:rounded to 0` para gramas e população.
- **`meta.truncado`:** `yes` quando a contagem total sem `:items until` for maior que o `limit`.
- **Nomes de campo:** exatamente os do contrato. Se divergir, a ferramenta no n8n quebra silenciosamente e o agente inventa em cima do que sobrou.

### 1.6 Testar antes de ir para o n8n

No terminal:

```bash
curl -X POST "https://app.meupescado.com.br/version-test/api/1.1/wf/ia_listar_lotes" \
  -H "Authorization: Bearer $BUBBLE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fk_empresa":"COLE_O_ID_AQUI","fk_user":"COLE_O_ID_AQUI","status":"ativo","limit":20}'
```

Checklist de aceite:
- [ ] Responde em **< 2 s** (teste com uma fazenda grande de verdade, não a de demo)
- [ ] Payload **< 4 KB**
- [ ] Datas em `AAAA-MM-DD`
- [ ] Nenhum campo nulo ou vazio no JSON
- [ ] **Teste de vazamento:** troque `fk_empresa` pelo id de outra fazenda mantendo o mesmo `fk_user` → tem que voltar `acesso_negado`

Só depois de passar nos 5, siga para o próximo endpoint.

---

## Etapa 2 — Replicar para os demais

O molde é sempre o mesmo:

1. Novo API workflow, autenticação ligada, privacy rules ignoradas
2. **Passo 1 = validação `fk_user` × `fk_empresa`** (copie do `ia_listar_lotes`)
3. Busca com constraint `fk_empresa` em **toda** query
4. `Return data from API` com o contrato exato
5. `curl` de teste + teste de vazamento

Ordem sugerida: `ia_auth_identificar` → `ia_resolver_entidade` → `ia_listar_lotes` → `ia_detalhe_lote` → **ir para produção e observar o log** → depois o P1.

> **Sugestão prática:** crie o `ia_listar_lotes` comigo na sessão ao vivo, e depois use-o como template no Bubble (*Copy* no workflow) para os outros. O passo de validação vem junto e ninguém esquece de colocá-lo.

---

## Armadilhas conhecidas do Bubble nesta integração

| Armadilha | Efeito | Como evitar |
|---|---|---|
| Esquecer de fazer *deploy* para `live` | Funciona em teste, quebra em produção | Deploy + trocar `BUBBLE_API_BASE` no n8n |
| Endpoint retorna `status/response` embrulhado | n8n lê `undefined` | Sempre ler `$json.response` |
| Parâmetro opcional não enviado | Bubble pode dar erro em vez de tratar como vazio | Marque como *optional* e trate com `:is empty` |
| `Do a search for` sem constraint de empresa | **Vazamento entre clientes** | Revisão obrigatória de toda query nova |
| Campos `_EXCLUIR`/`deleted` no resultado | Agente reporta lote que não existe mais | Constraint `deleted ≠ yes` em todas as buscas |
| Lista grande sem `:items until` | Timeout e WU alto | Teto de linhas em todo endpoint |
| Data sem `:formatted as` | LLM erra o cálculo de "dias de cultivo" | Formatar sempre na origem |
| Trocar o nome de um campo do JSON | Ferramenta quebra sem erro visível | O contrato em `02` é a fonte de verdade — mudou lá, muda no n8n |
