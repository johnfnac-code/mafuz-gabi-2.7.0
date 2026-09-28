'use strict';
// Testes das novidades da 2.7.0: memória de longo prazo, área do cliente,
// lembretes de visita, distribuição, monitor, Meta Lead Ads e qualidade.
// Rode: node --test test/v27.test.js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'gabi27-'));
process.env.WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'segredo-de-teste';
const { config } = require('../src/config');
const { Store } = require('../src/store');
const { MemoriaClientes, consolidar, textoMemoria, objecoesDe } = require('../src/memoria');
const { AreaCliente, normalizarFone } = require('../src/areaCliente');
const rotinas = require('../src/rotinas');
const { escolherCorretor, carteiraDoLead } = require('../src/distribuicao');
const { diagnosticar } = require('../src/monitor');
const { lerCampos, assinaturaValida } = require('../src/metaLeads');
const { qualidadeConversas, faixaDe } = require('../src/qualidade');
const { Agente } = require('../src/agent');

const conversa = (extra = {}) => ({
  fone: '5531999990000',
  nome: 'Ana Lima',
  criadaEm: Date.now() - 3600000,
  atualizadaEm: Date.now(),
  historico: [
    { papel: 'cliente', texto: 'Quero uma casa no Alphaville, achei o 17560 caro demais', ts: Date.now() - 3000000 },
    { papel: 'agente', texto: '[imóvel enviado com foto] Casa', ts: Date.now() - 2900000 },
    { papel: 'cliente', texto: 'não gostei do 17561, muito longe', ts: Date.now() - 2800000 },
  ],
  qualificacao: { finalidade: 'comprar', tipo: 'casa', bairros: ['Alphaville'], preco_max: 4000000 },
  imoveis: { 17560: { codigo: '17560', apresentado: true }, 17561: { codigo: '17561', apresentado: true } },
  urlsPermitidas: [],
  visitas: [],
  transferencias: [],
  ...extra,
});

test('memória: consolida perfil, vistos, descartados e objeções', () => {
  const m = consolidar(null, conversa(), []);
  assert.strictEqual(m.nome, 'Ana Lima');
  assert.deepStrictEqual(m.vistos.sort(), ['17560', '17561']);
  assert.ok(m.descartados.includes('17561'));
  assert.ok(m.objecoes.includes('preço acima do orçamento'));
  assert.ok(m.objecoes.includes('localização'));
  assert.strictEqual(m.conversas, 1);
  const t = textoMemoria(m);
  assert.match(t, /Descartou: 17561/);
  assert.match(t, /Procurava: comprar · casa · Alphaville/);
});

test('memória: conversa expirada vai para a memória e o radar sobrevive', () => {
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'gabimem-'));
  const store = new Store(dir, { conversaTtlDias: 1 });
  clearInterval(store.timer);
  const memoria = new MemoriaClientes(store);
  store.aoExpirar = (c) => memoria.registrar(c);
  const velha = conversa({ atualizadaEm: Date.now() - 3 * 86400000, radar: { filtros: { finalidade: 'venda', tipo: 'casa' } } });
  store.conversas[velha.fone] = velha;
  const nova = store.conversa(velha.fone);
  assert.strictEqual(nova.historico.length, 0);
  assert.ok(nova.radar && nova.radar.filtros);
  assert.ok(memoria.obter('31999990000'), 'memória acha pelo número sem 55');
  assert.match(memoria.texto(velha.fone), /já falou com a MAFUZ/);
});

test('objeções reconhecidas', () => {
  assert.deepStrictEqual(objecoesDe(['o condomínio é muito alto']), ['condomínio alto']);
  assert.deepStrictEqual(objecoesDe(['perfeito, adorei']), []);
});

test('área do cliente: código, token e favoritos', async () => {
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'gabiarea-'));
  const store = new Store(dir, {});
  clearInterval(store.timer);
  const enviados = [];
  const zapi = { enviarTexto: async (f, t) => enviados.push({ f, t }) };
  const memoria = new MemoriaClientes(store);
  const area = new AreaCliente({ config, store, zapi, memoria });
  assert.ok(area.ativa());
  assert.strictEqual(normalizarFone('(31) 99999-0000'), '5531999990000');
  assert.strictEqual(normalizarFone('123'), null);
  const r = await area.pedirCodigo('(31) 99999-0000', 1000000);
  assert.ok(r.ok);
  const codigo = enviados[0].t.match(/(\d{6})/)[1];
  assert.match(enviados[0].t, /área do cliente MAFUZ/);
  const repetido = await area.pedirCodigo('31999990000', 1000000 + 10000);
  assert.ok(!repetido.ok, 'segundo pedido em menos de 1 min é recusado');
  assert.ok(!area.entrar('31999990000', '000000', 1000000 + 20000).ok || codigo === '000000');
  const ok = area.entrar('31999990000', codigo, 1000000 + 30000);
  assert.ok(ok.ok);
  assert.strictEqual(area.ler(ok.token, 1000000 + 60000), '5531999990000');
  assert.strictEqual(area.ler(ok.token + 'x', 1000000 + 60000), null);
  assert.strictEqual(area.ler(ok.token, 1000000 + 31 * 86400000), null, 'token expira em 30 dias');
  assert.ok(!area.entrar('31999990000', codigo, 1000000 + 40000).ok, 'código só vale uma vez');
  assert.deepStrictEqual(area.favoritar('5531999990000', '17560'), ['17560']);
  assert.deepStrictEqual(area.favoritar('5531999990000', '17560', 'remover'), []);
  const alerta = area.alerta('5531999990000', { filtros: { finalidade: 'venda', tipo: 'casa', bairros: ['Alphaville'], preco_max: 5000000 } });
  assert.strictEqual(alerta.ativo, true);
  assert.strictEqual(area.alerta('5531999990000', { ativo: false }).ativo, false);
});

