// Gera os arquivos de n8n/nodes/ inlinando n8n/lib/telefone.js.
// Code node do n8n não faz require de arquivo local, então o código precisa
// ir inteiro no campo. Rode `node n8n/build.mjs` depois de mexer na lib.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = dirname(fileURLToPath(import.meta.url));

const lib = readFileSync(join(raiz, 'lib/telefone.js'), 'utf8')
  .replace(/^'use strict';\n/, '')
  .replace(/\nmodule\.exports[\s\S]*$/, '\n')
  .replace(/^\/\/ Fonte única[\s\S]*?por `node n8n\/build\.mjs`.*\n/m, '')
  .trim();

const aviso = `// ⚠️ GERADO por n8n/build.mjs — não edite aqui.
// Edite n8n/lib/telefone.js e rode: node n8n/build.mjs
// Cole o conteúdo abaixo no campo "JavaScript" do Code node.\n`;

const nodes = {
  '01-normalizar-telefone.js': `${aviso}
// Code node: "Normalizar telefone"  (Run Once for All Items)
// Entrada: payload do webhook do BubbleWhats.
// Saída: alvo do casamento + fone4 (o que a busca do Bubble recebe) e a
// consulta ao cache, para não gastar WU quando o usuário já foi identificado.

${lib}

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

const telefone = soDigitos(remetente);
const cache = $getWorkflowStaticData('global');
cache.auth = cache.auth || {};
const TTL_MS = 12 * 60 * 60 * 1000; // sessão de 12 h (ver 05-seguranca-multitenant)

const guardado = cache.auth[telefone];
if (guardado && Date.now() - guardado.ts < TTL_MS) {
  return [{ json: { ...guardado.dados, telefone, cache_hit: true } }];
}
delete cache.auth[telefone]; // expirado

return [{
  json: {
    telefone,
    ddd: alvo.ddd,
    fone8: alvo.fone8,
    fone4: alvo.fone8.slice(-4), // sobrevive à máscara do cadastro
    cache_hit: false,
  },
}];
`,

  '02-validar-identificacao.js': `${aviso}
// Code node: "Validar identificação"  (Run Once for All Items)
// Entrada: resposta de ag_identificar_usuario (nó HTTP Request anterior).
// Saída: { status: ok | nao_encontrado | ambiguo | erro_busca_truncada }
// Só aqui o fk_usuario/fk_empresa do resto do fluxo é definido.

${lib}

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
};

mkdirSync(join(raiz, 'nodes'), { recursive: true });
for (const [nome, conteudo] of Object.entries(nodes)) {
  writeFileSync(join(raiz, 'nodes', nome), conteudo);
  console.log('gerado: n8n/nodes/' + nome);
}
