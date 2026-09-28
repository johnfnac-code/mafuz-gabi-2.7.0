'use strict';
// Resumo executivo das 8h para a diretoria da MAFUZ (dia anterior completo).
//
// Fontes:
//  · Painel (Supabase do site): leads por origem (Imoview, site, WhatsApp),
//    captações publicadas pela equipe com o nome de quem publicou, anúncios de
//    proprietários, visitas. Precisa de acesso de leitura da administração:
//    PAINEL_EMAIL + PAINEL_SENHA (conta do painel com papel de administração)
//    ou SUPABASE_SERVICE_KEY. Sem acesso, o resumo diz o que ficou de fora.
//  · A própria Gabi: conversas, visitas marcadas, encaminhamentos e captações.
//  · Carteira: imóveis no Imoview, no site e na busca da Gabi (conferência diária
//    de que a Gabi lê o site inteiro).

const { log, partesSP, formatarBRL } = require('./util');

const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const WHATS = ['whatsapp_gabi', 'whatsapp_captacao', 'whatsapp', 'gabi'];
const TIPO = { house: 'Casa', apartment: 'Apartamento', penthouse: 'Cobertura', land: 'Lote', commercial: 'Comercial', rural: 'Rural' };
const n = (v) => Number(v || 0).toLocaleString('pt-BR');
const plural = (q, um, varios) => `${n(q)} ${q === 1 ? um : varios}`;
const primeiro = (s) => String(s || '').trim().split(/\s+/)[0] || '';

function origemDoLead(source) {
  const s = String(source || '').toLowerCase();
  if (s === 'imoview') return 'imoview';
  if (s.startsWith('meta')) return 'meta';
  if (WHATS.includes(s) || s.startsWith('whatsapp')) return 'whatsapp';
  if (!s || s === 'manual') return 'manual';
  return 'site';
}

const ROTULO_ORIGEM = { imoview: 'Imoview', site: 'Site', whatsapp: 'WhatsApp (Gabi)', meta: 'Meta Ads', manual: 'Cadastro manual' };
const rotuloOrigem = (o) => ROTULO_ORIGEM[o] || o;

/** Início e fim (ISO, UTC) do dia anterior no horário de Brasília. */
function diaAnterior(agora = new Date()) {
  const hoje = partesSP(agora);
  const ini = new Date(Date.parse(`${hoje.iso}T00:00:00-03:00`) - 86400000);
  const fim = new Date(ini.getTime() + 86400000);
  const p = partesSP(new Date(ini.getTime() + 12 * 3600000));
  return { ini, fim, p, hoje };
}

// ------------------------------------------------------------------ acesso ao painel
class PainelDados {
  constructor(config) {
    this.s = config.site;
    this.cfg = config.painel || {};
    this.sessao = null;
  }

  configurado() {
    return !!(this.s.supabaseUrl && this.s.supabaseAnonKey && (this.cfg.serviceKey || (this.cfg.email && this.cfg.senha)));
  }

  async token() {
    if (this.cfg.serviceKey) return this.cfg.serviceKey;
    if (this.sessao && this.sessao.expira > Date.now() + 60000) return this.sessao.token;
    const r = await fetch(`${this.s.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.s.supabaseAnonKey },
      body: JSON.stringify({ email: this.cfg.email, password: this.cfg.senha }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`login do painel falhou (HTTP ${r.status})`);
    this.sessao = { token: j.access_token, expira: Date.now() + (j.expires_in || 3600) * 1000 };
    return this.sessao.token;
  }

  async ler(tabela, query) {
    const tk = await this.token();
    const r = await fetch(`${this.s.supabaseUrl}/rest/v1/${tabela}?${query}`, {
      headers: { apikey: this.cfg.serviceKey || this.s.supabaseAnonKey, Authorization: `Bearer ${tk}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`${tabela} HTTP ${r.status}`);
    return r.json();
  }

