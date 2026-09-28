# Atualização da Gabi · versão 4.7 (servidor 2.7.0)

## O que muda na 4.7 (servidor 2.7.0)

- **Monitor de sincronização.** A cada 10 minutos a Gabi confere a carteira do Imoview, o índice do site, as
  sincronizações de fichas e de leads, a divergência entre Imoview e site, leads parados há 48 h (dias úteis) e a
  conexão do WhatsApp. Problema novo gera um aviso no WhatsApp do suporte técnico (`SUPORTE_TECNICO`, sem ela vai para
  `ADMIN_PHONES`); o mesmo problema só se repete a cada 6 h e a volta ao normal também é avisada. O painel mostra o
  aviso no topo. Teste: `GET /admin/monitor`.
- **Webhook do Imoview puxa os leads na hora**, além da carteira (no máximo uma vez por minuto).
- **Memória de longo prazo por cliente.** Quando a conversa expira (`CONVERSA_TTL_DIAS`), o que importa fica guardado
  pelo telefone: perfil de busca, imóveis já enviados, descartados, visitas e notas, objeções e favoritos do site.
  Quando o cliente volta, a Gabi recebe esse resumo, não recomeça do zero e não reenvia o que ele descartou.
  O perfil do Radar também sobrevive ao fim da conversa.
- **Seleção personalizada.** Ferramenta `criar_selecao`: a Gabi monta um link `mafuz.site/selecao?c=...` só com os
  imóveis do cliente, para comparar com calma ou mostrar para a família.
- **Lembrete de visita 24 h e 2 h antes.** Cliente recebe só quando a visita foi confirmada pela equipe (status
  confirmada ou corretor já falou com ele depois da reserva); o corretor da agenda (ou a carteira) recebe sempre, com o
  status. Entre 7h e 21h, sem emojis. Prévia: `GET /admin/lembretes` (`&enviar=1` dispara). `LEMBRETE_VISITA=true`.
- **Sugestão de resposta para o corretor.** `POST /painel/sugestao` escreve um rascunho com o contexto da conversa
  (o corretor revisa e envia). Botão "Sugerir" nas Conversas do painel.
- **Qualidade das conversas.** `GET /painel/whatsapp/qualidade`: funil da conversa, onde as conversas param e por quê,
  objeções, bairros, faixas de valor e tipos mais pedidos, mensagens até o primeiro imóvel, nota do pós-visita.
- **Distribuição automática de leads.** Em horário comercial, leads novos sem corretor (site, WhatsApp e Meta Ads) vão
  para o corretor da carteira certa com menos leads no dia (rodízio). O corretor recebe no WhatsApp; sem primeiro
  contato em `DISTRIBUICAO_SLA_MIN` (30 min), o lead passa para o próximo e a gestão é avisada. Tudo fica nas notas do
  lead. Exige a conta da Gabi no painel (`PAINEL_EMAIL` e `PAINEL_SENHA`); sem ela, fica parada.
- **Visão 360 no painel.** `GET /painel/cliente?fone=` junta conversa, memória, visitas e eventos da Gabi.
  `GET /painel/imovel/estatisticas?codigo=` alimenta o relatório para o proprietário.
- **Área do cliente no site** (`mafuz.site/minha-area`). `POST /site/codigo` envia um código de 6 dígitos pelo WhatsApp
  (10 min, 5 tentativas, 1 por minuto e 5 por hora por número); `POST /site/entrar` devolve um acesso assinado de 30 dias;
  `GET /site/minha-area`, `POST /site/favoritos` e `POST /site/alerta` (o alerta é o Radar da Gabi; o cliente pode pausar).
- **Selo de preço reduzido** (`GET /site/reduzidos`) e **vídeo da Gabi na ficha** (`GET /site/video/:codigo`).
- **Meta Lead Ads direto no Pipeline.** `GET /webhook/meta-leads` (verificação) e `POST /webhook/meta-leads` (lead novo):
  a Gabi busca os campos na Graph API, cria o lead no painel com origem "Meta Ads", avisa a carteira e, com
  `IMOVIEW_ENVIAR_LEADS=true`, inclui no Imoview. Assinatura conferida com `META_APP_SECRET`.
- Resumo da diretoria mostra "Meta Ads" nos leads por origem quando houver.

