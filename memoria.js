'use strict';
// Memória de longo prazo por cliente.
//
// A conversa do WhatsApp expira depois de CONVERSA_TTL_DIAS. O que importa do
// cliente fica guardado aqui, por telefone, e volta para a Gabi quando ele
// escreve de novo: o que procura, o que já viu, o que descartou, visitas,
// objeções e favoritos marcados na área do cliente do site.

const OBJECOES = [
  ['condomínio alto', /condom[íi]nio[^.,;!?]{0,14}\b(alto|caro|salgado)\b/i],
  ['preço acima do orçamento', /\b(caro|car[íi]ssimo|acima do (meu )?or[çc]amento|fora do (meu )?or[çc]amento|pre[çc]o (muito |bem )?alto|valor (muito |bem )?alto|n[aã]o cabe)\b/i],
  ['localização', /\b(longe|muito distante|fora de m[aã]o|localiza[çc][aã]o ruim|tr[aâ]nsito)\b/i],
  ['tamanho', /\b(pequen[oa]|apertad[oa]|metragem pequena|pouco espa[çc]o)\b/i],
  ['precisa de reforma', /\b(reforma|antig[oa]|desatualizad[oa])\b/i],
  ['sem vaga suficiente', /\b(poucas? vagas?|s[óo] uma vaga|falta vaga)\b/i],
  ['financiamento', /\b(n[aã]o aceita financiamento|precis[oa] financiar|financiamento negado)\b/i],
];

function chave(fone) {
  let d = String(fone || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  return d.length >= 10 ? d.slice(0, 2) + d.slice(-8) : d;
}

function objecoesDe(textos) {
  const achadas = new Set();
  for (const t of textos) {
    for (const [rotulo, re] of OBJECOES) {
      if (!re.test(t)) continue;
      // "condomínio caro" não conta também como preço do imóvel.
      if (rotulo === 'preço acima do orçamento' && OBJECOES[0][1].test(t) && !/\b(im[óo]vel|pre[çc]o|valor|or[çc]amento)\b/i.test(t)) continue;
      achadas.add(rotulo);
    }
  }
  return [...achadas];
}

/** Junta o que já sabíamos do cliente com a conversa atual. */
function consolidar(anterior, conv, visitas = []) {
  const m = { ...(anterior || {}) };
  const agora = Date.now();
  m.fone = conv.fone || m.fone;
  if (conv.nome) m.nome = conv.nome;
  m.primeiroContato = m.primeiroContato || conv.criadaEm || agora;
  m.ultimoContato = Math.max(m.ultimoContato || 0, conv.atualizadaEm || 0);
  if (conv.criadaEm && conv.criadaEm !== m.conversaAtual) {
    m.conversas = (m.conversas || 0) + 1;
    m.conversaAtual = conv.criadaEm;
  }
  const q = conv.qualificacao || {};
  const campos = Object.fromEntries(Object.entries(q).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)));
  if (Object.keys(campos).length) m.perfil = { ...(m.perfil || {}), ...campos };
  if (conv.fonte && !m.origem) m.origem = conv.fonte;

  const vistos = new Set(m.vistos || []);
  for (const i of Object.values(conv.imoveis || {})) if (i && i.apresentado && i.codigo) vistos.add(String(i.codigo));
  m.vistos = [...vistos].slice(-60);

  const falas = (conv.historico || []).filter((h) => h.papel === 'cliente').map((h) => String(h.texto || ''));
  m.objecoes = [...new Set([...(m.objecoes || []), ...objecoesDe(falas)])].slice(0, 8);

  // Descartados: nota baixa no pós-visita ou "não gostei" citando um código.
  const descartados = new Set(m.descartados || []);
  for (const t of falas) {
    const c = t.match(/n[aã]o (gostei|curti|me interessa|serve)[^\d]{0,40}(\d{3,7})/i);
    if (c) descartados.add(c[2]);
  }
  const minhas = visitas.filter((v) => chave(v.fone) === chave(conv.fone));
  for (const v of minhas) if (v.posVisita && v.posVisita.nota && v.posVisita.nota <= 2) descartados.add(String(v.codigo));
  m.descartados = [...descartados].slice(-40);
  m.visitas = minhas.slice(-10).map((v) => ({ codigo: v.codigo, bairro: v.bairro || '', data: v.data, hora: v.hora, nota: v.posVisita ? v.posVisita.nota || null : null }));
  if (conv.captacao) m.captacao = { tipo: conv.captacao.tipo, bairro: conv.captacao.bairro, finalidade: conv.captacao.finalidade };
  if (conv.optOut) m.optOut = true;
  return m;
}

const dataCurta = (ts) => (ts ? new Date(ts).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }) : '');

/** Texto curto para o prompt da Gabi quando o cliente volta. */
function textoMemoria(m) {
  if (!m) return '';
  const p = m.perfil || {};
  const perfil = [
    p.finalidade,
    p.tipo,
    [].concat(p.bairros || []).join(', ') || p.cidade,
    p.preco_max ? `até R$ ${Number(p.preco_max).toLocaleString('pt-BR')}` : '',
    p.dormitorios ? `${p.dormitorios} quartos` : '',
  ].filter(Boolean).join(' · ');
  const linhas = [
    `Cliente que já falou com a MAFUZ antes (${m.conversas || 1} atendimento(s), primeiro em ${dataCurta(m.primeiroContato)}, último em ${dataCurta(m.ultimoContato)}).`,
    perfil ? `Procurava: ${perfil}.` : '',
    m.vistos && m.vistos.length ? `Já recebeu os imóveis: ${m.vistos.slice(-12).join(', ')} (não reenvie sem motivo).` : '',
    m.descartados && m.descartados.length ? `Descartou: ${m.descartados.join(', ')} (não ofereça de novo).` : '',
    m.favoritos && m.favoritos.length ? `Favoritou no site: ${m.favoritos.slice(-10).join(', ')}.` : '',
    m.visitas && m.visitas.length ? `Visitas: ${m.visitas.map((v) => `cód. ${v.codigo} em ${String(v.data || '').split('-').reverse().join('/')}${v.nota ? ` (nota ${v.nota})` : ''}`).join('; ')}.` : '',
    m.objecoes && m.objecoes.length ? `Objeções já ditas: ${m.objecoes.join(', ')}.` : '',
    m.captacao ? `Também falou em ${m.captacao.finalidade === 'locacao' ? 'alugar' : 'vender'} um ${m.captacao.tipo || 'imóvel'} no ${m.captacao.bairro || ''}.` : '',
  ].filter(Boolean);
  return linhas.join('\n');
}

class MemoriaClientes {
  constructor(store) {
    this.store = store;
    if (!store.clientes) store.clientes = {};
  }

  obter(fone) {
    return this.store.clientes[chave(fone)] || null;
  }

  registrar(conv) {
    if (!conv || !conv.fone || /^simulacao|^site/.test(conv.fone)) return null;
    const k = chave(conv.fone);
    this.store.clientes[k] = consolidar(this.store.clientes[k], conv, this.store.visitas || []);
    this.store.tocar();
    return this.store.clientes[k];
  }

  /** Favoritos e preferências vindos da área do cliente. */
  atualizar(fone, patch) {
    const k = chave(fone);
    this.store.clientes[k] = { ...(this.store.clientes[k] || { fone, primeiroContato: Date.now() }), ...patch };
    this.store.tocar();
    return this.store.clientes[k];
  }

  texto(fone) {
    return textoMemoria(this.obter(fone));
  }
}

module.exports = { MemoriaClientes, consolidar, textoMemoria, objecoesDe, chaveCliente: chave };
