'use strict';
// Testes de unidade das peças novas (não precisam de Imoview, Z-API nem LLM).
// Rode: node --test test/unidades.test.js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'gabi-'));
const { config } = require('../src/config');
const radar = require('../src/radar');
const { Agenda } = require('../src/agenda');
const { argumentosFfmpeg, textos } = require('../src/video');
const { comUtm } = require('../src/agent');
const { fotosDe } = require('../src/catalogo');

const casa = (extra = {}) => ({
  codigo: '17560', tipo: 'Casa em condomínio', grupo: 'casa', finalidade: 'venda', bairro: 'Alphaville Lagoa dos Ingleses',
  bairroNorm: 'alphaville lagoa dos ingleses', cidade: 'Nova Lima', preco: 4200000, preco_formatado: 'R$ 4.200.000',
  dormitorios: 4, suites: 4, vagas: 4, area_m2: 480, url: 'https://mafuz.site/imovel/abc', ...extra,
});

test('radar: registra perfil só com recorte concreto', () => {
  const conv = {};
  assert.equal(radar.registrarPerfil(conv, { texto_livre: 'piscina' }), false);
  assert.equal(radar.registrarPerfil(conv, { finalidade: 'venda', tipo: 'casa', bairros: ['Alphaville'], preco_max: 5000000 }), true);
  assert.deepEqual(conv.radar.filtros.bairros, ['Alphaville']);
});

test('radar: combina respeita tipo, região, preço (10%) e quartos', () => {
  const f = { finalidade: 'venda', tipo: 'casa', bairros: ['Alphaville'], preco_max: 4000000, dormitorios_min: 4 };
  assert.equal(radar.combina(casa(), f), true); // 4,2 mi cabe na tolerância de 10%
  assert.equal(radar.combina(casa({ preco: 4600000 }), f), false);
  assert.equal(radar.combina(casa({ grupo: 'apartamento' }), f), false);
  assert.equal(radar.combina(casa({ bairroNorm: 'vila da serra', bairro: 'Vila da Serra' }), f), false);
  assert.equal(radar.combina(casa({ dormitorios: 3 }), f), false);
  assert.equal(radar.combina(casa({ finalidade: 'locacao' }), f), false);
});

test('radar: planeja respeitando opt-out, intervalo, validade e duplicidade', () => {
  const agora = Date.now();
  const base = { finalidade: 'venda', tipo: 'casa', bairros: ['Alphaville'] };
  const convs = [
    { fone: '1', atualizadaEm: agora, radar: { filtros: base } },
    { fone: '2', atualizadaEm: agora, optOut: true, radar: { filtros: base } },
    { fone: '3', atualizadaEm: agora, radar: { filtros: base, ultimoEnvio: agora - 3600000 } },
    { fone: '4', atualizadaEm: agora - 90 * 86400000, radar: { filtros: base } },
    { fone: '5', atualizadaEm: agora, radar: { filtros: base, enviados: ['17560:novo'] } },
  ];
  const planos = radar.planejar(convs, { novos: [casa()] }, { intervaloHoras: 20, validadeDias: 60 }, agora);
  assert.deepEqual(planos.map((p) => p.conv.fone), ['1']);
  const msg = radar.mensagem({ nome: 'Paula Souza' }, planos[0].itens);
  assert.match(msg, /Oi, Paula!/);
  assert.doesNotMatch(msg, /[—–]/);
});

test('UTM: acrescenta parâmetros sem duplicar', () => {
  const u = comUtm('https://mafuz.site/imovel/abc', 'radar', config);
  assert.match(u, /utm_source=whatsapp&utm_medium=gabi&utm_campaign=radar/);
  assert.equal(comUtm(u, 'outra', config), u);
});

test('catálogo: fotos do Imoview em url, urlm ou urlp', () => {
  assert.deepEqual(fotosDe({ fotos: [{ url: 'https://a/1.jpg' }, { urlm: 'https://a/2.jpg' }, { x: 1 }, 'https://a/3.jpg'] }), [
    'https://a/1.jpg', 'https://a/2.jpg', 'https://a/3.jpg',
  ]);
});

test('vídeo: 15 s exatos com 3, 4 ou 5 fotos e textos sem travessão', () => {
  for (const n of [3, 4, 5]) {
    const { total, args } = argumentosFfmpeg(Array.from({ length: n }, (_, i) => `/tmp/f${i}.jpg`), casa(), '/tmp/s.mp4');
    assert.ok(Math.abs(total - 15) < 0.05, `total ${total} com ${n} fotos`);
    assert.ok(args.includes('libx264'));
  }
  const t = textos(casa());
  assert.equal(t.preco, 'R$ 4.200.000');
  assert.match(t.medidas, /4 quartos/);
});

