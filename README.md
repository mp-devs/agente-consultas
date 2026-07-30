# Agente de Consultas — Meu Pescado (WhatsApp)

Agente de IA no n8n que responde produtores rurais no WhatsApp com dados da
fazenda vindos do Bubble (app `aprimoreagro`, ~300 fazendas, aquicultura).

## Arquitetura

- **Caminho B**: endpoints dedicados `ag_*` no Bubble (réplica SQL descartada
  por volume: 5–15M linhas).
- **Dois workflows n8n**:
  - `MP - Agente de Consultas (WhatsApp)` (`O2UTikVA5qMsJsZq`):
    webhook → filtro → auth → agente OpenAI `gpt-4.1-mini` → envio.
  - `MP - Executar Consulta` (`HXgENgr91fsJja9D`): executor com catálogo de
    consultas, cache em `$getWorkflowStaticData`, resolvedor de nome de
    tanque v3, parser de listas.
- **Princípio**: quem orquestra é código, não o LLM. A cadeia
  tanque → lote → biometria roda dentro de um único endpoint no Bubble.

## WhatsApp (BubbleWhats)

- Device `9125`, plano PRO, número +55 48 8831-4787 ("Notificações").
- O webhook de recebimento **só funciona se configurado via API**
  (`POST https://9125.bubblewhats.com/config`, header `Authorization` com o
  token puro, sem `Bearer`) — o painel salva mas não propaga.
- Resposta é assíncrona: o webhook devolve `200` na hora e o texto sai por
  `POST /send-message`.

## Regras de negócio

- Cliente só fala em **tanque** (nunca lote); 1 lote = 1 tanque.
- Nomes de tanque são livres ("Berçário 03", "Desova 01") e únicos.
- Sempre usar o **lote povoado**.
- Não expor: distinção lote/biometria, dias de cultivo, previsão de despesca.
- Unidade de estoque vive no `estoque` — **nunca somar quantidades de itens
  diferentes**.

## Endpoints Bubble (`ag_*`)

| Endpoint | Status |
|---|---|
| `ag_identificar_usuario` | ⚠️ versão de fumaça (hardcoded) — ver [docs/ag_identificar_usuario.md](docs/ag_identificar_usuario.md) |
| `ag_indice_tanques` | ✅ |
| `ag_panorama_tanque` | ✅ |
| `ag_resumo_tanques` | ✅ |
| `ag_estoque_saldo` | ✅ |

Padrão obrigatório dos endpoints: `Ignore privacy rules` ✅; parâmetros que
representam uma coisa declarados com o **tipo da tabela** (não `text`);
`Ignore empty constraints` ✅ para filtros opcionais; listas retornadas como
`colunas` + `itens` com `|` e `;;` (ou JSON puro em `application/json`).

## Ferramentas do agente

Ativas: `panorama_tanque`, `resumo_fazenda`, `listar_tanques` (responde do
índice em cache, zero WU), `estoque_saldo`, `estoque_acabando`.
Desativadas: `historico_biometria`, `estoque_movimentos`, `estoque_consumo`.

Trava de piloto: só o número `554884115045` é processado.

## Armadilhas conhecidas (não repetir)

- No editor n8n, expressões vão **sem** o `=` inicial (`{{ ... }}`).
- `projectId` da URL ≠ `workflowId`.
- Parâmetro Bubble tipo `text` não casa com campo do tipo coisa.
- Bubble omite chaves de valor vazio na resposta.
- `filtros` como JSON não é legível no Bubble → usar parâmetros `f_*`.

## Bloqueantes para abrir o piloto

1. **`ag_identificar_usuario` real** buscando `User` por telefone — sem isso
   qualquer testador vê a fazenda do Pablo. → [docs/ag_identificar_usuario.md](docs/ag_identificar_usuario.md)
2. Validação `fk_usuario` × `fk_empresa` nos 5 endpoints.
3. Decidir número dedicado vs. compartilhado com Notificações.

Depois: `version-live`, medir WU/conversa, `EXECUTIONS_DATA_PRUNE`, tokens
para credencial.

## Outros projetos neste repositório

Este repo também guarda o contexto de outra linha de trabalho da Meu Pescado,
com arquitetura diferente (LLM decide a tool, cache em Data Tables): ver
[docs/agente-consultas-whatsapp-ia.md](docs/agente-consultas-whatsapp-ia.md).
