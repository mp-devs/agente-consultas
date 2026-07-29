'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { chave, ordemBusca, resolverTanque, agruparPorEmpresa } = require('./escopo');

// Produtor com duas fazendas, logado na Boa Vista.
const DUAS = {
  fk_empresa_atual: 'e1',
  empresa_atual_nome: 'Fazenda Boa Vista',
  empresas: [
    { id: 'e1', nome: 'Fazenda Boa Vista' },
    { id: 'e2', nome: 'Sítio das Águas' },
  ],
};
const UMA = {
  fk_empresa_atual: 'e1',
  empresa_atual_nome: 'Fazenda Boa Vista',
  empresas: [{ id: 'e1', nome: 'Fazenda Boa Vista' }],
};

const T = (id, nome, empresa_id) => ({ id, nome, empresa_id });

test('chave: nome livre normalizado', () => {
  assert.equal(chave('Berçário 03'), 'bercario 3');
  assert.equal(chave('BERCARIO 3'), 'bercario 3');
  assert.equal(chave('  Desova-01  '), 'desova 1');
});

test('ordemBusca: fazenda logada primeiro', () => {
  assert.deepEqual(ordemBusca(DUAS), ['e1', 'e2']);
  assert.deepEqual(ordemBusca({ ...DUAS, fk_empresa_atual: 'e2' }), ['e2', 'e1']);
});

test('ordemBusca: empresa logada fora da lista não entra no escopo', () => {
  // Sessão apontando para fazenda que saiu da permissão do usuário.
  assert.deepEqual(ordemBusca({ ...DUAS, fk_empresa_atual: 'e9' }), ['e1', 'e2']);
});

test('tanque na fazenda logada: responde sem rodeio', () => {
  const r = resolverTanque([T('t1', 'Berçário 03', 'e1')], 'berçario 3', DUAS);
  assert.equal(r.status, 'ok');
  assert.equal(r.tanque.id, 't1');
  assert.equal(r.fora_da_atual, false);
  assert.equal(r.rotular, true); // multi-fazenda: sempre diz de onde veio
});

test('produtor de uma fazenda só: sem rótulo, sem ruído', () => {
  const r = resolverTanque([T('t1', 'Berçário 03', 'e1')], 'berçário 03', UMA);
  assert.equal(r.status, 'ok');
  assert.equal(r.rotular, false);
});

test('tanque só existe na outra fazenda: acha e avisa de qual é', () => {
  const r = resolverTanque([T('t9', 'Desova 01', 'e2')], 'desova 01', DUAS);
  assert.equal(r.status, 'ok');
  assert.equal(r.empresa_nome, 'Sítio das Águas');
  assert.equal(r.fora_da_atual, true);
  assert.equal(r.rotular, true);
});

test('mesmo nome nas duas fazendas: pergunta, não escolhe', () => {
  const indice = [T('t1', 'Berçário 01', 'e1'), T('t2', 'Berçário 01', 'e2')];
  const r = resolverTanque(indice, 'berçário 01', DUAS);
  assert.equal(r.status, 'ambiguo_fazendas');
  assert.deepEqual(r.candidatos.map((c) => c.empresa_nome), ['Fazenda Boa Vista', 'Sítio das Águas']);
});

test('nome exato em outra fazenda ganha de parecido na logada', () => {
  // "Berçário 03B" na logada x "Berçário 03" exato na outra.
  const indice = [T('t1', 'Berçário 03B', 'e1'), T('t2', 'Berçário 03', 'e2')];
  const r = resolverTanque(indice, 'Berçário 03', DUAS);
  assert.equal(r.status, 'ok');
  assert.equal(r.tanque.id, 't2');
  assert.equal(r.fora_da_atual, true);
});

test('vários parecidos na mesma fazenda: pergunta qual', () => {
  const indice = [T('t1', 'Berçário 03A', 'e1'), T('t2', 'Berçário 03B', 'e1')];
  const r = resolverTanque(indice, 'berçário 03', DUAS);
  assert.equal(r.status, 'ambiguo_nomes');
  assert.equal(r.candidatos.length, 2);
});

test('não existe em nenhuma: diz onde procurou', () => {
  const r = resolverTanque([T('t1', 'Berçário 03', 'e1')], 'engorda 7', DUAS);
  assert.equal(r.status, 'nao_encontrado');
  assert.deepEqual(r.empresas, ['Fazenda Boa Vista', 'Sítio das Águas']);
});

test('tanque de fazenda fora da lista é invisível', () => {
  // e3 não está no escopo do usuário: não pode vazar nem como "existe".
  const r = resolverTanque([T('t7', 'Berçário 03', 'e3')], 'berçário 03', DUAS);
  assert.equal(r.status, 'nao_encontrado');
});

test('agruparPorEmpresa: estoque lado a lado, logada primeiro', () => {
  const linhas = [
    { item: 'Ração 32%', saldo: 800, empresa_id: 'e2' },
    { item: 'Ração 32%', saldo: 1200, empresa_id: 'e1' },
  ];
  const g = agruparPorEmpresa(linhas, DUAS);
  assert.equal(g.length, 2);
  assert.equal(g[0].empresa_nome, 'Fazenda Boa Vista');
  assert.equal(g[0].atual, true);
  assert.equal(g[0].linhas[0].saldo, 1200);
  assert.equal(g[1].empresa_nome, 'Sítio das Águas');
});

test('agruparPorEmpresa: fazenda sem linha não aparece', () => {
  const g = agruparPorEmpresa([{ item: 'Ração', saldo: 1, empresa_id: 'e1' }], DUAS);
  assert.equal(g.length, 1);
  assert.equal(g[0].empresa_id, 'e1');
});
