# `ag_identificar_usuario` — busca real por telefone (Item 1 do piloto)

Substituir a versão de fumaça (que devolve sempre o usuário/fazenda do Pablo)
por uma busca real de `User` pelo telefone que chega do WhatsApp. Sem isso,
qualquer testador vê a fazenda do Pablo.

Código pronto e testado: [`n8n/lib/telefone.js`](../n8n/lib/telefone.js)
(fonte) → [`n8n/nodes/`](../n8n/nodes) (o que se cola no n8n).
`npm test` roda 21 casos, incluindo os de vazamento.

---

## 1. O problema: o cadastro tem máscara

O mesmo telefone aparece de formas diferentes nas duas pontas:

| Origem | Exemplo |
|---|---|
| WhatsApp (BubbleWhats) | `554884115045@s.whatsapp.net` — só dígitos, com DDI, sem o nono dígito |
| Cadastro no Bubble | `(48) 8411-5045`, `+55 48 98411-5045`, `48 84115045, 48 3333-4444` |

Duas consequências, e a segunda é a que derruba o desenho ingênuo:

1. **DDI e nono dígito são instáveis.** A âncora confiável de um número
   brasileiro é **DDD + os 8 dígitos finais**.
2. **`contains` no Bubble é substring literal no texto cru.** Buscar pelos 8
   dígitos (`84115045`) **não acha** `(48) 8411-5045` — o hífen no meio quebra
   a substring. Um endpoint que busque por 8 dígitos passa no teste com um
   cadastro sem máscara e falha calado em produção.

> `03-passo-a-passo-bubble.md` da branch antiga já apontava isso e propunha
> criar um campo `whats_normalizado` (só dígitos) com backfill + trigger.
> Funciona, mas exige mexer no schema e migrar ~300 fazendas.

### A saída sem mexer no schema: buscar pelos **4 últimos dígitos**

Em toda máscara brasileira a quebra é `xxxxx-5045` ou `xxxx-5045` — os 4
últimos dígitos são **sempre contíguos**, com ou sem máscara, com ou sem DDI,
com ou sem o nono dígito. Então `telefones contains "5045"` acha todo mundo.

E é barato: 4 dígitos são 10.000 combinações. Com a ordem de grandeza de
usuários do app, o retorno típico é **1 linha** (raramente 2–3). A busca larga
não custa WU relevante, e a precisão é recuperada no n8n, onde há código de
verdade.

**Divisão de responsabilidade:**

| Onde | Faz |
|---|---|
| n8n (antes) | Normaliza o número do WhatsApp → `ddd`, `fone8`, `fone4` |
| Bubble | Uma busca simples: `telefones contains fone4` |
| n8n (depois) | Separa os telefones do cadastro, normaliza cada um e compara `ddd` + `fone8` **exatos** |

A comparação final é igualdade exata por número, não regex sobre o campo
inteiro — isso elimina o falso positivo de fronteira, quando o "48" procurado
só existe porque dois telefones diferentes ficaram colados no mesmo campo
(há teste para esse caso).

---

## 2. Endpoint no Bubble

Backend workflow `ag_identificar_usuario` — substituir o conteúdo da versão de
fumaça, mantendo nome e URL.

**Configuração** (padrão do projeto):
- `Expose as a public API workflow` ✅
- `Ignore privacy rules when running the workflow` ✅
- Autenticação ligada (roda com o `Authorization: Bearer <API_TOKEN>`)

**Parâmetro** — remover os antigos e deixar só:

| Nome | Tipo | Conteúdo |
|---|---|---|
| `fone4` | `text` | Os 4 últimos dígitos do telefone (ex.: `5045`) |

**Ação única — `Return data from API`**, sobre
`Do a search for Users` com a constraint `telefones contains fone4`.

Campos devolvidos (padrão `colunas` + `itens` do projeto, `|` entre colunas e
`;;` entre linhas):

| Campo | Valor no editor |
|---|---|
| `colunas` (text) | `usuario_id|usuario_nome|telefones|empresa_id|empresa_nome` |
| `itens` (text) | `Search for Users:items until #50 :format as text`, com o item formatado como `This User's unique id \| This User's nome \| This User's telefones \| This User's empresa's unique id \| This User's empresa's nome` e delimitador `;;` |
| `qtd` (number) | `Search for Users:count` |

Três detalhes que não são decorativos:

- **`qtd` é o total, não o que coube em `itens`.** O n8n compara os dois: se
  `qtd > linhas recebidas`, a busca foi truncada e ele devolve
  `erro_busca_truncada` em vez de "número não cadastrado" — um truncamento
  silencioso identificaria a pessoa errada ou negaria acesso a quem tem
  cadastro.
- **`:items until #50`** é teto de segurança. Com 4 dígitos o normal é 1.
- **Não filtre por DDD no Bubble** com um segundo `contains`. Como `contains`
  é substring solta, um "48" vindo de outro trecho do texto casaria à toa. O
  DDD é conferido no n8n, com adjacência garantida.

**Dois pontos a confirmar no editor** (não tenho acesso ao schema):

1. O nome real do campo de telefone do `User`. Se houver mais de um
   (ex.: `telefone` e `celular`), concatene os dois na coluna `telefones`
   separados por vírgula — o n8n já trata campo com vários números.
2. O campo que liga `User` → empresa. A doc antiga menciona
   `fk_lista_empresas` (lista, usuário pode ter mais de uma fazenda). Se for
   lista, use `:first item` por enquanto e me avise: usuário multi-fazenda
   precisa que o agente pergunte "qual fazenda?", e isso é escopo próprio.

---

## 3. Fluxo no n8n (`MP - Agente de Consultas`, `O2UTikVA5qMsJsZq`)

Substituir o nó de auth atual (que chama a versão de fumaça) por cinco nós:

```
Webhook → [1] Normalizar telefone → IF "cache?" ─sim→ Agente
                                       │
                                       └─não→ [2] HTTP ag_identificar_usuario
                                                → [3] Validar identificação
                                                → Switch "status" → Agente | mensagens
```

**[1] Code — "Normalizar telefone"**
Cole [`n8n/nodes/01-normalizar-telefone.js`](../n8n/nodes/01-normalizar-telefone.js).
Extrai `ddd`/`fone8`/`fone4`, ignora mensagem de grupo e status, e **consulta o
cache** (`$getWorkflowStaticData`, TTL 12 h — a mesma janela de sessão do
`05-seguranca-multitenant.md`). Cache hit sai com os dados prontos e o fluxo
pula o Bubble: uma busca por usuário por dia, não uma por mensagem.

**IF "cache?"** — condição booleana `{{ $json.cache_hit }}`.
Lembrete: no editor do n8n a expressão vai **sem** o `=` inicial.

**[2] HTTP Request — "ag_identificar_usuario"**
`POST {{ $env.BUBBLE_API_BASE }}/ag_identificar_usuario`, body JSON:
`{ "fone4": "{{ $json.fone4 }}" }`, header de autenticação pela credencial.

**[3] Code — "Validar identificação"**
Cole [`n8n/nodes/02-validar-identificacao.js`](../n8n/nodes/02-validar-identificacao.js).
Parseia `colunas`/`itens`, detecta truncamento, casa os telefones, grava o
cache no sucesso e loga quando dá ambiguidade.

**Switch por `status`:**

| `status` | O que fazer |
|---|---|
| `ok` | Segue para o agente com `fk_usuario` e `fk_empresa` do resultado — fim dos valores hardcoded |
| `nao_encontrado` | "Olá! Não encontrei seu número aqui no Meu Pescado. Confira com o administrador da sua fazenda se o telefone cadastrado é este mesmo." |
| `ambiguo` | "Não consegui confirmar seu cadastro. Já avisei o suporte, em breve alguém te procura." + alerta interno (é telefone duplicado em dois `User`) |
| `erro_busca_truncada` | Mesma mensagem de `ambiguo`. É falha técnica, não do usuário |
| `telefone_invalido` | Encerra sem responder |
| `ignorar` | Encerra sem responder (grupo/status do WhatsApp) |

Nenhum desses caminhos chama o LLM — o teste #5 de vazamento
(`05-seguranca-multitenant.md`) exige exatamente isso.

**Trava de piloto:** manter o filtro do número `554884115045`. Ela só sai
depois do Item 2 (validação `fk_usuario` × `fk_empresa` nos 5 endpoints); a
partir daí "estar identificado" passa a ser a própria trava.

---

## 4. Teste

**Antes de mexer no n8n**, direto no endpoint (version-test):

```bash
BASE="https://app.meupescado.com.br/version-test/api/1.1/wf"
TOKEN="<API_TOKEN>"

# 1. Últimos 4 dígitos do Pablo → deve voltar o cadastro dele
curl -s -X POST "$BASE/ag_identificar_usuario" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"fone4": "5045"}'

# 2. Sequência inexistente → qtd 0
curl -s -X POST "$BASE/ag_identificar_usuario" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"fone4": "0000"}'
```

O que olhar na resposta do teste 1: se `itens` traz o telefone **com a máscara
do cadastro**, o desenho está certo — é justamente o que o n8n sabe tratar. Se
`qtd` vier alto (dezenas), me avise: quer dizer que a base é maior do que eu
supus e vale reconsiderar o campo normalizado.

Lembre que o Bubble **omite chaves de valor vazio**: com 0 resultados, `itens`
pode nem aparecer. O código já trata (`parseLista({})` → `[]`, testado).

**Depois do n8n atualizado**, ponta a ponta pelo WhatsApp com o número do
piloto, conferindo no log de execução que `fk_usuario`/`fk_empresa` vieram da
busca e não do hardcode. E rode os testes 1, 3 e 5 de vazamento do
`05-seguranca-multitenant.md`.

---

## 5. Casos cobertos por teste automatizado

`npm test` — 21 casos em [`n8n/lib/telefone.test.js`](../n8n/lib/telefone.test.js):

| Caso | Comportamento |
|---|---|
| Máscara no cadastro x número cru do WhatsApp | Casa |
| Nono dígito presente de um lado só | Casa (a âncora são os 8 finais) |
| DDI, zero de operadora, `+55`, espaços e parênteses | Casa |
| **DDD 55** (Santa Maria/RS) | Não é confundido com o DDI — só remove `55` da frente quando o resto tem tamanho nacional |
| Vários telefones no mesmo campo (`,` `;` `/` `ou`) | Casa se qualquer um bater |
| Dois telefones colados formando um "48" na fronteira | **Não** casa (falso positivo evitado) |
| DDD diferente com os mesmos 8 dígitos finais | **Não** casa |
| Cadastro sem DDD (`8411-5045`) | Casa fraco; match forte tem prioridade |
| Mesmo telefone em dois `User` | `ambiguo` — ninguém vê dado de ninguém |
| Mesmo `User` repetido na resposta | `ok` (dedup por `usuario_id`) |
| Busca truncada | `erro_busca_truncada`, nunca "não cadastrado" |
| Resposta do Bubble sem a chave `itens` | Lista vazia, sem exceção |

---

## 6. Manutenção

A lógica vive em `n8n/lib/telefone.js` (com testes). Os arquivos de
`n8n/nodes/` são **gerados** — Code node do n8n não importa módulo local, então
o código vai inteiro no campo. Depois de qualquer mudança:

```bash
npm test && npm run build
```

Nunca edite `n8n/nodes/*.js` à mão: o build sobrescreve.