test('agenda: horários livres respeitam ocupação da agenda e janela de visitas', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const conta = { client_email: 'gabi@mafuz.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const cfg = {
    ...config,
    agenda: { ...config.agenda, contaServico: JSON.stringify(conta), corretores: [{ fone: '5531989097232', email: 'marcella@mafuz.com.br' }], duracaoMin: 60, diasAFrente: 3 },
    equipe: { ...config.equipe, venda: ['5531989097232'], locacao: [] },
  };
  // Segunda 29/09/2026 08:00 em Brasília; ocupado 09:00 a 12:00.
  const agora = new Date('2026-09-29T11:00:00Z');
  const ocupado = [{ start: '2026-09-29T09:00:00-03:00', end: '2026-09-29T12:00:00-03:00' }];
  const fetchImpl = async (url) => {
    if (url.includes('oauth2')) return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    return { ok: true, json: async () => ({ calendars: { 'marcella@mafuz.com.br': { busy: ocupado } } }) };
  };
  const ag = new Agenda(cfg, { fetchImpl });
  assert.equal(ag.ativa(), true);
  const slots = await ag.horariosLivres({ carteira: 'venda', data: '2026-09-29', periodo: 'manha' }, agora);
  assert.ok(slots.length > 0);
  for (const s of slots.filter((x) => x.data === '2026-09-29')) {
    const h = +s.hora.slice(0, 2);
    assert.ok(h >= 13, `slot ${s.hora} colide com o bloco ocupado (margem de 30 min)`);
  }
  assert.match(slots[0].rotulo, /às \d+h$/);
});

// ---------------- v2.3: resumo das 8h, pós-visita, 2º Cérebro, Instagram ----------------
const rotinas = require('../src/rotinas');
const { Cerebro, montarSistema, contextoServidor } = require('../src/cerebro');
const { Instagram } = require('../src/instagram');

// Sábado, 26/09/2026, 08:05 em Brasília (11:05 UTC).
const SAB_8H = new Date('2026-09-26T11:05:00Z');

test('resumo das 8h: visitas do dia, clientes esperando e novos na carteira da carteira certa', () => {
  const conversas = {
    '5531911111111': { fone: '5531911111111', nome: 'Ana Souza', carteira: 'venda', encaminhamento: { ts: SAB_8H.getTime() - 3 * 3600000 } },
    '5531922222222': { fone: '5531922222222', nome: 'Bruno', carteira: 'locacao', encaminhamento: { ts: SAB_8H.getTime() - 3 * 3600000 } },
    '5531933333333': { fone: '5531933333333', nome: 'Carla', carteira: 'venda', encaminhamento: { ts: SAB_8H.getTime() - 3 * 3600000, respondidoEm: 1 } },
  };
  const visitas = [
    { fone: '5531911111111', nome: 'Ana Souza', codigo: '17560', bairro: 'Alphaville', data: '2026-09-26', hora: '10:00', status: 'aguardando_confirmacao' },
    { fone: '5531922222222', nome: 'Bruno', codigo: '9000', bairro: 'Lourdes', data: '2026-09-26', hora: '11:00', status: 'aguardando_confirmacao' },
    { fone: '5531911111111', nome: 'Ana Souza', codigo: '1', data: '2026-09-27', hora: '10:00', status: 'aguardando_confirmacao' },
  ];
  const novos = [casa({ codigo: '20001' }), casa({ codigo: '20002', finalidade: 'locacao' })];
  const r = rotinas.resumoCorretor({ nome: 'Marcella Lima', carteira: 'venda', visitas, conversas, novos, carteiraDe: (c) => c.carteira, painelUrl: 'https://mafuz.site/painel?tab=conversas', agora: SAB_8H });
  assert.match(r.texto, /^\*MAFUZ · Seu resumo do dia\*\nSábado, 26\/09 · carteira de venda\n\nBom dia, Marcella\./);
  assert.match(r.texto, /\*Visitas de hoje \(1\)\*/);
  assert.doesNotMatch(r.texto, /[\u{1F300}-\u{1FAFF}\u2705\u23F3]/u);
  assert.equal(r.visitas, 1);
  assert.match(r.texto, /10:00 · Ana Souza · cód\. 17560/);
  assert.doesNotMatch(r.texto, /Bruno/);
  assert.equal(r.esperando, 1);
  assert.equal(r.novos, 1);
  assert.match(r.texto, /Cód\. 20001/);
  assert.doesNotMatch(r.texto, /[—–]/);
});

