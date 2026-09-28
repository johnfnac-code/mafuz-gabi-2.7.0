'use strict';
// Tempo real entre Imoview, Gabi e o site.
//
// 1. Vigia: a cada poucos minutos lê a PRIMEIRA página do Imoview (os 20 mais
//    recentes de venda e de locação). Código novo entra na carteira da Gabi na
//    hora e dispara a sincronização do site (função imoview-sync do Supabase),
//    em vez de esperar o ciclo completo.
// 2. Leads do Imoview: dispara a função imoview-leads-sync em intervalo curto.
// 3. Leads do WhatsApp: cria o lead no painel (pipeline e lista de leads) pela
//    mesma função pública que o site usa (create_attributed_lead), com origem
//    "whatsapp_gabi".

const { log, sleep } = require('./util');

class TempoReal {
  constructor({ config, imoview, catalogo }) {
    this.config = config;
    this.imoview = imoview;
    this.catalogo = catalogo;
    this.ultimoSyncSite = 0;
    this.ultimoLeadsSync = 0;
    this.stats = { vigias: 0, novos_detectados: 0, syncs_site: 0, syncs_leads: 0, leads_whatsapp: 0, ultimo_novo: null, ultimo_sync_site: null, erro: null };
  }

  ativo() {
    const s = this.config.site;
    return !!(s.supabaseUrl && s.supabaseAnonKey && this.config.tempoReal.ativo);
  }

  async funcao(nome, corpo) {
    const s = this.config.site;
    const r = await fetch(`${s.supabaseUrl}/functions/v1/${nome}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: s.supabaseAnonKey, Authorization: `Bearer ${s.supabaseAnonKey}` },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(55000),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${nome} HTTP ${r.status}: ${t.slice(0, 160)}`);
    return t;
  }

  /** Sincroniza as fichas do site com os mais recentes do Imoview (com intervalo mínimo). */
  async sincronizarSite(motivo, limite = 60) {
    if (!this.ativo()) return false;
    const agora = Date.now();
    if (agora - this.ultimoSyncSite < this.config.tempoReal.intervaloMinimoSyncSeg * 1000) return false;
    this.ultimoSyncSite = agora;
    try {
      await this.funcao('imoview-sync', { action: 'sync', limit: limite, start_page: 1, triggered_by: `gabi-${motivo}` });
      this.stats.syncs_site++;
      this.stats.falhas_site_seguidas = 0;
      this.stats.ultimo_sync_site = new Date().toISOString();
      log('site_sync_ok', { motivo, limite });
      return true;
    } catch (e) {
      this.stats.erro = e.message;
      this.stats.falhas_site_seguidas = (this.stats.falhas_site_seguidas || 0) + 1;
      log('site_sync_erro', { motivo, erro: e.message });
      return false;
    }
  }

  /**
   * Leads do Imoview no painel. A função do site lê a listagem de atendimentos a
   * partir de uma página; como a ordem do Imoview pode colocar os mais novos no
   * fim, a Gabi pede as duas pontas: a primeira página e as últimas de cada
   * finalidade (venda e locação). O upsert é idempotente, então nada duplica.
   */
  async sincronizarLeadsImoview() {
    if (!this.ativo()) return;
    const pedidos = [{ limit: 100, start_page: 1 }];
    if (this.imoview && this.imoview.req) {
      for (const fin of [2, 1]) {
        try {
          const r = await this.imoview.req('GET', '/Atendimento/RetornarAtendimentos', { query: { numeroPagina: 1, numeroRegistros: 20, finalidade: fin }, tentativas: 1 });
          const paginas = Math.ceil((+(r && r.quantidade) || 0) / 20);
          if (paginas > 3) pedidos.push({ limit: 60, start_page: paginas - 2 });
        } catch (e) {
          log('leads_paginas_erro', { finalidade: fin, erro: e.message });
        }
      }
    }
    const resultado = { received: 0, inserted: 0, updated: 0 };
    let falhas = 0;
    for (const p of pedidos) {
      try {
        const t = await this.funcao('imoview-leads-sync', { action: 'sync', ...p, triggered_by: 'gabi' });
        let j = {};
        try {
          j = JSON.parse(t);
        } catch {
          /* resposta sem JSON */
        }
        for (const k of Object.keys(resultado)) resultado[k] += +j[k] || 0;
      } catch (e) {
        this.stats.erro_leads = e.message;
        falhas++;
        log('leads_sync_erro', { erro: e.message, pedido: p });
      }
    }
    this.stats.falhas_leads_seguidas = falhas === pedidos.length ? (this.stats.falhas_leads_seguidas || 0) + 1 : 0;
    this.stats.syncs_leads++;
    this.stats.ultimo_sync_leads = { ts: new Date().toISOString(), ...resultado };
    return resultado;
  }

