'use strict';
// Distribuição automática de leads (rodízio por carteira + SLA).
//
// Em horário comercial, a cada 3 minutos:
//  1. Leads novos do painel sem corretor (site, WhatsApp, Meta Ads; os do Imoview
//     já chegam com corretor no CRM) recebem um corretor da carteira certa
//     (venda ou locação), por rodízio: quem recebeu menos leads hoje primeiro.
//  2. O corretor recebe o lead no WhatsApp, com o prazo para o primeiro contato.
//  3. Se o lead continua "Novo" e sem contato registrado depois do SLA
//     (DISTRIBUICAO_SLA_MIN, padrão 30 min), passa para o próximo corretor da
//     fila, e a gestão é avisada. Depois de N reatribuições, fica com a gestão.
// Precisa da conta do painel da Gabi (PAINEL_EMAIL/PAINEL_SENHA ou SUPABASE_SERVICE_KEY).

const { log, dentroDoHorario, foneExibicao, partesSP } = require('./util');
const { chaveCliente } = require('./memoria');
const { origemDoLead, rotuloOrigem } = require('./diretoria');

const carteiraDoLead = (l) => (/rent|loca|alug/i.test(`${l.interest || ''} ${l.property_interest || ''}`) ? 'locacao' : 'venda');

/** Escolhe o próximo corretor: menos leads hoje, depois o rodízio. Função pura. */
function escolherCorretor(pool, { contagem = {}, ponteiro = 0, excluir = [] } = {}) {
  const livres = pool.filter((c) => !excluir.includes(c.id));
  if (!livres.length) return null;
  const min = Math.min(...livres.map((c) => contagem[c.id] || 0));
  const empatados = livres.filter((c) => (contagem[c.id] || 0) === min);
  return empatados[ponteiro % empatados.length];
}

class Distribuicao {
  constructor({ config, store, painel, zapi, alertarGestao }) {
    Object.assign(this, { config, store, painel, zapi, alertarGestao });
    if (!store.global.distribuicao) store.global.distribuicao = { leads: {}, contagem: {}, ponteiro: {} };
    this.rodando = false;
    this.stats = { atribuidos: 0, reatribuidos: 0, ultimo_ciclo: null, erro: null };
  }

  ativa() {
    return !!(this.config.distribuicao.ativo && this.painel && this.painel.configurado());
  }

  estado() {
    const e = this.store.global.distribuicao;
    const hoje = partesSP().iso;
    if (e.dia !== hoje) {
      e.dia = hoje;
      e.contagem = {};
    }
    return e;
  }

  async corretores() {
    const ag = await this.painel.agencia();
    const lista = await this.painel.ler('agency_brokers', `select=id,broker_name,broker_phone,status&agency_user_id=eq.${ag}&status=eq.active&broker_phone=not.is.null`);
    const cfg = this.config.equipe;
    const pools = { venda: [], locacao: [] };
    for (const c of lista) {
      const k = chaveCliente(c.broker_phone);
      if (!k) continue;
      const item = { id: c.id, nome: c.broker_name, fone: String(c.broker_phone).replace(/\D/g, '') };
      if (item.fone.length <= 11) item.fone = '55' + item.fone;
      if (cfg.venda.some((f) => chaveCliente(f) === k)) pools.venda.push(item);
      if (cfg.locacao.some((f) => chaveCliente(f) === k)) pools.locacao.push(item);
    }
    // Sem a lista por carteira: todos os corretores ativos entram nas duas filas.
    const todos = lista.filter((c) => c.broker_phone).map((c) => ({ id: c.id, nome: c.broker_name, fone: String(c.broker_phone).replace(/\D/g, '').replace(/^(?!55)/, '55') }));
    if (!pools.venda.length) pools.venda = todos;
    if (!pools.locacao.length) pools.locacao = todos;
    return pools;
  }

  mensagemCorretor(lead, reatribuido) {
    const origem = rotuloOrigem ? rotuloOrigem(origemDoLead(lead.source)) : lead.source;
    const painelUrl = `${this.config.site.url.replace(/\/$/, '')}/painel?tab=pipeline`;
    const tel = String(lead.phone || '').replace(/\D/g, '');
    return [
      `*MAFUZ · ${reatribuido ? 'Lead repassado para você' : 'Novo lead para você'}*`,
      `${lead.name || 'Sem nome'}${tel ? ` · ${foneExibicao(tel.length <= 11 ? '55' + tel : tel)}` : ''}`,
      `Origem: ${origem}`,
      lead.property_interest ? `Interesse: ${String(lead.property_interest).slice(0, 160)}` : '',
      lead.budget_range ? `Faixa: ${lead.budget_range}` : '',
      tel ? `WhatsApp: https://wa.me/${tel.length <= 11 ? '55' + tel : tel}` : '',
      `Faça o primeiro contato em até ${this.config.distribuicao.slaMin} min e mova o lead no Pipeline. Sem contato registrado, ele passa para o próximo corretor.`,
      painelUrl,
    ]
      .filter(Boolean)
      .join('\n');
  }