test('resumo das 8h: roda uma vez por dia, só na hora e nos dias configurados', () => {
  assert.equal(rotinas.horaDoResumo({ agora: SAB_8H, hora: 8, dias: [1, 2, 3, 4, 5, 6], ultimoEnvio: null }), true);
  assert.equal(rotinas.horaDoResumo({ agora: SAB_8H, hora: 8, dias: [1, 2, 3, 4, 5, 6], ultimoEnvio: '2026-09-26' }), false);
  assert.equal(rotinas.horaDoResumo({ agora: SAB_8H, hora: 9, dias: [1, 2, 3, 4, 5, 6], ultimoEnvio: null }), false);
  assert.equal(rotinas.horaDoResumo({ agora: SAB_8H, hora: 8, dias: [1, 2, 3, 4, 5], ultimoEnvio: null }), false);
});

test('pós-visita: só visitas confirmadas pela equipe, 2 h depois e sem repetir', () => {
  const agora = new Date('2026-09-26T17:30:00Z'); // 14:30 em Brasília
  const reservada = '2026-09-25T15:00:00Z';
  const conversas = {
    a: { fone: 'a', nome: 'Ana', historico: [{ papel: 'equipe', ts: Date.parse('2026-09-25T16:00:00Z') }] },
    b: { fone: 'b', nome: 'Bia', historico: [{ papel: 'agente', ts: Date.parse('2026-09-25T16:00:00Z') }] },
    c: { fone: 'c', nome: 'Caio', historico: [] },
  };
  const visitas = [
    { id: 'V1', fone: 'a', codigo: '1', data: '2026-09-26', hora: '10:00', status: 'aguardando_confirmacao', criadaEm: reservada },
    { id: 'V2', fone: 'b', codigo: '2', data: '2026-09-26', hora: '10:00', status: 'aguardando_confirmacao', criadaEm: reservada },
    { id: 'V3', fone: 'c', codigo: '3', data: '2026-09-26', hora: '10:00', status: 'confirmada', criadaEm: reservada },
    { id: 'V4', fone: 'a', codigo: '4', data: '2026-09-26', hora: '13:30', status: 'confirmada', criadaEm: reservada },
    { id: 'V5', fone: 'a', codigo: '5', data: '2026-09-26', hora: '10:00', status: 'cancelada', criadaEm: reservada },
    { id: 'V6', fone: 'a', codigo: '6', data: '2026-09-26', hora: '10:00', status: 'confirmada', criadaEm: reservada, posVisita: { enviadaEm: 'x' } },
  ];
  const prontas = rotinas.visitasParaPosVisita({ visitas, conversas, agora, horasDepois: 2 }).map((v) => v.id);
  assert.deepEqual(prontas, ['V1', 'V3']);
  const msgs = rotinas.mensagemPosVisita({ codigo: '17560', bairro: 'Alphaville' }, { nome: 'Ana Souza' });
  assert.match(msgs[0], /^Oi, Ana! Aqui é a Gabi, da MAFUZ\. Como foi a visita ao imóvel no Alphaville \(cód\. 17560\)\?/);
  assert.match(msgs[1], /De 1 a 5/);
});

test('2º Cérebro: guarda, prioriza e esquece anotações; monta contexto sem inventar', () => {
  const c = new Cerebro(process.env.DATA_DIR);
  const a = c.lembrar('Proprietário da cobertura do Belvedere aceita permuta até R$ 2 mi', 'Fernando');
  c.lembrar('Reunião de equipe toda segunda às 9h', 'Fernando');
  assert.equal(c.relevantes('permuta na cobertura')[0].id, a.id);
  const c2 = new Cerebro(process.env.DATA_DIR);
  assert.equal(c2.memorias.length, 2, 'persiste em disco');
  assert.ok(c2.esquecer(a.id));
  const sis = montarSistema({ fatos: { leads: { semana: 12 } }, rascunho: '**12 leads nesta semana.**', servidor: {}, memorias: c2.memorias, perguntasRecentes: [], usuario: { nome: 'Fernando', papeis: ['agency'] }, agora: SAB_8H });
  assert.match(sis, /RASCUNHO CALCULADO PELO PAINEL\n\*\*12 leads/);
  assert.match(sis, /Nunca invente/);
  assert.match(sis, /Reunião de equipe/);
  const ctx = contextoServidor({
    conversas: { x: { fone: '5531', historico: [{}], atualizadaEm: SAB_8H.getTime(), fonte: 'instagram', encaminhamento: { ts: SAB_8H.getTime() - 7200000 } } },
    visitas: [], eventos: [{ tipo: 'resposta_humana', ts: SAB_8H.toISOString(), dados: { minutos: 12 } }], catalogoStatus: {}, funil: {}, agora: SAB_8H.getTime(),
  });
  assert.equal(ctx.conversas_whatsapp.por_origem_30_dias.instagram, 1);
  assert.equal(ctx.esperando_resposta_da_equipe[0].ha_horas, 2);
  assert.equal(ctx.tempo_primeira_resposta_humana_mediana_min, 12);
});

