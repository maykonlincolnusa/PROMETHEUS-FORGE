/**
 * Intelligence workspaces: applied statistics, data engineering, the model lab
 * and the AWS platform view. They share the console runtime in core.js, so the
 * dataset and asset selected in one workspace carry into the others.
 */
(() => {
  const { html, api, kpi, sectionTitle, heading, state } = Forge;
  const { number, percent, dateTime } = Forge;
  const metricNames = { health: 'Saúde', vibration: 'Vibração', temperature: 'Temperatura' };

  const datasetField = () => html`
    <label for="dataset-select">Dataset
      <select id="dataset-select">
        <option value="synthetic-v1" ${Forge.raw(state.dataset === 'synthetic-v1' ? 'selected' : '')}>Demonstração sintética · v1</option>
        <option value="ingested" ${Forge.raw(state.dataset === 'ingested' ? 'selected' : '')}>Telemetria importada</option>
      </select>
    </label>`;

  function assetField(assets) {
    if (!assets.some(asset => asset.id === state.assetId)) state.assetId = assets[0]?.id || '';
    return html`
      <label for="analytics-asset">Ativo
        <select id="analytics-asset">
          ${assets.map(asset => html`<option value="${asset.id}" ${Forge.raw(asset.id === state.assetId ? 'selected' : '')}>${asset.id} · ${asset.name}</option>`)}
        </select>
      </label>`;
  }

  function bindSelectors(view) {
    const dataset = document.querySelector('#dataset-select');
    if (dataset) dataset.onchange = () => { state.dataset = dataset.value; Forge.show(view); };
    const asset = document.querySelector('#analytics-asset');
    if (asset) asset.onchange = () => { state.assetId = asset.value; Forge.show(view); };
  }

  /** Telemetry series with the model's anomaly marks kept visually distinct. */
  function plot(series, metric) {
    if (!series.length) return html`<p class="empty-state">Nenhuma amostra neste dataset. Importe telemetria na área de dados.</p>`;
    const start = Date.parse(series[0].timestamp);
    const duration = Date.parse(series.at(-1).timestamp) - start || 1;
    const x = row => 46 + ((Date.parse(row.timestamp) - start) / duration) * 720;
    const y = row => 215 - row[metric] * 1.85;
    const points = series.map(row => `${x(row).toFixed(1)},${y(row).toFixed(1)}`).join(' ');
    return html`
      <svg class="telemetry-plot" viewBox="0 0 800 260" role="img"
        aria-label="Série temporal de ${metricNames[metric]}, escala de 0 a 100. Pontos âmbar indicam desvios multivariados.">
        ${[0, 25, 50, 75, 100].map(value => html`
          <line class="plot-grid" x1="46" x2="766" y1="${215 - value * 1.85}" y2="${215 - value * 1.85}" />
          <text x="8" y="${219 - value * 1.85}">${value}</text>`)}
        <polyline points="${points}" fill="none" stroke="var(--cyan)" stroke-width="2.5" />
        ${series.map(row => html`
          <circle cx="${x(row).toFixed(1)}" cy="${y(row).toFixed(1)}" r="${row.anomaly ? 4.5 : 2}"
            fill="${row.anomaly ? 'var(--amber)' : 'var(--cyan)'}">
            <title>${dateTime(row.timestamp)}: ${number(row[metric], 2)}${row.anomaly ? ' · desvio multivariado' : ''}</title>
          </circle>`)}
        <text x="46" y="245">${dateTime(series[0].timestamp)}</text>
        <text x="766" y="245" text-anchor="end">${dateTime(series.at(-1).timestamp)}</text>
      </svg>`;
  }

  /* ----------------------------------------------------------- statistics */

  Forge.register('statistics', {
    kicker: 'ESTATÍSTICA APLICADA',
    title: 'Laboratório estatístico',
    async render({ stale }) {
      const assets = await api('/api/assets');
      const field = assetField(assets);
      const result = await api(`/api/analytics?assetId=${encodeURIComponent(state.assetId)}&metric=${state.metric}&dataset=${state.dataset}`);
      if (stale()) return;
      const summary = result.summary;

      Forge.content().innerHTML = html`
        ${heading('01 / ESTATÍSTICA APLICADA', 'Do sinal à evidência.', 'Explore a distribuição, a tendência e os desvios da telemetria por ativo.')}
        <div class="workspace-filters">
          ${field}${datasetField()}
          <label for="metric-select">Métrica
            <select id="metric-select">
              ${Object.entries(metricNames).map(([key, name]) => html`<option value="${key}" ${Forge.raw(state.metric === key ? 'selected' : '')}>${name}</option>`)}
            </select>
          </label>
        </div>
        <div class="kpi-grid">
          ${kpi('AMOSTRAS', summary.count, result.synthetic ? 'Dados sintéticos identificados' : 'Dados importados')}
          ${kpi('MÉDIA', number(summary.mean, 2), 'Escala normalizada · 0 a 100')}
          ${kpi('DESVIO PADRÃO', number(summary.stddev, 2), 'Estimador amostral · n − 1')}
          ${kpi('PERCENTIL 95', number(summary.p95, 2), 'Interpolação linear')}
        </div>
        <article class="card wide">
          ${sectionTitle(`${metricNames[state.metric]} ao longo do tempo`, '● SÉRIE · ● DESVIO')}
          ${plot(result.series, state.metric)}
        </article>
        <div class="split wide">
          <article class="card">
            ${sectionTitle('Leitura estatística')}
            <dl class="facts">
              <div><dt>Mediana</dt><dd>${number(summary.median, 2)}</dd></div>
              <div><dt>Mínimo / máximo</dt><dd>${number(summary.min, 2)} / ${number(summary.max, 2)}</dd></div>
              <div><dt>Inclinação por hora</dt><dd>${number(result.slopePerHour, 4)} pontos</dd></div>
              <div><dt>Correlação vibração × temperatura</dt><dd>${number(result.correlation, 3)}</dd></div>
            </dl>
          </article>
          <article class="card">
            <p class="eyebrow">INTERPRETAÇÃO</p>
            <h3>Uma anomalia pede investigação.</h3>
            <p class="workspace-copy">A marcação usa Robust MAD nas três métricas, ajustado apenas nos primeiros 2/3 da série. Correlação não estabelece causalidade; a inclinação descreve a janela observada e não é previsão de falha.</p>
            <button class="button secondary" id="export-analysis" type="button">Exportar análise JSON</button>
          </article>
        </div>`.__html;

      bindSelectors('statistics');
      document.querySelector('#metric-select').onchange = event => {
        state.metric = event.target.value;
        Forge.show('statistics');
      };
      document.querySelector('#export-analysis').onclick = () => Forge.download(result, 'forge-analysis.json');
    },
  });

  /* ------------------------------------------------------ data engineering */

  Forge.register('data', {
    kicker: 'ENGENHARIA DE DADOS',
    title: 'Dados & qualidade',
    async render({ stale }) {
      const [assets, data] = await Promise.all([api('/api/assets'), api(`/api/telemetry?dataset=${state.dataset}`)]);
      if (stale()) return;
      const labelled = data.records.filter(row => typeof row.label === 'boolean').length;
      const times = data.records.map(row => row.timestamp).sort();

      Forge.content().innerHTML = html`
        ${heading('02 / ENGENHARIA DE DADOS', 'Dados com contexto e contrato.', 'Importe lotes, inspecione a cobertura e mantenha a origem de cada observação.')}
        <div class="workspace-filters">
          ${datasetField()}
          <button class="button secondary" id="export-data" type="button">Exportar dataset</button>
        </div>
        <div class="kpi-grid">
          ${kpi('REGISTROS', data.count, 'Janela consultável de até 10.000')}
          ${kpi('ATIVOS COM DADOS', new Set(data.records.map(row => row.assetId)).size, `${assets.length} ativos no inventário`)}
          ${kpi('COM RÓTULO', percent(data.count ? labelled / data.count : null), 'Rótulos habilitam a avaliação')}
          ${kpi('ORIGEM', state.dataset === 'synthetic-v1' ? 'DEMO' : 'IMPORTADO', 'Datasets mantidos separados')}
        </div>
        <div class="split wide">
          <article class="card">
            ${sectionTitle('Ingestão de telemetria', 'JSON · LOTE ATÔMICO')}
            <p class="workspace-copy">Até 100 registros por envio. Métricas normalizadas de 0 a 100, horário UTC, ativo já cadastrado. Reenvios do mesmo ativo e horário são ignorados.</p>
            <label for="telemetry-input">Registros do lote</label>
            <textarea id="telemetry-input" rows="12" spellcheck="false" aria-describedby="ingest-result"></textarea>
            <div class="inline-actions">
              <button class="button" id="ingest-data" type="button">Validar e importar</button>
              <button class="button secondary" id="example-data" type="button">Preencher exemplo</button>
            </div>
            <p id="ingest-result" role="status" class="workspace-copy">O exemplo só será salvo ao clicar em importar.</p>
          </article>
          <article class="card">
            ${sectionTitle('Contrato de dados', 'v1')}
            <dl class="facts">
              <div><dt>assetId</dt><dd>ID do inventário</dd></div>
              <div><dt>timestamp</dt><dd>ISO 8601 · UTC</dd></div>
              <div><dt>health / vibration / temperature</dt><dd>Número · 0–100</dd></div>
              <div><dt>label</dt><dd>true / false / null</dd></div>
              <div><dt>Primeira amostra</dt><dd>${times.length ? dateTime(times[0]) : '—'}</dd></div>
              <div><dt>Última amostra</dt><dd>${times.length ? dateTime(times.at(-1)) : '—'}</dd></div>
            </dl>
            <div class="reason">Rótulos não são inferidos na importação. Use <code>null</code> quando o evento ainda não passou por revisão. O modo local retém as 10.000 amostras mais recentes; PostgreSQL preserva o histórico.</div>
          </article>
        </div>`.__html;

      bindSelectors('data');
      document.querySelector('#export-data').onclick = () => Forge.download(data, `forge-${state.dataset}.json`);
      document.querySelector('#example-data').onclick = () => {
        document.querySelector('#telemetry-input').value = JSON.stringify({
          records: [{
            assetId: assets[0]?.id || 'VX-204',
            timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
            health: 72, vibration: 45, temperature: 58, label: null,
          }],
        }, null, 2);
      };
      document.querySelector('#ingest-data').onclick = async event => {
        const button = event.currentTarget;
        const output = document.querySelector('#ingest-result');
        button.disabled = true;
        try {
          const result = await api('/api/telemetry', JSON.parse(document.querySelector('#telemetry-input').value));
          output.textContent = `${result.accepted} aceitos; ${result.duplicates} duplicados; ${result.evicted} removidos pela retenção. Selecione Telemetria importada para consultar.`;
        } catch (error) {
          output.textContent = error instanceof SyntaxError ? 'JSON inválido: revise o lote antes de importar.' : error.message;
        } finally { button.disabled = false; }
      };
    },
  });

  /* -------------------------------------------------------------- model lab */

  function runTable(runs) {
    if (!runs.length) return html`<p class="empty-state">Execute uma avaliação para registrar métricas, versão e identidade do dataset.</p>`;
    return html`
      <div class="table-scroll">
        <table class="data-table">
          <thead><tr><th>Modelo / execução</th><th>Dataset</th><th>Precisão</th><th>Recall</th><th>F1</th><th>Teste</th></tr></thead>
          <tbody>
            ${runs.map(run => html`
              <tr>
                <td><strong>${run.modelId}</strong><small>${dateTime(run.at)}</small></td>
                <td>${run.synthetic ? 'Sintético' : 'Importado'}<small title="${run.datasetHash}">${run.datasetHash.slice(0, 12)}</small></td>
                <td>${percent(run.precision)}</td><td>${percent(run.recall)}</td><td>${percent(run.f1)}</td><td>${run.testCount}</td>
              </tr>`)}
          </tbody>
        </table>
      </div>`;
  }

  Forge.register('models', {
    kicker: 'ENGENHARIA DE IA',
    title: 'Laboratório de modelos',
    async render({ stale }) {
      const [data, assets] = await Promise.all([api('/api/models'), api('/api/assets')]);
      if (stale()) return;
      const enabled = data.bedrock.enabled && data.bedrock.configured;

      Forge.content().innerHTML = html`
        ${heading('03 / ENGENHARIA DE IA', 'Modelos que mostram suas evidências.', 'Compare baselines, registre experimentos e consulte um modelo generativo com contexto delimitado.')}
        <div class="workspace-filters">
          ${datasetField()}
          <p class="workspace-copy">Treino: primeiros 2/3 por ativo · teste: período restante.</p>
        </div>
        <div class="model-grid">
          ${data.models.map((model, index) => html`
            <article class="card model-card">
              <div class="section-title"><span>BASELINE ${String(index + 1).padStart(2, '0')}</span><span class="risk-badge risk-low">LOCAL</span></div>
              <h3>${model.name}</h3>
              <p class="eyebrow">${model.kind} · v${model.version}</p>
              <p class="workspace-copy">${model.description}</p>
              <div class="model-footer">
                <span>Limiar: ${model.threshold}</span>
                <button class="button" data-evaluate="${model.id}" type="button">Avaliar modelo</button>
              </div>
            </article>`)}
        </div>
        <p id="evaluation-status" role="status" class="workspace-copy"></p>
        <article class="card wide">
          <div class="section-title"><h2>Registro de experimentos</h2><button class="button secondary" id="export-runs" type="button">Exportar registro</button></div>
          ${runTable(data.runs)}
          <p class="workspace-copy">Resultados sintéticos verificam o pipeline; não comprovam qualidade em produção. Métricas sem denominador aparecem como “—”. Nenhum modelo é promovido automaticamente.</p>
        </article>
        <article class="card wide">
          <div class="section-title">
            <h2>Assistente de evidências</h2>
            <span class="risk-badge ${enabled ? 'risk-low' : 'risk-medium'}">BEDROCK · ${enabled ? 'CONFIGURADO' : 'DESATIVADO'}</span>
          </div>
          <div class="workspace-filters">
            ${assetField(assets)}
            <div>
              <p class="eyebrow">MODELO / PROMPT</p>
              <p class="workspace-copy">${data.bedrock.modelId || 'Configure o provedor no servidor'} · ${data.bedrock.promptVersion}</p>
            </div>
          </div>
          <label for="ai-question">Pergunta sobre o ativo</label>
          <textarea id="ai-question" rows="3" maxlength="1000" placeholder="Quais evidências merecem investigação neste ativo?"></textarea>
          <button class="button" id="ask-ai" type="button" ${Forge.raw(enabled ? '' : 'disabled')}>Consultar modelo</button>
          <p class="workspace-copy">Envia à AWS o ativo e um resumo do dataset selecionado. Requer acesso à plataforma e ao modelo; chamadas podem gerar cobrança.</p>
          <div id="ai-output" class="ai-answer" role="status">${enabled
            ? 'Configuração detectada; a conexão será verificada ao consultar.'
            : 'A análise estatística local está disponível. A integração generativa aguarda configuração AWS.'}</div>
        </article>`.__html;

      bindSelectors('models');
      document.querySelector('#export-runs').onclick = () => Forge.download(data.runs, 'forge-experiments.json');
      document.querySelectorAll('[data-evaluate]').forEach(button => {
        button.onclick = async () => {
          const output = document.querySelector('#evaluation-status');
          button.disabled = true;
          output.textContent = 'Ajustando baseline e avaliando o período de teste…';
          try {
            const run = await api('/api/models/evaluate', { modelId: button.dataset.evaluate, dataset: state.dataset });
            if (stale()) return;
            await Forge.show('models');
            const status = document.querySelector('#evaluation-status');
            if (status) {
              status.textContent = `Experimento registrado: ${run.trainCount} amostras de treino, ${run.testCount} de teste. `
                + `TP ${run.matrix.tp} · FP ${run.matrix.fp} · TN ${run.matrix.tn} · FN ${run.matrix.fn}.`;
            }
          } catch (error) {
            output.textContent = error.message;
            button.disabled = false;
          }
        };
      });
      document.querySelector('#ask-ai').onclick = async event => {
        const button = event.currentTarget;
        const output = document.querySelector('#ai-output');
        button.disabled = true;
        output.textContent = 'Consultando modelo com as evidências selecionadas…';
        try {
          const result = await api('/api/ai/explain', {
            question: document.querySelector('#ai-question').value,
            assetId: state.assetId,
            dataset: state.dataset,
          });
          output.textContent = `${result.answer}\n\n${result.modelId} · ${result.latencyMs} ms · ${result.usage?.totalTokens ?? '—'} tokens · revisão humana necessária`;
        } catch (error) {
          output.textContent = error.message;
        } finally { button.disabled = false; }
      };
    },
  });

  /* ---------------------------------------------------------- aws platform */

  Forge.register('platform', {
    kicker: 'CLOUD & PLATAFORMA',
    title: 'Plataforma AWS',
    async render({ stale }) {
      const data = await api('/api/platform');
      if (stale()) return;

      Forge.content().innerHTML = html`
        ${heading('04 / ENGENHARIA DE PLATAFORMA', 'Uma fundação para crescer na AWS.', 'Estado observado do serviço e arquitetura de destino, com infraestrutura declarativa no repositório.')}
        <div class="kpi-grid">
          ${kpi('RUNTIME', data.runtime, `Forge ${data.version}`)}
          ${kpi('PERSISTÊNCIA', data.persistence === 'postgresql' ? 'POSTGRES' : 'LOCAL', 'Conectividade consultada agora')}
          ${kpi('ACESSO API', data.authentication === 'token' ? 'TOKEN' : 'DEMO', 'SSO e RBAC: evolução futura')}
          ${kpi('UPTIME', `${number(data.uptimeSeconds / 60, 1)} min`, 'Tempo deste processo')}
        </div>
        <article class="card wide">
          ${sectionTitle('Arquitetura AWS', 'DESTINO · NÃO É INVENTÁRIO DA CONTA')}
          <div class="architecture-flow">
            <div><span>01 / EXECUÇÃO</span><strong>ECR → ECS Fargate</strong><p>Imagem imutável, tarefas privadas e configuração externa.</p></div>
            <div><span>02 / DADOS</span><strong>PostgreSQL + S3</strong><p>Histórico transacional e bucket para artefatos de dados.</p></div>
            <div><span>03 / CONTEXTO</span><strong>EventBridge → coletor</strong><p>Fontes federais coletadas em agenda e materializadas, em vez de proxy por clique.</p></div>
            <div><span>04 / OPERAÇÃO</span><strong>CloudWatch + IAM</strong><p>Logs, papéis separados e segredos injetados na execução.</p></div>
          </div>
        </article>
        <div class="split wide">
          <article class="card">
            ${sectionTitle('Prontidão observável', 'ESTA INSTÂNCIA')}
            <dl class="facts">
              <div><dt>Ambiente de execução</dt><dd>${data.cloud}</dd></div>
              <div><dt>Região configurada</dt><dd>${data.region || 'Não configurada'}</dd></div>
              <div><dt>Bedrock</dt><dd>${data.bedrock.enabled && data.bedrock.configured ? 'Configurado; conexão não verificada' : 'Desativado ou incompleto'}</dd></div>
              <div><dt>Contexto público</dt><dd>${data.publicContext === 'enabled' ? 'Habilitado' : 'Desativado por configuração'}</dd></div>
              <div><dt>Infraestrutura</dt><dd>Templates versionados no repositório</dd></div>
            </dl>
            <button class="button secondary" id="refresh-platform" type="button">Atualizar estado</button>
          </article>
          <article class="card">
            <p class="eyebrow">PRÓXIMOS MARCOS</p>
            <ol class="platform-milestones">
              <li><strong>Fundação AWS</strong><span>Revisar templates, rede privada, segredos e imagem.</span></li>
              <li><strong>Dados operacionais</strong><span>Migrar PostgreSQL, conectar fontes e definir retenção.</span></li>
              <li><strong>Coleta agendada</strong><span>EventBridge e histórico das fontes federais em S3 e Postgres.</span></li>
              <li><strong>Operação de produção</strong><span>SSO, RBAC, TLS no ingresso, alertas e recuperação.</span></li>
            </ol>
            <p class="workspace-copy">O bucket S3 é provisionável; a exportação atual gera arquivos locais. SageMaker, Glue e streaming permanecem no roteiro.</p>
          </article>
        </div>`.__html;

      document.querySelector('#refresh-platform').onclick = () => Forge.show('platform');
    },
  });
})();
