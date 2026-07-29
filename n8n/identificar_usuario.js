// ============================================================
// BLOCO 1 — Code node "Normalizar telefone"
// Entrada: item do webhook BubbleWhats (número em $json.from ou similar)
// Saída: { telefone, ddd, fone8 } — ou erro se o número não for BR válido
// ============================================================

const bruto = String($json.from ?? $json.telefone ?? '');
// remove sufixo de JID (ex.: "554884115045@s.whatsapp.net") e não-dígitos
const digitos = bruto.replace(/@.*$/, '').replace(/\D/g, '');

// tira DDI 55 se presente (número BR: 10 ou 11 dígitos após o DDI)
let nacional = digitos;
if (nacional.startsWith('55') && (nacional.length === 12 || nacional.length === 13)) {
  nacional = nacional.slice(2);
}
// tira zero de operadora à esquerda (ex.: 048...)
if (nacional.startsWith('0')) nacional = nacional.slice(1);

if (nacional.length !== 10 && nacional.length !== 11) {
  return [{ json: { status: 'telefone_invalido', telefone: digitos } }];
}

const ddd = nacional.slice(0, 2);
const fone8 = nacional.slice(-8); // últimos 8 dígitos: ignora o nono dígito

return [{ json: { telefone: digitos, ddd, fone8 } }];


// ============================================================
// BLOCO 2 — Code node "Validar identificação"
// Antes do HTTP Request, checar o cache; aqui assumimos que o nó anterior
// é o HTTP Request para ag_identificar_usuario e que os dados da
// normalização estão acessíveis via $('Normalizar telefone').
// Saída: { status: 'ok'|'nao_encontrado'|'ambiguo', fk_usuario, fk_empresa,
//          usuario_nome, empresa_nome }
// ============================================================

const norm = $('Normalizar telefone').first().json;
const cache = $getWorkflowStaticData('global');
cache.auth = cache.auth || {};

// cache hit (TTL 12h) — evita WU no Bubble a cada mensagem
const TTL = 12 * 60 * 60 * 1000;
const hit = cache.auth[norm.telefone];
if (hit && Date.now() - hit.ts < TTL) {
  return [{ json: { ...hit.dados, cache: true } }];
}

const resp = $json.response ?? $json;
// Bubble omite chaves vazias: sem resultados, "itens" pode não existir
const colunas = (resp.colunas ?? '').split('|').map(c => c.trim());
const linhas = (resp.itens ?? '')
  .split(';;')
  .map(l => l.trim())
  .filter(Boolean);

// regex: DDI 55 opcional, zero opcional, DDD obrigatório, nono dígito
// opcional, últimos 8 dígitos — tudo adjacente
const re = new RegExp(`(?:55)?0?${norm.ddd}9?${norm.fone8}`);

const candidatos = linhas
  .map(l => {
    const v = l.split('|').map(c => c.trim());
    return Object.fromEntries(colunas.map((c, i) => [c, v[i] ?? '']));
  })
  .filter(u => re.test((u.telefones ?? '').replace(/\D/g, '')));

// dedup por usuario_id (mesmo user pode aparecer 2x se telefones repetem)
const unicos = [...new Map(candidatos.map(u => [u.usuario_id, u])).values()];

if (unicos.length === 0) {
  return [{ json: { status: 'nao_encontrado', telefone: norm.telefone } }];
}
if (unicos.length > 1) {
  // telefone presente em mais de um cadastro — não arriscar dado alheio
  return [{ json: { status: 'ambiguo', telefone: norm.telefone,
                    usuarios: unicos.map(u => u.usuario_id) } }];
}

const u = unicos[0];
const dados = {
  status: 'ok',
  fk_usuario: u.usuario_id,
  fk_empresa: u.empresa_id,
  usuario_nome: u.usuario_nome,
  empresa_nome: u.empresa_nome,
};
cache.auth[norm.telefone] = { ts: Date.now(), dados };
return [{ json: dados }];