test('Instagram: normaliza vídeos, fotos e álbuns da API', () => {
  const v = Instagram.normalizar({ id: '1', media_type: 'VIDEO', media_url: 'https://v.mp4', thumbnail_url: 'https://t.jpg', permalink: 'https://instagram.com/p/1', caption: 'Casa no Alphaville\nsegunda linha', timestamp: '2026-09-20' });
  assert.deepEqual(v, { id: '1', tipo: 'video', midia: 'https://v.mp4', capa: 'https://t.jpg', link: 'https://instagram.com/p/1', legenda: 'Casa no Alphaville', data: '2026-09-20' });
  assert.equal(Instagram.normalizar({ id: '2', media_type: 'IMAGE', media_url: 'https://i.jpg' }).capa, 'https://i.jpg');
  assert.equal(new Instagram({ token: '', dir: process.env.DATA_DIR }).ativo(), false);
});

test('resumo da diretoria: dia anterior com leads por origem, captações com nome e conferência da busca', async () => {
  const dir = require('../src/diretoria');
  const agora = new Date('2026-09-29T11:05:00Z'); // 08:05 em Brasília, terça
  const { ini } = dir.diaAnterior(agora);
  const ontem = (h) => new Date(ini.getTime() + h * 3600000).toISOString();
  const painel = {
    configurado: () => true,
    ler: async (tabela) => ({
      agency_leads: [
        { source: 'imoview', created_at: ontem(9) }, { source: 'imoview', created_at: ontem(10) },
        { source: 'agendar_visita', created_at: ontem(11) },
        { source: 'whatsapp_gabi', notes: 'Prontidão: 82/100 (alta)', created_at: ontem(12) },
        { source: 'whatsapp_captacao', created_at: ontem(13), assigned_broker_id: 'b1' },
      ],
      properties: [
        { external_source: null, status: 'published', user_id: 'u1', property_type: 'house', neighborhood: 'Vila da Serra', price: 4200000, listing_type: 'sale' },
        { external_source: null, status: 'published', user_id: 'u2', property_type: 'apartment', neighborhood: 'Lourdes', price: 2100000, listing_type: 'sale' },
        { external_source: 'imoview', status: 'published' },
      ],
      pending_listings: [{ status: 'pending', source: 'site_anuncie', created_at: ontem(15) }],
      agency_brokers: [{ id: 'b1', broker_name: 'Thais Freire', broker_user_id: 'u1' }],
      appointments: [{ scheduled_time: '10:00:00', buyer_name: 'Ricardo', broker_id: 'u1' }],
      profiles: [{ user_id: 'u2', full_name: 'Marcella Pinho' }],
    })[tabela],
  };
  const store = {
    conversas: { '5531999': { fone: '5531999', criadaEm: Date.parse(ontem(9)), historico: [{ papel: 'cliente', ts: Date.parse(ontem(9)) }], transferencias: [{ ts: Date.parse(ontem(10)) }] } },
    visitas: [{ criadaEm: ontem(10), data: '2026-09-30', hora: '15:00' }],
    eventos: [{ tipo: 'captacao', ts: ontem(13) }],
  };
  const d = await dir.coletarDiretoria({ painel, store, catalogo: { esperado: 2611, itens: new Array(2611).fill({}) }, buscaSite: { itens: new Array(2721), erro: null }, agora });
  assert.deepEqual(d.leads.porOrigem, { imoview: 2, site: 1, whatsapp: 2, meta: 0, manual: 0 });
  assert.equal(d.leads.prontos, 1);
  assert.deepEqual(d.captacoes.map((c) => c.quem), ['Thais Freire', 'Marcella Pinho']);
  const t = dir.formatarDiretoria(d, { nome: 'Fernando Mafuz', painelUrl: 'https://mafuz.site/painel' });
  assert.match(t, /^\*MAFUZ · Resumo do dia anterior\*\nSegunda-feira, 28\/09/);
  assert.match(t, /Bom dia, Fernando\./);
  assert.match(t, /5 leads novos\.\nImoview: 2\nSite: 1\nWhatsApp \(Gabi\): 2/);
  assert.match(t, /Thais Freire: Casa · Vila da Serra · R\$ 4\.200\.000 \(venda\)/);
  assert.match(t, /1 anúncio aguardando aprovação/);
  assert.match(t, /1 visita agendada e 1 atendimento encaminhado/);
  assert.match(t, /lendo 2\.721 imóveis do site/);
  assert.match(t, /10:00 · Ricardo · Thais Freire/);
  assert.doesNotMatch(t, /[\u{1F300}-\u{1FAFF}]/u);
});

