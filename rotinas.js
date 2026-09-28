'use strict';
// Rotinas da equipe: o resumo das 8h de cada corretor e o pós-visita automático.
// Funções puras (recebem o estado e devolvem o que enviar) para serem testáveis;
// o server.js decide quando rodar e faz o envio.

const { partesSP, formatarBRL } = require('./util');

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

// Visitas são marcadas no horário de Brasília (UTC-3, sem horário de verão).
const tsVisita = (v) => Date.parse(`${v.data}T${String(v.hora || '12:00').padStart(5, '0')}:00-03:00`);

const primeiroNome = (s) => String(s || '').trim().split(/\s+/)[0] || '';

/**
 * Resumo das 8h para um corretor.
 * @param {object} p
 * @param {string} p.nome        nome do corretor
 * @param {'venda'|'locacao'} p.carteira
 * @param {object[]} p.visitas   store.visitas
 * @param {object} p.conversas   store.conversas
 * @param {object[]} p.novos     imóveis que entraram na carteira nas últimas 24h
 * @param {(conv:object)=>string} p.carteiraDe
 * @param {string} p.painelUrl
 * @param {Date} [p.agora]
 */
function resumoCorretor({ nome, carteira, visitas, conversas, novos, carteiraDe, painelUrl, agora = new Date(), leadsPainel = null }) {
  const hoje = partesSP(agora);
  const doDia = visitas
    .filter((v) => v.data === hoje.iso && v.status !== 'cancelada')
    .filter((v) => {
      const c = conversas[v.fone];
      return !c || carteiraDe(c) === carteira;
    })
    .sort((a, b) => String(a.hora).localeCompare(String(b.hora)));

  const esperando = Object.values(conversas)
    .filter((c) => c && c.encaminhamento && !c.encaminhamento.respondidoEm && carteiraDe(c) === carteira)
    .filter((c) => agora.getTime() - c.encaminhamento.ts > 15 * 60000 && agora.getTime() - c.encaminhamento.ts < 7 * 86400000)
    .sort((a, b) => a.encaminhamento.ts - b.encaminhamento.ts);

  const naCarteira = (novos || []).filter((i) => (carteira === 'locacao' ? /loca|alug/i.test(i.finalidade || '') : !/loca|alug/i.test(i.finalidade || '')));

  const linhas = [];
  const data = `${DIAS[hoje.diaSemana]}, ${String(hoje.dia).padStart(2, '0')}/${String(hoje.mes).padStart(2, '0')}`;
  linhas.push('*MAFUZ · Seu resumo do dia*');
  linhas.push(`${data[0].toUpperCase()}${data.slice(1)} · carteira de ${carteira === 'locacao' ? 'locação' : 'venda'}`);
  linhas.push('');
  linhas.push(`Bom dia${nome ? `, ${primeiroNome(nome)}` : ''}. Seguem os pontos de hoje.`);

  linhas.push('');
  linhas.push(`*Visitas de hoje${doDia.length ? ` (${doDia.length})` : ''}*`);
  if (doDia.length) {
    for (const v of doDia.slice(0, 8)) linhas.push(`${v.hora} · ${v.nome || 'Cliente'} · cód. ${v.codigo}${v.bairro ? ` · ${v.bairro}` : ''}`);
  } else {
    linhas.push('Nenhuma visita marcada pela Gabi para hoje.');
  }

  linhas.push('');
  linhas.push(`*Clientes aguardando retorno${esperando.length ? ` (${esperando.length})` : ''}*`);
  if (esperando.length) {
    for (const c of esperando.slice(0, 6)) {
      const horas = Math.round((agora.getTime() - c.encaminhamento.ts) / 3600000);
      linhas.push(`${c.nome || 'Cliente'} · há ${horas < 1 ? 'menos de 1 h' : `${horas} h`} · wa.me/${c.fone}`);
    }
    if (esperando.length > 6) linhas.push(`e mais ${esperando.length - 6} no painel.`);
  } else {
    linhas.push('Nenhum cliente aguardando retorno.');
  }

  // Leads: os atribuídos no painel (com acesso) ou os que a Gabi trouxe ontem para esta carteira.
  const ORIG = { imoview: 'Imoview', site: 'site', whatsapp: 'WhatsApp', manual: 'manual' };
  const iniOntem = Date.parse(`${hoje.iso}T00:00:00-03:00`) - 86400000;
  const daGabi = Object.values(conversas)
    .filter((c) => c && c.leadPainel && c.criadaEm >= iniOntem && c.criadaEm < iniOntem + 86400000 && carteiraDe(c) === carteira);
  if (leadsPainel) {
    linhas.push('');
    linhas.push(`*Seus leads* · ${leadsPainel.abertos} em aberto`);
    if (leadsPainel.novos.length) {
      linhas.push(`Novos ontem (${leadsPainel.novos.length}):`);
      for (const l of leadsPainel.novos.slice(0, 6)) linhas.push(`${l.nome || 'Cliente'} · ${ORIG[l.origem] || l.origem}`);
    } else linhas.push('Nenhum lead novo atribuído ontem.');
    if (leadsPainel.prontos.length) linhas.push(`Prontos para fechar: ${leadsPainel.prontos.slice(0, 5).map((l) => l.nome || 'Cliente').join(', ')}.`);
  } else if (daGabi.length) {
    linhas.push('');
    linhas.push(`*Leads da Gabi ontem na sua carteira (${daGabi.length})*`);
    for (const c of daGabi.slice(0, 6)) linhas.push(`${c.nome || 'Cliente'} · wa.me/${c.fone}`);
  }

  if (naCarteira.length) {
    linhas.push('');
    linhas.push(`*Novos na carteira desde ontem (${naCarteira.length})*`);
    for (const i of naCarteira.slice(0, 5)) linhas.push(`Cód. ${i.codigo} · ${i.tipo || 'Imóvel'}${i.bairro ? ` · ${i.bairro}` : ''} · ${i.preco_formatado || formatarBRL(i.preco)}`);
    if (naCarteira.length > 5) linhas.push(`e mais ${naCarteira.length - 5} no painel, em Novos imóveis.`);
  }
  if (painelUrl) {
    linhas.push('');
    linhas.push(`Conversas ao vivo: ${painelUrl}`);
  }
  return { texto: linhas.join('\n'), visitas: doDia.length, esperando: esperando.length, novos: naCarteira.length };
}

