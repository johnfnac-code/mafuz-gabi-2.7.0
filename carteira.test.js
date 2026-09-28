'use strict';
// Carteira inteira e busca por lugar (sem Imoview de verdade: um CRM falso com falhas).
// Rode: node --test test/carteira.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Catalogo } = require('../src/catalogo');
const { Imoview } = require('../src/imoview');
const { SiteLinks } = require('../src/site');

const LUGARES = [
  ['Vila da Serra', 'Nova lima'], ['Vale do Sereno', 'Nova lima'], ['Alphaville  Lagoa dos Ingleses', 'Nova lima'],
  ['Condomínio Alphaville Vespasiano', 'Vespasiano'], ['Condomínio Gran Royalle', 'Lagoa Santa'], ['Condomínio Gran Royalle', 'Confins'],
  ['Belvedere', 'Belo Horizonte'], ['Lourdes', 'Belo Horizonte'], ['Serra', 'Belo Horizonte'], ['Sion', 'Belo Horizonte'],
  ['Solar da Lagoa', 'Nova lima'], ['Bandeirantes (Pampulha)', 'Belo Horizonte'], ['Condomínio Retiro do Chalé', 'Brumadinho'],
];

// 2.700 imóveis, 20 por página; 1 em cada 6 páginas falha na primeira vez (como um 429 do Imoview).
function crmFalso(total = 2700) {
  const base = Array.from({ length: total }, (_, k) => {
    const [bairro, cidade] = LUGARES[k % LUGARES.length];
    return {
      codigo: 10000 + k, finalidade: k % 9 === 0 ? 'Aluguel' : 'Venda', tipo: k % 2 ? 'Apartamento' : 'Casa em condomínio',
      bairro, cidade, codigobairro: bairro, codigocidade: cidade, valor: `R$ ${(1000000 + k * 1000).toLocaleString('pt-BR')},00`,
      numeroquartos: 3 + (k % 3), numerosuites: 2 + (k % 3), numerovagas: 3, areaprincipal: '250', titulo: `Imóvel ${k}`, descricao: 'Lindo imóvel.',
    };
  });
  const falhou = new Set();
  const imoview = new Imoview({ baseUrl: 'http://x', chave: 'x' }, null);
  imoview.garantirListas = async () => ({});
  imoview.req = async (metodo, caminho, { corpo, query } = {}) => {
    if (caminho.includes('Detalhes')) return { imovel: base.find((b) => String(b.codigo) === String(query.codigoImovel)) || null };
    const lista = base.filter((b) => (corpo.finalidade === 1) === /alug/i.test(b.finalidade));
    const chave = `${corpo.finalidade}-${corpo.numeroPagina}`;
    if (corpo.numeroPagina > 1 && corpo.numeroPagina % 6 === 0 && !falhou.has(chave)) {
      falhou.add(chave);
      throw new Error('Imoview HTTP 429');
    }
    const ini = (corpo.numeroPagina - 1) * 20;
    return { quantidade: lista.length, lista: lista.slice(ini, ini + 20) };
  };
  return { imoview, base, falhou };
}

const site = new SiteLinks({ url: 'https://mafuz.site' });
site.carregarTodos = async () => 0;

async function carteira() {
  const crm = crmFalso();
  const cat = new Catalogo({ imoview: crm.imoview, site, config: {} });
  cat.pagina = (fin, n) => crm.imoview.req('POST', '/Imovel/RetornarImoveisDisponiveis', { corpo: { finalidade: fin, numeroPagina: n, numeroRegistros: 20 } });
  await cat.sincronizar();
  return { cat, crm };
}

test('sincronização traz a carteira inteira mesmo com páginas que falham', async () => {
  const { cat, crm } = await carteira();
  assert.ok(crm.falhou.size > 10, 'o teste precisa ter falhas');
  assert.strictEqual(cat.itens.length, 2700);
  assert.strictEqual(cat.esperado, 2700);
  assert.strictEqual(cat.completa, true);
});

test('todo bairro e condomínio da carteira é encontrável pelo nome', async () => {
  const { cat } = await carteira();
  for (const [bairro] of LUGARES) {
    const nome = bairro.replace(/^Condomínio /, '');
    const r = await cat.buscar({ finalidade: 'venda', bairros: [nome] });
    assert.ok(r.total_encontrado > 0 && !r.sugestao_alternativa, `${nome}: ${JSON.stringify(r.filtros_aplicados)}`);
  }
});

