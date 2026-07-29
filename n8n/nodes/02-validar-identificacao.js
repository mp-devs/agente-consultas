// ⚠️ GERADO por n8n/build.mjs — não edite aqui.
// Edite n8n/lib/telefone.js e rode: node n8n/build.mjs
// Cole o conteúdo abaixo no campo "JavaScript" do Code node.

// Code node: "Validar identificação"  (Run Once for All Items)
// Entrada: resposta de ag_identificar_usuario (nó HTTP Request anterior).
// Saída: { status: ok | nao_encontrado | ambiguo | erro_busca_truncada }
// Só aqui o fk_usuario/fk_empresa do resto do fluxo é definido.

// Casamento de telefone brasileiro entre o WhatsApp e o cadastro do Bubble.

const soDigitos = (s) => String(s ?? '').replace(/\D/g, '');

// Normaliza um telefone BR para { ddd, fone8 }.
// `ddd` vem null quando o cadastro guardou o número sem DDD (8 ou 9 dígitos).
function normalizar(bruto) {
  let d = soDigitos(bruto);

  // DDI só é removido quando o resto ainda tem tamanho de número nacional;
  // caso contrário "5548841150" (DDD 55, fixo) viraria 8 dígitos sem DDD.
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2);
  if (d.startsWith('0') && d.length > 9) d = d.slice(1); // 0 de operadora

  if (d.length === 10 || d.length === 11) {
    return { ddd: d.slice(0, 2), fone8: d.slice(-8) };
  }
  if (d.length === 8 || d.length === 9) {
    return { ddd: null, fone8: d.slice(-8) };
  }
  return null;
}

// Um campo de cadastro pode ter vários números ("48 99988-7766 / (48) 3333-4444").
const separar = (campo) =>
  String(campo ?? '')
    .split(/[,;/\n]| ou /i)
    .map((t) => t.trim())
    .filter((t) => soDigitos(t).length >= 8);

// Compara um telefone do cadastro com o alvo do WhatsApp.
// 'forte' = DDD e 8 dígitos finais batem. 'fraca' = cadastro sem DDD.
function comparar(armazenado, alvo) {
  const n = normalizar(armazenado);
  if (!n || n.fone8 !== alvo.fone8) return null;
  if (n.ddd === null) return 'fraca';
  return n.ddd === alvo.ddd ? 'forte' : null;
}

function casa(campoTelefones, alvo) {
  let melhor = null;
  for (const t of separar(campoTelefones)) {
    const r = comparar(t, alvo);
    if (r === 'forte') return 'forte';
    if (r === 'fraca') melhor = 'fraca';
  }
  return melhor;
}

// Decide quem é o usuário. Erra sempre para o lado seguro: na dúvida entre
// dois cadastros, ninguém é identificado (melhor um chamado no suporte que
// entregar a fazenda do vizinho).
function identificar(candidatos, alvo, meta = {}) {
  const achados = [];
  for (const c of candidatos || []) {
    const forca = casa(c.telefones, alvo);
    if (forca) achados.push({ ...c, forca });
  }

  // Mesmo usuário pode voltar repetido se tiver o número em dois campos.
  const unicos = [...new Map(achados.map((u) => [u.usuario_id, u])).values()];

  // Match exato ganha de match sem DDD: um cadastro incompleto de outro
  // estado não deve bloquear quem bateu certinho.
  const fortes = unicos.filter((u) => u.forca === 'forte');
  const finais = fortes.length ? fortes : unicos;

  if (finais.length === 0) {
    // A busca do Bubble foi truncada? Então o usuário certo pode ter ficado
    // de fora — é falha técnica, não "número não cadastrado".
    if (meta.truncado) return { status: 'erro_busca_truncada' };
    return { status: 'nao_encontrado' };
  }
  if (finais.length > 1) {
    return { status: 'ambiguo', usuarios: finais.map((u) => u.usuario_id) };
  }

  const u = finais[0];
  return {
    status: 'ok',
    fk_usuario: u.usuario_id,
    fk_empresa: u.empresa_id,
    usuario_nome: u.usuario_nome,
    empresa_nome: u.empresa_nome,
    match: u.forca,
  };
}

// Resposta do Bubble no padrão do projeto: "colunas" + "itens" (| e ;;).
// Lembrete: o Bubble omite chaves de valor vazio, então "itens" pode faltar.
function parseLista(resp) {
  const colunas = String(resp?.colunas ?? '').split('|').map((c) => c.trim());
  return String(resp?.itens ?? '')
    .split(';;')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((linha) => {
      const v = linha.split('|').map((c) => c.trim());
      return Object.fromEntries(colunas.map((c, i) => [c, v[i] ?? '']));
    });
}

const alvo = $('Normalizar telefone').first().json;
const resp = $json.response ?? $json;

const candidatos = parseLista(resp);
const qtd = Number(resp.qtd ?? candidatos.length);
const truncado = qtd > candidatos.length;

const r = identificar(candidatos, { ddd: alvo.ddd, fone8: alvo.fone8 }, { truncado });
const saida = { ...r, telefone: alvo.telefone, cache_hit: false };

if (r.status === 'ok') {
  const cache = $getWorkflowStaticData('global');
  cache.auth = cache.auth || {};
  cache.auth[alvo.telefone] = { ts: Date.now(), dados: r };
}

if (r.status === 'ambiguo') {
  // Telefone repetido em dois cadastros: erro de dado que precisa de humano.
  console.warn('[auth] telefone ambiguo', alvo.telefone, r.usuarios);
}

return [{ json: saida }];
