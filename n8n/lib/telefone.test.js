'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizar, separar, casa, identificar, parseLista, parseEmpresas } = require('./telefone');

const PABLO = { ddd: '48', fone8: '84115045' }; // vindo de 554884115045

test('normalizar: número do WhatsApp com DDI', () => {
  assert.deepEqual(normalizar('554884115045'), { ddd: '48', fone8: '84115045' });
  assert.deepEqual(normalizar('554884115045@s.whatsapp.net'), { ddd: '48', fone8: '84115045' });
});

test('normalizar: nono dígito é indiferente', () => {
  assert.deepEqual(normalizar('5548984115045'), { ddd: '48', fone8: '84115045' });
  assert.deepEqual(normalizar('4884115045'), { ddd: '48', fone8: '84115045' });
  assert.deepEqual(normalizar('48984115045'), { ddd: '48', fone8: '84115045' });
});

test('normalizar: máscara do cadastro', () => {
  assert.deepEqual(normalizar('(48) 8411-5045'), { ddd: '48', fone8: '84115045' });
  assert.deepEqual(normalizar('+55 (48) 98411-5045'), { ddd: '48', fone8: '84115045' });
  assert.deepEqual(normalizar('048 8411 5045'), { ddd: '48', fone8: '84115045' });
});

test('normalizar: DDD 55 não é confundido com DDI', () => {
  // Santa Maria/RS: 10 dígitos, o "55" da frente é DDD e precisa ficar.
  assert.deepEqual(normalizar('5548841150'), { ddd: '55', fone8: '48841150' });
  // Com DDI + DDD 55 são 12 dígitos: aí sim o primeiro 55 sai.
  assert.deepEqual(normalizar('555548841150'), { ddd: '55', fone8: '48841150' });
});

test('normalizar: cadastro sem DDD fica marcado com ddd null', () => {
  assert.deepEqual(normalizar('8411-5045'), { ddd: null, fone8: '84115045' });
  assert.deepEqual(normalizar('98411-5045'), { ddd: null, fone8: '84115045' });
});

test('normalizar: lixo devolve null', () => {
  assert.equal(normalizar(''), null);
  assert.equal(normalizar('sem telefone'), null);
  assert.equal(normalizar('12345'), null);
  assert.equal(normalizar(null), null);
});

test('separar: vários números no mesmo campo', () => {
  assert.deepEqual(separar('(48) 8411-5045, (48) 3333-4444'), ['(48) 8411-5045', '(48) 3333-4444']);
  assert.deepEqual(separar('4884115045 / 4833334444'), ['4884115045', '4833334444']);
  assert.deepEqual(separar('4884115045 ou 4833334444'), ['4884115045', '4833334444']);
  assert.deepEqual(separar('ramal 12'), []); // curto demais para ser telefone
});

test('casa: mascarado no cadastro x cru no WhatsApp', () => {
  assert.equal(casa('(48) 8411-5045', PABLO), 'forte');
  assert.equal(casa('+55 48 98411-5045', PABLO), 'forte');
  assert.equal(casa('(48) 3333-4444, (48) 98411-5045', PABLO), 'forte');
});

test('casa: DDD diferente não casa', () => {
  assert.equal(casa('(11) 98411-5045', PABLO), null);
});

test('casa: cadastro sem DDD casa fraco', () => {
  assert.equal(casa('8411-5045', PABLO), 'fraca');
});

test('casa: números colados não criam falso positivo', () => {
  // O par "48" só existe na fronteira entre dois números diferentes.
  assert.equal(casa('(11) 99999-9948, (99) 8411-5045', PABLO), null);
});

const U = (id, telefones, extra = {}) => ({
  usuario_id: id, usuario_nome: 'U' + id, telefones,
  empresa_atual_id: 'E' + id, empresa_atual_nome: 'Fazenda ' + id,
  empresas: 'E' + id + ':Fazenda ' + id, ...extra,
});

test('identificar: caso feliz', () => {
  const r = identificar([U('1', '(48) 98411-5045')], PABLO);
  assert.equal(r.status, 'ok');
  assert.equal(r.fk_usuario, '1');
  assert.equal(r.fk_empresa_atual, 'E1');
  assert.equal(r.match, 'forte');
});