/** Deve rodar o resumo agora? Uma vez por dia, na hora marcada, nos dias da regra. */
function horaDoResumo({ agora = new Date(), hora = 8, dias = [1, 2, 3, 4, 5, 6], ultimoEnvio }) {
  const p = partesSP(agora);
  if (!dias.includes(p.diaSemana)) return false;
  if (p.hora !== hora) return false;
  return ultimoEnvio !== p.iso;
}

/**
 * Visitas prontas para o pós-visita: aconteceram há pelo menos `horasDepois`,
 * no máximo há 2 dias, não foram canceladas, ainda não receberam a mensagem e
 * foram confirmadas por alguém da equipe (mensagem do corretor na conversa
 * depois da reserva, ou status "confirmada").
 */
function visitasParaPosVisita({ visitas, conversas, agora = new Date(), horasDepois = 2 }) {
  const t = agora.getTime();
  return visitas.filter((v) => {
    if (!v || v.posVisita || v.status === 'cancelada') return false;
    const quando = tsVisita(v);
    if (!Number.isFinite(quando)) return false;
    if (t < quando + horasDepois * 3600000 || t > quando + 2 * 86400000) return false;
    const conv = conversas[v.fone];
    if (!conv || conv.optOut) return false;
    if (v.status === 'confirmada') return true;
    const reservada = Date.parse(v.criadaEm || 0) || 0;
    return (conv.historico || []).some((h) => h.papel === 'equipe' && h.ts > reservada);
  });
}

function mensagemPosVisita(v, conv) {
  const nome = primeiroNome(conv && conv.nome ? conv.nome : v.nome);
  return [
    `Oi${nome ? `, ${nome}` : ''}! Aqui é a Gabi, da MAFUZ. Como foi a visita ao imóvel${v.bairro ? ` no ${v.bairro}` : ''} (cód. ${v.codigo})?`,
    'De 1 a 5, quanto ele combinou com o que você procura? Se faltou alguma coisa, me conta o quê que eu separo opções mais certeiras.',
  ];
}


// ---------------- lembretes de visita (24 h e 2 h antes) ----------------
// Cliente: só visitas confirmadas (status "confirmada" ou equipe já falou com ele depois da reserva).
// Corretor: toda visita que não foi cancelada, com o status atual.
function visitaConfirmada(v, conv) {
  if (v.status === 'confirmada') return true;
  const reservada = Date.parse(v.criadaEm || 0) || 0;
  return !!conv && (conv.historico || []).some((h) => h.papel === 'equipe' && h.ts > reservada);
}

function visitasParaLembrete({ visitas, conversas, agora = new Date() }) {
  const t = agora.getTime();
  const saida = [];
  for (const v of visitas || []) {
    if (!v || v.status === 'cancelada') continue;
    const quando = tsVisita(v);
    if (!Number.isFinite(quando) || quando < t) continue;
    v.lembretes = v.lembretes || {};
    let tipo = null;
    if (!v.lembretes['24h'] && t >= quando - 24 * 3600000 && t < quando - 18 * 3600000) tipo = '24h';
    else if (!v.lembretes['2h'] && t >= quando - 2 * 3600000 && t < quando - 45 * 60000) tipo = '2h';
    if (!tipo) continue;
    const conv = conversas[v.fone];
    saida.push({ visita: v, tipo, conv, confirmada: visitaConfirmada(v, conv) });
  }
  return saida;
}

function mensagemLembreteCliente(v, conv, tipo) {
  const nome = primeiroNome(conv && conv.nome ? conv.nome : v.nome);
  const onde = `imóvel cód. ${v.codigo}${v.bairro ? `, ${v.bairro}` : ''}`;
  if (tipo === '24h') {
    return `Olá${nome ? `, ${nome}` : ''}. Passando para lembrar da sua visita amanhã às ${v.hora} (${onde}). Se precisar mudar o horário, é só me avisar por aqui.`;
  }
  return `${nome ? `${nome}, ` : ''}sua visita é hoje às ${v.hora} (${onde}). O corretor da MAFUZ está com tudo pronto. Qualquer imprevisto, me avise por aqui.`;
}

function mensagemLembreteCorretor(v, conv, tipo, confirmada, foneExibicao) {
  return [
    `*MAFUZ · Lembrete de visita · ${tipo === '24h' ? 'amanhã' : 'hoje'} às ${v.hora}*`,
    `Cliente: ${(conv && conv.nome) || v.nome || 'sem nome'} · ${foneExibicao ? foneExibicao(v.fone) : v.fone}`,
    `Imóvel: cód. ${v.codigo}${v.bairro ? ` · ${v.bairro}` : ''}`,
    v.url || '',
    `Status: ${confirmada ? 'confirmada com o cliente' : 'ainda sem confirmação com o cliente'}`,
    confirmada ? '' : 'Confirme com o cliente pelo WhatsApp da MAFUZ.',
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = { resumoCorretor, horaDoResumo, visitasParaPosVisita, mensagemPosVisita, tsVisita, visitasParaLembrete, mensagemLembreteCliente, mensagemLembreteCorretor, visitaConfirmada };
