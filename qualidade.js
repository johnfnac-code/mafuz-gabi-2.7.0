'use strict';
// Painel de qualidade das conversas da Gabi: onde a conversa avança, onde para
// e por quê. Tudo calculado a partir do estado do agente (sem custo de IA).

const { objecoesDe } = require('./memoria');

const FAIXAS = [
  [0, 1000000, 'até R$ 1 mi'],
  [1000000, 2000000, 'R$ 1 a 2 mi'],
  [2000000, 4000000, 'R$ 2 a 4 mi'],
  [4000000, 8000000, 'R$ 4 a 8 mi'],
  [8000000, Infinity, 'acima de R$ 8 mi'],
];
const FAIXAS_LOC = [
  [0, 5000, 'até R$ 5 mil'],
  [5000, 10000, 'R$ 5 a 10 mil'],
  [10000, 20000, 'R$ 10 a 20 mil'],
  [20000, Infinity, 'acima de R$ 20 mil'],
];

function faixaDe(q) {
  const v = +q.preco_max || +q.preco_min || 0;
  if (!v) return null;
  const tabela = /alug|loca/i.test(q.finalidade || '') || v < 60000 ? FAIXAS_LOC : FAIXAS;
  const f = tabela.find(([a, b]) => v >= a && v < b);
  return f ? f[2] : null;
}

const top = (obj, n = 6) =>
  Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([nome, total]) => ({ nome, total }));

/**
 * @param conversas lista de conversas de clientes (sem equipe e simulações)
 * @param visitas store.visitas
 * @param dias janela
 */
function qualidadeConversas({ conversas, visitas = [], eventos = [], dias = 30, agora = Date.now() }) {
  const desde = agora - dias * 86400000;
  const conv = conversas.filter((c) => (c.criadaEm || c.atualizadaEm || 0) >= desde);
  const n = conv.length;
  const pct = (x) => (n ? Math.round((x / n) * 100) : 0);

  const respondeu = conv.filter((c) => c.historico.filter((h) => h.papel === 'cliente').length >= 2);
  const perfil = conv.filter((c) => c.radar && c.radar.filtros);
  const recebeuImoveis = conv.filter((c) => Object.values(c.imoveis || {}).some((i) => i.apresentado));
  const lead = conv.filter((c) => (c.leadPainel && c.leadPainel.id) || c.leadEnviadoImoview || c.temperatura);
  const visita = conv.filter((c) => (c.visitas || []).length);
  const corretor = conv.filter((c) => (c.transferencias || []).length);

  // Motivos de perda: conversas que pararam antes de lead/visita.
  const perdas = {};
  const objecoes = {};
  for (const c of conv) {
    const falas = c.historico.filter((h) => h.papel === 'cliente').map((h) => String(h.texto || ''));
    for (const o of objecoesDe(falas)) objecoes[o] = (objecoes[o] || 0) + 1;
    if ((c.visitas || []).length || c.temperatura) continue;
    const ultimaCliente = [...c.historico].reverse().find((h) => h.papel === 'cliente');
    const parada = !ultimaCliente || agora - ultimaCliente.ts > 3 * 86400000;
    if (!parada) continue;
    let motivo;
    if (c.optOut) motivo = 'pediu para não receber mensagens';
    else if (falas.length <= 1) motivo = 'não respondeu depois da primeira mensagem';
    else if (!(c.radar && c.radar.filtros)) motivo = 'perfil não chegou a ser definido';
    else if (!Object.values(c.imoveis || {}).some((i) => i.apresentado)) motivo = 'não recebeu imóveis';
    else if (objecoesDe(falas).length) motivo = `objeção: ${objecoesDe(falas)[0]}`;
    else motivo = 'parou depois de ver imóveis';
    perdas[motivo] = (perdas[motivo] || 0) + 1;
  }

  const bairros = {};
  const faixas = {};
  const tipos = {};
  for (const c of conv) {
    const q = c.qualificacao || {};
    for (const b of [].concat(q.bairros || [])) if (b) bairros[String(b).trim()] = (bairros[String(b).trim()] || 0) + 1;
    const f = faixaDe(q);
    if (f) faixas[f] = (faixas[f] || 0) + 1;
    if (q.tipo) tipos[String(q.tipo).toLowerCase()] = (tipos[String(q.tipo).toLowerCase()] || 0) + 1;
  }

  // Tempo até o primeiro imóvel enviado (em mensagens do cliente).
  const turnos = recebeuImoveis.map((c) => {
    const i = c.historico.findIndex((h) => h.papel === 'agente' && /\[imóvel enviado/.test(h.texto));
    return i < 0 ? null : c.historico.slice(0, i).filter((h) => h.papel === 'cliente').length;
  }).filter((x) => x !== null).sort((a, b) => a - b);

  const notas = visitas.filter((v) => v.posVisita && v.posVisita.nota && Date.parse(v.criadaEm || 0) >= desde).map((v) => v.posVisita.nota);
  const respostasEquipe = eventos.filter((e) => e.tipo === 'resposta_humana' && Date.parse(e.ts) >= desde).map((e) => e.minutos).filter((m) => m >= 0).sort((a, b) => a - b);

  return {
    dias,
    conversas: n,
    funil: [
      { etapa: 'Conversas iniciadas', total: n, pct: 100 },
      { etapa: 'Cliente respondeu', total: respondeu.length, pct: pct(respondeu.length) },
      { etapa: 'Perfil definido', total: perfil.length, pct: pct(perfil.length) },
      { etapa: 'Recebeu imóveis', total: recebeuImoveis.length, pct: pct(recebeuImoveis.length) },
      { etapa: 'Virou lead', total: lead.length, pct: pct(lead.length) },
      { etapa: 'Visita pedida', total: visita.length, pct: pct(visita.length) },
    ],
    conversao_visita: pct(visita.length),
    conversao_lead: pct(lead.length),
    encaminhadas_corretor: corretor.length,
    perdas: top(perdas, 8),
    objecoes: top(objecoes, 8),
    bairros: top(bairros, 8),
    faixas: top(faixas, 6),
    tipos: top(tipos, 6),
    mensagens_ate_primeiro_imovel: turnos.length ? turnos[Math.floor(turnos.length / 2)] : null,
    nota_pos_visita: notas.length ? Math.round((notas.reduce((a, b) => a + b, 0) / notas.length) * 10) / 10 : null,
    notas_pos_visita: notas.length,
    resposta_equipe_mediana_min: respostasEquipe.length ? respostasEquipe[Math.floor(respostasEquipe.length / 2)] : null,
  };
}

module.exports = { qualidadeConversas, faixaDe };
