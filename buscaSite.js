'use strict';
// Busca pelo SITE da MAFUZ: a mesma base e os mesmos filtros da página Imóveis
// (mafuz.site/imoveis). É a segunda fonte da Gabi, ao lado da carteira lida
// direto do Imoview. As duas são cruzadas em toda busca; se uma falhar ou vier
// incompleta, a outra cobre. Um imóvel que está no site sempre é encontrável.
//
// Três camadas:
//  1. índice em memória com TODOS os imóveis publicados no site (recarregado a
//     cada 10 minutos), com o mesmo motor de regiões, tipos e desejos da carteira;
//  2. consulta ao vivo na API do site com os filtros da página Imóveis
//     (finalidade, tipo, quartos, preço, área e texto), usada quando o índice
//     não achou nada ou ainda não carregou;
//  3. código do imóvel: consulta direta pelo código.

const { Catalogo } = require('./catalogo');
const { IndiceRegioes } = require('./regioes');
const { log, norm, formatarBRL, limparTitulo } = require('./util');

const TIPO_SITE = {
  apartment: ['Apartamento', 'apartamento'],
  house: ['Casa', 'casa'],
  penthouse: ['Cobertura', 'cobertura'],
  land: ['Lote', 'lote'],
  commercial: ['Comercial', 'comercial'],
  rural: ['Rural', 'rural'],
};
const TIPO_PEDIDO = { apartamento: 'apartment', apto: 'apartment', flat: 'apartment', casa: 'house', sobrado: 'house', cobertura: 'penthouse', lote: 'land', terreno: 'land', comercial: 'commercial', sala: 'commercial', loja: 'commercial', rural: 'rural', sitio: 'rural', fazenda: 'rural', chacara: 'rural' };
const CAMPOS =
  'id,title,description,neighborhood,city,condo_name,address,property_type,listing_type,price,bedrooms,suites,bathrooms,parking_spots,area_built,area_total,external_id,external_source,created_at,amenities';