test('resumo da diretoria: sem acesso ao painel, avisa o que ficou de fora', async () => {
  const dir = require('../src/diretoria');
  const d = await dir.coletarDiretoria({ painel: { configurado: () => false, publico: async () => [] }, store: { conversas: {}, visitas: [], eventos: [] }, catalogo: null, buscaSite: null, agora: new Date('2026-09-29T11:05:00Z') });
  const t = dir.formatarDiretoria(d, {});
  assert.match(t, /PAINEL_EMAIL e PAINEL_SENHA/);
  assert.match(t, /Nenhuma captação publicada/);
});

test('resumo semanal: leads e captações comparados à semana anterior, ranking de captadores', () => {
  const dir = require('../src/diretoria');
  const agora = new Date('2026-10-05T11:05:00Z'); // segunda
  const { atual } = dir.semanas(agora);
  const a = { leads: { total: 40, porOrigem: { imoview: 20, site: 12, whatsapp: 8 } }, captacoes: [{ quem: 'Thais Freire' }, { quem: 'Thais Freire' }, { quem: 'Marcella Pinho' }], gabi: { novas: 30, visitas: 9, encaminhadas: 6, captacoes: 2 }, avisos: [] };
  const b = { leads: { total: 32, porOrigem: { imoview: 20, site: 8, whatsapp: 4 } }, captacoes: [{}, {}], gabi: { novas: 20, visitas: 6 } };
  const t = dir.formatarSemana(a, b, { nome: 'Bruno Sabino', periodo: atual });
  assert.match(t, /^\*MAFUZ · Resumo da semana\*\n28\/09 a 04\/10/);
  assert.match(t, /40 leads novos \(\+25% sobre a semana anterior\)/);
  assert.match(t, /Imoview: 20 \(igual à semana anterior\)/);
  assert.match(t, /WhatsApp \(Gabi\): 8 \(\+100% sobre a semana anterior\)/);
  assert.match(t, /3 imóveis publicados pela equipe \(\+50%/);
  assert.match(t, /1\. Thais Freire · 2 imóveis\n2\. Marcella Pinho · 1 imóvel/);
  assert.match(t, /Bom dia, Bruno\./);
});

test('resumo do corretor: leads da Gabi de ontem na carteira dele (sem acesso ao painel)', () => {
  const agora = new Date('2026-09-29T11:00:00Z');
  const ontem = Date.parse('2026-09-28T15:00:00-03:00');
  const conversas = { '5531977': { fone: '5531977', nome: 'Paula', carteira: 'venda', leadPainel: { id: 'x' }, criadaEm: ontem } };
  const r = rotinas.resumoCorretor({ nome: 'Thais', carteira: 'venda', visitas: [], conversas, novos: [], carteiraDe: (c) => c.carteira, agora });
  assert.match(r.texto, /\*Leads da Gabi ontem na sua carteira \(1\)\*\nPaula · wa\.me\/5531977/);
  const r2 = rotinas.resumoCorretor({ nome: 'Thais', carteira: 'venda', visitas: [], conversas: {}, novos: [], carteiraDe: () => 'venda', agora, leadsPainel: { abertos: 7, novos: [{ nome: 'Rafael', origem: 'imoview' }], prontos: [{ nome: 'Helena' }] } });
  assert.match(r2.texto, /\*Seus leads\* · 7 em aberto\nNovos ontem \(1\):\nRafael · Imoview\nProntos para fechar: Helena\./);
});
