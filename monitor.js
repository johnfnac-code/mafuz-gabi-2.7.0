'use strict';
// Monitor de sincronização.
//
// A cada 10 minutos confere se as engrenagens que alimentam a Gabi e o site
// estão girando: carteira do Imoview, índice do site, sincronização de fichas e
// de leads, divergência entre Imoview e site e conexão do WhatsApp. Problema
// novo gera um alerta no WhatsApp do suporte técnico (SUPORTE_TECNICO); o mesmo
// problema só é repetido a cada 6 horas, e a volta ao normal também é avisada.

const { log, partesSP } = require('./util');

const H = 3600000;

function idadeMin(iso, agora) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.round((agora - t) / 60000) : null;
}

/** Lista de problemas atuais (função pura, testável). */
function diagnosticar({ agora = Date.now(), catalogo, buscaSite, tempoReal, whatsapp, ultimoLeadImoview, cfg = {} }) {
  const p = [];
  const limCat = (cfg.catalogoMaxMin || 120);
  const limSite = (cfg.siteMaxMin || 60);
  if (catalogo && catalogo.ativo) {
    const idade = idadeMin(catalogo.ultimaSync, agora);
    if (catalogo.erro && (idade === null || idade > limCat)) p.push({ id: 'catalogo', texto: `Carteira do Imoview sem atualizar${idade !== null ? ` há ${Math.round(idade / 60)} h` : ''}. Último erro: ${String(catalogo.erro).slice(0, 140)}` });
    else if (idade !== null && idade > limCat) p.push({ id: 'catalogo', texto: `Carteira do Imoview sem atualizar há ${Math.round(idade / 60)} h.` });
    else if (idade === null && catalogo.noArMin > 30) p.push({ id: 'catalogo', texto: 'A carteira do Imoview ainda não carregou desde que o servidor subiu.' });
  }
  if (buscaSite) {
    const idade = idadeMin(buscaSite.ultimaSync, agora);
    if (!buscaSite.itens && buscaSite.noArMin > 15) p.push({ id: 'indice_site', texto: `O índice de imóveis do site está vazio${buscaSite.erro ? ` (${String(buscaSite.erro).slice(0, 120)})` : ''}.` });
    else if (idade !== null && idade > limSite) p.push({ id: 'indice_site', texto: `Índice de imóveis do site sem atualizar há ${idade} min.` });
  }
  if (tempoReal && tempoReal.ativo) {
    if ((tempoReal.falhas_leads_seguidas || 0) >= 3) p.push({ id: 'leads_sync', texto: `Sincronização de leads do Imoview falhou ${tempoReal.falhas_leads_seguidas} vezes seguidas. Último erro: ${String(tempoReal.erro_leads || '').slice(0, 140)}` });
    if ((tempoReal.falhas_site_seguidas || 0) >= 3) p.push({ id: 'fichas_sync', texto: `Sincronização de fichas do site falhou ${tempoReal.falhas_site_seguidas} vezes seguidas. Último erro: ${String(tempoReal.erro || '').slice(0, 140)}` });
  }
  if (catalogo && catalogo.itens > 200 && buscaSite && buscaSite.itensImoview > 0) {
    const dif = Math.abs(catalogo.itens - buscaSite.itensImoview);
    if (dif > 60 && dif / catalogo.itens > 0.2) {
      p.push({ id: 'divergencia', texto: `Divergência entre Imoview (${catalogo.itens} imóveis) e site (${buscaSite.itensImoview} do Imoview). Vale rodar a sincronização completa no painel, aba Imoview.` });
    }
  }
  if (ultimoLeadImoview) {
    const idade = idadeMin(ultimoLeadImoview, agora);
    const { diaSemana, hora } = partesSP(new Date(agora));
    if (idade !== null && idade > (cfg.leadsMaxHoras || 48) * 60 && diaSemana >= 1 && diaSemana <= 5 && hora >= 10) {
      p.push({ id: 'leads_parados', texto: `Nenhum lead novo do Imoview no painel há ${Math.round(idade / 60)} h.` });
    }
  }
  if (whatsapp && !/^conectado|não verificado/.test(whatsapp)) p.push({ id: 'whatsapp', texto: `WhatsApp da MAFUZ: ${whatsapp}` });
  return p;
}

class Monitor {
  constructor({ config, zapi, store, catalogo, buscaSite, tempoReal, painel, situacaoWhatsApp, inicio }) {
    Object.assign(this, { config, zapi, store, catalogo, buscaSite, tempoReal, painel, situacaoWhatsApp });
    this.inicio = inicio || Date.now();
    this.ultimo = { ts: null, problemas: [] };
    if (!store.global.monitor) store.global.monitor = {};
  }

