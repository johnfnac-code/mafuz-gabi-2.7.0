'use strict';
// Studio MAFUZ: aprimora fotos de imóveis com a OpenAI (Images API, edição).
// A foto original nunca é alterada aqui: a imagem aprimorada volta para o painel,
// o administrador revisa e decide publicar.

const PRESETS_STUDIO = [
  { id: 'luz', nome: 'Luz natural', descricao: 'Iluminação equilibrada, brancos limpos e sombras abertas.', prompt: 'Corrija a exposição e o balanço de branco para uma luz natural, clara e equilibrada, com brancos limpos, sombras abertas e janelas sem estourar.' },
  { id: 'ceu', nome: 'Céu azul', descricao: 'Troca céu nublado ou estourado por céu azul com nuvens suaves.', prompt: 'Substitua o céu por um céu azul limpo com poucas nuvens suaves e luz de dia claro, ajustando reflexos em vidros e água de forma coerente.' },
  { id: 'cores', nome: 'Cores e nitidez', descricao: 'Cores vivas e naturais, contraste refinado e mais definição.', prompt: 'Realce cores de forma natural (sem saturar demais), refine o contraste e aumente a nitidez e a definição de texturas como madeira, pedra e tecido.' },
  { id: 'crepusculo', nome: 'Entardecer', descricao: 'Clima de fim de tarde com luzes internas acesas.', prompt: 'Transforme a cena em um entardecer (golden hour / crepúsculo) elegante, com céu em tons quentes e as luzes internas e de paisagismo acesas.' },
  { id: 'arrumar', nome: 'Organizar ambiente', descricao: 'Remove objetos soltos, fios e pequenas bagunças.', prompt: 'Remova objetos soltos e pequenas bagunças (boias, fios, objetos pessoais, lixo, carros estacionados de forma aleatória), sem alterar paredes, móveis fixos, piso, janelas ou paisagem.' },
  { id: 'hdr', nome: 'Interior HDR', descricao: 'Equilibra o ambiente interno com a vista das janelas.', prompt: 'Aplique um equilíbrio HDR natural: interior bem iluminado e a vista pelas janelas visível e bem exposta, sem aparência artificial.' },
];

const BASE = 'Você é um editor profissional de fotografia imobiliária de alto padrão. Edite esta foto real de um imóvel à venda. Regras: preserve fielmente a arquitetura, a planta, as proporções, os materiais, os móveis, o enquadramento e a perspectiva; não invente cômodos, móveis ou vistas que não existem; mantenha a marca d\'água MAFUZ se existir; o resultado deve parecer uma fotografia real, sem aparência de ilustração.';

async function baixar(url) {
  // Versão já aprimorada (para refinar em cima dela) chega como data URL.
  const dataUrl = String(url || '').match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (dataUrl) {
    const buf = Buffer.from(dataUrl[2], 'base64');
    if (buf.length > 20 * 1024 * 1024) throw new Error('Studio: foto maior que 20 MB.');
    return { buf, tipo: dataUrl[1] };
  }
  if (!/^https:\/\//.test(String(url || ''))) throw new Error('Studio: envie o endereço https da foto.');
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Studio: não foi possível baixar a foto (HTTP ${r.status}).`);
  const tipo = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
  if (!/^image\/(jpeg|png|webp)$/.test(tipo)) throw new Error('Studio: formato de foto não suportado.');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 20 * 1024 * 1024) throw new Error('Studio: foto maior que 20 MB.');
  return { buf, tipo };
}

async function aprimorarFoto({ config, imagem, preset, instrucao }) {
  const chave = config.llm.openaiKey;
  if (!chave) throw new Error('Studio: a chave da OpenAI não está configurada no servidor.');
  const p = PRESETS_STUDIO.find((x) => x.id === preset);
  const pedido = String(instrucao || '').trim().slice(0, 800);
  if (!p && !pedido) throw new Error('Studio: escolha um ajuste pronto ou escreva o que deseja.');
  const { buf, tipo } = await baixar(imagem);
  const prompt = [BASE, p ? `Ajuste pedido: ${p.prompt}` : '', pedido ? `Pedido da equipe: ${pedido}` : ''].filter(Boolean).join('\n\n');
  const form = new FormData();
  form.append('model', config.studio.modelo);
  form.append('prompt', prompt);
  form.append('image', new Blob([buf], { type: tipo }), `foto.${tipo.split('/')[1]}`);
  form.append('quality', config.studio.qualidade);
  form.append('size', 'auto');
  form.append('output_format', 'jpeg');
  form.append('n', '1');
  const r = await fetch(`${config.llm.openaiBaseUrl}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${chave}` },
    body: form,
    signal: AbortSignal.timeout(180000),
  });
  const texto = await r.text();
  let json;
  try {
    json = JSON.parse(texto);
  } catch {
    json = {};
  }
  if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}: ${(json.error && json.error.message) || texto.slice(0, 200)}`);
  const b64 = json.data && json.data[0] && json.data[0].b64_json;
  if (!b64) throw new Error('Studio: a IA não devolveu imagem.');
  return { imagem: `data:image/jpeg;base64,${b64}`, preset: p ? p.id : null, modelo: config.studio.modelo };
}

module.exports = { aprimorarFoto, PRESETS_STUDIO };
