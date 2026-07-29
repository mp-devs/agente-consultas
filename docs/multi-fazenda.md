# Multi-fazenda: escopo, preferência e rótulo

Como o agente se comporta quando o produtor tem mais de uma fazenda.
Lógica implementada e testada em [`n8n/lib/escopo.js`](../n8n/lib/escopo.js)
(13 testes em `escopo.test.js`).

---

## 1. Os dois campos não são a mesma coisa

| Campo no `user` | O que é | Papel no agente |
|---|---|---|
| `empresa` | A fazenda em que ele está **logado agora** no app. Muda quando ele troca de empresa na tela. | **Preferência** de busca |
| `fk_lista_empresas` | As fazendas cujos dados ele **pode** acessar | **Fronteira de permissão** |

O erro que isso corrige: tratar a fazenda logada como fronteira. O produtor
teria que sair da conversa, entrar no sistema, trocar de empresa e voltar —
só para perguntar de um tanque que é dele do mesmo jeito.

**Regra:** o escopo do agente é `fk_lista_empresas`. A fazenda logada só
decide *por onde começar a procurar* e o que responder quando há empate.

### Isso não afrouxa o isolamento

A fronteira passa a ser exatamente a lista que o app já define como
autorizada — nem um registro além. As 4 camadas do
`05-seguranca-multitenant.md` continuam valendo, com uma troca de "igual a"
por "está contida em":

- **Camada 1** — o n8n injeta o escopo (`fieldValue`), o LLM nunca preenche.
- **Camada 2** — o Bubble valida que **toda** empresa recebida está em
  `fk_lista_empresas` do `fk_usuario`. Se qualquer uma não estiver, retorna
  `acesso_negado` e para. É a mesma validação de antes, aplicada à lista.
- **Camada 3** — toda busca filtra por `fk_empresa is in fk_empresas`.
- **Camada 4** — o prompt, que segue sendo a camada mais fraca.

Efeito colateral bom: como a busca varre todas as fazendas, a fazenda logada
ficar desatualizada no cache de 12 h **não trava mais nada** — ela virou
ordenação, não permissão.

---

## 2. Ordem de resolução de um tanque

O produtor fala "Berçário 03". O índice de tanques em cache já cobre todas as
fazendas do escopo, então essa varredura custa **zero WU**.

1. **Nome exato**, em qualquer fazenda do escopo — fazenda logada primeiro.
2. Se não houver exato, **nome parecido**, mesma ordem.

> Exato ganha de parecido mesmo estando em outra fazenda: se a logada tem
> "Berçário 03B" e a outra tem "Berçário 03", o produtor quis o segundo.
> Entre dois exatos, a fazenda logada ganha.

Comparação por nome é tolerante: sem acento, sem caixa, sem zero à esquerda —
`"berçario 3"` acha `"Berçário 03"`.

### Os quatro desfechos

| Situação | `status` | O que o agente responde |
|---|---|---|
| Achou um, na fazenda logada | `ok` (`fora_da_atual: false`) | Responde direto |
| Achou um, em outra fazenda dele | `ok` (`fora_da_atual: true`) | Responde **dizendo de qual fazenda é** |
| Mesmo nome em duas fazendas | `ambiguo_fazendas` | Pergunta de qual, listando os nomes |
| Vários parecidos na mesma fazenda | `ambiguo_nomes` | Pergunta qual, listando os tanques |
| Não existe em nenhuma | `nao_encontrado` | Diz que não achou **e em quais fazendas procurou** |

Exemplos de fala:

> **Fora da logada** — "O *Desova 01* é do **Sítio das Águas** (você está no
> *Boa Vista* agora). Lá o peso médio é 12,4 g…"

> **Ambíguo entre fazendas** — "Você tem um *Berçário 01* em cada fazenda.
> Quer o do **Boa Vista** (onde você está) ou o do **Sítio das Águas**?"

> **Não encontrado** — "Não achei nenhum tanque chamado *Engorda 7* — procurei
> no *Boa Vista* e no *Sítio das Águas*."

---

## 3. Quando rotular a fazenda

O campo `rotular` sai pronto do resolvedor:

- **Produtor com uma fazenda só → nunca rotula.** É a maioria dos casos e o
  nome da fazenda em toda resposta vira ruído.
- **Produtor com duas ou mais → rotula.** Ele precisa saber de onde veio o
  número, e de quebra entende em qual está logado.

---

## 4. Estoque é diferente: mostra lado a lado

O mesmo item costuma existir nas duas fazendas com o mesmo nome. Aqui não se
pergunta nem se escolhe — e **não se soma** (a unidade vive no item, e são
estoques fisicamente separados). Mostra-se cada fazenda, a logada primeiro:

> "Ração 32%: **Boa Vista** 1.200 kg · **Sítio das Águas** 800 kg"

Implementado em `agruparPorEmpresa`. Fazenda sem aquele item não aparece.

---

## 5. O que muda nos endpoints `ag_*`

Todos passam a receber a lista, não uma empresa:

| Antes | Depois |
|---|---|
| `fk_empresa` (text) | `fk_empresas` — tipo da tabela de empresa, **is a list** ✅ |
| constraint `fk_empresa = fk_empresa` | constraint `fk_empresa is in fk_empresas` |
| — | toda linha retornada ganha a coluna `empresa_id` |

Duas razões para mandar a lista inteira numa chamada só, em vez de chamar o
endpoint uma vez por fazenda: gasta menos WU e evita o vaivém de "não achei,
tenta na outra".

`ag_identificar_usuario` passa a devolver as duas coisas: a fazenda logada e a
lista autorizada — ver [`ag_identificar_usuario.md`](ag_identificar_usuario.md).

O `ag_indice_tanques` passa a indexar todas as fazendas do escopo de uma vez,
com `empresa_id` em cada tanque. É o que faz o resolvedor conseguir dizer "esse
tanque é do Sítio das Águas" sem nenhuma chamada extra.

---

## 6. Ordem de implantação sugerida

1. `ag_identificar_usuario` devolvendo `empresa_atual` + `empresas` ← **agora**
2. `ag_indice_tanques` aceitando `fk_empresas` (lista) e devolvendo `empresa_id`
3. Nó "Resolver tanque" no *MP - Executar Consulta*
   ([`n8n/nodes/03-resolver-tanque.js`](../n8n/nodes/03-resolver-tanque.js))
4. Ajuste do system prompt para as falas da seção 2
5. Os demais `ag_*` migrando de `fk_empresa` para `fk_empresas`

Dá para abrir o piloto com um produtor de uma fazenda só depois do passo 1 —
os passos 2 a 5 não mudam nada para quem tem uma fazenda.