  /** Leads do Imoview na hora (webhook), no máximo uma vez por minuto. */
  sincronizarLeadsAgora(motivo = 'webhook') {
    const agora = Date.now();
    if (agora - (this.ultimoLeadsAgora || 0) < 60000) return false;
    this.ultimoLeadsAgora = agora;
    this.stats.leads_por_webhook = (this.stats.leads_por_webhook || 0) + 1;
    log('leads_sync_imediato', { motivo });
    this.sincronizarLeadsImoview().catch(() => undefined);
    return true;
  }

  /**
   * Move o lead do WhatsApp no Pipeline conforme a conversa avança
   * (novo → em contato → visita agendada → negociação). Só avança, nunca volta.
   * Precisa da conta do painel da Gabi (PAINEL_EMAIL e PAINEL_SENHA).
   */
  async moverLead(id, etapa, { prontidao } = {}) {
    if (!id || !this.painel || !this.painel.configurado()) return false;
    const ORDEM = ['new', 'contacted', 'visit_scheduled', 'visit_done', 'negotiation', 'documentation', 'won'];
    try {
      const [atual] = await this.painel.ler('agency_leads', `select=id,stage,notes,priority&id=eq.${id}`);
      if (!atual) return false;
      const patch = { last_contact_at: new Date().toISOString() };
      if (atual.stage !== 'lost' && ORDEM.indexOf(etapa) > ORDEM.indexOf(atual.stage)) patch.stage = etapa;
      if (prontidao) {
        const linha = prontidao;
        const notas = String(atual.notes || '');
        patch.notes = /Prontid[aã]o:[^\n]*/i.test(notas) ? notas.replace(/Prontid[aã]o:[^\n]*/i, linha) : `${notas}\n${linha}`.trim();
        const m = linha.match(/(\d+)\/100/);
        if (m && +m[1] >= 60 && atual.priority !== 'high') patch.priority = 'high';
      }
      await this.painel.escrever('agency_leads', `id=eq.${id}`, patch);
      if (patch.stage) {
        this.stats.leads_movidos = (this.stats.leads_movidos || 0) + 1;
        log('lead_movido', { id, de: atual.stage, para: patch.stage });
      }
      return true;
    } catch (e) {
      log('lead_mover_erro', { erro: e.message });
      return false;
    }
  }

  /** Lê a primeira página do Imoview e adiciona à carteira o que for novo. */
  async vigiar() {
    if (!this.catalogo.pronto()) return [];
    this.stats.vigias++;
    const novos = [];
    for (const fin of [2, 1]) {
      try {
        const r = await this.catalogo.pagina(fin, 1);
        for (const b of r.lista || []) {
          if (b && b.codigo && !this.catalogo.porCodigo.has(String(b.codigo))) novos.push(b);
        }
      } catch (e) {
        log('vigia_erro', { finalidade: fin, erro: e.message });
      }
      await sleep(300);
    }
    if (!novos.length) return [];
    const itens = this.catalogo.adicionar(novos);
    this.stats.novos_detectados += itens.length;
    this.stats.ultimo_novo = new Date().toISOString();
    log('vigia_novos', { codigos: itens.map((i) => i.codigo) });
    await this.sincronizarSite('novo-imovel', 40);
    return itens;
  }

  iniciar() {
    if (!this.config.tempoReal.ativo) return;
    const cfg = this.config.tempoReal;
    const vigia = setInterval(() => this.vigiar().catch((e) => log('vigia_erro', { erro: e.message })), cfg.vigiaSeg * 1000);
    vigia.unref();
    const leads = setInterval(() => this.sincronizarLeadsImoview(), cfg.leadsSeg * 1000);
    leads.unref();
    // Primeira sincronização de leads logo depois de subir (não espera o primeiro intervalo).
    setTimeout(() => this.sincronizarLeadsImoview().catch(() => undefined), 20000).unref();
    log('tempo_real_ligado', { vigia_seg: cfg.vigiaSeg, leads_seg: cfg.leadsSeg });
  }

  /** Lead do WhatsApp → pipeline e lista de leads do painel. */
  async criarLeadWhatsApp({ nome, fone, email, interesse, propertyId, notas, fonte }) {
    if (!this.ativo()) return null;
    const s = this.config.site;
    const r = await fetch(`${s.supabaseUrl}/rest/v1/rpc/create_attributed_lead`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: s.supabaseAnonKey, Authorization: `Bearer ${s.supabaseAnonKey}` },
      body: JSON.stringify({
        p_name: nome || 'Cliente WhatsApp',
        p_phone: String(fone || ''),
        p_email: email || null,
        p_property_id: propertyId || null,
        p_referral_token: null,
        p_notes: String(notas || '').slice(0, 3000),
        p_interest: interesse === 'rent' ? 'rent' : 'buy',
        p_source: fonte || 'whatsapp_gabi',
      }),
      signal: AbortSignal.timeout(12000),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`lead painel HTTP ${r.status}: ${t.slice(0, 160)}`);
    this.stats.leads_whatsapp++;
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  }

  status() {
    return { ativo: this.ativo(), move_pipeline: !!(this.painel && this.painel.configurado()), ...this.stats };
  }
}

module.exports = { TempoReal };
