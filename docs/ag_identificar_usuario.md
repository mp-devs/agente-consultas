# `ag_identificar_usuario` — busca real por telefone (Item 1 do piloto)

Objetivo: substituir a versão de fumaça (que devolve sempre o usuário/fazenda
do Pablo) por uma busca real de `User` pelo telefone que chega do WhatsApp.
Sem isso, qualquer testador vê a fazenda do Pablo.

## O problema central: formato de telefone

O mesmo número aparece de várias formas:

| Origem | Exemplo |
|---|---|
| WhatsApp (BubbleWhats) | `554884115045` (sem o 9 extra, com DDI 55) |
| Cadastro no Bubble | `(48) 99115-0455`, `48 84115045`, `+55 48 8411-5045`… |

Um "contains" ingênuo não casa. A âncora confiável de um número brasileiro é
**DDD + últimos 8 dígitos** — o DDI (`55`) e o nono dígito (`9`) são
opcionais/instáveis.

## Divisão de responsabilidade

- **n8n normaliza** (extrai DDD e últimos 8 dígitos do número do WhatsApp).
- **Bubble busca largo** (um único `contains` pelos últimos 8 dígitos) e
  devolve os candidatos com seus telefones cadastrados.
- **n8n valida fino** (regex com DDD adjacente) e decide: 1 usuário → segue;
  0 → mensagem de "não reconhecido"; 2+ → mensagem de ambiguidade.

Assim o Bubble fica com uma busca simples (sem advanced filter, barato em WU)
e a lógica delicada fica em código no n8n, onde é testável.

## Passo 1 — Endpoint no Bubble

Backend workflow `ag_identificar_usuario` (substituir o conteúdo da versão de
fumaça, mantendo o mesmo nome/URL):

**Configuração** (padrão do projeto):
- `Expose as a public API workflow` ✅
- `Ignore privacy rules when running the workflow` ✅

**Parâmetro** (remover os antigos, se houver):
- `fone8` — tipo `text`. Últimos 8 dígitos do telefone (ex.: `84115045`).

**Ação única — `Return data from API`**, com a busca:
`Do a search for Users` com constraint `telefones contains fone8`.

> Se o campo de telefone do `User` tiver outro nome, ajustar. Se houver
> mais de um campo (ex.: `telefone` e `celular`), concatenar os dois na
> expressão de cada coluna ou duplicar a constraint via `OR` — na dúvida,
> devolver os dois campos na coluna `telefones`.

Campos retornados (padrão `colunas` + `itens`, `|` entre colunas, `;;` entre
linhas):

- `colunas` (text): `usuario_id|usuario_nome|telefones|empresa_id|empresa_nome`
- `itens` (text): `Search for Users:items until #10 :format as text`, com o
  conteúdo por item:
  `This User's unique id | This User's nome | This User's telefones | This User's empresa's unique id | This User's empresa's nome`
  e delimitador `;;`.
- `qtd` (number): `Search for Users:count`

> Ajustar `empresa` para o nome real do campo que liga o `User` à empresa
> (o mesmo usado como `fk_empresa` nos outros endpoints `ag_*`).
> `:items until #10` é só um teto de segurança; o normal é 0 ou 1.

**O que NÃO fazer**: não filtrar por DDD no Bubble com um segundo `contains`
— como `contains` é substring solta, um "48" de outro trecho do texto geraria
falso positivo. A validação de DDD fica no n8n (Passo 2).

## Passo 2 — n8n (workflow `MP - Agente de Consultas`, `O2UTikVA5qMsJsZq`)

Substituir o nó de auth atual (que chama a versão de fumaça) por:

1. **Code node "Normalizar telefone"** — extrai `ddd` e `fone8` do número do
   webhook. Código em [`n8n/identificar_usuario.js`](../n8n/identificar_usuario.js)
   (bloco 1).
2. **HTTP Request "ag_identificar_usuario"** — `POST` no endpoint com body
   `{ "fone8": {{ $json.fone8 }} }`. Lembrete: expressões **sem** o `=`
   inicial no editor.
3. **Code node "Validar identificação"** — parseia `colunas`/`itens`, aplica a
   regex `(?:55)?\s*0?DDD\s*9?\s*FONE8` sobre cada telefone cadastrado
   (dígitos apenas) e classifica o resultado (bloco 2 do mesmo arquivo).
   Também mantém **cache em `$getWorkflowStaticData('global')`** por telefone
   (TTL 12 h) para não gastar WU a cada mensagem.
4. **IF "identificado?"**:
   - `status = ok` → segue para o agente com `fk_usuario` e `fk_empresa` do
     resultado (fim dos valores hardcoded no fluxo).
   - `status = nao_encontrado` → `POST /send-message` com:
     "Olá! Não encontrei seu número no Meu Pescado. Confira se o telefone
     cadastrado no app é este mesmo ou fale com o suporte." → encerra.
   - `status = ambiguo` → mensagem pedindo contato com o suporte → encerra
     (e logar, porque indica telefone duplicado no cadastro).

**Trava de piloto**: manter o filtro do número `554884115045` por enquanto.
Ela só sai depois que o Item 2 (validação `fk_usuario` × `fk_empresa` nos 5
endpoints) estiver no ar — a partir daí, "estar identificado" passa a ser a
própria trava.

## Passo 3 — Teste (antes de mexer no n8n)

Direto no endpoint (version-test), com `curl`:

```bash
BASE="https://<app>/version-test/api/1.1/wf"

# 1. Telefone do Pablo → deve voltar qtd=1 e a fazenda dele
curl -s -X POST "$BASE/ag_identificar_usuario" \
  -H 'Content-Type: application/json' \
  -d '{"fone8": "84115045"}'

# 2. Número inexistente → qtd=0, itens vazio
curl -s -X POST "$BASE/ag_identificar_usuario" \
  -H 'Content-Type: application/json' \
  -d '{"fone8": "00000000"}'
```

Lembrete: o Bubble **omite chaves de valor vazio** — com 0 resultados,
`itens` pode nem vir na resposta; o código do n8n já trata isso.

Depois do n8n atualizado, teste fim-a-fim pelo WhatsApp com o número do
piloto e confira no log de execução que `fk_usuario`/`fk_empresa` vieram da
busca, não do hardcode.

## Casos de borda cobertos

- Nono dígito: `9` opcional na regex — casa `84115045` e `984115045`.
- DDI: `55` opcional; zero à esquerda no DDD (`048`) também.
- Máscara no cadastro (`(48) 8411-5045`): o n8n remove tudo que não é dígito
  antes de comparar.
- Vários telefones no campo (separados por vírgula): a regex roda sobre o
  campo inteiro já limpo — qualquer um dos números casando, identifica.
- Mesmo `fone8` em DDDs diferentes: a regex exige o DDD adjacente, então não
  colide.
- Usuário com telefone duplicado em dois cadastros: `status = ambiguo`,
  ninguém vê dado de fazenda alheia.
