'use strict';
// Área do cliente no site (mafuz.site/minha-area), com login pelo WhatsApp.
//
// 1. O cliente informa o celular; a Gabi manda um código de 6 dígitos pelo
//    WhatsApp da MAFUZ (válido por 10 minutos, 5 tentativas).
// 2. Com o código certo, o servidor devolve um token assinado (HMAC, 30 dias).
// 3. Com o token, o site lê e grava favoritos, alertas (Radar MAFUZ) e vê as
//    visitas marcadas com a Gabi. Nada disso usa senha nem cria conta no site.

const crypto = require('crypto');
const { chaveCliente } = require('./memoria');

const DIA = 86400000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function normalizarFone(entrada) {
  let d = String(entrada || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (!/^55\d{10,11}$/.test(d)) return null;
  return d;
}

class AreaCliente {
  constructor({ config, store, zapi, memoria }) {
    this.config = config;
    this.store = store;
    this.zapi = zapi;
    this.memoria = memoria;
    const base = config.areaCliente.segredo || [config.webhookSecret, config.adminToken].filter(Boolean).join('|');
    this.segredo = base ? crypto.createHash('sha256').update('mafuz-area|' + base).digest() : null;
    if (!store.global.acessos) store.global.acessos = {};
  }

  ativa() {
    return !!(this.config.areaCliente.ativa && this.segredo);
  }

  hash(fone, codigo) {
    return crypto.createHmac('sha256', this.segredo).update(`${chaveCliente(fone)}:${codigo}`).digest('hex');
  }

  /** Envia o código pelo WhatsApp. Limites: 1 por minuto e 5 por hora por número. */
  async pedirCodigo(entrada, agora = Date.now()) {
    if (!this.ativa()) return { ok: false, erro: 'A área do cliente está indisponível no momento.' };
    const fone = normalizarFone(entrada);
    if (!fone) return { ok: false, erro: 'Informe um celular com DDD.' };
    const k = chaveCliente(fone);
    const a = this.store.global.acessos[k] || { envios: [] };
    a.envios = (a.envios || []).filter((t) => agora - t < 3600000);
    if (a.envios.length && agora - a.envios[a.envios.length - 1] < 60000) return { ok: false, erro: 'Aguarde um minuto para pedir outro código.' };
    if (a.envios.length >= 5) return { ok: false, erro: 'Muitos pedidos de código. Tente de novo em uma hora.' };
    const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    a.hash = this.hash(fone, codigo);
    a.expira = agora + 10 * 60000;
    a.tentativas = 0;
    a.envios.push(agora);
    this.store.global.acessos[k] = a;
    this.store.tocar();
    await this.zapi.enviarTexto(fone, `Seu código de acesso à área do cliente MAFUZ é ${codigo}. Ele vale por 10 minutos. Se você não pediu, pode ignorar esta mensagem.`);
    return { ok: true, fone };
  }

  /** Confere o código e devolve o token. */
  entrar(entrada, codigo, agora = Date.now()) {
    if (!this.ativa()) return { ok: false, erro: 'A área do cliente está indisponível no momento.' };
    const fone = normalizarFone(entrada);
    const k = fone && chaveCliente(fone);
    const a = k && this.store.global.acessos[k];
    if (!a || !a.hash || a.expira < agora) return { ok: false, erro: 'Código expirado. Peça um novo.' };
    if ((a.tentativas || 0) >= 5) return { ok: false, erro: 'Muitas tentativas. Peça um novo código.' };
    a.tentativas = (a.tentativas || 0) + 1;
    this.store.tocar();
    const esperado = Buffer.from(a.hash, 'hex');
    const recebido = Buffer.from(this.hash(fone, String(codigo || '').replace(/\D/g, '')), 'hex');
    if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return { ok: false, erro: 'Código incorreto.' };
    delete a.hash;
    this.store.tocar();
    return { ok: true, token: this.emitir(fone, agora), fone };
  }

  emitir(fone, agora = Date.now()) {
    const corpo = b64url(JSON.stringify({ f: fone, e: agora + 30 * DIA }));
    const assinatura = b64url(crypto.createHmac('sha256', this.segredo).update(corpo).digest());
    return `${corpo}.${assinatura}`;
  }

  /** Telefone dono do token, ou null. */
  ler(token, agora = Date.now()) {
    if (!this.ativa() || !token) return null;
    const [corpo, assinatura] = String(token).split('.');
    if (!corpo || !assinatura) return null;
    const certa = b64url(crypto.createHmac('sha256', this.segredo).update(corpo).digest());
    if (certa.length !== assinatura.length || !crypto.timingSafeEqual(Buffer.from(certa), Buffer.from(assinatura))) return null;
    try {
      const j = JSON.parse(Buffer.from(corpo.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      return j && j.f && j.e > agora ? j.f : null;
    } catch {
      return null;
    }
  }

  conversaDe(fone) {
    const k = chaveCliente(fone);
    const chave = Object.keys(this.store.conversas).find((c) => chaveCliente(c) === k);
    return chave ? this.store.conversas[chave] : null;
  }

  dados(fone) {
    const conv = this.conversaDe(fone);
    const mem = this.memoria.obter(fone) || {};
    const k = chaveCliente(fone);
    const r = conv && conv.radar;
    return {
      nome: (conv && conv.nome) || mem.nome || '',
      fone,
      favoritos: mem.favoritos || [],
      alerta: r && r.filtros ? { filtros: r.filtros, ativo: !r.desligado, ultimoEnvio: r.ultimoEnvio || null } : null,
      visitas: (this.store.visitas || [])
        .filter((v) => chaveCliente(v.fone) === k)
        .slice(-20)
        .reverse()
        .map((v) => ({ codigo: v.codigo, bairro: v.bairro || '', data: v.data, hora: v.hora, url: v.url || null, status: v.status === 'cancelada' ? 'cancelada' : v.status === 'confirmada' ? 'confirmada' : 'aguardando_confirmacao' })),
      selecoes: ((conv && conv.selecoes) || []).slice(-5).reverse().map((s) => ({ url: s.url, titulo: s.titulo || '', imoveis: s.codigos.length, ts: s.ts })),
      vistos: (mem.vistos || []).slice(-24).reverse(),
    };
  }

  favoritar(fone, codigo, acao) {
    const cod = String(codigo || '').replace(/[^\w-]/g, '').slice(0, 40);
    if (!cod) return null;
    const mem = this.memoria.obter(fone) || {};
    const set = new Set(mem.favoritos || []);
    if (acao === 'remover') set.delete(cod);
    else set.add(cod);
    const favoritos = [...set].slice(-100);
    this.memoria.atualizar(fone, { favoritos, fone: mem.fone || fone });
    this.store.evento('area_favorito', { acao: acao === 'remover' ? 'remover' : 'adicionar', codigo: cod });
    return favoritos;
  }

  /** Cria, muda ou pausa o alerta de imóveis (o mesmo Radar da Gabi). */
  alerta(fone, { filtros, ativo }) {
    let conv = this.conversaDe(fone);
    if (!conv) conv = this.store.conversa(fone);
    conv.radar = conv.radar || { enviados: [] };
    if (filtros && typeof filtros === 'object') {
      const f = {};
      if (['venda', 'locacao'].includes(filtros.finalidade)) f.finalidade = filtros.finalidade;
      if (filtros.tipo) f.tipo = String(filtros.tipo).slice(0, 30);
      if (filtros.cidade) f.cidade = String(filtros.cidade).slice(0, 60);
      if (Array.isArray(filtros.bairros)) f.bairros = filtros.bairros.map((b) => String(b).slice(0, 60)).filter(Boolean).slice(0, 6);
      for (const n of ['preco_min', 'preco_max', 'dormitorios_min', 'suites_min', 'vagas_min']) if (+filtros[n] > 0) f[n] = +filtros[n];
      if (!f.finalidade) f.finalidade = 'venda';
      conv.radar.filtros = f;
      conv.radar.atualizadoEm = Date.now();
      conv.atualizadaEm = Math.max(conv.atualizadaEm || 0, Date.now());
    }
    if (typeof ativo === 'boolean') conv.radar.desligado = !ativo;
    if (conv.radar.desligado === false) delete conv.radar.desligado;
    this.store.tocar();
    this.store.evento('area_alerta', { ativo: !conv.radar.desligado });
    return this.dados(fone).alerta;
  }
}

module.exports = { AreaCliente, normalizarFone };