  destinatarios() {
    return this.config.monitor.destinatarios;
  }

  async coletar(agora = Date.now()) {
    const noArMin = Math.round((agora - this.inicio) / 60000);
    let ultimoLeadImoview = null;
    if (this.painel && this.painel.configurado()) {
      try {
        const ag = await this.painel.agencia();
        const [l] = await this.painel.ler('agency_leads', `select=created_at&agency_user_id=eq.${ag}&source=eq.imoview&order=created_at.desc&limit=1`);
        ultimoLeadImoview = l ? l.created_at : null;
      } catch (e) {
        log('monitor_leads_erro', { erro: e.message });
      }
    }
    const tr = this.tempoReal ? this.tempoReal.status() : null;
    return {
      agora,
      catalogo: this.catalogo && this.config.imoview.chave ? { ativo: true, ultimaSync: this.catalogo.ultimaSync, erro: this.catalogo.erro, itens: this.catalogo.itens.length, noArMin } : null,
      buscaSite: this.buscaSite
        ? { ultimaSync: this.buscaSite.ultimaSync, erro: this.buscaSite.erro, itens: this.buscaSite.itens.length, itensImoview: this.buscaSite.itens.filter((i) => i.origem_imoview).length, noArMin }
        : null,
      tempoReal: tr,
      whatsapp: this.situacaoWhatsApp ? await this.situacaoWhatsApp().catch(() => 'não verificado') : null,
      ultimoLeadImoview,
      cfg: this.config.monitor,
    };
  }

  async verificar(agora = Date.now()) {
    if (!this.config.monitor.ativo) return [];
    const problemas = diagnosticar(await this.coletar(agora));
    const estado = this.store.global.monitor;
    const ativos = new Set(problemas.map((p) => p.id));
    const avisar = [];
    for (const p of problemas) {
      const e = estado[p.id];
      if (!e || !e.desde) estado[p.id] = { desde: agora, avisadoEm: 0 };
      if (agora - (estado[p.id].avisadoEm || 0) >= 6 * H) {
        estado[p.id].avisadoEm = agora;
        avisar.push(p);
      }
    }
    const resolvidos = [];
    for (const [id, e] of Object.entries(estado)) {
      if (!ativos.has(id)) {
        if (e.avisadoEm) resolvidos.push(id);
        delete estado[id];
      }
    }
    this.store.tocar();
    this.ultimo = { ts: new Date(agora).toISOString(), problemas: problemas.map((p) => p.texto) };
    if (avisar.length || resolvidos.length) await this.avisar(avisar, resolvidos);
    return problemas;
  }

  async avisar(problemas, resolvidos) {
    const NOMES = { catalogo: 'carteira do Imoview', indice_site: 'índice do site', leads_sync: 'sincronização de leads', fichas_sync: 'sincronização de fichas', divergencia: 'divergência Imoview x site', leads_parados: 'leads do Imoview', whatsapp: 'WhatsApp' };
    const texto = [
      '*MAFUZ · Monitor de sincronização*',
      ...problemas.map((p) => `Atenção: ${p.texto}`),
      ...resolvidos.map((id) => `Normalizado: ${NOMES[id] || id}.`),
      problemas.length ? 'O aviso se repete a cada 6 h enquanto o problema continuar.' : '',
    ]
      .filter(Boolean)
      .join('\n');
    for (const fone of this.destinatarios()) {
      try {
        await this.zapi.enviarTexto(fone, texto);
      } catch (e) {
        log('monitor_aviso_erro', { erro: e.message });
      }
    }
    log('monitor_aviso', { problemas: problemas.map((p) => p.id), resolvidos });
    this.store.evento('monitor', { problemas: problemas.map((p) => p.id), resolvidos });
  }

  iniciar() {
    if (!this.config.monitor.ativo) return;
    // Primeira verificação 20 min depois de subir (dá tempo das cargas iniciais).
    setTimeout(() => this.verificar().catch((e) => log('monitor_erro', { erro: e.message })), 20 * 60000).unref();
    setInterval(() => this.verificar().catch((e) => log('monitor_erro', { erro: e.message })), 10 * 60000).unref();
  }

  status() {
    return { ativo: this.config.monitor.ativo, destinatarios: this.destinatarios().length, ultima_verificacao: this.ultimo.ts, problemas: this.ultimo.problemas };
  }
}

module.exports = { Monitor, diagnosticar };
