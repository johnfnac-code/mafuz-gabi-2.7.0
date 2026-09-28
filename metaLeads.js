'use strict';
// Meta Lead Ads (formulários instantâneos do Facebook e do Instagram) direto no Pipeline.
//
// A Meta chama /webhook/meta-leads com o id do lead (leadgen). A Gabi busca os
// campos na Graph API com o token da página, cria o lead no painel pela mesma
// função pública do site (create_attributed_lead, origem "meta_lead_ads"),
// avisa a carteira no WhatsApp e, se configurado, inclui o lead no Imoview.
//
// Variáveis: META_VERIFY_TOKEN (texto combinado na configuração do webhook),
// META_PAGE_TOKEN (token de acesso da página, permissão leads_retrieval) e,
// recomendado, META_APP_SECRET (confere a assinatura de cada chamada).

const crypto = require('crypto');
const { log } = require('./util');

const CAMPOS_NOME = ['full_name', 'nome', 'nome_completo'];
const CAMPOS_FONE = ['phone_number', 'telefone', 'celular', 'whatsapp'];
const CAMPOS_EMAIL = ['email', 'e-mail'];

/** field_data da Graph API -> { nome, telefone, email, extras } (função pura). */
function lerCampos(fieldData) {
  const mapa = {};
  for (const f of fieldData || []) {
    if (!f || !f.name) continue;
    mapa[String(f.name).toLowerCase()] = Array.isArray(f.values) ? f.values.join(', ') : String(f.values || '');
  }
  const pega = (lista) => {
    for (const k of lista) if (mapa[k]) return mapa[k];
    return '';
  };
  let nome = pega(CAMPOS_NOME);
  if (!nome && (mapa.first_name || mapa.last_name)) nome = [mapa.first_name, mapa.last_name].filter(Boolean).join(' ');
  const usados = new Set([...CAMPOS_NOME, ...CAMPOS_FONE, ...CAMPOS_EMAIL, 'first_name', 'last_name']);
  const extras = Object.entries(mapa)
    .filter(([k]) => !usados.has(k))
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`);
  let telefone = pega(CAMPOS_FONE).replace(/[^\d+]/g, '');
  if (/^\d{10,11}$/.test(telefone)) telefone = '55' + telefone;
  return { nome: nome.trim(), telefone: telefone.replace(/^\+/, ''), email: pega(CAMPOS_EMAIL).trim(), extras };
}

function assinaturaValida(segredo, corpo, cabecalho) {
  if (!segredo) return true;
  const m = /^sha256=([a-f0-9]{64})$/i.exec(String(cabecalho || ''));
  if (!m) return false;
  const certa = crypto.createHmac('sha256', segredo).update(corpo).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(certa, 'hex'), Buffer.from(m[1].toLowerCase(), 'hex'));
}

class MetaLeads {
  constructor({ config, store, tempoReal, imoview, alertarEquipe }) {
    Object.assign(this, { config, store, tempoReal, imoview, alertarEquipe });
    if (!store.global.metaLeads) store.global.metaLeads = {};
    this.stats = { recebidos: 0, criados: 0, erro: null, ultimo: null };
  }

  ativo() {
    return !!(this.config.meta.verifyToken && this.config.meta.pageToken);
  }

  verificar(params) {
    if (params.get('hub.mode') === 'subscribe' && this.config.meta.verifyToken && params.get('hub.verify_token') === this.config.meta.verifyToken) return params.get('hub.challenge') || '';
    return null;
  }

  async buscarLead(id) {
    const v = this.config.meta.versao;
    const u = `https://graph.facebook.com/${v}/${encodeURIComponent(id)}?fields=created_time,field_data,ad_name,adset_name,campaign_name,form_id,platform&access_token=${encodeURIComponent(this.config.meta.pageToken)}`;
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Graph HTTP ${r.status}: ${(j.error && j.error.message) || ''}`.slice(0, 200));
    return j;
  }

  /** Corpo do webhook -> leads criados. */
  async processar(corpo) {
    const ids = [];
    for (const e of (corpo && corpo.entry) || []) {
      for (const c of e.changes || []) if (c.field === 'leadgen' && c.value && c.value.leadgen_id) ids.push({ id: String(c.value.leadgen_id), form: c.value.form_id || null });
    }
    const criados = [];
    for (const { id } of ids) {
      this.stats.recebidos++;
      if (this.store.global.metaLeads[id]) continue;
      this.store.global.metaLeads[id] = { ts: Date.now() };
      this.store.tocar();
      try {
        const lead = await this.buscarLead(id);
        const c = lerCampos(lead.field_data);
        const campanha = [lead.campaign_name, lead.adset_name, lead.ad_name].filter(Boolean).join(' · ');
        const carteira = /alug|loca/i.test(c.extras.join(' ') + ' ' + campanha) ? 'locacao' : 'venda';
        const notas = [
          `Lead do Meta Ads (${lead.platform === 'ig' ? 'Instagram' : 'Facebook'}).`,
          campanha ? `Campanha: ${campanha}` : '',
          ...c.extras,
          c.telefone ? `WhatsApp: https://wa.me/${c.telefone}` : '',
        ].filter(Boolean);
        let idPainel = null;
        if (this.tempoReal) {
          idPainel = await this.tempoReal.criarLeadWhatsApp({ nome: c.nome || 'Lead Meta Ads', fone: c.telefone, email: c.email, interesse: carteira === 'locacao' ? 'rent' : 'buy', notas: notas.join('\n'), fonte: 'meta_lead_ads' });
        }
        this.store.global.metaLeads[id].painel = idPainel || null;
        await this.alertarEquipe(
          [`*MAFUZ · Lead do Meta Ads · ${carteira === 'locacao' ? 'Locação' : 'Venda'}*`, `${c.nome || 'Sem nome'}${c.telefone ? ` · ${c.telefone}` : ''}`, c.email ? `E-mail: ${c.email}` : '', ...notas.slice(1)].filter(Boolean).join('\n'),
          carteira
        ).catch(() => undefined);
        if (this.config.imoview.enviarLeads && this.imoview && c.telefone) {
          this.imoview
            .incluirLead({ nome: c.nome || 'Lead Meta Ads', telefone: c.telefone, email: c.email, finalidade: carteira, anotacoes: notas.join(' · ').slice(0, 900) })
            .catch((e) => log('meta_lead_imoview_erro', { erro: e.message }));
        }
        this.stats.criados++;
        this.stats.ultimo = new Date().toISOString();
        this.store.evento('meta_lead', { carteira });
        criados.push(id);
      } catch (e) {
        this.stats.erro = e.message;
        delete this.store.global.metaLeads[id]; // tenta de novo se a Meta reenviar
        log('meta_lead_erro', { erro: e.message });
      }
    }
    // Memória de ids: 30 dias.
    for (const [k, v] of Object.entries(this.store.global.metaLeads)) if (Date.now() - v.ts > 30 * 86400000) delete this.store.global.metaLeads[k];
    return criados;
  }

  status() {
    return { ativo: this.ativo(), assinatura: !!this.config.meta.appSecret, ...this.stats };
  }
}

module.exports = { MetaLeads, lerCampos, assinaturaValida };
