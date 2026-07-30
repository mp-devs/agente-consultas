# Agente de Consultas — WhatsApp + IA (n8n / ClickUp)

> Projeto distinto do descrito no README raiz deste repositório (que documenta
> o piloto "Caminho B" com endpoints `ag_*` e orquestração por código). Este
> documento cobre outra linha de trabalho da Meu Pescado: um agente de
> WhatsApp em que o **próprio LLM decide qual ferramenta chamar**, com cache
> em Data Tables do n8n.
>
> Origem: sessão anterior no claude.ai ("Agente consultas - n8n",
> [link da conversa](https://claude.ai/share/80c26fa0-8338-41d6-9a96-f4423fbcf558)),
> migrada para este repositório em 2026-07-30 para manter contexto
> versionado.

## 1. O que é o projeto

Agente de WhatsApp (n8n + OpenAI) que responde consultas sobre a fazenda de
aquicultura do cliente (tanques, lotes, biometrias, estoques), lendo dados de
um backend Bubble. Localização no n8n: **Personal / Agentes de consulta /
\<nome do workflow\>**.

## 2. Workflows e IDs

| Workflow | ID | Papel |
|---|---|---|
| **Whatsapp Consulta - Testes** | `7MBOuRuhi32P9MLQ` | Workflow principal do agente (Chat Trigger + AI Agent) |
| buscar_lotes_ia (com cache) | `XpTduSjhR9ht3O9w` | Sub-workflow: cache + chamada Bubble para lotes |
| buscar_biometrias_ia (com cache) | `e8ExZ14SMdr48aPv` | Sub-workflow: cache + chamada Bubble para biometrias |
| buscar_estoques_ia (com cache) | `FOsZKXmb5o4YeuJC` | Sub-workflow: cache + chamada Bubble para estoques |

**Data Tables (cache, TTL 5 min):** `cache_lotes` (`vjCzL22BC3VY4p5S`),
`cache_biometrias` (`RXegjCq83mrP4QfG`), `cache_estoques` (`PvuYr3YSwsymqh7y`).
Projeto n8n: `bBqGPNbLWK26DTft` (Personal).

**Endpoints Bubble**
(`https://app.meupescado.com.br/version-test/api/1.1/wf/<nome>`):
`buscar_lotes_ia`, `buscar_biometrias_ia`, `buscar_estoques_ia`. Auth: Bearer
token fixo + `fkEmpresa` fixo — hoje hardcoded no node HTTP Request (flag de
segurança: idealmente migrar para uma credential do n8n).

**Nodes principais do workflow principal:**
- `Agente - Consultas` — AI Agent (system message gigante, ver seção 4)
- `Modelo` — OpenAI Chat Model (gpt-5-mini)
- `Memória` — buffer de memória de conversa
- `Parser - Estoques` — Structured Output Parser (ver seção 5)
- `Gate - Estoques por Tipo` — Code node determinístico pós-agente (ver seção 5)
- Tool nodes (`toolWorkflow`): `buscar_lotes_ia`, `buscar_biometrias_ia`, `buscar_estoques_ia`

## 3. Arquitetura de cada tool (padrão repetido nos 3 sub-workflows)

```
Execute Workflow Trigger (recebe filtros como strings)
→ Code: monta cache_key (JSON ordenado dos filtros relevantes)
→ Data Table "get" (alwaysOutputData: true — senão o node é pulado quando não há cache)
→ Code: verifica validade (cached_at vs. agora, TTL 5 min)
→ IF válido:
    TRUE  → Code "Retornar do cache": parse do array cacheado, devolve N itens
    FALSE → HTTP Request (Bubble, alwaysOutputData: true)
            → Code "Agregar resultado" (mode: runOnceForAllItems): combina os N itens
              retornados em UM item único {cache_key, registros: [...]} — formata datas
              (timestamp epoch → dd/mm/aaaa) aqui, uma vez só
            → Data Table "upsert" (UM único upsert, salva o array inteiro serializado)
            → Code "Retornar dado fresco": lê o array do node anterior e devolve N itens
```

Datas (`data` em biometrias, `ultima_entrada.data` em estoques) chegam do
Bubble como timestamp epoch em ms — **sempre formatadas no n8n**
(`dd/mm/aaaa`), nunca deixadas para o LLM calcular (ele errava a conversão).

## 4. Bugs reais encontrados e corrigidos

1. **`alwaysOutputData` não persiste** quando definido via SDK
   (`create_workflow_from_code`/`validate_workflow`) — precisa ser aplicado
   depois via `update_workflow` com `type: "setNodeSettings"`.
2. **Tool node sem `schema`**: o resource mapper do node `toolWorkflow`
   precisa do array `schema` (definição dos campos) além de `value` — sem
   isso, os valores do `$fromAI` chegavam como `null` no sub-workflow
   (quebrou `buscar_biometrias_ia` inicialmente).
3. **Sub-workflow precisa estar publicado/ativo** (não só rascunho) para o
   `toolWorkflow` conseguir chamá-lo — senão erro "Workflow is not active".
4. **Bug de cache mais sério**: quando o Bubble retorna um array (vários
   registros), o HTTP Request "explode" isso em N itens n8n. Se o node de
   salvar cache roda uma vez por item (cada execução fazendo upsert na MESMA
   linha), cada execução **sobrescreve a anterior** — só sobra o último
   registro. Isso fazia buscas com múltiplos resultados (ex: "quanto tenho de
   ração?") às vezes trazerem só 1 estoque em vez de 8, dependendo se batiam
   num cache corrompido dentro da janela de TTL. **Corrigido** com o node
   "Agregar resultado" (agrega tudo em 1 item antes de cachear) nos três
   sub-workflows.
5. **Busca por nome do Bubble às vezes retorna algo sem relação real** (ex:
   "tanque 8" → "Viveiro (10)"). Mitigado com regra explícita no prompt: só
   aceitar resultado único se bater com os critérios de equivalência (seção
   4 e 6-B do prompt).

## 5. Camada de segurança extra (Output Parser + Gate determinístico)

Mesmo com os bugs de cache corrigidos, o modelo (`gpt-5-mini`) ocasionalmente
falhava em seguir a regra "pergunte antes de mostrar números quando há vários
estoques do mesmo tipo". Para isso:

- **`Parser - Estoques`** (Structured Output Parser) força o agente a
  devolver JSON: `{resposta_final, aguardando_escolha_tipo_estoque,
  nomes_estoques_do_tipo}`.
- **`Gate - Estoques por Tipo`** (Code node, depois do agente): se
  `aguardando_escolha_tipo_estoque === true` OU
  `nomes_estoques_do_tipo.length >= 2`, **descarta** `resposta_final` e
  reconstrói a pergunta de forma 100% determinística a partir dos nomes —
  nunca deixa passar números de estoque individual nesse cenário,
  independente do que o modelo escreveu.
- Decisão do usuário: manter essa mitigação (não trocar o modelo do agente
  nem investir mais tempo nisso por ora).

## 6. Resumo do system message do agente (`Agente - Consultas`)

- **Topo:** data/hora atual injetada via expressão
  (`{{ $now.setZone('America/Sao_Paulo')... }}`) — agente calcula "essa
  semana", "esse mês" etc. sozinho, nunca pergunta a data de hoje.
- **Seção 2:** modelo de dados — TANQUE, LOTE (registro por tanque), LOTE-PAI
  (`id_lote_pai` agrupa tanques do mesmo lote dividido), ESTOQUE
  (`tipo_estoque`, `status_estoque`).
- **Seção 3:** as 3 ferramentas, parâmetros e campos retornados (3.1 lotes,
  3.2 biometrias, 3.3 estoques).
- **Seção 4:** procedimento obrigatório de busca por nome (tanque/lote/
  estoque), com regras de equivalência (zeros à esquerda, acentos,
  parênteses etc.) e proteção contra resultado único implausível.
- **Seção 5:** roteiro de decisão A–L (cada tipo de pergunta → qual
  tool/filtro usar).
- **Seção 6 / 6-B:** lote dividido entre tanques (perguntar separado vs.
  agrupado; soma simples para a maioria dos campos, média ponderada por
  população para biometria/sobrevivência) e resolução de `id_lote` para
  consultar biometrias.
- **Seção 7 / 7-A:** regras de preenchimento de parâmetros e reaproveitamento
  de dado já buscado na mesma conversa (não repetir chamada idêntica, exceto
  sinal de dado desatualizado).
- **Seções 9–12:** formato de resposta, casos especiais, regras
  inegociáveis (lista numerada) e ~17 exemplos (incluindo exemplos de erro a
  evitar).
- Regra-chave sobre estoques: `tipo_estoque` e `status_estoque` **não são
  parâmetros filtráveis** da tool — sempre buscar tudo (`nomes_estoques=[]`)
  e filtrar no código/raciocínio. Pergunta por **tipo** ("quanto tenho de
  ração") com 2+ resultados → só pergunta, zero números (reforçado pelo
  Gate). Pergunta por **status** ("o que está com baixo estoque") → é
  listagem, responde direto sem perguntar.

## 7. ClickUp

- Conector habilitado; tools disponíveis: `clickup_create_task`,
  `clickup_get_task`, `clickup_update_task`, `clickup_search`,
  `clickup_filter_tasks`, etc.
- **Lista alvo para tasks de desenvolvimento:** Sprint 15 (7/20 - 8/2) →
  pasta Melhorias → espaço TECNOLOGIA.
  - `list_id`: **901114070933** | `folder_id`: 90114684374 | `space_id`: 49173545
  - Caminho na UI: *Compartilhado comigo / Melhorias / Sprint 15 (7/20 - 8/2)*
- **Template automático:** toda task nova nessa lista recebe um template
  fixo (não é IA por task, é o mesmo texto sempre) com cabeçalhos em negrito
  **DESCRIÇÃO** / **SOLUÇÃO** / **TESTE** e texto de instrução/exemplo.
- **O "banner" azul centralizado dos cabeçalhos é um bloco nativo do editor
  ClickUp, não representável via a API de markdown do conector** — ao ler,
  já vem só como `**negrito**`; ao escrever, só consigo produzir
  `**negrito**` também. Decisão do usuário: manter negrito simples, sem
  tentar recriar o banner.
- **Fluxo correto para criar uma task de dev:**
  1. `clickup_create_task` só com `list_id` + `name` (sem descrição) → deixa
     o template automático popular.
  2. `clickup_get_task` (`include: ["description"]`) → pega o template
     recém-criado.
  3. `clickup_update_task` (`markdown_description`) substituindo o texto de
     instrução de cada seção pelo conteúdo real, mantendo os cabeçalhos
     `**DESCRIÇÃO**` / `**SOLUÇÃO TÉCNICA**` / `**TESTE**`.
     > Cabeçalho mudou de `**SOLUÇÃO**` para `**SOLUÇÃO TÉCNICA**` a partir da
     > task de biometrias — usar esse a partir de agora.
- **Tasks ainda não implementadas** (funcionalidade não existe no agente):
  preencher **só a DESCRIÇÃO**, deixando SOLUÇÃO TÉCNICA e TESTE de fora até
  a implementação acontecer — não criar os cabeçalhos vazios, só a
  DESCRIÇÃO mesmo.
- **Convenção especial para a task "Agente principal"**: como novas
  consultas vão sendo adicionadas o tempo todo, a SOLUÇÃO TÉCNICA/TESTE
  dessa task específica ficaria desatualizada rápido demais. Decisão do
  usuário: deixar SOLUÇÃO TÉCNICA e TESTE **em branco** nessa task até que
  todas as consultas planejadas estejam implementadas — só então preencher
  de uma vez, já refletindo o estado final.
- Tasks de teste criadas em sessão anterior (o usuário apaga manualmente):
  `868kj08gj`, `868kj092c`, `868kj09z6`, `868kj0atk`.

### Tasks reais criadas (Sprint 15)

| Task | ID | Status do conteúdo |
|---|---|---|
| Criar consultas de estoques | `868kj183c` | DESCRIÇÃO + SOLUÇÃO TÉCNICA + TESTE completos |
| Criar consultas de tanques e lotes | `868kj2bbk` | DESCRIÇÃO + SOLUÇÃO + TESTE completos |
| Criar consultas de biometrias | `868kj2gdk` | DESCRIÇÃO + SOLUÇÃO TÉCNICA + TESTE completos |
| Criar agente principal | `868kj2j85` | Só DESCRIÇÃO (SOLUÇÃO TÉCNICA/TESTE apagados de propósito — ver convenção acima; preencher só quando todas as consultas estiverem prontas) |
| Criar consultas de despescas | `868kj2mxe` | Só DESCRIÇÃO (feature não implementada) |
| Criar consultas de análise de água | `868kj2phg` | Só DESCRIÇÃO (feature não implementada) |
| Criar consultas do financeiro | `868kj2tet` | Só DESCRIÇÃO (feature não implementada) |
| Configurar integração com o WhatsApp | `868kj2vuy` | Só DESCRIÇÃO (feature não implementada) |
| Criar fluxo de autenticação e escolha de empresa | `868kj2wre` | Só DESCRIÇÃO (feature não implementada) |

## 8. Próximo passo

Tasks de planejamento criadas no ClickUp (tabela acima). Conforme cada
funcionalidade pendente (despescas, análise de água, financeiro, integração
WhatsApp, autenticação/escolha de empresa) for implementada no n8n/Bubble,
voltar na task correspondente e preencher SOLUÇÃO TÉCNICA + TESTE. A task do
"Agente principal" só recebe SOLUÇÃO TÉCNICA/TESTE depois que todas as
consultas planejadas estiverem prontas.