Variáveis novas (todas opcionais):
- `SUPORTE_TECNICO`: WhatsApp de quem recebe os avisos do monitor (ex.: `5531999999999`). `MONITOR` (true).
- `DISTRIBUICAO` (true), `DISTRIBUICAO_SLA_MIN` (30), `DISTRIBUICAO_MAX_REPASSES` (2), `DISTRIBUICAO_ORIGENS`
  (`site,whatsapp,meta`).
- `LEMBRETE_VISITA` (true).
- `AREA_CLIENTE` (true) e `AREA_CLIENTE_SEGREDO` (opcional; sem ela o acesso é assinado com base no `WEBHOOK_SECRET`).
- `META_VERIFY_TOKEN`, `META_PAGE_TOKEN` e `META_APP_SECRET` (só para o Meta Lead Ads). No app da Meta: Webhooks ›
  Page › campo `leadgen`, URL `https://<servidor>/webhook/meta-leads`, token de verificação = `META_VERIFY_TOKEN`.

Observação: a função `imoview-leads-sync` publicada na base atual lê primeiro a venda e, quando a venda enche o limite,
não chega à locação. A versão corrigida está no repositório do site (orçamento próprio para venda e locação) e entra
quando a base própria da MAFUZ for publicada.

`/health` mostra `"versao": "2.7.0"`, `monitor`, `distribuicao`, `area_cliente`, `meta_lead_ads` e
`memoria_clientes`.

---

# Atualização da Gabi · versão 4.6 (servidor 2.6.0)

## O que muda na 4.6 (servidor 2.6.0)

- **Resumo executivo das 8h para a diretoria**, todos os dias, com o dia anterior completo: leads por origem
  (Imoview, site e WhatsApp), leads com prontidão alta sem corretor, captações publicadas no site com o nome de
  quem publicou, anúncios de proprietários aguardando aprovação, atendimento da Gabi (conversas, clientes novos,
  visitas, encaminhamentos), carteira (Imoview, site e conferência de que a Gabi lê o site inteiro) e a agenda do dia.
  Destinatários padrão: Fernando Mafuz, Thiago Britto e Bruno Sabino (variável `DIRETORIA`).
- **Resumo semanal na segunda-feira**: além do dia anterior, a diretoria recebe os últimos sete dias comparados à
  semana anterior (leads por origem, captações, ranking de captadores e atendimento da Gabi). `RESUMO_SEMANAL=true`.
- **Resumo dos corretores reformatado**: seções em negrito, sem emojis, data e carteira no topo, e uma seção de leads:
  com acesso ao painel, os leads atribuídos ao corretor (novos de ontem e prontos para fechar); sem acesso, os leads
  que a Gabi trouxe ontem para a carteira dele.
- **Leads do Imoview no painel ao vivo**: a cada 5 minutos (e logo ao subir) a Gabi dispara a sincronização de
  leads do site pelas duas pontas da listagem do Imoview (primeira página e últimas páginas de venda e de
  locação), para os leads mais novos entrarem mesmo quando o Imoview os lista no fim. `/health` mostra
  `tempo_real.ultimo_sync_leads` com recebidos, inseridos e atualizados.
- **Gabi move os leads no Pipeline**: busca → Novo; qualificação ou encaminhamento → Em contato; visita marcada →
  Visita agendada; negociação → Negociação. Só avança, nunca volta, e atualiza a prontidão nas notas. Exige a conta
  da Gabi no painel (`PAINEL_EMAIL` e `PAINEL_SENHA`); `/health` mostra `tempo_real.move_pipeline: true`.
- **Busca**: a Gabi oferece tudo o que está publicado no site (mais de 2.700 imóveis), além da carteira do Imoview.
- Prévia sem enviar: `GET /admin/diretoria` (mesma autenticação das outras rotas /admin). Com `&enviar=1` envia agora.

Variáveis novas:
- `PAINEL_EMAIL` e `PAINEL_SENHA`: conta do painel criada só para a Gabi, com papel de administração. Sem ela,
  o resumo da diretoria sai só com os dados da Gabi e da carteira (e avisa o que ficou de fora).
  Alternativa: `SUPABASE_SERVICE_KEY` (acesso total ao banco; preferir a conta do painel).
