// ⚠️ GERADO por n8n/build.mjs — não edite aqui.
// Edite a lib em n8n/lib/ e rode: node n8n/build.mjs
// Cole o conteúdo abaixo no campo "JavaScript" do Code node.

// Workflow: MP - Executar Consulta
// Code node: "Resolver tanque"  (Run Once for All Items)
// Entrada: $json.termo (o nome que o produtor falou) + o escopo vindo do
// Contexto. O índice de tanques cobre TODAS as fazendas do escopo e está em
// cache, então essa varredura custa zero WU.
// Saída: status ok | ambiguo_fazendas | ambiguo_nomes | nao_encontrado

// Escopo multi-fazenda.
//
// A fazenda logada no app (`empresa` do user) é PREFERÊNCIA de busca, não
// muro: o produtor não deve precisar entrar no sistema e trocar de empresa
// para perguntar sobre um tanque de outra fazenda dele. A fronteira de
// permissão continua sendo `fk_lista_empresas` — quem não está lá não existe.
//
// escopo = {
//   fk_empresa_atual, empresa_atual_nome,
//   empresas: [{ id, nome }]        // todas as que o usuário pode acessar
// }

// Chave de comparação de nome livre: "Berçário 03" ≈ "bercario 3".
function chave(nome) {
  return String(nome ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // tira acento
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\b0+(\d)/g, '$1'); // "03" -> "3"
}

const compacta = (nome) => chave(nome).replace(/ /g, '');

// Fazenda logada primeiro, o resto depois — a ordem de desempate.
function ordemBusca(escopo) {
  const ids = (escopo.empresas ?? []).map((e) => e.id);
  const atual = escopo.fk_empresa_atual;
  return atual && ids.includes(atual) ? [atual, ...ids.filter((i) => i !== atual)] : ids;
}

const multiFazenda = (escopo) => (escopo.empresas ?? []).length > 1;

const nomeEmpresa = (escopo, id) =>
  (escopo.empresas ?? []).find((e) => e.id === id)?.nome ?? '';

// Resolve o nome que o produtor falou dentro do índice de tanques.
//
// indice = [{ id, nome, empresa_id }] — o índice já cobre TODAS as fazendas
// do escopo e fica em cache no n8n, então essa varredura custa zero WU.
//
// Precedência: match exato ganha de parcial mesmo que o exato esteja em outra
// fazenda (nome batendo certinho é evidência mais forte que a fazenda logada);
// entre iguais, a fazenda logada ganha.
function resolverTanque(indice, termo, escopo) {
  const ordem = ordemBusca(escopo);
  const noEscopo = (indice ?? []).filter((t) => ordem.includes(t.empresa_id));
  const posicao = (t) => ordem.indexOf(t.empresa_id);
  const k = chave(termo);
  const kc = compacta(termo);

  if (!k) return { status: 'nao_encontrado', empresas: ordem.map((id) => nomeEmpresa(escopo, id)) };

  const exatos = noEscopo.filter((t) => chave(t.nome) === k);
  const parciais = noEscopo.filter((t) => {
    const n = chave(t.nome);
    return n !== k && (n.includes(k) || k.includes(n) || compacta(t.nome).includes(kc));
  });

  const achados = (exatos.length ? exatos : parciais).sort((a, b) => posicao(a) - posicao(b));

  if (achados.length === 0) {
    return { status: 'nao_encontrado', empresas: ordem.map((id) => nomeEmpresa(escopo, id)) };
  }

  const fazendas = new Set(achados.map((t) => t.empresa_id));

  // Mesmo nome em duas fazendas (comum: "Berçário 01" existe em ambas).
  // Não escolher sozinho — perguntar, mostrando de quais fazendas se trata.
  if (fazendas.size > 1) {
    return {
      status: 'ambiguo_fazendas',
      candidatos: achados.map((t) => ({ ...t, empresa_nome: nomeEmpresa(escopo, t.empresa_id) })),
    };
  }

  // Vários tanques diferentes com nome parecido na mesma fazenda.
  if (achados.length > 1) {
    return {
      status: 'ambiguo_nomes',
      empresa_id: achados[0].empresa_id,
      empresa_nome: nomeEmpresa(escopo, achados[0].empresa_id),
      candidatos: achados,
    };
  }

  const t = achados[0];
  const fora = t.empresa_id !== escopo.fk_empresa_atual;
  return {
    status: 'ok',
    tanque: t,
    empresa_id: t.empresa_id,
    empresa_nome: nomeEmpresa(escopo, t.empresa_id),
    fora_da_atual: fora,
    // Com mais de uma fazenda o produtor precisa saber de onde veio o dado.
    rotular: multiFazenda(escopo) || fora,
  };
}

// Estoque costuma ter o mesmo item nas duas fazendas. Aí não se pergunta nem
// se soma (unidades vivem no item): mostra-se lado a lado, fazenda logada
// primeiro.
function agruparPorEmpresa(linhas, escopo) {
  const ordem = ordemBusca(escopo);
  return ordem
    .map((id) => ({
      empresa_id: id,
      empresa_nome: nomeEmpresa(escopo, id),
      atual: id === escopo.fk_empresa_atual,
      linhas: (linhas ?? []).filter((l) => l.empresa_id === id),
    }))
    .filter((g) => g.linhas.length > 0);
}

const ctx = $('Contexto').first().json;
const meuEscopo = {
  fk_empresa_atual: ctx.fk_empresa_atual,
  empresa_atual_nome: ctx.empresa_atual_nome,
  empresas: ctx.empresas || [],
};

const cache = $getWorkflowStaticData('global');
const indice = (cache.indiceTanques || {})[ctx.fk_usuario] || [];

return [{ json: resolverTanque(indice, $json.termo, meuEscopo) }];
