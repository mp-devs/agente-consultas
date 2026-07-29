// Gera os arquivos de n8n/nodes/ inlinando as libs de n8n/lib/.
// Code node do n8n não faz require de arquivo local, então o código precisa
// ir inteiro no campo. Rode `node n8n/build.mjs` depois de mexer nas libs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = dirname(fileURLToPath(import.meta.url));

// Tira o cabeçalho de módulo para o código poder ser colado direto no n8n.
const carregar = (nome) =>
  readFileSync(join(raiz, 'lib', nome), 'utf8')
    .replace(/^'use strict';\n/, '')
    .replace(/\nmodule\.exports[\s\S]*$/, '\n')
    .trim();

const telefone = carregar('telefone.js');
const escopo = carregar('escopo.js');

const aviso = `// ⚠️ GERADO por n8n/build.mjs — não edite aqui.
// Edite a lib em n8n/lib/ e rode: node n8n/build.mjs
// Cole o conteúdo abaixo no campo "JavaScript" do Code node.\n`;

const nodes = {
  '01-normalizar-telefone.js': `${aviso}
// Workflow: MP - Agente de Consultas
// Code node: "Normalizar telefone"  (Run Once for All Items)
// Entrada: payload do webhook do BubbleWhats.
// Saída: alvo do casamento + fone4 (o que a busca do Bubble recebe) e a
// consulta ao cache, para não gastar WU quando o usuário já foi identificado.

${telefone}

const ENTRADA = $json.body ?? $json;
const remetente = String(
  ENTRADA.from ?? ENTRADA.telefone ?? ENTRADA.sender ?? ENTRADA.chatId ?? ''
);

// Grupo e status do WhatsApp não são conversa com produtor.
if (/@g\\.us|status@broadcast/.test(remetente)) {
  return [{ json: { status: 'ignorar', motivo: 'grupo_ou_status' } }];
}

const alvo = normalizar(remetente);
if (!alvo || !alvo.ddd) {
  return [{ json: { status: 'telefone_invalido', telefone: soDigitos(remetente) } }];
}

const telefoneLimpo = soDigitos(remetente);
const cache = $getWorkflowStaticData('global');
cache.auth = cache.auth || {};
const TTL_MS = 12 * 60 * 60 * 1000; // sessão de 12 h (ver 05-seguranca-multitenant)

const guardado = cache.auth[telefoneLimpo];
if (guardado && Date.now() - guardado.ts < TTL_MS) {
  return [{ json: { ...guardado.dados, telefone: telefoneLimpo, cache_hit: true } }];
}
delete cache.auth[telefoneLimpo]; // expirado

return [{
  json: {
    telefone: telefoneLimpo,
    ddd: alvo.ddd,
    fone8: alvo.fone8,
    fone4: alvo.fone8.slice(-4), // sobrevive à máscara do cadastro
    cache_hit: false,
  },
}];
`,

  '02-validar-identificacao.js': `${aviso}
// Workflow: MP - Agente de Consultas
// Code node: "Validar identificação"  (Run Once for All Items)
// Entrada: resposta de ag_identificar_usuario (nó HTTP Request anterior).
// Saída: { status, fk_usuario, fk_empresa_atual, empresas[] }
// O escopo do agente é "empresas" (todas as fazendas autorizadas);
// fk_empresa_atual é só a preferência de busca.

${telefone}

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
`,

  '03-resolver-tanque.js': `${aviso}
// Workflow: MP - Executar Consulta
// Code node: "Resolver tanque"  (Run Once for All Items)
// Entrada: $json.termo (o nome que o produtor falou) + o escopo vindo do
// Contexto. O índice de tanques cobre TODAS as fazendas do escopo e está em
// cache, então essa varredura custa zero WU.
// Saída: status ok | ambiguo_fazendas | ambiguo_nomes | nao_encontrado

${escopo}

const ctx = $('Contexto').first().json;
const meuEscopo = {
  fk_empresa_atual: ctx.fk_empresa_atual,
  empresa_atual_nome: ctx.empresa_atual_nome,
  empresas: ctx.empresas || [],
};

const cache = $getWorkflowStaticData('global');
const indice = (cache.indiceTanques || {})[ctx.fk_usuario] || [];

return [{ json: resolverTanque(indice, $json.termo, meuEscopo) }];
`,
};

mkdirSync(join(raiz, 'nodes'), { recursive: true });
for (const [nome, conteudo] of Object.entries(nodes)) {
  writeFileSync(join(raiz, 'nodes', nome), conteudo);
  console.log('gerado: n8n/nodes/' + nome);
}