test('identificar: ninguém casa', () => {
  assert.equal(identificar([U('1', '(11) 3333-4444')], PABLO).status, 'nao_encontrado');
  assert.equal(identificar([], PABLO).status, 'nao_encontrado');
});

test('identificar: telefone em dois cadastros é ambíguo, não escolhe', () => {
  const r = identificar([U('1', '4884115045'), U('2', '(48) 98411-5045')], PABLO);
  assert.equal(r.status, 'ambiguo');
  assert.deepEqual(r.usuarios, ['1', '2']);
});

test('identificar: mesmo usuário repetido não vira ambiguidade', () => {
  const r = identificar([U('1', '4884115045'), U('1', '(48) 98411-5045')], PABLO);
  assert.equal(r.status, 'ok');
  assert.equal(r.fk_usuario, '1');
});

test('identificar: match forte ganha do fraco', () => {
  // U2 tem o mesmo final sem DDD; U1 bateu DDD e número.
  const r = identificar([U('1', '(48) 98411-5045'), U('2', '8411-5045')], PABLO);
  assert.equal(r.status, 'ok');
  assert.equal(r.fk_usuario, '1');
});

test('identificar: só matches fracos e mais de um = ambíguo', () => {
  const r = identificar([U('1', '8411-5045'), U('2', '98411-5045')], PABLO);
  assert.equal(r.status, 'ambiguo');
});

test('identificar: busca truncada não vira "não cadastrado"', () => {
  const r = identificar([U('1', '(11) 3333-4444')], PABLO, { truncado: true });
  assert.equal(r.status, 'erro_busca_truncada');
});

test('parseLista: padrão colunas + itens', () => {
  const linhas = parseLista({
    colunas: 'usuario_id|usuario_nome|telefones',
    itens: 'a|Pablo|(48) 8411-5045;;b|Ana|(48) 3333-4444',
  });
  assert.equal(linhas.length, 2);
  assert.deepEqual(linhas[0], { usuario_id: 'a', usuario_nome: 'Pablo', telefones: '(48) 8411-5045' });
});

test('parseLista: Bubble omite chave vazia', () => {
  assert.deepEqual(parseLista({ colunas: 'usuario_id|usuario_nome' }), []);
  assert.deepEqual(parseLista({}), []);
  assert.deepEqual(parseLista(undefined), []);
});

test('ponta a ponta: resposta real do Bubble com telefones mascarados', () => {
  // O que a busca `telefones contains "5045"` devolveria: o Pablo e um
  // vizinho que por acaso também termina em 5045, mas em outro DDD.
  const resp = {
    colunas: 'usuario_id|usuario_nome|telefones|empresa_atual_id|empresa_atual_nome|empresas',
    itens: [
      '1699a|Pablo|(48) 8411-5045, (48) 3333-4444|1699e1|Fazenda Camarão|' +
        '1699e1:Fazenda Camarão^1699e2:Sítio das Águas',
      '1699b|Marcos|(11) 99999-5045|1699e9|Sítio do Vizinho|1699e9:Sítio do Vizinho',
    ].join(';;'),
    qtd: 2,
  };
  const linhas = parseLista(resp);
  const r = identificar(linhas, PABLO, { truncado: resp.qtd > linhas.length });
  assert.equal(r.status, 'ok');
  assert.equal(r.fk_usuario, '1699a');
  assert.equal(r.fk_empresa_atual, '1699e1');
  assert.equal(r.empresa_atual_nome, 'Fazenda Camarão');
  // O escopo é a lista inteira, não só a fazenda logada.
  assert.deepEqual(r.empresas, [
    { id: '1699e1', nome: 'Fazenda Camarão' },
    { id: '1699e2', nome: 'Sítio das Águas' },
  ]);
});

test('parseEmpresas: lista, vazio e nome com dois-pontos', () => {
  assert.deepEqual(parseEmpresas('e1:Boa Vista^e2:Águas'), [
    { id: 'e1', nome: 'Boa Vista' },
    { id: 'e2', nome: 'Águas' },
  ]);
  assert.deepEqual(parseEmpresas(''), []);
  assert.deepEqual(parseEmpresas(undefined), []);
  assert.deepEqual(parseEmpresas('e1:Fazenda: a boa'), [{ id: 'e1', nome: 'Fazenda: a boa' }]);
});