  async atribuir(lead, corretor, { reatribuido = false, anterior = null } = {}) {
    const e = this.estado();
    const quando = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const linha = `Distribuição automática: ${corretor.nome} (${quando})${reatribuido && anterior ? `, repassado de ${anterior} por falta de contato em ${this.config.distribuicao.slaMin} min` : ''}`;
    const notas = `${String(lead.notes || '').trim()}\n${linha}`.trim().slice(-6000);
    await this.painel.escrever('agency_leads', `id=eq.${lead.id}`, { assigned_broker_id: corretor.id, notes: notas });
    e.contagem[corretor.id] = (e.contagem[corretor.id] || 0) + 1;
    const reg = e.leads[lead.id] || { historico: [], tentativas: 0, carteira: carteiraDoLead(lead) };
    reg.historico.push(corretor.id);
    reg.corretor = corretor.id;
    reg.ts = Date.now();
    reg.tentativas += 1;
    e.leads[lead.id] = reg;
    this.store.tocar();
    try {
      await this.zapi.enviarTexto(corretor.fone, this.mensagemCorretor(lead, reatribuido));
    } catch (err) {
      log('distribuicao_aviso_erro', { erro: err.message });
    }
    this.store.evento(reatribuido ? 'lead_reatribuido' : 'lead_atribuido', { lead: lead.id, corretor: corretor.id });
    if (reatribuido) this.stats.reatribuidos++;
    else this.stats.atribuidos++;
  }

  async ciclo(agora = new Date()) {
    if (!this.ativa() || this.rodando) return;
    if (!dentroDoHorario(this.config.comportamento.horario, agora)) return;
    this.rodando = true;
    try {
      const e = this.estado();
      const pools = await this.corretores();
      const cfg = this.config.distribuicao;

      // 1. Novos sem corretor
      const desde = new Date(agora.getTime() - cfg.janelaDias * 86400000).toISOString();
      const ag = await this.painel.agencia();
      // select=* para ler, quando existir, o corretor escolhido pelo cliente (vitrine_broker_user_id): esses já têm dono.
      const novos = await this.painel.ler(
        'agency_leads',
        `select=*&agency_user_id=eq.${ag}&stage=eq.new&assigned_broker_id=is.null&created_at=gte.${desde}&order=created_at.asc&limit=25`
      );
      for (const l of novos) {
        if (!cfg.origens.includes(origemDoLead(l.source))) continue;
        if (l.vitrine_broker_user_id) continue;
        const carteira = carteiraDoLead(l);
        const c = escolherCorretor(pools[carteira], { contagem: e.contagem, ponteiro: e.ponteiro[carteira] || 0 });
        if (!c) continue;
        e.ponteiro[carteira] = (e.ponteiro[carteira] || 0) + 1;
        await this.atribuir(l, c);
      }

      // 2. SLA: sem contato no prazo, passa para o próximo.
      const vencidos = Object.entries(e.leads).filter(([, r]) => !r.fim && r.ts && agora.getTime() - r.ts > cfg.slaMin * 60000);
      if (vencidos.length) {
        const ids = vencidos.map(([id]) => id).slice(0, 40);
        const atuais = await this.painel.ler('agency_leads', `select=id,name,phone,source,interest,property_interest,budget_range,notes,stage,last_contact_at,assigned_broker_id&agency_user_id=eq.${ag}&id=in.(${ids.join(',')})`);
        const porId = new Map(atuais.map((l) => [l.id, l]));
        for (const [id, r] of vencidos) {
          const l = porId.get(id);
          const contato = l && l.last_contact_at && Date.parse(l.last_contact_at) > r.ts;
          if (!l || l.stage !== 'new' || contato || l.assigned_broker_id !== r.corretor) {
            r.fim = Date.now();
            continue;
          }
          const todos = [...pools.venda, ...pools.locacao];
          const anterior = (todos.find((c) => c.id === r.corretor) || {}).nome || 'corretor anterior';
          if (r.tentativas > cfg.maxReatribuicoes) {
            r.fim = Date.now();
            await this.alertarGestao(`*MAFUZ · Lead sem contato*\n${l.name || 'Sem nome'} · ${l.phone || ''}\nPassou por ${r.tentativas} corretores sem primeiro contato. Vale a gestão assumir.`).catch(() => undefined);
            continue;
          }
          const proximo = escolherCorretor(pools[r.carteira] || pools.venda, { contagem: e.contagem, ponteiro: e.ponteiro[r.carteira] || 0, excluir: r.historico });
          if (!proximo) {
            r.fim = Date.now();
            continue;
          }
          e.ponteiro[r.carteira] = (e.ponteiro[r.carteira] || 0) + 1;
          await this.atribuir(l, proximo, { reatribuido: true, anterior });
          await this.alertarGestao(`*MAFUZ · Lead repassado*\n${l.name || 'Sem nome'}: ${anterior} não fez o primeiro contato em ${cfg.slaMin} min. Agora está com ${proximo.nome}.`).catch(() => undefined);
        }
      }
      // Limpeza: registros com mais de 7 dias.
      for (const [id, r] of Object.entries(e.leads)) if (r.ts && Date.now() - r.ts > 7 * 86400000) delete e.leads[id];
      this.store.tocar();
      this.stats.ultimo_ciclo = new Date().toISOString();
      this.stats.erro = null;
    } catch (err) {
      this.stats.erro = err.message;
      log('distribuicao_erro', { erro: err.message });
    } finally {
      this.rodando = false;
    }
  }

  iniciar() {
    if (!this.config.distribuicao.ativo) return;
    setInterval(() => this.ciclo().catch(() => undefined), 3 * 60000).unref();
  }

  status() {
    return { ativa: this.ativa(), sla_min: this.config.distribuicao.slaMin, ...this.stats };
  }
}

module.exports = { Distribuicao, escolherCorretor, carteiraDoLead };