test('lugares do jeito que o cliente fala', async () => {
  const { cat } = await carteira();
  const buscar = (f) => cat.buscar({ finalidade: 'venda', ...f });
  // cidade errada junto do bairro: o bairro manda
  let r = await buscar({ bairros: ['vila da serra'], cidade: 'Belo Horizonte' });
  assert.ok(r.imoveis.every((i) => i.bairro === 'Vila da Serra'));
  // "Alphaville" pega Nova Lima e Vespasiano
  r = await buscar({ bairros: ['Alphaville'], limite: 6 });
  assert.deepStrictEqual(new Set(r.filtros_aplicados.local.map((x) => x.split(' (').pop())).size >= 2, true);
  // região
  r = await buscar({ bairros: ['Seis Pistas'] });
  assert.ok(r.total_encontrado > 0 && r.imoveis.every((i) => ['Vila da Serra', 'Vale do Sereno', 'Belvedere'].includes(i.bairro)));
  // cidade passada como bairro
  r = await buscar({ bairros: ['Lagoa Santa'] });
  assert.ok(r.imoveis.every((i) => i.cidade === 'Lagoa Santa'));
  // erro de digitação
  r = await buscar({ bairros: ['Solr da Lagoa'] });
  assert.ok(r.total_encontrado > 0 && r.imoveis.every((i) => i.bairro === 'Solar da Lagoa'));
  // "Vila da Serra" não pode virar "Serra" (BH)
  r = await buscar({ bairros: ['Vila da Serra'] });
  assert.ok(r.imoveis.every((i) => i.bairro === 'Vila da Serra'));
  // código: acha mesmo com a finalidade errada
  r = await buscar({ codigo: '10009', finalidade: 'venda' });
  assert.strictEqual(r.imoveis[0].codigo, '10009');
});

test('link sempre é a página exata do imóvel no site', async () => {
  const { cat } = await carteira();
  const r = await cat.buscar({ finalidade: 'venda', bairros: ['Lourdes'] });
  for (const i of r.imoveis) assert.strictEqual(i.url, `https://mafuz.site/imovel/${i.codigo}`);
  assert.strictEqual(site.codigoDoLink('Olha esse https://mafuz.site/imovel/12345?utm_source=x'), '12345');
});

test('vigia: imóvel novo do Imoview entra na carteira na hora', async () => {
  const { TempoReal } = require('../src/tempoReal');
  const { cat, crm } = await carteira();
  crm.base.unshift({ codigo: 99999, finalidade: 'Venda', tipo: 'Casa', bairro: 'Vila da Serra', cidade: 'Nova lima', codigobairro: 'x', codigocidade: 'y', valor: 'R$ 3.000.000,00', numeroquartos: 4, numerosuites: 4, numerovagas: 4, areaprincipal: '400', titulo: 'Nova casa', descricao: 'Casa nova.' });
  let novidade = null;
  cat.aoAtualizar = (x) => { novidade = x; };
  const tr = new TempoReal({ config: { site: {}, tempoReal: { ativo: true, intervaloMinimoSyncSeg: 90 } }, imoview: crm.imoview, catalogo: cat });
  const novos = await tr.vigiar();
  assert.deepStrictEqual(novos.map((i) => i.codigo), ['99999']);
  assert.ok(cat.porCodigo.has('99999'));
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(novidade.novos[0].codigo, '99999');
  const r = await cat.buscar({ finalidade: 'venda', codigo: '99999' });
  assert.strictEqual(r.imoveis[0].codigo, '99999');
});

test('prontidão: sinais de compra somam, conversa parada perde pontos', () => {
  const { prontidao, linhaProntidao } = require('../src/prontidao');
  const frio = prontidao({ qualificacao: {}, historico: [], atualizadaEm: Date.now() - 20 * 86400000 });
  assert.strictEqual(frio.faixa, 'baixa');
  const quente = prontidao({
    nome: 'Ana', qualificacao: { prazo: 'ate_30d', pagamento: 'a_vista', preco_max: 6000000, codigo_imovel_interesse: '123' },
    visitas: [{}], transferencias: [{ motivo: 'negociacao' }], historico: Array(9).fill({ papel: 'cliente' }), atualizadaEm: Date.now(),
  });
  assert.strictEqual(quente.faixa, 'alta');
  assert.ok(quente.pontos >= 90 && quente.pontos <= 100);
  assert.match(linhaProntidao({ qualificacao: { prazo: '30_90d' } }), /^Prontidão: \d+\/100 \(baixa\) · prazo de 30 a 90 dias/);
});