/** Tipo "de gente" a partir do título do anúncio (o Imoview escreve o tipo no começo). */
function tipoDoTitulo(titulo, tipoSite) {
  const t = String(titulo || '').trim();
  const m = t.match(/^(casa em condom[ií]nio|casa de alto padr[aã]o|casa|apartamento duplex|apartamento|[áa]rea privativa|cobertura duplex|cobertura|lote em condom[ií]nio|lote|terreno|loja|sala|galp[aã]o|s[ií]tio|fazenda|ch[aá]cara)\b/i);
  if (m) {
    const s = m[1].toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  return (TIPO_SITE[tipoSite] || [tipoSite || 'Imóvel'])[0];
}

class CatalogoSite extends Catalogo {
  constructor({ config, site }) {
    super({ imoview: null, site, config });
    this.cfg = config.site;
    this.fonte = 'site';
    this.minimo = 50;
  }

  headers() {
    return { apikey: this.cfg.supabaseAnonKey, Authorization: `Bearer ${this.cfg.supabaseAnonKey}` };
  }

  ativo() {
    return !!(this.cfg && this.cfg.supabaseUrl && this.cfg.supabaseAnonKey);
  }

  // Linha do banco do site -> item no mesmo formato da carteira do Imoview.
  compactarSite(r) {
    const codigo = String(r.external_id || r.id);
    const tipo = tipoDoTitulo(r.title, r.property_type);
    const descricao = String(r.description || '').replace(/\r/g, '').slice(0, 2500);
    const grupo = { apartment: 'apartamento', house: 'casa', penthouse: 'cobertura', land: 'lote', commercial: 'comercial', rural: 'rural' }[r.property_type] || norm(tipo);
    const preco = +r.price || 0;
    const area = +r.area_built || null;
    const flags = [];
    return {
      codigo,
      id: r.id,
      origem_imoview: r.external_source === 'imoview',
      tipo,
      finalidade: ['rent', 'season'].includes(r.listing_type) ? 'locacao' : 'venda',
      grupo,
      bairro: String(r.neighborhood || '').replace(/\s+/g, ' ').trim(),
      bairroNorm: norm(String(r.neighborhood || '').replace(/\s+/g, ' ')),
      cidade: String(r.city || '').trim().replace(/^Nova lima$/i, 'Nova Lima'),
      condominio: r.condo_name || undefined,
      preco,
      preco_formatado: preco ? formatarBRL(preco) : 'Valor sob consulta',
      dormitorios: +r.bedrooms || 0,
      suites: +r.suites || 0,
      banheiros: +r.bathrooms || 0,
      vagas: +r.parking_spots || 0,
      area_m2: area || (grupo === 'lote' ? null : +r.area_total || null),
      area_lote_m2: +r.area_total || null,
      alto_ticket: preco > 10000000,
      titulo: limparTitulo(r.title || ''),
      descricao,
      texto: norm(`${r.title || ''} ${descricao} ${r.condo_name || ''} ${r.address || ''} ${(r.amenities || []).join(' ')}`),
      flags,
      cadastro: String(r.created_at || '').slice(0, 10),
      url: `${this.cfg.url}/imovel/${r.external_id ? encodeURIComponent(String(r.external_id)) : r.id}`,
      pagina: true,
      fotos: [],
      fonte: 'site',
    };
  }

  async lerPagina(query, offset, limite = 1000) {
    const url = `${this.cfg.supabaseUrl}/rest/v1/properties?select=${CAMPOS}&status=eq.published${query}&order=id&limit=${limite}&offset=${offset}`;
    const r = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`site HTTP ${r.status}`);
    return r.json();
  }

  aceita(r) {
    // Só o que é da MAFUZ: vindo do Imoview ou anunciado pelo site e aprovado.
    return !r.external_source || r.external_source === 'imoview';
  }

  async sincronizar() {
    if (!this.ativo()) return;
    if (this.sincronizando) return this.sincronizando;
    this.sincronizando = (async () => {
      const t0 = Date.now();
      try {
        const linhas = [];
        for (let offset = 0; offset < 30000; offset += 1000) {
          let lote = null;
          for (let t = 0; t < 3 && !lote; t++) {
            try {
              lote = await this.lerPagina('', offset);
            } catch (e) {
              if (t === 2) throw e;
            }
          }
          linhas.push(...lote);
          if (lote.length < 1000) break;
        }
        const itens = linhas.filter((r) => this.aceita(r)).map((r) => this.compactarSite(r));
        if (itens.length < this.minimo) throw new Error(`site trouxe só ${itens.length} imóveis`);
        this.itens = itens;
        this.porCodigo = new Map(itens.map((i) => [i.codigo, i]));
        this.indice = new IndiceRegioes(itens);
        this.calcularMedianas();
        this.ultimaSync = new Date().toISOString();
        this.esperado = itens.length;
        this.completa = true;
        this.erro = null;
        log('site_indice_ok', { imoveis: itens.length, segundos: Math.round((Date.now() - t0) / 1000) });
      } catch (e) {
        this.erro = e.message;
        log('site_indice_erro', { erro: e.message });
      } finally {
        this.sincronizando = null;
      }
    })();
    return this.sincronizando;
  }

  iniciar(minutos = 10) {
    super.iniciar(minutos);
  }

  // O que está publicado no site já é o que o cliente vê: não há o que revalidar no CRM.
  async revalidar(lista) {
    return lista;
  }

  /** Consulta ao vivo com os filtros da página Imóveis do site. */
  async consultaAoVivo(f = {}) {
    if (!this.ativo()) return [];
    const q = [];
    const cod = f.codigo ? String(f.codigo).replace(/\D/g, '') : '';
    if (cod) q.push(`external_id=eq.${cod}`);
    else {
      q.push(f.finalidade === 'locacao' ? 'listing_type=in.(rent,season)' : 'listing_type=in.(sale,launch)');
      const tp = f.tipo ? TIPO_PEDIDO[norm(f.tipo).split(' ')[0]] : null;
      if (tp) q.push(`property_type=eq.${tp}`);
      if (f.dormitorios_min) q.push(`bedrooms=gte.${+f.dormitorios_min}`);
      if (f.suites_min) q.push(`suites=gte.${+f.suites_min}`);
      if (f.vagas_min) q.push(`parking_spots=gte.${+f.vagas_min}`);
      if (f.preco_min) q.push(`price=gte.${Math.round(f.preco_min)}`);
      if (f.preco_max) q.push(`price=lte.${Math.round(f.preco_max)}`);
      if (f.area_min) q.push(`area_built=gte.${+f.area_min}`);
      const lugares = [...(Array.isArray(f.bairros) ? f.bairros : f.bairros ? [f.bairros] : []), ...(f.cidade && !(f.bairros || []).length ? [f.cidade] : [])]
        .map((t) => String(t).replace(/[(),*%]/g, ' ').trim())
        .filter(Boolean);
      if (lugares.length) {
        const ors = [];
        for (const l of lugares) for (const c of ['neighborhood', 'city', 'condo_name', 'title', 'address']) ors.push(`${c}.ilike.*${encodeURIComponent(l)}*`);
        q.push(`or=(${ors.join(',')})`);
      }
    }
    try {
      const linhas = await this.lerPagina(`&${q.join('&')}`, 0, 60);
      return linhas.filter((r) => this.aceita(r)).map((r) => this.compactarSite(r));
    } catch (e) {
      log('site_ao_vivo_erro', { erro: e.message });
      return [];
    }
  }

  async buscar(f = {}) {
    if (!this.pronto()) {
      // Índice ainda carregando: vai direto na API do site.
      const vivos = await this.consultaAoVivo(f);
      return {
        total_encontrado: vivos.length,
        imoveis: vivos.slice(0, Math.min(Math.max(+f.limite || 6, 1), 6)).map((i) => this.saida(i)),
        filtros_aplicados: { fonte: 'site ao vivo' },
        avisos: [],
      };
    }
    const r = await super.buscar(f);
    if (r.total_encontrado > 0) return r;
    // Nada exato no índice: confere ao vivo (pode ter entrado no site agora).
    const vivos = await this.consultaAoVivo(f);
    if (vivos.length) {
      for (const i of vivos) if (!this.porCodigo.has(i.codigo)) this.porCodigo.set(i.codigo, i);
      return { ...r, total_encontrado: vivos.length, imoveis: vivos.slice(0, 6).map((i) => this.saida(i)), sugestao_alternativa: undefined };
    }
    return r;
  }
}

module.exports = { CatalogoSite, tipoDoTitulo };
