'use strict';
// Prontidão do lead: quão perto ele está de fechar negócio.
//
// Nota de 0 a 100 somando sinais que a própria conversa dá: prazo, forma de
// pagamento, ticket, visita marcada, imóvel escolhido, pedido de corretor e
// engajamento. O pipeline do painel ordena os cartões por essa nota, então o
// corretor começa o dia por quem está pronto para comprar.

const PRAZO = { ate_30d: [30, 'quer fechar em até 30 dias'], '30_90d': [18, 'prazo de 30 a 90 dias'], acima_90d: [5, 'prazo acima de 90 dias'] };
const PAGAMENTO = { a_vista: [15, 'pagamento à vista'], financiamento: [10, 'vai financiar'], permuta: [7, 'tem permuta'], avaliando: [3, 'avaliando a forma de pagamento'] };
const MOTIVOS_QUENTES = ['negociacao', 'pedido_do_cliente', 'qualificado', 'alto_ticket', 'venda_do_imovel'];

function prontidao(conv, agora = Date.now()) {
  const q = (conv && conv.qualificacao) || {};
  let pontos = 0;
  const motivos = [];
  const soma = (p, m) => {
    pontos += p;
    if (m) motivos.push(m);
  };

  if (PRAZO[q.prazo]) soma(...PRAZO[q.prazo]);
  if (PAGAMENTO[q.pagamento]) soma(...PAGAMENTO[q.pagamento]);

  const teto = +q.preco_max || 0;
  if (teto >= 5000000) soma(10, 'ticket acima de R$ 5 mi');
  else if (teto || +q.preco_min) soma(7, 'orçamento informado');

  const visitas = (conv && conv.visitas) || [];
  if (visitas.length) soma(25, visitas.length > 1 ? `${visitas.length} visitas marcadas` : 'visita marcada');

  if (q.codigo_imovel_interesse) soma(8, 'escolheu um imóvel');

  const transf = (conv && conv.transferencias) || [];
  if (transf.some((t) => MOTIVOS_QUENTES.includes(t.motivo))) soma(12, 'pediu corretor ou negociação');

  const falas = ((conv && conv.historico) || []).filter((m) => m.papel === 'cliente' || m.papel === 'user').length;
  if (falas >= 8) soma(6, 'conversa longa');
  else if (falas >= 4) soma(3, null);

  const ultima = (conv && conv.atualizadaEm) || 0;
  if (ultima && agora - ultima < 24 * 3600000) soma(5, 'falou nas últimas 24 h');
  else if (ultima && agora - ultima > 14 * 86400000) soma(-10, 'sem resposta há mais de 14 dias');

  if (q.email) soma(2, null);
  if (conv && conv.nome) soma(2, null);

  pontos = Math.max(0, Math.min(100, Math.round(pontos)));
  const faixa = pontos >= 60 ? 'alta' : pontos >= 30 ? 'media' : 'baixa';
  return { pontos, faixa, motivos: motivos.slice(0, 4) };
}

/** Linha que vai nas notas do lead no painel (o site lê "Prontidão: NN/100"). */
function linhaProntidao(conv) {
  const p = prontidao(conv);
  const rotulo = { alta: 'alta', media: 'média', baixa: 'baixa' }[p.faixa];
  return `Prontidão: ${p.pontos}/100 (${rotulo})${p.motivos.length ? ` · ${p.motivos.join(', ')}` : ''}`;
}

module.exports = { prontidao, linhaProntidao };