  async escrever(tabela, filtro, dados) {
    const tk = await this.token();
    const r = await fetch(`${this.s.supabaseUrl}/rest/v1/${tabela}?${filtro}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal', apikey: this.cfg.serviceKey || this.s.supabaseAnonKey, Authorization: `Bearer ${tk}` },
      body: JSON.stringify(dados),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`${tabela} PATCH HTTP ${r.status}`);
    return true;
  }

  /** Id da imobiliária MAFUZ no banco (para não ler dados de outra marca na base compartilhada). */
  async agencia() {
    if (this.agenciaId) return this.agenciaId;
    const tk = await this.token();
    const r = await fetch(`${this.s.supabaseUrl}/rest/v1/rpc/mafuz_main_agency_id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: this.cfg.serviceKey || this.s.supabaseAnonKey, Authorization: `Bearer ${tk}` },
      body: '{}',
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`mafuz_main_agency_id HTTP ${r.status}`);
    const id = await r.json();
    if (!id || typeof id !== 'string') throw new Error('mafuz_main_agency_id vazio');
    this.agenciaId = id;
    return id;
  }

  /** Leitura pública (sem login): imóveis publicados. */
  async publico(tabela, query) {
    const r = await fetch(`${this.s.supabaseUrl}/rest/v1/${tabela}?${query}`, {
      headers: { apikey: this.s.supabaseAnonKey, Authorization: `Bearer ${this.s.supabaseAnonKey}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`${tabela} HTTP ${r.status}`);
    return r.json();
  }
}

// ------------------------------------------------------------------ coleta
async function coletarDiretoria({ painel, store, catalogo, buscaSite, agora = new Date(), periodo = null }) {
  const base = diaAnterior(agora);
  const ini = periodo ? periodo.ini : base.ini;
  const fim = periodo ? periodo.fim : base.fim;
  const { p, hoje } = base;
  const faixa = (campo) => `${campo}=gte.${ini.toISOString()}&${campo}=lt.${fim.toISOString()}`;
  const d = { dia: p, hoje, acessoPainel: false, avisos: [] };

  // Painel: leads, captações, anúncios e agenda
  if (painel && painel.configurado()) {
    try {
      const [leads, props, pend, corretores, visitasHoje] = await Promise.all([
        painel.ler('agency_leads', `select=id,source,stage,assigned_broker_id,notes,created_at&${faixa('created_at')}&limit=5000`),
        painel.ler('properties', `select=id,title,neighborhood,city,price,property_type,listing_type,user_id,listing_broker_id,external_source,status,created_at&${faixa('created_at')}&limit=2000`),
        painel.ler('pending_listings', `select=id,status,source,owner_name,title,neighborhood,created_at,reviewed_at&or=(and(created_at.gte.${ini.toISOString()},created_at.lt.${fim.toISOString()}),status.eq.pending)&limit=2000`),
        painel.ler('agency_brokers', 'select=id,broker_name,broker_user_id,status&limit=500'),
        painel.ler('appointments', `select=id,scheduled_date,scheduled_time,status,buyer_name,broker_id&scheduled_date=eq.${hoje.iso}&status=neq.cancelled&order=scheduled_time&limit=50`),
      ]);
      d.acessoPainel = true;
      const porOrigem = { imoview: 0, site: 0, whatsapp: 0, meta: 0, manual: 0 };
      for (const l of leads) porOrigem[origemDoLead(l.source)]++;
      const prontos = leads.filter((l) => {
        const m = String(l.notes || '').match(/Prontid[aã]o:\s*(\d+)/i);
        return m && +m[1] >= 60;
      });
      d.leads = { total: leads.length, porOrigem, prontos: prontos.length, prontosSemCorretor: prontos.filter((l) => !l.assigned_broker_id).length, captacoesWhats: leads.filter((l) => l.source === 'whatsapp_captacao').length };

      const nomes = new Map(corretores.filter((c) => c.broker_user_id).map((c) => [c.broker_user_id, c.broker_name]));
      const faltam = [...new Set(props.map((x) => x.user_id).filter((u) => u && !nomes.has(u)))];
      if (faltam.length) {
        try {
          const perfis = await painel.ler('profiles', `select=user_id,full_name&user_id=in.(${faltam.join(',')})`);
          for (const pf of perfis) if (pf.full_name) nomes.set(pf.user_id, pf.full_name);
        } catch (e) {
          /* sem leitura de perfis: fica "Equipe MAFUZ" */
        }
      }
      const daEquipe = props.filter((x) => !x.external_source && x.status === 'published');
      d.captacoes = daEquipe.map((x) => ({
        quem: nomes.get(x.listing_broker_id || x.user_id) || 'Equipe MAFUZ',
        tipo: TIPO[x.property_type] || 'Imóvel',
        bairro: String(x.neighborhood || '').replace(/\s+/g, ' ').trim(),
        preco: x.price ? formatarBRL(x.price) : 'valor sob consulta',
        finalidade: ['rent', 'season'].includes(x.listing_type) ? 'locação' : 'venda',
      }));
      d.imoviewNoSite = props.filter((x) => x.external_source === 'imoview').length;
      const doDia = pend.filter((x) => Date.parse(x.created_at) >= ini.getTime() && Date.parse(x.created_at) < fim.getTime());
      d.anuncios = {
        recebidos: doDia.filter((x) => x.source !== 'painel_captacao').length,
        aguardando: pend.filter((x) => x.status === 'pending').length,
      };
      d.agendaHoje = visitasHoje.map((v) => ({ hora: String(v.scheduled_time || '').slice(0, 5), cliente: v.buyer_name || 'Cliente', corretor: nomes.get(v.broker_id) || '' }));
    } catch (e) {
      d.avisos.push(`Dados do painel indisponíveis nesta manhã (${e.message}).`);
      log('diretoria_painel_erro', { erro: e.message });
    }
  } else {
    d.avisos.push('Leads do Imoview e do site e os nomes de quem captou entram no resumo quando o acesso de leitura do painel estiver configurado (PAINEL_EMAIL e PAINEL_SENHA).');
  }

  // Sem painel: publicações da equipe pela API pública (sem nomes)
  if (!d.acessoPainel && painel) {
    try {
      const props = await painel.publico('properties', `select=id,property_type,neighborhood,price,listing_type,external_source&status=eq.published&${faixa('created_at')}&limit=2000`);
      d.captacoes = props.filter((x) => !x.external_source).map((x) => ({ quem: '', tipo: TIPO[x.property_type] || 'Imóvel', bairro: x.neighborhood || '', preco: x.price ? formatarBRL(x.price) : 'valor sob consulta', finalidade: x.listing_type === 'rent' ? 'locação' : 'venda' }));
      d.imoviewNoSite = props.filter((x) => x.external_source === 'imoview').length;
    } catch (e) {
      /* segue sem */
    }
  }

  // Gabi: conversas, visitas, encaminhamentos e captações do dia
  const conversas = Object.values(store.conversas || {}).filter((c) => c && c.fone && !/^site|^simulacao/.test(c.fone));
  const noDia = (ts) => ts >= ini.getTime() && ts < fim.getTime();
  const novas = conversas.filter((c) => noDia(c.criadaEm || 0));
  const ativas = conversas.filter((c) => (c.historico || []).some((h) => h.papel === 'cliente' && noDia(h.ts || 0)));
  const encaminhadas = conversas.filter((c) => (c.transferencias || []).some((t) => noDia(t.ts || 0)));
  const visitasGabi = (store.visitas || []).filter((v) => noDia(Date.parse(v.criadaEm || 0) || 0));
  const captacoesGabi = (store.eventos || []).filter((e) => e.tipo === 'captacao' && noDia(Date.parse(e.ts))).length;
  d.gabi = { ativas: ativas.length, novas: novas.length, encaminhadas: encaminhadas.length, visitas: visitasGabi.length, captacoes: captacoesGabi };
  if (!d.leads) d.leads = { total: null, porOrigem: { whatsapp: novas.filter((c) => c.leadPainel).length }, prontos: null };

  // Agenda de hoje marcada pela Gabi (se o painel não trouxe)
  if (!d.agendaHoje) {
    d.agendaHoje = (store.visitas || [])
      .filter((v) => v.data === hoje.iso && v.status !== 'cancelada')
      .sort((a, b) => String(a.hora).localeCompare(String(b.hora)))
      .map((v) => ({ hora: v.hora, cliente: v.nome || 'Cliente', codigo: v.codigo, bairro: v.bairro }));
  }

  // Carteira e conferência da busca
  const iniDia = ini.toISOString().slice(0, 10);
  const itens = (catalogo && catalogo.itens) || [];
  d.carteira = {
    imoview: catalogo ? catalogo.esperado || itens.length : null,
    naBuscaImoview: itens.length,
    noSite: buscaSite ? buscaSite.itens.length : null,
    siteOk: !!(buscaSite && buscaSite.itens.length >= 50 && !buscaSite.erro),
    novosImoview: itens.filter((i) => i.cadastro === iniDia).length,
    reduzidos: itens.filter((i) => i.precoAnterior && i.preco && i.precoAnterior > i.preco * 1.02 && i.detectadoEm && noDia(Date.parse(i.detectadoEm))).length,
  };
  return d;
}

// ------------------------------------------------------------------ texto
function formatarDiretoria(d, { nome, painelUrl } = {}) {
  const p = d.dia;
  const dataLonga = `${DIAS[p.diaSemana]}, ${String(p.dia).padStart(2, '0')}/${String(p.mes).padStart(2, '0')}`;
  const L = [];
  L.push('*MAFUZ · Resumo do dia anterior*');
  L.push(`${dataLonga[0].toUpperCase()}${dataLonga.slice(1)}`);
  L.push('');
  L.push(`Bom dia${nome ? `, ${primeiro(nome)}` : ''}. Segue o consolidado da operação.`);

  // Leads
  L.push('');
  L.push('*Leads*');
  if (d.leads && d.leads.total !== null && d.leads.total !== undefined) {
    const o = d.leads.porOrigem;
    L.push(`${d.leads.total === 0 ? 'Nenhum lead novo.' : `${plural(d.leads.total, 'lead novo', 'leads novos')}.`}`);
    if (d.leads.total) {
      L.push(`Imoview: ${n(o.imoview)}`);
      L.push(`Site: ${n(o.site)}`);
      L.push(`WhatsApp (Gabi): ${n(o.whatsapp)}`);
      if (o.meta) L.push(`Meta Ads: ${n(o.meta)}`);
      if (o.manual) L.push(`Cadastro manual: ${n(o.manual)}`);
    }
    if (d.leads.prontos) L.push(`Com prontidão alta: ${n(d.leads.prontos)}${d.leads.prontosSemCorretor ? `, sendo ${n(d.leads.prontosSemCorretor)} ainda sem corretor` : ''}.`);
  } else {
    L.push(`WhatsApp (Gabi): ${n(d.leads && d.leads.porOrigem ? d.leads.porOrigem.whatsapp : 0)}`);
  }

  // Captações
  L.push('');
  L.push('*Captações publicadas no site*');
  const caps = d.captacoes || [];
  if (!caps.length) L.push('Nenhuma captação publicada pela equipe.');
  else {
    L.push(`${plural(caps.length, 'imóvel publicado', 'imóveis publicados')} pela equipe:`);
    for (const c of caps.slice(0, 12)) L.push(`${c.quem ? `${c.quem}: ` : ''}${c.tipo} · ${c.bairro} · ${c.preco} (${c.finalidade})`);
    if (caps.length > 12) L.push(`e mais ${n(caps.length - 12)}.`);
    const porPessoa = {};
    for (const c of caps) if (c.quem) porPessoa[c.quem] = (porPessoa[c.quem] || 0) + 1;
    const rank = Object.entries(porPessoa).sort((a, b) => b[1] - a[1]);
    if (rank.length > 1) L.push(`Por captador: ${rank.map(([q, v]) => `${q} (${v})`).join(', ')}.`);
  }
  const extras = [];
  if (d.gabi && d.gabi.captacoes) extras.push(`${plural(d.gabi.captacoes, 'proprietário atendido', 'proprietários atendidos')} pela Gabi para captação`);
  if (d.anuncios) {
    if (d.anuncios.recebidos) extras.push(`${plural(d.anuncios.recebidos, 'anúncio recebido', 'anúncios recebidos')} pelo site`);
    if (d.anuncios.aguardando) extras.push(`${plural(d.anuncios.aguardando, 'anúncio aguardando', 'anúncios aguardando')} aprovação no painel`);
  }
  if (extras.length) L.push(`${extras.join('; ')}.`.replace(/^./, (x) => x.toUpperCase()));

  // Gabi
  const g = d.gabi || {};
  L.push('');
  L.push('*Atendimento da Gabi*');
  L.push(`${plural(g.ativas || 0, 'conversa ativa', 'conversas ativas')}, sendo ${plural(g.novas || 0, 'cliente novo', 'clientes novos')}.`);
  L.push(`${plural(g.visitas || 0, 'visita agendada', 'visitas agendadas')} e ${plural(g.encaminhadas || 0, 'atendimento encaminhado', 'atendimentos encaminhados')} para corretores.`);

  // Carteira
  const c = d.carteira || {};
  L.push('');
  L.push('*Carteira*');
  const linhaCarteira = [];
  if (c.imoview) linhaCarteira.push(`${n(c.imoview)} imóveis ativos no Imoview`);
  if (c.noSite) linhaCarteira.push(`${n(c.noSite)} publicados no site`);
  if (linhaCarteira.length) L.push(`${linhaCarteira.join(' e ')}.`);
  L.push(c.siteOk ? `Busca da Gabi: lendo ${n(c.noSite)} imóveis do site e ${n(c.naBuscaImoview)} do Imoview.` : 'Atenção: a busca da Gabi no site não carregou nesta manhã. A equipe técnica foi avisada.');
  const mov = [];
  if (c.novosImoview) mov.push(`${plural(c.novosImoview, 'imóvel novo', 'imóveis novos')} no Imoview`);
  if (d.imoviewNoSite) mov.push(`${plural(d.imoviewNoSite, 'imóvel sincronizado', 'imóveis sincronizados')} para o site`);
  if (c.reduzidos) mov.push(`${plural(c.reduzidos, 'imóvel com preço reduzido', 'imóveis com preço reduzido')}`);
  if (mov.length) L.push(`No dia: ${mov.join(', ')}.`);

  // Agenda de hoje
  const ag = d.agendaHoje || [];
  L.push('');
  L.push('*Agenda de hoje*');
  if (!ag.length) L.push('Nenhuma visita marcada.');
  else for (const v of ag.slice(0, 10)) L.push(`${v.hora} · ${v.cliente}${v.codigo ? ` · cód. ${v.codigo}` : ''}${v.bairro ? ` · ${v.bairro}` : ''}${v.corretor ? ` · ${v.corretor}` : ''}`);

  if (d.avisos && d.avisos.length) {
    L.push('');
    L.push(`_${d.avisos.join(' ')}_`);
  }
  if (painelUrl) {
    L.push('');
    L.push(`Painel completo: ${painelUrl}`);
  }
  return L.join('\n');
}

/** Semana que terminou ontem (7 dias) e a semana anterior, para comparar. */
function semanas(agora = new Date()) {
  const { fim } = diaAnterior(agora);
  const atual = { ini: new Date(fim.getTime() - 7 * 86400000), fim };
  const anterior = { ini: new Date(fim.getTime() - 14 * 86400000), fim: atual.ini };
  return { atual, anterior };
}

const variacao = (a, b) => {
  if (a === null || a === undefined || b === null || b === undefined) return '';
  if (!b) return a ? ' (sem base na semana anterior)' : '';
  const pct = Math.round(((a - b) / b) * 100);
  return pct === 0 ? ' (igual à semana anterior)' : ` (${pct > 0 ? '+' : ''}${pct}% sobre a semana anterior)`;
};

function formatarSemana(atual, anterior, { nome, painelUrl, periodo } = {}) {
  const f = (d) => `${String(partesSP(d).dia).padStart(2, '0')}/${String(partesSP(d).mes).padStart(2, '0')}`;
  const L = [];
  L.push('*MAFUZ · Resumo da semana*');
  if (periodo) L.push(`${f(periodo.ini)} a ${f(new Date(periodo.fim.getTime() - 3600000))}`);
  L.push('');
  L.push(`Bom dia${nome ? `, ${primeiro(nome)}` : ''}. Segue o consolidado dos últimos sete dias, comparado à semana anterior.`);

  L.push('');
  L.push('*Leads*');
  if (atual.leads && atual.leads.total !== null && atual.leads.total !== undefined) {
    const o = atual.leads.porOrigem;
    const oa = (anterior.leads && anterior.leads.porOrigem) || {};
    L.push(`${plural(atual.leads.total, 'lead novo', 'leads novos')}${variacao(atual.leads.total, anterior.leads && anterior.leads.total)}.`);
    L.push(`Imoview: ${n(o.imoview)}${variacao(o.imoview, oa.imoview)}`);
    L.push(`Site: ${n(o.site)}${variacao(o.site, oa.site)}`);
    L.push(`WhatsApp (Gabi): ${n(o.whatsapp)}${variacao(o.whatsapp, oa.whatsapp)}`);
    if (o.meta || oa.meta) L.push(`Meta Ads: ${n(o.meta || 0)}${variacao(o.meta || 0, oa.meta)}`);
  } else {
    const w = atual.leads && atual.leads.porOrigem ? atual.leads.porOrigem.whatsapp : 0;
    const wa = anterior.leads && anterior.leads.porOrigem ? anterior.leads.porOrigem.whatsapp : null;
    L.push(`WhatsApp (Gabi): ${n(w)}${variacao(w, wa)}`);
  }

  L.push('');
  L.push('*Captações publicadas no site*');
  const caps = atual.captacoes || [];
  L.push(`${caps.length ? plural(caps.length, 'imóvel publicado', 'imóveis publicados') : 'Nenhum imóvel publicado'} pela equipe${variacao(caps.length, (anterior.captacoes || []).length)}.`);
  if (atual.gabi && atual.gabi.captacoes) L.push(`${plural(atual.gabi.captacoes, 'proprietário atendido', 'proprietários atendidos')} pela Gabi para captação.`);

  const rank = {};
  for (const c of caps) if (c.quem && c.quem !== 'Equipe MAFUZ') rank[c.quem] = (rank[c.quem] || 0) + 1;
  const r = Object.entries(rank).sort((a, b) => b[1] - a[1]);
  if (r.length) {
    L.push('');
    L.push('*Ranking de captações*');
    r.slice(0, 8).forEach(([q, v], i) => L.push(`${i + 1}. ${q} · ${plural(v, 'imóvel', 'imóveis')}`));
  }

  const g = atual.gabi || {};
  const ga = anterior.gabi || {};
  L.push('');
  L.push('*Atendimento da Gabi*');
  L.push(`${plural(g.novas || 0, 'cliente novo', 'clientes novos')}${variacao(g.novas || 0, ga.novas)}.`);
  L.push(`${plural(g.visitas || 0, 'visita agendada', 'visitas agendadas')}${variacao(g.visitas || 0, ga.visitas)} e ${plural(g.encaminhadas || 0, 'atendimento encaminhado', 'atendimentos encaminhados')} para corretores.`);

  if (atual.avisos && atual.avisos.length) {
    L.push('');
    L.push(`_${atual.avisos.join(' ')}_`);
  }
  if (painelUrl) {
    L.push('');
    L.push(`Painel completo: ${painelUrl}`);
  }
  return L.join('\n');
}

function horaDiretoria({ agora = new Date(), hora = 8, dias = [0, 1, 2, 3, 4, 5, 6], ultimoEnvio }) {
  const p = partesSP(agora);
  return dias.includes(p.diaSemana) && p.hora === hora && ultimoEnvio !== p.iso;
}

/** Leads para o resumo de um corretor: os atribuídos a ele no painel (se houver acesso). */
async function leadsDoCorretor({ painel, fone, agora = new Date() }) {
  if (!painel || !painel.configurado()) return null;
  const { ini, fim } = diaAnterior(agora);
  const corretores = await painel.ler('agency_brokers', 'select=id,broker_phone,status&limit=500');
  const final = String(fone).replace(/\D/g, '').slice(-9);
  const eu = corretores.find((c) => String(c.broker_phone || '').replace(/\D/g, '').slice(-9) === final);
  if (!eu) return null;
  const leads = await painel.ler('agency_leads', `select=id,name,source,stage,notes,created_at&assigned_broker_id=eq.${eu.id}&stage=not.in.(won,lost)&order=created_at.desc&limit=200`);
  const novos = leads.filter((l) => Date.parse(l.created_at) >= ini.getTime() && Date.parse(l.created_at) < fim.getTime());
  const prontos = leads.filter((l) => {
    const m = String(l.notes || '').match(/Prontid[aã]o:\s*(\d+)/i);
    return m && +m[1] >= 60;
  });
  return { novos: novos.map((l) => ({ nome: l.name, origem: origemDoLead(l.source) })), prontos: prontos.map((l) => ({ nome: l.name })), abertos: leads.length };
}

module.exports = { PainelDados, coletarDiretoria, formatarDiretoria, formatarSemana, semanas, leadsDoCorretor, horaDiretoria, diaAnterior, origemDoLead, rotuloOrigem };