- `DIRETORIA` (padrão `5531987277000=Fernando Mafuz,5531983470779=Thiago Britto,5531991713301=Bruno Sabino`),
  `RESUMO_DIRETORIA` (true), `RESUMO_DIRETORIA_HORA` (8), `RESUMO_DIRETORIA_DIAS` (0,1,2,3,4,5,6).

`/health` mostra `"versao": "2.6.0"` e `resumo_diretoria` com `acesso_painel: true` quando o login estiver certo.

---

# Atualização da Gabi · versão 4.5 (servidor 2.5.0)

## O que muda na 4.5 (servidor 2.5.0)

- **Busca em duas fontes, sem falha.** Toda busca consulta ao mesmo tempo a carteira do Imoview e o próprio site
  (a mesma base e os mesmos filtros da página Imóveis: finalidade, tipo, quartos, suítes, vagas, preço, área e lugar).
  Um imóvel publicado no site é sempre encontrável. Se o índice do site ainda estiver carregando, a Gabi consulta a API
  do site ao vivo. Tipos por grupo ("cobertura duplex", "casas", "área privativa", "sobrado").
- **Atendimento consultivo.** Antes de mandar imóveis a Gabi confirma finalidade (comprar ou alugar), região e faixa de
  valor ou quartos, uma pergunta por vez, usando o panorama do recorte ("No Alphaville tenho 181 casas, de R$ 2 mi a
  R$ 17 mi. Qual faixa faz sentido?"). Se o cliente pedir para ver opções, ela envia na hora.
- **Captação pelo WhatsApp.** Proprietário que quer vender ou alugar: a Gabi registra o imóvel (ferramenta
  `registrar_captacao`), traz a referência de preço da carteira, pede o dia da avaliação e avisa a equipe. A captação
  entra no painel em Carteira › Captações.
- **Prontidão do lead (0 a 100).** Prazo, pagamento, ticket, visita, imóvel escolhido e pedido de corretor viram uma nota;
  o Pipeline ordena os cartões por ela (`GET /painel/leads/prontidao`).
- **Tempo real.** Vigia do Imoview a cada 3 minutos (imóvel novo entra na busca na hora e dispara a sincronização do
  site), leads do Imoview a cada 5 minutos, leads do WhatsApp no pipeline e na lista de leads (`whatsapp_gabi`).
- **Studio.** `POST /painel/studio/aprimorar` aprimora fotos com a OpenAI (modelo `OPENAI_IMAGE_MODEL`, padrão
  `gpt-image-1`); aceita também uma versão já aprimorada para refinar.
- **Novo número da Gabi:** (31) 3157-3741 nos textos de apoio.

Variáveis novas (opcionais): `TEMPO_REAL` (padrão ligado), `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_QUALITY`.
`/health` mostra `"versao": "2.5.0"`, `busca_no_site.imoveis` (cerca de 2.700) e `tempo_real`.

---

# Atualização da Gabi · versão 4.4 (servidor 2.5.0)

Tempo estimado: 20 minutos. Nada muda no número de WhatsApp nem na Z-API.

## O que muda na 4.4 (servidor 2.5.0)

- **Carteira inteira, sempre.** A sincronização refaz as páginas que o Imoview recusar (limite de requisições) até fechar a conta com o total do CRM. O `/health` mostra `carteira`, `carteira_no_imoview` e `carteira_completa`.
- **Busca por lugar do jeito que o cliente fala.** Todo bairro e condomínio com imóvel publicado é reconhecido, mesmo com erro de digitação, cidade trocada ("Vila da Serra em BH") ou cidade no lugar do bairro. Regiões: Seis Pistas, Zona Sul, Oeste, Pampulha, Vetor Sul, Vetor Norte, Lagoa dos Ingleses, Serra do Cipó e Trancoso. Sem imóvel no bairro, sugere os vizinhos antes da cidade inteira.
- **Link exato.** Todo imóvel vai com a página dele no site (`mafuz.site/imovel/<id>`); imóvel que acabou de entrar no CRM vai como `mafuz.site/imovel/<código>`, que o site 2.4.2 abre direto na ficha.
- Busca por código acha o imóvel mesmo que a finalidade venha trocada e, se ele entrou no CRM depois da última carga, consulta o Imoview na hora.

## Por que o /health ainda mostra 1.0.0

A Gabi que conversa no WhatsApp foi atualizada pelo prompt, mas o **servidor** que roda na Railway é o arquivo `src/server.js` do repositório. Se `/health` mostra `1.0.0`, a Railway está publicando a versão antiga desse arquivo. As duas causas mais comuns:

1. **Pasta dentro de pasta.** O zip abre como `mafuz-agente/src/...`. Arrastar a pasta `mafuz-agente` inteira cria `mafuz-agente/mafuz-agente/src` no GitHub, e a Railway continua lendo o `src` antigo da raiz.
2. **Upload parcial.** Só alguns arquivos foram enviados e `src/server.js` ficou na versão antiga.

Como conferir: no GitHub, abra `src/server.js` **na raiz** do repositório e procure `VERSAO`. Tem que estar `'2.5.0'`.

## Passo 1 · GitHub (repositório `mafuz-agente`)

1. Descompacte `mafuz-agente-v4.2.zip` no computador.
2. **Entre** na pasta `mafuz-agente` que foi criada.
3. No GitHub: **Add file › Upload files** e arraste **o conteúdo** dela: as pastas `src`, `assets`, `conhecimento`, `test`, `site-extras` e os arquivos `Dockerfile`, `package.json`, `README.md`, `.env.example`, `ATUALIZACAO-V4.md`, `GUIA-DE-IMPLANTACAO.md`.
4. Mensagem do commit: `Gabi v4.2`. **Commit changes**.
5. Se existir uma pasta `mafuz-agente/` dentro do repositório (de um upload anterior), apague-a: abra a pasta › `...` › **Delete directory**.

A Railway publica em 2 a 4 minutos (esta versão instala o `ffmpeg` para os vídeos).

## Passo 2 · Railway › Variables

Obrigatórias nesta versão:

| Variável | Valor |
|---|---|
| `PUBLIC_URL` | `https://mafuz-agente-production.up.railway.app` (endereço dos vídeos) |
| `SITE_CHAT_ORIGINS` | `https://mafuz.site,https://www.mafuz.site,https://SEU-SITE.netlify.app` |

Agenda do Google (horários livres de verdade):

| Variável | Valor |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | JSON inteiro da conta de serviço (Passo 4) |
| `AGENDA_CORRETORES` | `5531989097232=marcella@mafuz.com.br,5531988093993=thais@mafuz.com.br,...` (telefone=e-mail da agenda) |

Opcionais, já com o valor certo no código:

| Variável | Padrão | O que faz |
|---|---|---|
| `CATALOGO_SYNC_MIN` | `15` | Recarrega a carteira do Imoview a cada 15 min |
| `RADAR` | `true` | Avisa clientes quando entra imóvel que combina com a busca deles |
| `RADAR_INTERVALO_HORAS` / `RADAR_MAX_IMOVEIS` / `RADAR_VALIDADE_DIAS` | `20` / `2` / `60` | Intervalo mínimo entre avisos, imóveis por aviso, validade do perfil |
| `VIDEO_AUTOMATICO` | `true` | Gera vídeo vertical de 15 s para cada imóvel novo |
| `VIDEO_NO_WHATSAPP` | `true` | Envia o vídeo no lugar da foto quando ele existe |
| `VIDEO_MAX_POR_CICLO` | `6` | Vídeos gerados por ciclo, para não pesar o servidor |
| `UTM_LINKS` | `true` | Links para o site saem com `utm_source=whatsapp&utm_medium=gabi` |
| `VISITA_DURACAO_MIN` / `AGENDA_DIAS` | `60` / `7` | Duração da visita e quantos dias à frente oferecer |
| `SITE_SUPABASE_URL` / `SITE_SUPABASE_ANON_KEY` | projeto atual do site | Troque quando o Supabase próprio da MAFUZ estiver no ar |

## Passo 3 · Webhook do Imoview (carteira ao vivo)

No Imoview, em *Configurações › Integrações › Webhook*, cadastre:

```
https://mafuz-agente-production.up.railway.app/webhook/imoview?secret=SEU_WEBHOOK_SECRET
```

Cada cadastro ou alteração no Imoview faz a Gabi recarregar a carteira em segundos. Os 15 minutos continuam como garantia.

## Passo 4 · Google Agenda dos corretores

1. [console.cloud.google.com](https://console.cloud.google.com) › projeto novo `mafuz-agenda` › ative a **Google Calendar API**.
2. *IAM › Contas de serviço* › **Criar** `gabi-agenda` › *Chaves* › **Adicionar chave › JSON**. Baixa um arquivo.
3. Cada corretor, no Google Agenda dele: *Configurações da agenda › Compartilhar com pessoas específicas* › adiciona o e-mail da conta de serviço com **Fazer alterações nos eventos**.
4. Na Railway, cole o conteúdo do JSON em `GOOGLE_SERVICE_ACCOUNT_JSON` e preencha `AGENDA_CORRETORES`.

Com isso a Gabi oferece só horários em que o corretor da carteira está livre e cria o evento na agenda dele ao confirmar. Sem essas variáveis ela volta a perguntar o melhor dia e horário, como antes.

## Passo 5 · Conferir em 2 minutos

1. `…/health` mostra `"versao": "2.5.0"`, `sincroniza_a_cada_min: 15`, `radar`, `agenda_google` e `videos`.
2. `…/admin/funil?token=SEU_ADMIN_TOKEN`: origem dos leads, tempo de resposta e conversão por corretor.
3. `…/admin/videos?token=SEU_ADMIN_TOKEN`: vídeos gerados. Para gerar um: `&gerar=CODIGO`.
4. `…/admin/radar?token=SEU_ADMIN_TOKEN`: prévia de quem receberia aviso. **Só** com `&enviar=1` envia de verdade.
5. No WhatsApp, `#status` mostra as linhas do radar e dos vídeos.

## O que mudou nesta versão

| Recurso | Como funciona |
|---|---|
| Carteira ao vivo | Sincroniza a cada 15 min e no webhook do Imoview; registra imóveis novos e baixas |
| Radar MAFUZ | Guarda o perfil de busca de cada cliente e avisa quando entra um imóvel compatível (preço com 10% de tolerância), no máximo 1 aviso a cada 20 h, dentro da janela de envio |
| Agenda real | Ferramenta `horarios_livres` lê a agenda do corretor da carteira e reserva o evento |
| Vídeo de 15 s | 1080×1920 com as fotos do Imoview, dados do imóvel e cartão final; enviado no WhatsApp |
| Origem do lead | Site, Instagram, anúncio, ficha de imóvel, portal ou WhatsApp direto, registrada em cada conversa |
| Tempo de resposta | Mede quanto a equipe levou para responder depois do encaminhamento |
| Conversas no painel | Rotas `/painel/*` alimentam a aba **Conversas** do painel do site: todos veem e respondem pelo número da MAFUZ |
| Mensagens do site | Links do site abrem o WhatsApp com texto pronto ("Vim pelo site da Mafuz… Código: X"); a Gabi entende e já responde sobre o imóvel |

## Novidades da 4.3

| Recurso | Como funciona | Variáveis |
|---|---|---|
| Resumo das 8h | De segunda a sábado, às 8h, cada corretor recebe no WhatsApp as visitas do dia, os clientes esperando retorno e os imóveis novos da carteira dele | `RESUMO_8H`, `RESUMO_HORA`, `RESUMO_DIAS`, `NOMES_CORRETORES` |
| Pós-visita | 2 h depois de uma visita confirmada pela equipe, a Gabi pergunta ao cliente como foi (nota de 1 a 5). A resposta vai para o corretor e, se a nota for baixa, ela oferece alternativas | `POS_VISITA`, `POS_VISITA_HORAS` |
| 2º Cérebro | Chat do painel (Inteligência) responde com os números do site, das conversas e das anotações da equipe | usa a mesma chave da OpenAI |
| Instagram no site | Vídeos de @mafuzimoveisdeluxo aparecem na home e em Sobre | `INSTAGRAM_TOKEN` |

Prévias sem enviar nada: `…/admin/resumo?token=SEU_ADMIN_TOKEN` e `…/admin/posvisita?token=SEU_ADMIN_TOKEN`.
Com `&enviar=1` envia de verdade.

## Voltar para a versão anterior

Railway › *Deployments* › deploy anterior › **Redeploy**. As conversas continuam no volume `/app/data`.

## Testes automáticos

`npm run test:unidades` roda radar, UTM, fotos, vídeo de 15 s e agenda. `IMOVIEW_API_KEY=… npm test` roda também a simulação ponta a ponta.
