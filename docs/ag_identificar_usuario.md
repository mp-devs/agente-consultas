# `ag_identificar_usuario` — busca real por telefone (Item 1 do piloto)

Substituir a versão de fumaça (que devolve sempre o usuário/fazenda do Pablo)
por uma busca real de `User` pelo telefone que chega do WhatsApp. Sem isso,
qualquer testador vê a fazenda do Pablo.

Código pronto e testado: [`n8n/lib/telefone.js`](../n8n/lib/telefone.js)
(fonte) → [`n8n/nodes/`](../n8n/nodes) (o que se cola no n8n).
`npm test` roda 35 casos, incluindo os de vazamento.

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
| `colunas` (text) | `usuario_id|usuario_nome|telefones|empresa_atual_id|empresa_atual_nome|empresas` |
| `itens` (text) | `Search for Users:items until #50 :format as text` (conteúdo abaixo), delimitador `;;` |
| `qtd` (number) | `Search for Users:count` |

Conteúdo de cada item no `:format as text`, separado por `|`:

1. `This User's unique id`
2. `This User's nome`
3. `This User's whatsapp` ← o campo mascarado, sem tratamento
4. `This User's empresa's unique id` ← a fazenda **logada**
5. `This User's empresa's nome`
6. `This User's fk_lista_empresas:format as text` ← a lista **autorizada**

O item 6 é um `:format as text` dentro do outro. Na caixinha dele:

- **Conteúdo:** `This Empresa's unique id` + `:` + `This Empresa's nome`
- **Delimitador:** `^`

Resultado: `1699e1:Fazenda Boa Vista^1699e2:Sítio das Águas`. O n8n desmonta
isso (`parseEmpresas`, testado, inclusive com nome de fazenda contendo `:`).

> **Por que os dois** — `empresa` é a fazenda logada no momento, que serve de
> preferência de busca; `fk_lista_empresas` é a fronteira de permissão de
> verdade. Ver [`multi-fazenda.md`](multi-fazenda.md).

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

**A confirmar no editor** (não tenho acesso ao schema): o nome real do campo
de telefone do `User` — a doc antiga chama de `whatsapp`. Se houver mais de um
(ex.: `whatsapp` e `telefone`), concatene os dois na coluna `telefones`
separados por vírgula: o n8n já trata campo com vários números.

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
| `ok` | Segue para o agente com `fk_usuario`, `fk_empresa_atual` e `empresas` — fim dos valores hardcoded |
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

O teste é **pelo WhatsApp**, mandando mensagem de verdade. Não precisa de
terminal: o log de execução do n8n mostra a resposta crua do Bubble, que é
justamente o que se quer inspecionar.

**Roteiro:** monte o endpoint → monte os nós do n8n → mande uma mensagem
qualquer do número do piloto → abra a execução no n8n.

No nó **HTTP Request "ag_identificar_usuario"**, aba *Output*, confira:

| O que olhar | Esperado | Se vier diferente |
|---|---|---|
| `itens` | Traz o telefone **com a máscara** (`(48) 8411-5045`) | Se vier vazio, o campo de telefone tem outro nome — ajuste a constraint |
| `qtd` | `1` | Se vier alto (dezenas), a base é maior do que supus: me avise que a gente reconsidera o campo normalizado |
| `empresa_atual_id` | Preenchido | Vazio = o campo da fazenda logada tem outro nome |
| `empresas` | `id:Nome^id:Nome` | Vazio = o vínculo não é `fk_lista_empresas` |

No nó **"Validar identificação"**, aba *Output*: `status` deve ser `ok`, com
`fk_usuario`, `fk_empresa_atual` e `empresas` — vindos da busca, não do
hardcode. É esse o critério de pronto do Item 1.

Vale mandar uma segunda mensagem logo em seguida: a execução deve mostrar
`cache_hit: true` e **nem chamar** o Bubble. Se chamar, o cache não pegou.

Casos que valem testar depois, ainda pelo WhatsApp:

| Teste | Esperado |
|---|---|
| Mensagem de um número não cadastrado | "não encontrei seu número" — e **zero** chamada de LLM (teste #5 de vazamento) |
| Perguntar por um tanque que é de outra fazenda sua | Responde dizendo de qual fazenda é |
| Perguntar por um tanque que não existe em nenhuma | Diz que não achou e em quais fazendas procurou |

> Lembre que o Bubble **omite chaves de valor vazio**: com 0 resultados,
> `itens` pode nem aparecer na resposta. O código já trata isso
> (`parseLista({})` → `[]`, testado).

---

## 5. Casos cobertos por teste automatizado

`npm test` — 22 casos de telefone em [`n8n/lib/telefone.test.js`](../n8n/lib/telefone.test.js):

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
