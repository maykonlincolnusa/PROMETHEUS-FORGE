# Forge Intelligence · dados, IA e plataforma

Esta parte do console cobre quatro áreas executáveis. O ambiente local funciona sem conta AWS. Inferência generativa e implantação são configuradas separadamente.

| Área | Implementado | Limite atual |
| --- | --- | --- |
| Estatística | Média, mediana, desvio amostral, P95, correlação, inclinação temporal e gráfico por ativo | Sem previsão calibrada de falha |
| Dados | Importação JSON validada, deduplicação, persistência e exportação | Sem streaming ou upload automático para S3 |
| Engenharia de IA | Dois baselines estatísticos, teste temporal, matriz de confusão e registro de experimentos | Sem redes neurais ou promoção automática |
| IA generativa | Adaptador Amazon Bedrock Converse com contexto delimitado e auditoria | Requer modelo, região, identidade AWS e acesso à API |
| Plataforma | Estado do processo e persistência, Docker, templates AWS e CI | Implantação na conta, SSO/RBAC e alertas ainda pendentes |

## Executar

```powershell
npm ci
npm start
```

Abra `http://localhost:3000/?view=statistics`. As outras áreas são `data`, `models` e `platform`. Os seis módulos operacionais anteriores continuam disponíveis.

A demonstração gera 48 observações horárias por ativo numa janela móvel que termina na hora cheia mais recente: 288 amostras para o inventário de seis ativos. A janela rola com o relógio, de modo que frescor e cobertura no console são reais; ela se ancora na hora cheia, o que mantém o hash do dataset estável dentro da mesma hora. São dados sintéticos, não medições. Telemetria importada fica em outro dataset e nunca se mistura à demonstração; importar uma série não altera o inventário nem a prontidão.

`npm start` não carrega `.env` automaticamente. Para usar esse arquivo, execute `node --env-file=.env server.js` (Node 20.6+) ou Docker Compose. Copiar `.env.example` seleciona PostgreSQL; omita `DATABASE_URL` para continuar no modo local.

## API e contrato de dados

Quando `FORGE_API_TOKEN` está definido, `/api/*`, exceto `/api/health`, exige `Authorization: Bearer <token>`. Em produção, o servidor exige um token de pelo menos 32 caracteres. A interface recebe a chave em **Acesso API** e mantém o valor somente na memória da aba. Isso ainda não é identidade individual ou autorização por papéis.

| Método | Endpoint | Contrato |
| --- | --- | --- |
| GET | `/api/telemetry?dataset=synthetic-v1` | Use `ingested` para selecionar importações |
| POST | `/api/telemetry` | Objeto `records`, 1–100 observações, até 64 KiB |
| GET | `/api/analytics?assetId=VX-204&metric=health&dataset=synthetic-v1` | Métricas: `health`, `vibration`, `temperature` |
| GET | `/api/models` | Modelos, configuração Bedrock sem segredos e últimas 50 execuções |
| POST | `/api/models/evaluate` | `modelId`: `robust-mad-v1` ou `zscore-v1`; `dataset` opcional |
| POST | `/api/ai/explain` | `assetId`, `question` de 1–1000 caracteres e `dataset` |
| GET | `/api/platform` | Processo, persistência e configuração; não consulta inventário AWS |

Os endpoints operacionais — `/api/overview`, `/api/decisions/*`, `/api/context/*` e `/api/audit` — estão descritos em [architecture.md](architecture.md).

O dataset padrão é sempre `synthetic-v1`. Exemplo de importação:

```json
{
  "records": [{
    "assetId": "VX-204",
    "timestamp": "2026-09-01T12:00:00Z",
    "health": 72,
    "vibration": 45,
    "temperature": 58,
    "label": null
  }]
}
```

O servidor verifica o ativo, valores numéricos finitos entre 0 e 100 e calendário UTC. Rejeita datas mais de cinco minutos no futuro. `label: true` significa anomalia revisada; `false`, observação normal revisada; `null`, sem rótulo. Um lote inválido não grava observações. Duplicatas dentro do lote são rejeitadas. Registros persistidos com o mesmo ativo e horário são ignorados, sem sobrescrita. A origem importada é atribuída pelo servidor.