test('captação: registra no painel como captação, avisa a equipe e traz referência da carteira', async () => {
  const { Agente } = require('../src/agent');
  const { cat } = await carteira();
  const leads = [];
  const alertas = [];
  const eventos = [];
  const ag = new Agente({
    config: { agente: { nome: 'Gabi' }, comportamento: {}, equipe: {} },
    store: { evento: (...a) => eventos.push(a), tocar: () => {}, leads: {} },
    zapi: {}, imoview: {}, llm: {}, catalogo: cat,
  });
  ag.tempoReal = { criarLeadWhatsApp: async (x) => { leads.push(x); return 'lead-1'; } };
  ag.alertar = async (turno, montar, carteira) => alertas.push({ texto: montar(), carteira });
  ag.cabecalhoCliente = () => 'Cliente: Ana';
  const conv = { fone: '5531999990000', nome: 'Ana', qualificacao: {}, imoveis: {}, historico: [] };
  const turno = { cartoes: [], alertas: [] };
  const r = await ag.executar('registrar_captacao', { finalidade: 'venda', tipo: 'casa', bairro: 'Vila da Serra', area_m2: 400, valor_pretendido: 4500000 }, conv, turno);
  await new Promise((ok) => setTimeout(ok, 5));
  assert.strictEqual(r.registrado, true);
  assert.ok(r.referencia.imoveis_parecidos_na_carteira > 0);
  assert.match(r.referencia.faixa_referencia, /^R\$ .+ a R\$ /);
  assert.strictEqual(leads.length, 1);
  assert.strictEqual(leads[0].fonte, 'whatsapp_captacao');
  assert.match(leads[0].notas, /Valor pretendido: R\$ 4\.500\.000/);
  assert.strictEqual(conv.captacaoPainel.id, 'lead-1');
  assert.match(alertas[0].texto, /CAPTAÇÃO · VENDA/);
  // segunda chamada com a disponibilidade: não duplica o lead, avisa a equipe da avaliação
  await ag.executar('registrar_captacao', { finalidade: 'venda', tipo: 'casa', bairro: 'Vila da Serra', disponibilidade: 'quinta à tarde' }, conv, turno);
  assert.strictEqual(leads.length, 1);
  assert.match(alertas[1].texto, /AVALIAÇÃO[\s\S]*quinta à tarde/);
});

test('busca em duas fontes: o site cobre o que a carteira do Imoview não trouxe', async () => {
  const { Agente } = require('../src/agent');
  const { CatalogoSite } = require('../src/buscaSite');
  const { cat } = await carteira();
  const siteCat = new CatalogoSite({ config: { site: { url: 'https://mafuz.site', supabaseUrl: 'http://x', supabaseAnonKey: 'k' } }, site });
  const linha = (id, bairro, extra = {}) => ({ id: `uuid-${id}`, external_id: String(id), external_source: 'imoview', title: `Cobertura duplex à venda, ${bairro}`, description: 'Vista livre.', neighborhood: bairro, city: 'Belo Horizonte', property_type: 'penthouse', listing_type: 'sale', price: 4000000, bedrooms: 4, suites: 3, parking_spots: 3, area_built: 300, created_at: '2026-09-01', ...extra });
  siteCat.lerPagina = async () => [linha(50001, 'Funcionários'), linha(50002, 'Funcionários', { price: 5000000 }), linha(50003, 'Sion'), { ...linha(50004, 'Funcionários'), external_source: 'whitestone-seed' }];
  siteCat.minimo = 1;
  await siteCat.sincronizar();
  assert.strictEqual(siteCat.itens.length, 3, 'só imóveis da MAFUZ');
  const ag = new Agente({ config: { agente: { nome: 'Gabi' }, comportamento: {}, equipe: {} }, store: { evento() {}, tocar() {}, leads: {} }, zapi: {}, imoview: {}, llm: {}, catalogo: cat });
  ag.buscaSite = siteCat;
  // "Cobertura duplex" no Funcionários: não existe na carteira do teste, existe no site
  const r = await ag.buscarEmTodasAsFontes({ finalidade: 'venda', tipo: 'cobertura', bairros: ['Funcionários'] });
  assert.deepStrictEqual(r.imoveis.map((i) => i.codigo).sort(), ['50001', '50002']);
  assert.strictEqual(r.imoveis[0].url.startsWith('https://mafuz.site/imovel/5000'), true);
  assert.ok(r.panorama && r.panorama.imoveis_no_recorte === 2);
  // Carteira com resultado exato: vem primeiro e o site só completa sem repetir
  const r2 = await ag.buscarEmTodasAsFontes({ finalidade: 'venda', bairros: ['Lourdes'], limite: 6 });
  assert.ok(r2.imoveis.length > 0 && r2.imoveis.every((i) => i.bairro === 'Lourdes'));
});

