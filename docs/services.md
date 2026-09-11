# Caminho para serviços

## O erro comum

A forma mais comum de errar em microserviços é dividir por camada: um serviço de ativos, um de auditoria, um de API. Isso parece organizado e produz o pior resultado possível — inventário, decisão e trilha de auditoria são uma **unidade transacional**. Uma simulação precisa ler o ativo e gravar o registro; separá-los troca uma chamada de função por uma chamada de rede, um `await` por um commit distribuído, e um erro impossível por um estado parcial.

Forge não divide por camada. Divide onde o **perfil de falha e de escala** é genuinamente diferente.

## Primeira costura: o coletor de contexto

O coletor é a única parte do sistema que:

- fala com serviços de terceiros — quatro APIs federais, lentas, sujeitas a limite de taxa e indisponibilidade;
- falha de um jeito que **não deveria** aparecer no clique de um operador;
- tem cadência própria: uma declaração da FEMA muda em semanas, um METAR a cada hora, e nada disso precisa ser buscado no instante em que alguém abre a tela;
- não escreve nada que outra parte do sistema precise ler de forma transacional.

Ele já está isolado. `lib/context.js` declara as fontes, valida parâmetros, normaliza payloads e recebe `fetch` por injeção. `scripts/collect-context.js` é o entrypoint: recebe o inventário, executa o plano e persiste snapshots.

```text
EventBridge (agenda)
        │
        ▼
scripts/collect-context.js ──► APIs federais (sequencial, tolerante a falha)
        │
        ▼
context_snapshots  ◄────── GET /api/context/cache ◄── console
```

Extrair esse coletor para um contêiner separado é **mudança de implantação, não reescrita**: mesma função `collect`, mesmo contrato de saída, mesma tabela.

```powershell
npm run collect:context
```

Cada job emite uma linha estruturada; uma fonte que falha não derruba as outras, e o código de saída 1 sinaliza falha parcial sem descartar o que deu certo.

## Por que o console ainda consulta ao vivo

Os dois caminhos coexistem de propósito. A consulta ao vivo (`/api/context/weather?area=CA`) prova que a integração funciona e serve para demonstração. O cache (`/api/context/cache`) é o caminho de produção, onde nenhuma API federal fica entre o operador e a tela. Quando a coleta agendada estiver rodando de fato, o console passa a ler o cache por padrão e a consulta ao vivo vira ação explícita de "atualizar agora".

## Segunda costura, quando fizer sentido

**Avaliação de modelos.** `POST /api/models/evaluate` é ligado a CPU, cresce com o volume de telemetria e não tem nada a ver com a latência do console. Hoje roda em milissegundos sobre 288 amostras; com histórico real, vira trabalho de fila. A extração natural é uma fila de tarefas com resultados gravados em `model_runs` — o registro de experimentos já tem o formato certo para isso, incluindo hash do dataset e metadados de reprodutibilidade.

Não antes disso. Extrair um serviço que roda em 3 ms é custo puro.

## O que nunca deve ser dividido

Inventário, modelo de decisão e trilha de auditoria. `lib/operations.js` precisa ser a única definição de risco e prontidão no sistema inteiro: duas implementações divergem, e no dia em que divergirem o console e o relatório vão discordar sobre a mesma frota. Se a lógica precisar ser compartilhada entre serviços, publique-a como **biblioteca versionada**, não como serviço de rede.

## Critérios para extrair o próximo

Antes de criar um serviço, três respostas precisam existir:

1. **O que quebra separado que não quebra junto?** Se a resposta é "nada", a costura não é real.
2. **Qual contrato permanece estável?** Se o contrato muda toda semana, a fronteira está no lugar errado.
3. **Quem opera?** Cada serviço adiciona implantação, observabilidade, versionamento e um modo de falha novo.

O coletor responde às três: quebra separado porque depende da internet pública; o contrato é a forma normalizada do snapshot, estável desde que as fontes sejam as mesmas; e roda em agenda, sem SLA de latência.
