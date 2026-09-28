FROM node:22-alpine
# ffmpeg gera os vídeos verticais; font-dejavu é a fonte reserva
RUN apk add --no-cache ffmpeg font-dejavu
WORKDIR /repo
COPY . .
# Monta a estrutura do app a partir do repositório, esteja cada arquivo na raiz ou em pastas.
RUN set -e; A=/app; mkdir -p $A/src $A/conhecimento $A/assets/fontes $A/data; \
    for f in $(find . -name '*.js' -not -path '*/node_modules/*' -not -path '*/test/*' -not -name '*.test.js' -not -name 'simulate.js' | awk -F/ '{print NF" "$0}' | sort -n | cut -d' ' -f2-); do cp "$f" $A/src/; done; \
    for f in $(find . -name 'casa.md' -o -name 'mercado.md'); do cp "$f" $A/conhecimento/; done; \
    for f in $(find . -name 'Jost-*.ttf'); do cp "$f" $A/assets/fontes/; done; \
    for f in Jost-Light Jost-Regular; do [ -f $A/assets/fontes/$f.ttf ] || cp "$(find /usr/share/fonts -name '*.ttf' | head -1)" $A/assets/fontes/$f.ttf; done; \
    cp package.json $A/ 2>/dev/null || true; \
    for f in server.js agent.js catalogo.js regioes.js config.js imoview.js util.js buscaSite.js prontidao.js tempoReal.js studio.js diretoria.js memoria.js monitor.js distribuicao.js areaCliente.js metaLeads.js qualidade.js; do test -f $A/src/$f || { echo "ERRO: falta o arquivo $f no repositorio"; exit 1; }; done; \
    for f in casa.md mercado.md; do test -f $A/conhecimento/$f || { echo "ERRO: falta o arquivo $f no repositorio"; exit 1; }; done; \
    echo "Gabi montada:"; ls $A/src; rm -rf /repo
WORKDIR /app
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
