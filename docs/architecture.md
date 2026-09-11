# Arquitetura — Prometheus Forge

## Princípio que organiza o resto

**Nenhum número aparece na tela sem que se possa reconstruí-lo.** Toda figura do console é derivada do inventário, da telemetria ou da trilha de auditoria por uma função pura e testada. Não existe constante ilustrativa, KPI decorativo nem série de exemplo embutida na interface.

Essa decisão define o desenho: o modelo de decisão é um módulo isolado, o servidor o aplica, o navegador só desenha o que recebeu, e o método viaja junto com o resultado.

```text
┌────────────────────────────────────────────────────────────────┐
│                    Console (navegador)                          │
│  public/core.js      runtime, escaping, gráfico, registro       │
│  public/app.js       7 workspaces operacionais                  │
│  public/workspaces.js 4 workspaces de dados, IA e plataforma    │
└───────────────────────────┬────────────────────────────────────┘
                            │ REST · mesma origem · CSP restritiva
┌───────────────────────────▼────────────────────────────────────┐
│                    server.js — fronteira                        │
│  autenticação por token · validação · limite de taxa            │
│  cabeçalhos de segurança · log estruturado · estáticos          │
└──┬──────────────┬───────────────┬──────────────┬───────────────┘
   │              │               │              │
┌──▼──────────┐ ┌─▼───────────┐ ┌─▼──────────┐ ┌─▼──────────────┐
│ operations  │ │intelligence │ │  context   │ │    bedrock     │
│ risco       │ │estatística  │ │4 fontes    │ │ Converse       │
│ prontidão   │ │baselines    │ │federais    │ │ opcional       │
│ decisões    │ │avaliação    │ │normalizadas│ │                │
└──┬──────────┘ └─┬───────────┘ └─┬──────────┘ └────────────────┘
   │              │               │
┌──▼──────────────▼───────────────▼──────────────────────────────┐
│                 database.js — dois backends                     │
│  local: data/ (somente leitura) + runtime/ (escrita)            │
│  produção: PostgreSQL com migrações versionadas                 │
└────────────────────────────────────────────────────────────────┘
```

## O modelo de decisão

`lib/operations.js` é a única fonte de verdade sobre a condição de um ativo. Servidor, navegador e testes usam as mesmas definições, e os pesos são explícitos para que um revisor refaça qualquer conta à mão.

| Grandeza | Definição | Onde aparece |
| --- | --- | --- |
| **Risco do ativo** | `0,50·(100 − saúde) + 0,20·vibração + 0,15·temperatura + 0,15·criticidade` | Faixas CRÍTICO ≥ 70, ATENÇÃO ≥ 45, ESTÁVEL abaixo |
| **Prontidão da frota** | `Σ(saúde × criticidade) ÷ Σ(criticidade)` | Índice ponderado; capacidade entregue, não nominal |
| **Cobertura** | janelas horárias observadas ÷ esperadas na janela do dataset | Qualidade do dado, por ativo e agregada |
| **Frescor** | idade da amostra mais recente; acima de 3h o ativo é `stale` | Marca explícita na lista de ativos |
| **Exposição** | queda de prontidão se o ativo sair de operação | Ranking de pontos únicos de falha |

Uma consequência deliberada do índice de prontidão: **perder um ativo já degradado custa menos do que perder um saudável**, mesmo que o degradado seja mais crítico — porque metade de uma capacidade só entregava metade. Isso está fixado em teste, não é acidente.

O ativo nunca carrega um campo `status` armazenado. A migração `004` removeu essa coluna justamente porque um rótulo escrito à mão pode divergir do risco calculado, e duas versões da mesma verdade só produzem contradição.

## Decisões assistidas

Três endpoints produzem recomendações. Todos registram na trilha de auditoria **antes** de devolver o resultado, e todos devolvem os termos que compõem o número, além do limite do método.

| Endpoint | Pergunta | Devolve |
| --- | --- | --- |
| `POST /api/decisions/scenario` | E se este ativo operar sob carga X por Y horas? | Risco projetado e seus três termos |
| `POST /api/decisions/outage` | E se este ativo ficar indisponível? | Prontidão projetada, queda, reservas equivalentes |
| `POST /api/decisions/review` | Esta alteração técnica pode entrar em operação? | Veredito de encaminhamento e verificações |

Nenhum deles autoriza nada. O veredito de revisão encaminha para o nível certo de análise humana — `acceptable`, `controlled` ou `blocked` — e é isso.