test('consultiva: pergunta finalidade e faixa antes de mandar imóveis', async () => {
  const { Agente } = require('../src/agent');
  const { cat } = await carteira();
  const ag = new Agente({ config: { agente: { nome: 'Gabi' }, comportamento: {}, equipe: {} }, store: { evento() {}, tocar() {}, leads: {} }, zapi: {}, imoview: {}, llm: {}, catalogo: cat });
  const conv = { fone: '5531', qualificacao: {}, imoveis: {}, urlsPermitidas: [], historico: [{ papel: 'cliente', texto: 'Oi, procuro uma casa no Alphaville' }], visitas: [], transferencias: [], radar: {} };
  const turno = { cartoes: [], alertas: [], ferramentas: [], textoCliente: 'Oi, procuro uma casa no Alphaville', simulacao: true };
  const busca = await ag.executar('buscar_imoveis', { finalidade: 'venda', tipo: 'casa', bairros: ['Alphaville'] }, conv, turno);
  assert.match(busca.antes_de_enviar, /finalidade/);
  const cod = busca.imoveis[0].codigo;
  const env = await ag.executar('enviar_imoveis', { imoveis: [{ codigo: cod, motivo: 'x' }] }, conv, turno);
  assert.deepStrictEqual(env.enviados, []);
  assert.deepStrictEqual(env.aguardando_perfil, ['finalidade', 'valor_ou_quartos']);
  // cliente responde: comprar, até 5 milhões -> envia
  conv.historico.push({ papel: 'cliente', texto: 'Quero comprar, até 5 milhões' });
  const t2 = { ...turno, cartoes: [], textoCliente: 'Quero comprar, até 5 milhões' };
  const env2 = await ag.executar('enviar_imoveis', { imoveis: [{ codigo: cod, motivo: 'x' }] }, conv, t2);
  assert.deepStrictEqual(env2.enviados, [cod]);
  // pedido explícito para ver opções não é travado
  const conv3 = { ...conv, historico: [], envioSegurado: 0 };
  const env3 = await ag.executar('enviar_imoveis', { imoveis: [{ codigo: cod, motivo: 'x' }] }, conv3, { cartoes: [], textoCliente: 'me manda umas opções' });
  assert.deepStrictEqual(env3.enviados, [cod]);
});

test('tempo real: leads do Imoview pelas duas pontas e Pipeline só avança', async () => {
  const { TempoReal } = require('../src/tempoReal');
  const chamadas = [];
  const tr = new TempoReal({ config: { site: { supabaseUrl: 'http://x', supabaseAnonKey: 'k' }, tempoReal: { ativo: true } }, imoview: { req: async (m, c, { query }) => ({ quantidade: query.finalidade === 2 ? 3000 : 40 }) }, catalogo: {} });
  tr.funcao = async (nome, corpo) => { chamadas.push(corpo); return JSON.stringify({ received: 20, inserted: 2, updated: 18 }); };
  const r = await tr.sincronizarLeadsImoview();
  assert.deepStrictEqual(chamadas.map((c) => c.start_page), [1, 148]);
  assert.deepStrictEqual(r, { received: 40, inserted: 4, updated: 36 });
  const escritas = [];
  tr.painel = { configurado: () => true, ler: async () => [{ id: 'L1', stage: 'contacted', notes: 'Busca: casa\nProntidão: 20/100 (baixa)' }], escrever: async (t, f, d) => escritas.push(d) };
  await tr.moverLead('L1', 'visit_scheduled', { prontidao: 'Prontidão: 70/100 (alta) · visita marcada' });
  assert.equal(escritas[0].stage, 'visit_scheduled');
  assert.match(escritas[0].notes, /Prontidão: 70\/100 \(alta\) · visita marcada/);
  assert.doesNotMatch(escritas[0].notes, /20\/100/);
  assert.equal(escritas[0].priority, 'high');
  await tr.moverLead('L1', 'new', {});
  assert.equal(escritas[1].stage, undefined, 'não volta etapa');
});