No modo local, `intelligence.json` no diretório de runtime retém até 10.000 observações e 50 experimentos. `data/` é semente somente leitura: nenhuma escrita acontece lá. Escritas são serializadas e publicadas por substituição de arquivo; não use múltiplos processos sobre essa pasta. `FORGE_DATA_DIR` permite escolher outra pasta. PostgreSQL usa a migração `003_intelligence.sql`, transações e chave composta para deduplicação. O banco preserva o histórico, mas a consulta analítica seleciona as 10.000 observações mais recentes globalmente; ativos de baixa frequência podem ficar fora da janela. Paginação e política de retenção precisam evoluir para volumes maiores.

## Método estatístico

O desvio amostral usa `n−1`. Quantis usam interpolação linear. Correlação de Pearson exige ao menos três pares e variância nas duas séries. A inclinação usa horas efetivamente transcorridas, inclusive com intervalos irregulares. Valores indefinidos retornam `null`. Não há probabilidades de falha ou intervalos de confiança artificiais.

Cada baseline é ajustado por ativo nas primeiras `floor(2n/3)` observações cronológicas. O restante forma o teste. São necessárias dez amostras por ativo; apenas rótulos booleanos no teste entram nas métricas. Os dados de teste não participam do ajuste.

- **Robust MAD v1:** centro = mediana; escala = `max(1, 1.4826 × MAD)`; limiar = 3,5.
- **Z-score v1:** centro = média; escala = `max(1, desvio amostral)`; limiar = 3.
- **Score:** maior desvio absoluto normalizado entre as três métricas. Uma excedência sinaliza a observação inteira. O piso da escala é um ponto normalizado.
- **Registro:** versão, limiar, baselines, fronteiras temporais, SHA-256 do dataset, contagens, precisão, recall, F1, acurácia e matriz TP/FP/TN/FN.

O cenário sintético contém desvios deliberadamente fáceis. Resultados elevados verificam o pipeline, não demonstram qualidade preditiva no campo. O treino não é filtrado automaticamente por rótulos; contaminação do baseline e mudanças de regime exigem validação. Não há validação cruzada, seleção de hiperparâmetros ou promoção automática.

## Amazon Bedrock

Configure `AI_PROVIDER=bedrock`, `AWS_REGION`, `BEDROCK_MODEL_ID` e `FORGE_API_TOKEN`. O SDK usa a cadeia padrão de credenciais: identidade temporária/SSO local ou IAM task role no ECS. Não existem campos de credenciais AWS no navegador. Escolha um modelo Converse compatível com `maxTokens` e `temperature` e disponível na região.

O pedido envia pergunta, ativo, resumo estatístico e as cinco últimas observações do dataset escolhido. O prompt `forge-evidence-v1` exige distinção entre observações e hipóteses, além de revisão humana. Há limite de 700 tokens de saída, timeout de 25 segundos e uma tentativa. Cada processo permite uma consulta simultânea e um início a cada dez segundos. Para múltiplas instâncias, implemente controle central de consumo.

O retorno informa modelo, prompt, uso reportado pelo provedor, latência e motivo de parada. A auditoria guarda metadados, sem pergunta ou resposta. Não há ferramentas executáveis ou atualização de ativos. O adaptador é testado com provedor simulado; uma chamada real exige configuração AWS e pode gerar cobrança.

Referência: [exemplos oficiais Bedrock para JavaScript](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_bedrock-runtime_code_examples.html).

## Verificação e próximos marcos

```powershell
npm run check
npm test
npx playwright install chromium
npm run test:ui
```

Com Edge instalado no Windows, use `$env:PLAYWRIGHT_CHANNEL = 'msedge'` antes de `npm run test:ui`, dispensando o download de Chromium.

Os testes cobrem o modelo de decisão, cálculos estatísticos, separação temporal, validação, deduplicação concorrente, persistência local, acesso à API, proteção de arquivos internos, limite de taxa, cabeçalhos de segurança, as quatro fontes federais, o contrato Bedrock e as onze telas. O navegador usa servidor isolado na porta 3100 e pasta temporária. PostgreSQL precisa de validação própria; não é exercitado pelo modo local.

Próximos marcos: conectores e streaming; exportação S3 e catálogo Glue; qualidade por fonte; datasets revisados; comparação com modelos treinados no SageMaker; SLOs, alertas, SSO/RBAC e aprovação. Veja [a implantação AWS](../infra/aws/README.md).