## Contexto público federal

Quatro fontes oficiais dos EUA, escolhidas por cobrirem horizontes diferentes do mesmo problema:

| Fonte | Horizonte | O que informa |
| --- | --- | --- |
| Aviation Weather Center (METAR) | Agora | Envelope de operação no aeródromo de referência: VFR, MVFR, IFR, LIFR |
| NOAA / NWS | Horas | Avisos meteorológicos vigentes por estado, com severidade da fonte |
| USGS | Instantâneo | Sismos M4.5+ nas últimas 24 horas |
| FEMA / OpenFEMA | Semanas a meses | Declarações federais de desastre, áreas designadas e situação de encerramento |

O servidor é a fronteira: `lib/context.js` declara host, parâmetros aceitos e normalização de cada fonte. O navegador nunca escolhe uma URL. Parâmetro inválido é recusado **antes** de qualquer requisição de saída, e todo payload é reduzido a uma forma única — `{ id, title, detail, area, at, severity }` — com campos truncados e espaços colapsados, de modo que nenhum texto de terceiro chega ao console verbatim.

Sinal externo abre revisão humana. Não altera prontidão, não libera ativo, não cria ordem de manutenção.

## Fronteira de segurança

- **Estáticos**: servidos apenas de `public/`, com contenção verificada após resolução do caminho. Não há lista de nomes permitidos para manter sincronizada; o que está fora do diretório é inalcançável por construção.
- **CSP**: `default-src 'none'`, scripts só da própria origem, nada pode emoldurar o console. Estilos inline são permitidos porque as barras e gráficos dimensionam por atributo.
- **Escaping por construção**: o console monta HTML com um template tag que escapa toda interpolação. Injetar marcação exige `Forge.raw` explícito.
- **Token**: com `FORGE_API_TOKEN` definido, todo `/api/*` exceto `/api/health` exige `Authorization: Bearer`. Comparação em tempo constante. Em produção o servidor recusa iniciar com token menor que 32 caracteres. Isso ainda **não** é identidade individual nem autorização por papéis.
- **Limite de taxa**: escritas e chamadas de contexto são limitadas por cliente, em janela fixa e memória local — o que basta para uma instância e não basta para várias.
- **Erros**: um erro com `status` explícito foi levantado de propósito e sua mensagem é segura de mostrar; qualquer outro vira resposta genérica e log estruturado.
- **Dados**: `data/` é semente somente leitura. Toda escrita vai para o diretório de runtime, o que permite sistema de arquivos raiz somente leitura no contêiner.

## API

| Método | Rota | Finalidade |
| --- | --- | --- |
| GET | `/api/health` | Estado do serviço e persistência. Pública |
| GET | `/api/overview?dataset=` | Tudo que o centro de comando mostra, já derivado |
| GET | `/api/assets` | Inventário bruto |
| GET | `/api/telemetry?dataset=` | Observações, até 10.000 |
| POST | `/api/telemetry` | Lote validado de 1 a 100 observações |
| GET | `/api/analytics?assetId=&metric=&dataset=` | Estatística por ativo e série com desvios marcados |
| POST | `/api/decisions/scenario` | Projeção de risco sob carga |
| POST | `/api/decisions/outage` | Impacto de indisponibilidade |
| POST | `/api/decisions/review` | Triagem de alteração técnica |
| GET | `/api/models` | Baselines, configuração Bedrock e execuções |
| POST | `/api/models/evaluate` | Avaliação cronológica registrada |
| POST | `/api/ai/explain` | Explicação Bedrock com evidência delimitada |
| GET | `/api/context` | Catálogo de fontes, estações de referência e política |
| GET | `/api/context/cache` | Últimos snapshots coletados pelo coletor agendado |
| GET | `/api/context/{airfield,weather,disasters,earthquakes}` | Consulta ao vivo, normalizada |
| GET | `/api/audit` · POST | Trilha de auditoria |
| GET | `/api/platform` | Runtime, persistência e configuração observada |

## Caminho para serviços

O coletor de contexto é a primeira costura de extração e já está preparada. Ver [services.md](services.md).

## O que ainda não existe

Identidade individual e RBAC, imutabilidade criptográfica da trilha, política de retenção, limite de taxa distribuído, posição real de ativos com geofencing, e validação dos modelos em dados rotulados representativos. Nada disso está simulado na interface para parecer pronto.