test('lembretes: 24 h e 2 h, cliente só com visita confirmada', () => {
  const agora = new Date('2026-10-01T10:00:00-03:00');
  const visitas = [
    { id: 'A', fone: '5531999990000', codigo: '1', data: '2026-10-02', hora: '09:30', status: 'confirmada', criadaEm: '2026-09-30T10:00:00-03:00' },
    { id: 'B', fone: '5531999990001', codigo: '2', data: '2026-10-01', hora: '11:30', status: 'aguardando_confirmacao', criadaEm: '2026-09-30T10:00:00-03:00' },
    { id: 'C', fone: '5531999990002', codigo: '3', data: '2026-10-05', hora: '10:00', status: 'confirmada' },
    { id: 'D', fone: '5531999990003', codigo: '4', data: '2026-10-02', hora: '09:30', status: 'cancelada' },
  ];
  const r = rotinas.visitasParaLembrete({ visitas, conversas: {}, agora });
  assert.deepStrictEqual(r.map((x) => `${x.visita.id}:${x.tipo}:${x.confirmada}`), ['A:24h:true', 'B:2h:false']);
  visitas[0].lembretes['24h'] = 'x';
  assert.strictEqual(rotinas.visitasParaLembrete({ visitas, conversas: {}, agora }).filter((x) => x.visita.id === 'A').length, 0);
  const msg = rotinas.mensagemLembreteCliente(visitas[0], { nome: 'Ana Lima' }, '24h');
  assert.match(msg, /Ana/);
  assert.doesNotMatch(msg, /\p{Extended_Pictographic}/u);
});

test('distribuição: rodízio por menor contagem e carteira do lead', () => {
  const pool = [{ id: 'a' }, { id: 'b' }];
  assert.strictEqual(escolherCorretor(pool, { contagem: { a: 2, b: 1 } }).id, 'b');
  assert.strictEqual(escolherCorretor(pool, { contagem: {}, ponteiro: 1 }).id, 'b');
  assert.strictEqual(escolherCorretor(pool, { excluir: ['a', 'b'] }), null);
  assert.strictEqual(carteiraDoLead({ interest: 'rent' }), 'locacao');
  assert.strictEqual(carteiraDoLead({ interest: 'buy' }), 'venda');
});

test('monitor: sem problemas quando tudo está em dia', () => {
  const agora = Date.now();
  const p = diagnosticar({
    agora,
    catalogo: { ativo: true, ultimaSync: new Date(agora - 600000).toISOString(), itens: 1000, noArMin: 100 },
    buscaSite: { ultimaSync: new Date(agora - 600000).toISOString(), itens: 990, itensImoview: 950, noArMin: 100 },
    tempoReal: { ativo: true, falhas_leads_seguidas: 0 },
    whatsapp: 'conectado',
  });
  assert.deepStrictEqual(p, []);
});

test('Meta Lead Ads: campos e assinatura', () => {
  const c = lerCampos([{ name: 'first_name', values: ['Ana'] }, { name: 'last_name', values: ['Lima'] }, { name: 'telefone', values: ['31 99999-0000'] }, { name: 'email', values: ['a@b.com'] }]);
  assert.strictEqual(c.nome, 'Ana Lima');
  assert.strictEqual(c.telefone, '5531999990000');
  const corpo = '{"entry":[]}';
  const sig = 'sha256=' + crypto.createHmac('sha256', 'app').update(corpo).digest('hex');
  assert.ok(assinaturaValida('app', corpo, sig));
  assert.ok(!assinaturaValida('app', corpo, 'sha256=' + '0'.repeat(64)));
  assert.ok(assinaturaValida('', corpo, undefined), 'sem segredo configurado, aceita');
});

test('qualidade: funil e faixas', () => {
  const q = qualidadeConversas({ conversas: [conversa({ radar: { filtros: {} } })], dias: 30 });
  assert.strictEqual(q.conversas, 1);
  assert.strictEqual(q.funil[1].total, 1);
  assert.strictEqual(faixaDe({ preco_max: 3000000 }), 'R$ 2 a 4 mi');
  assert.strictEqual(faixaDe({ finalidade: 'alugar', preco_max: 8000 }), 'R$ 5 a 10 mil');
});

test('criar_selecao: link do site só com imóveis da conversa', async () => {
  const store = { evento() {}, tocar() {}, leads: {}, visitas: [] };
  const ag = new Agente({ config, store, zapi: {}, imoview: {}, llm: {} });
  const conv = conversa({ imoveis: { 1: { codigo: '1', url: 'https://mafuz.site/imovel/1' }, 2: { codigo: '2', url: 'https://mafuz.site/imovel/2' } } });
  const erro = await ag.executar('criar_selecao', { codigos: ['1', '99'] }, conv, { campanha: 'atendimento' });
  assert.ok(erro.erro);
  const r = await ag.executar('criar_selecao', { codigos: ['1', '2'], titulo: 'Casas' }, conv, { campanha: 'atendimento' });
  assert.match(r.url, /^https:\/\/mafuz\.site\/selecao\?c=1%2C2&n=Ana&t=Casas/);
  assert.ok(conv.urlsPermitidas.includes(r.url));
  const texto = ag.guardar(`Montei a sua seleção:\n${r.url}`, conv);
  assert.ok(texto.includes(r.url), 'o guardrail deixa o link da seleção passar');
});
