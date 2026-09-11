/**
 * Operational workspaces: command centre, digital twin, maintenance queue,
 * mission readiness, design review, public context and the audit trail.
 *
 * Nothing here invents a number. Every figure on screen is either returned by
 * the API or computed from a value the API returned, and every decision the
 * operator triggers is recorded server-side before its result is drawn.
 */
const { html, api, kpi, sectionTitle, heading, toast, state } = Forge;
const { number, dateTime, timeOnly, signed, ago, toneClass } = Forge;

const changeTypes = {
  component: 'Substituição de componente',
  configuration: 'Alteração de configuração',
  load: 'Aumento de carga operacional',
};
const states = { CA: 'Califórnia', FL: 'Flórida', TX: 'Texas', WA: 'Washington', VA: 'Virgínia' };
const metricNames = { health: 'Saúde', vibration: 'Vibração', temperature: 'Temperatura' };

const overview = () => api(`/api/overview?dataset=${state.dataset}`);

/** Keeps the selected asset valid across inventory changes and reloads. */
function selectedAsset(assets) {
  return assets.find(asset => asset.id === state.assetId)
    || [...assets].sort((a, b) => b.risk - a.risk)[0];
}

const assetRow = asset => html`
  <button class="asset-row asset-pick" data-asset="${asset.id}" type="button">
    <i class="status-dot ${toneClass(asset.band)}"></i>
    <span>
      <span class="asset-name">${asset.name}</span>
      <span class="asset-id">${asset.id} · ${asset.type}</span>
    </span>
    <span class="risk-badge ${toneClass(asset.band)}">${asset.bandLabel} ${asset.risk}</span>
    <span class="asset-meta" title="${dateTime(asset.lastSeen)}">${ago(asset.lastSeen)}${asset.stale ? ' · sem dados recentes' : ''}</span>
    <span class="readiness-bar"><i style="width:${asset.health}%"></i></span>
  </button>`;

const contributionTable = asset => html`
  <table class="data-table compact">
    <thead><tr><th>Fator</th><th>Entrada</th><th>Peso</th><th>Pontos</th></tr></thead>
    <tbody>
      ${asset.contributions.map(term => html`
        <tr><td>${term.label}</td><td>${number(term.input)}</td><td>${number(term.weight, 2)}</td><td><strong>${number(term.points, 2)}</strong></td></tr>`)}
      <tr class="total"><td colspan="3">Risco do ativo</td><td><strong>${asset.risk}</strong></td></tr>
    </tbody>
  </table>`;

function bindAssetPicks() {
  document.querySelectorAll('.asset-pick').forEach(button => {
    button.onclick = () => { state.assetId = button.dataset.asset; Forge.navigate('twin'); };
  });
}

/* ---------------------------------------------------------- command centre */

Forge.register('overview', {
  kicker: 'CENTRO DE COMANDO',
  title: 'Visão operacional',
  async render({ stale }) {
    const data = await overview();
    if (stale()) return;
    const trend = data.trend.map(point => ({ value: point.readiness, caption: timeOnly(point.timestamp) }));
    const drift = trend.length > 1 ? Math.round((trend.at(-1).value - trend[0].value) * 10) / 10 : null;
    const window = data.coverage.windowHours;

    Forge.content().innerHTML = html`
      <section class="forge-overview">
        <div>
          <p class="eyebrow">PROMETHEUS / INTELLIGENCE PLATFORM</p>
          <h2>Conecte operação,<br>dados e inteligência.</h2>
          <p>Cada número desta tela é derivado do inventário e da telemetria — nenhum é ilustrativo.</p>
          <span class="risk-badge risk-medium">CENÁRIO OPERACIONAL SINTÉTICO</span>
        </div>
        <div class="explore-grid">
          ${[
            ['statistics', '01', 'Estatística', 'Distribuições e desvios'],
            ['data', '02', 'Engenharia de dados', 'Contratos e qualidade'],
            ['models', '03', 'Laboratório de IA', 'Modelos e experimentos'],
            ['platform', '04', 'Plataforma AWS', 'Arquitetura e execução'],
          ].map(([view, index, name, detail]) => html`
            <button class="workspace-link" data-goto="${view}" type="button">
              <span>${index} /</span><strong>${name} ↗</strong><small>${detail}</small>
            </button>`)}
        </div>
      </section>

      <div class="kpi-grid">
        ${kpi('PRONTIDÃO DA FROTA', `${number(data.readiness)}%`,
          `${signed(drift)} pt na janela de ${window}h · ponderada por criticidade`,
          data.readiness >= 80 ? 'good' : data.readiness >= 65 ? 'warn' : 'bad')}
        ${kpi('ATIVOS CRÍTICOS', String(data.bands.critical).padStart(2, '0'),
          `de ${data.total} ativos · ${data.bands.attention} em atenção`, data.bands.critical ? 'bad' : 'good')}
        ${kpi('MANUTENÇÕES PENDENTES', String(data.backlog.total).padStart(2, '0'),
          `${data.backlog.urgent} em faixa crítica`, data.backlog.urgent ? 'warn' : 'good')}
        ${kpi('COBERTURA DE TELEMETRIA', data.coverage.completeness === null ? '—' : `${number(data.coverage.completeness)}%`,
          `${data.coverage.observed} de ${data.coverage.expected} janelas horárias`,
          (data.coverage.completeness ?? 0) >= 95 ? 'good' : 'warn')}
      </div>

      <div class="dashboard-grid">
        <article class="card">
          ${sectionTitle('Ativos por prioridade', 'RISCO DECRESCENTE')}
          <div class="asset-list">${[...data.assets].sort((a, b) => b.risk - a.risk).map(assetRow)}</div>
        </article>
        <article class="card">
          ${sectionTitle('Sinais recentes', `ÚLTIMAS ${window}H`)}
          <div class="event-list">
            ${data.signals.length ? data.signals.map(signal => html`
              <div class="event">
                <time>${timeOnly(signal.timestamp)}</time>
                <strong>${metricNames[signal.metric]} fora da faixa — ${signal.assetId}</strong>
                <p>${number(signal.value)} contra baseline ${number(signal.baseline)} · ${number(signal.deviations)} desvios robustos.</p>
              </div>`) : html`<p class="empty-state">Nenhum desvio acima do limiar robusto nesta janela.</p>`}
          </div>
        </article>
      </div>

      <article class="card wide">
        ${sectionTitle(`Índice de prontidão · últimas ${trend.length} janelas horárias`, `MÉTODO: ${data.method.readiness.toUpperCase()}`)}
        ${Forge.lineChart(trend, { label: 'Índice de prontidão da frota' })}
      </article>`.__html;

    bindAssetPicks();
    document.querySelectorAll('[data-goto]').forEach(button => {
      button.onclick = () => Forge.navigate(button.dataset.goto);
    });
  },
});

/* ------------------------------------------------------------ digital twin */

Forge.register('twin', {
  kicker: 'DIGITAL TWIN',
  title: 'Estado dos ativos',
  async render({ stale }) {
    const data = await overview();
    if (stale()) return;
    const asset = selectedAsset(data.assets);
    if (!asset) { Forge.content().innerHTML = '<p class="empty-state">Inventário vazio.</p>'; return; }
    state.assetId = asset.id;

    Forge.content().innerHTML = html`
      <div class="module-header">
        <div>
          <h2>${asset.name}</h2>
          <p>${asset.id} · ${asset.type} · ${asset.state} · telemetria ${ago(asset.lastSeen)}</p>
        </div>
        <span class="risk-badge ${toneClass(asset.band)}">${asset.bandLabel} ${asset.risk}</span>
      </div>

      <div class="workspace-filters">
        <label for="twin-asset">Ativo
          <select id="twin-asset">
            ${data.assets.map(item => html`<option value="${item.id}" ${Forge.raw(item.id === asset.id ? 'selected' : '')}>${item.id} — ${item.name}</option>`)}
          </select>
        </label>
      </div>

      <div class="split">
        <article class="card">
          ${sectionTitle('Composição do risco', 'ARITMÉTICA VISÍVEL')}
          <div class="asset-detail">
            <div><div class="kpi-label">SAÚDE ESTRUTURAL</div><div class="detail-number">${asset.health}%</div></div>
            <div><div class="kpi-label">HORAS DE OPERAÇÃO</div><div class="detail-number">${number(asset.hours, 0)}h</div></div>
            <div><div class="kpi-label">CRITICIDADE</div><div class="detail-number">${asset.criticality}/100</div></div>
          </div>
          ${contributionTable(asset)}
          ${[['Vibração', asset.vibration], ['Temperatura', asset.temperature], ['Saúde estrutural', asset.health]].map(([name, value]) => html`
            <div class="metric-row">
              <header><span>${name}</span><b>${value}%</b></header>
              <div class="readiness-bar"><i style="width:${value}%"></i></div>
            </div>`)}
          <div class="reason"><b>Leitura do gêmeo:</b> ${data.method.risk}. A pontuação é reconstruível à mão a partir do registro do ativo e não substitui inspeção.</div>
        </article>

        <aside class="card">
          ${sectionTitle('Cenário de carga', 'SIMULAÇÃO AUDITADA')}
          <div class="scenario">
            <label for="load-range">Carga operacional · <output id="load-output">65</output>%
              <input id="load-range" type="range" min="20" max="100" step="5" value="65" />
            </label>
            <label for="horizon">Horizonte
              <select id="horizon">
                <option value="24">24 horas</option>
                <option value="72">72 horas</option>
                <option value="168">7 dias</option>
              </select>
            </label>
            <button class="button" id="run-scenario" type="button">Executar simulação</button>
          </div>
          <div class="impact" id="scenario-result">
            <div class="kpi-label">RISCO PROJETADO</div>
            <div class="impact-value">—</div>
            <div class="kpi-delta">Execute a simulação para projetar o risco sob carga sustentada.</div>
          </div>
        </aside>
      </div>`.__html;

    document.querySelector('#twin-asset').onchange = event => {
      state.assetId = event.target.value;
      Forge.show('twin');
    };
    const range = document.querySelector('#load-range');
    range.oninput = () => { document.querySelector('#load-output').textContent = range.value; };

    document.querySelector('#run-scenario').onclick = async event => {
      const button = event.currentTarget;
      const output = document.querySelector('#scenario-result');
      button.disabled = true;
      try {
        const result = await api('/api/decisions/scenario', {
          assetId: asset.id,
          load: Number(range.value),
          horizonHours: Number(document.querySelector('#horizon').value),
        });
        output.innerHTML = html`
          <div class="kpi-label">RISCO PROJETADO</div>
          <div class="impact-value ${{ critical: 'bad', attention: '', stable: 'good' }[result.band]}">${result.projectedRisk}</div>
          <div class="kpi-delta">${result.bandLabel} · carga ${result.load}% por ${result.horizonHours}h</div>
          <ul class="terms">
            ${result.terms.map((term, index) => html`
              <li><span>${term.label}</span><b>${index === 0 ? number(term.points, 2) : signed(term.points)}</b></li>`)}
          </ul>
          <p class="workspace-copy">${result.limitation}</p>`.__html;
        toast('Simulação registrada na trilha de auditoria.');
      } catch (error) {
        output.innerHTML = html`<p role="alert" class="warn">${error.message}</p>`.__html;
      } finally { button.disabled = false; }
    };
  },
});

/* -------------------------------------------------------- maintenance queue */

Forge.register('maintenance', {
  kicker: 'MAINTAINER',
  title: 'Manutenção inteligente',
  async render({ stale }) {
    const data = await overview();
    if (stale()) return;
    const queue = [...data.assets].sort((a, b) => b.risk - a.risk);
    const first = queue[0];

    Forge.content().innerHTML = html`
      <div class="module-header">
        <div>
          <h2>Fila de manutenção orientada por risco</h2>
          <p>Priorização que combina degradação, vibração, temperatura e criticidade operacional.</p>
        </div>
        <span class="kpi-label">${data.total} ATIVOS ANALISADOS · ${data.backlog.total} NA FILA</span>
      </div>

      <div class="split">
        <article class="card">
          ${sectionTitle('Prioridades recomendadas', 'EXPLICÁVEL')}
          ${queue.map(asset => html`
            <div class="priority">
              <div>
                <strong>${asset.name}</strong>
                <small>${asset.id} · ${asset.type} · saúde ${asset.health}% · ${asset.contributions.map(term => `${term.factor.slice(0, 4)} ${number(term.points, 1)}`).join(' + ')}</small>
              </div>
              <span class="risk-badge ${toneClass(asset.band)}">${asset.risk} pts</span>
            </div>`)}
        </article>

        <aside class="recommendation">
          <div class="kpi-label">AÇÃO IMEDIATA</div>
          <h3>Inspecionar ${first.id}</h3>
          <p>O risco de ${first.risk} é puxado por ${first.contributions.slice().sort((a, b) => b.points - a.points)[0].label.toLowerCase()},
             com vibração em ${first.vibration}% e temperatura em ${first.temperature}%.</p>
          <p><b>Recomendação:</b> reduzir carga, executar inspeção dirigida e reservar o conjunto de reposição compatível.</p>
          <label for="intervention-note">Observação da intervenção
            <input id="intervention-note" maxlength="200" placeholder="Ex.: inspeção do subsistema de propulsão" />
          </label>
          <button class="button secondary" id="schedule-action" type="button">Registrar intervenção</button>
          <p class="workspace-copy">O registro entra na trilha de auditoria como pendência para aprovação humana; nada é executado automaticamente.</p>
        </aside>
      </div>`.__html;

    document.querySelector('#schedule-action').onclick = async event => {
      const button = event.currentTarget;
      const note = document.querySelector('#intervention-note').value.trim();
      button.disabled = true;
      try {
        await api('/api/audit', {
          action: 'Intervenção pendente',
          detail: `${first.id} (risco ${first.risk}): ${note || 'inspeção dirigida recomendada'}`,
        });
        toast('Intervenção registrada para aprovação humana.');
      } catch (error) { toast(error.message); }
      finally { button.disabled = false; }
    };
  },
});

/* ------------------------------------------------------- mission readiness */

Forge.register('readiness', {
  kicker: 'MISSION READINESS',
  title: 'Prontidão operacional',
  async render({ stale }) {
    const data = await overview();
    if (stale()) return;
    const reserve = data.assets.filter(asset => asset.capable && asset.band === 'stable');

    Forge.content().innerHTML = html`
      <div class="module-header">
        <div>
          <h2>Prontidão operacional</h2>
          <p>Capacidade disponível, concentração de risco e consequência de uma indisponibilidade.</p>
        </div>
        <span class="kpi-label">${data.method.readiness.toUpperCase()}</span>
      </div>

      <div class="kpi-grid">
        ${kpi('CAPACIDADE DISPONÍVEL', `${data.capable}/${data.total}`, 'ativos com saúde igual ou acima de 70%', data.capable === data.total ? 'good' : 'warn')}
        ${kpi('ÍNDICE DE PRONTIDÃO', `${number(data.readiness)}%`, 'ponderado por criticidade operacional', data.readiness >= 80 ? 'good' : 'warn')}
        ${kpi('PIOR PERDA UNITÁRIA', data.worstCaseDrop === null ? '—' : `−${number(data.worstCaseDrop)} pt`,
          data.exposure[0] ? `se ${data.exposure[0].assetId} ficar indisponível` : 'sem exposição calculada', 'warn')}
        ${kpi('RESERVA OPERACIONAL', `${reserve.length}`, 'ativos aptos e em faixa estável', reserve.length ? 'good' : 'bad')}
      </div>

      <div class="split wide">
        <article class="card">
          ${sectionTitle('Concentração de risco', 'PONTOS ÚNICOS DE FALHA')}
          ${data.exposure.map(item => html`
            <div class="priority">
              <div>
                <strong>${item.assetName}</strong>
                <small>${item.assetId} · ${item.hasSubstitute ? 'reserva equivalente disponível' : 'sem reserva equivalente'}</small>
              </div>
              <span class="risk-badge ${item.hasSubstitute ? 'risk-medium' : 'risk-high'}">−${number(item.delta)} pt</span>
            </div>`)}
          <p class="workspace-copy">Queda no índice de prontidão se o ativo sair de operação, mantendo a capacidade exigida no denominador.</p>
        </article>

        <article class="card">
          ${sectionTitle('Simulador de impacto', 'DECISÃO ASSISTIDA')}
          <div class="scenario">
            <label for="outage-asset">Indisponibilizar temporariamente
              <select id="outage-asset">
                ${data.assets.map(asset => html`<option value="${asset.id}">${asset.id} — ${asset.name}</option>`)}
              </select>
            </label>
            <label for="outage-duration">Duração
              <select id="outage-duration">
                <option value="4">4 horas</option>
                <option value="12">12 horas</option>
                <option value="24">24 horas</option>
                <option value="72">72 horas</option>
              </select>
            </label>
            <button class="button" id="calculate-impact" type="button">Calcular impacto</button>
          </div>
          <div class="impact" id="impact-result">
            <div class="kpi-label">PRONTIDÃO PROJETADA</div>
            <div class="impact-value">—</div>
            <div class="kpi-delta">Selecione um cenário para avaliar a consequência.</div>
          </div>
        </article>
      </div>`.__html;

    document.querySelector('#calculate-impact').onclick = async event => {
      const button = event.currentTarget;
      const output = document.querySelector('#impact-result');
      button.disabled = true;
      try {
        const result = await api('/api/decisions/outage', {
          assetId: document.querySelector('#outage-asset').value,
          hours: Number(document.querySelector('#outage-duration').value),
        });
        output.innerHTML = html`
          <div class="kpi-label">PRONTIDÃO PROJETADA</div>
          <div class="impact-value">${number(result.projectedReadiness)}%</div>
          <div class="kpi-delta">${result.assetId} indisponível por ${result.hours}h · ${signed(-result.delta)} pt sobre ${number(result.baselineReadiness)}%</div>
          <p class="workspace-copy">${result.mitigation}</p>
          ${result.substitutes.length ? html`
            <ul class="terms">
              ${result.substitutes.map(item => html`<li><span>${item.id} — ${item.name}</span><b>saúde ${item.health}%</b></li>`)}
            </ul>` : ''}
          <p class="workspace-copy">${result.limitation}</p>`.__html;
        toast('Impacto registrado na trilha de auditoria.');
      } catch (error) {
        output.innerHTML = html`<p role="alert" class="warn">${error.message}</p>`.__html;
      } finally { button.disabled = false; }
    };
  },
});

/* ----------------------------------------------------------- design review */

Forge.register('review', {
  kicker: 'DESIGN REVIEW',
  title: 'Validação de alteração',
  async render({ stale }) {
    const data = await overview();
    if (stale()) return;

    Forge.content().innerHTML = html`
      <div class="module-header">
        <div>
          <h2>Revisão de alteração técnica</h2>
          <p>Triagem de impacto e rastreabilidade antes de uma mudança entrar em operação.</p>
        </div>
      </div>

      <div class="split">
        <article class="card">
          ${sectionTitle('Nova alteração', 'RASCUNHO')}
          <label for="review-asset">Ativo afetado
            <select id="review-asset">
              ${data.assets.map(asset => html`<option value="${asset.id}">${asset.id} — ${asset.name} · risco ${asset.risk}</option>`)}
            </select>
          </label>
          <label for="change-type">Tipo de alteração
            <select id="change-type">
              ${Object.entries(changeTypes).map(([value, name]) => html`<option value="${value}">${name}</option>`)}
            </select>
          </label>
          <label for="change-description">Descrição
            <input id="change-description" maxlength="280" placeholder="Ex.: substituir módulo de filtragem pela versão B" />
          </label>
          <button class="button" id="review-change" type="button">Analisar alteração</button>
          <p class="workspace-copy">A triagem combina o peso da classe de alteração com a faixa de risco atual do ativo.</p>
        </article>

        <aside class="card">
          ${sectionTitle('Resultado da revisão', 'HUMANO NO LOOP')}
          <div id="review-output">
            <p class="kpi-delta">Preencha a alteração e execute a análise. O resultado é uma recomendação, não uma autorização automática.</p>
          </div>
        </aside>
      </div>`.__html;

    document.querySelector('#review-change').onclick = async event => {
      const button = event.currentTarget;
      const output = document.querySelector('#review-output');
      button.disabled = true;
      try {
        const result = await api('/api/decisions/review', {
          assetId: document.querySelector('#review-asset').value,
          changeType: document.querySelector('#change-type').value,
          description: document.querySelector('#change-description').value,
        });
        const tone = { blocked: 'risk-high', controlled: 'risk-medium', acceptable: 'risk-low' }[result.verdict];
        output.innerHTML = html`
          <span class="risk-badge ${tone}">${result.verdictLabel}</span>
          <div class="review-result">
            <b>${result.assetId} · ${result.description || 'Alteração não detalhada'}</b>
            <p class="workspace-copy">${result.changeLabel} · exposição combinada ${result.exposure} de 6</p>
            ${result.checks.map(check => html`
              <div class="check ${check.status}">
                <i>${check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '×'}</i>
                <span>${check.text}</span>
              </div>`)}
            <p class="workspace-copy">${result.limitation}</p>
          </div>`.__html;
        toast('Revisão registrada na trilha de auditoria.');
      } catch (error) {
        output.innerHTML = html`<p role="alert" class="warn">${error.message}</p>`.__html;
      } finally { button.disabled = false; }
    };
  },
});

/* ----------------------------------------------------------- public context */

const severityTone = { warning: 'risk-high', watch: 'risk-medium', info: 'risk-low' };
const severityMark = { warning: '!', watch: '~', info: '·' };

Forge.register('context', {
  kicker: 'INTELIGÊNCIA EXTERNA',
  title: 'Contexto público',
  async render({ stale }) {
    const [data, catalogue] = await Promise.all([overview(), api('/api/context')]);
    if (stale()) return;
    const covered = [...new Set(data.assets.map(asset => asset.state))].sort();
    const stateOptions = () => covered.map(code => html`
      <option value="${code}">${states[code] || code} (${code}) · ${data.assets.filter(asset => asset.state === code).length} ativo(s)</option>`);
    const labels = Object.fromEntries(catalogue.providers.map(provider => [provider.id, provider]));

    Forge.content().innerHTML = html`
      <div class="module-header">
        <div>
          <h2>Contexto operacional público</h2>
          <p>Quatro fontes federais dos EUA, quatro horizontes — do envelope de operação agora à disrupção regional de semanas.</p>
        </div>
        <span class="kpi-label">SEM CHAVE DE API · ${catalogue.providers.length} FONTES</span>
      </div>

      <div class="dashboard-grid context-grid">
        <article class="card">
          ${sectionTitle('Envelope de operação', `${labels.airfield?.horizon || 'Agora'} · METAR`)}
          <p class="workspace-copy">Categoria de voo observada na estação de referência: VFR, MVFR, IFR ou LIFR.</p>
          <label for="airfield-station">Estação de referência
            <select id="airfield-station">
              ${covered.filter(code => catalogue.stations[code]).map(code => html`
                <option value="${catalogue.stations[code].station}">${catalogue.stations[code].station} — ${catalogue.stations[code].name} (${code})</option>`)}
            </select>
          </label>
          <button class="button" data-source="airfield" data-param="station" data-from="#airfield-station" type="button">Consultar observação</button>
          <div class="review-result" data-output="airfield">
            <p class="kpi-delta">Observação meteorológica de aeródromo do Aviation Weather Center (NOAA).</p>
          </div>
        </article>

        <article class="card">
          ${sectionTitle('Alertas meteorológicos ativos', `${labels.weather?.horizon || 'Horas'} · NOAA / NWS`)}
          <p class="workspace-copy">Avisos vigentes emitidos para o estado, com severidade declarada pela fonte.</p>
          <label for="weather-state">Estado dos EUA
            <select id="weather-state">${stateOptions()}</select>
          </label>
          <button class="button" data-source="weather" data-param="area" data-from="#weather-state" type="button">Consultar alertas ativos</button>
          <div class="review-result" data-output="weather">
            <p class="kpi-delta">Escolha um estado para consultar alertas ativos diretamente da NOAA/NWS.</p>
          </div>
        </article>

        <article class="card">
          ${sectionTitle('Declarações federais de desastre', `${labels.disasters?.horizon || 'Semanas'} · FEMA`)}
          <p class="workspace-copy">Incidentes declarados pelo governo federal, com áreas designadas e situação de encerramento.</p>
          <label for="disaster-state">Estado dos EUA
            <select id="disaster-state">${stateOptions()}</select>
          </label>
          <button class="button" data-source="disasters" data-param="area" data-from="#disaster-state" type="button">Consultar declarações</button>
          <div class="review-result" data-output="disasters">
            <p class="kpi-delta">Fonte OpenFEMA. Uma declaração aberta indica disrupção regional em curso.</p>
          </div>
        </article>

        <article class="card">
          ${sectionTitle('Atividade sísmica recente', `${labels.earthquakes?.horizon || 'Instantâneo'} · USGS`)}
          <p class="workspace-copy">Eventos de magnitude 4,5 ou superior registrados nas últimas 24 horas.</p>
          <button class="button" data-source="earthquakes" type="button">Consultar eventos M4.5+</button>
          <div class="review-result" data-output="earthquakes">
            <p class="kpi-delta">O feed é global; a correlação com um ativo exige posição real, ausente neste protótipo.</p>
          </div>
        </article>
      </div>

      <article class="card wide">
        ${sectionTitle('Regra de uso operacional', 'CONTROLE')}
        <div class="reason">${catalogue.policy} Um sinal externo pode <b>abrir uma revisão humana</b> e nada além disso. A associação entre ativo e localização neste protótipo é fictícia e grosseira; uma integração real exige posição autorizada, geofencing e auditoria. Toda consulta é registrada na trilha.</div>
        <dl class="facts">
          ${catalogue.providers.map(provider => html`
            <div><dt>${provider.label}</dt><dd>${provider.attribution} · horizonte: ${provider.horizon}</dd></div>`)}
        </dl>
      </article>`.__html;

    document.querySelectorAll('[data-source]').forEach(button => {
      button.onclick = () => loadContext(button, data.assets);
    });
  },
});

/** Runs one context provider and renders its normalised result. */
async function loadContext(button, assets) {
  const source = button.dataset.source;
  const output = document.querySelector(`[data-output="${source}"]`);
  const field = button.dataset.from ? document.querySelector(button.dataset.from) : null;
  const value = field ? field.value : '';
  const query = button.dataset.param && value ? `?${button.dataset.param}=${encodeURIComponent(value)}` : '';
  button.disabled = true;
  output.innerHTML = '<p class="kpi-delta">Consultando fonte federal…</p>';
  try {
    const result = await api(`/api/context/${source}${query}`);
    // Only state-scoped sources can be tied to the demonstration inventory.
    const scoped = button.dataset.param === 'area' ? assets.filter(asset => asset.state === value) : [];
    const elevated = result.items.filter(item => item.severity !== 'info').length;
    output.innerHTML = html`
      <p class="kpi-label">${result.count} REGISTRO(S) · ${result.scope}${result.open === undefined ? '' : ` · ${result.open} EM ABERTO`}</p>
      ${button.dataset.param === 'area' ? html`
        <p class="kpi-delta">Ativos no escopo: ${scoped.length
          ? scoped.map(asset => `${asset.id} (risco ${asset.risk})`).join(', ')
          : 'nenhum ativo simulado neste estado'}${elevated && scoped.length ? ' · revisão humana sugerida' : ''}.</p>` : ''}
      ${result.items.length ? result.items.map(item => html`
        <div class="check ${item.severity === 'warning' ? 'fail' : item.severity === 'watch' ? 'warn' : ''}">
          <i>${severityMark[item.severity]}</i>
          <span>
            <b>${item.title}</b> <span class="risk-badge ${severityTone[item.severity]}">${item.severity}</span>
            <br><small>${item.detail}</small>
            <br><small>${item.at ? dateTime(item.at) : 'sem horário publicado'}</small>
          </span>
        </div>`) : html`<p class="good">Nenhum registro retornado para este escopo.</p>`}
      <p class="workspace-copy">${result.attribution} · consultado em ${dateTime(result.fetchedAt)}</p>`.__html;
    await api('/api/audit', {
      action: `Contexto ${source}`,
      detail: `${result.scope}: ${result.count} registro(s); ${elevated} acima de informativo; ${scoped.length} ativos no escopo`,
    });
  } catch (error) {
    output.innerHTML = html`<p role="alert" class="warn">${error.message}</p>`.__html;
  } finally { button.disabled = false; }
}

/* -------------------------------------------------------------- audit trail */

Forge.register('audit', {
  kicker: 'RASTREABILIDADE',
  title: 'Trilha de auditoria',
  async render({ stale }) {
    const entries = await api('/api/audit');
    if (stale()) return;
    const sources = [...new Set(entries.map(entry => entry.source || 'console'))].sort();

    Forge.content().innerHTML = html`
      ${heading('05 / RASTREABILIDADE', 'O que foi decidido, por quem e sobre qual evidência.',
        'Toda simulação, revisão, intervenção e consulta externa é registrada no servidor antes de o resultado aparecer na tela.',
        'FORGE / AUDIT')}

      <div class="kpi-grid">
        ${kpi('REGISTROS', entries.length, 'janela retida de até 500 eventos')}
        ${kpi('ORIGENS', sources.length, sources.join(' · ') || 'nenhuma')}
        ${kpi('MAIS RECENTE', entries[0] ? timeOnly(entries[0].at) : '—', entries[0] ? dateTime(entries[0].at) : 'sem registros ainda')}
        ${kpi('DECISÕES ASSISTIDAS', entries.filter(entry => /Simulação|Impacto|Revisão/i.test(entry.action)).length, 'simulações, impactos e revisões')}
      </div>

      <article class="card wide">
        ${sectionTitle('Eventos registrados', 'SERVIDOR · ORDEM DECRESCENTE')}
        <div class="workspace-filters">
          <label for="audit-filter">Filtrar por ação ou detalhe
            <input id="audit-filter" placeholder="Ex.: AR-081" autocomplete="off" />
          </label>
          <button class="button secondary" id="export-audit" type="button">Exportar trilha</button>
        </div>
        ${entries.length ? html`
          <div class="table-scroll">
            <table class="data-table" id="audit-table">
              <thead><tr><th>Quando</th><th>Ação</th><th>Detalhe</th><th>Origem</th></tr></thead>
              <tbody>
                ${entries.map(entry => html`
                  <tr data-search="${`${entry.action} ${entry.detail}`.toLowerCase()}">
                    <td><strong>${timeOnly(entry.at)}</strong><small>${dateTime(entry.at)}</small></td>
                    <td>${entry.action}</td>
                    <td class="detail-cell">${entry.detail}</td>
                    <td><span class="risk-badge ${entry.source === 'bedrock' ? 'risk-medium' : 'risk-low'}">${entry.source || 'console'}</span></td>
                  </tr>`)}
              </tbody>
            </table>
          </div>`
        : html`<p class="empty-state">Nenhum registro ainda. Execute uma simulação, um impacto ou uma revisão para criar o primeiro.</p>`}
        <p class="workspace-copy">O armazenamento local mantém os 500 eventos mais recentes; o modo PostgreSQL preserva o histórico. Imutabilidade criptográfica, retenção e exportação controlada são requisitos de produção ainda não implementados.</p>
      </article>`.__html;

    const filter = document.querySelector('#audit-filter');
    if (filter) {
      filter.oninput = () => {
        const term = filter.value.trim().toLowerCase();
        document.querySelectorAll('#audit-table tbody tr').forEach(row => {
          row.hidden = Boolean(term) && !row.dataset.search.includes(term);
        });
      };
    }
    document.querySelector('#export-audit').onclick = () => Forge.download(entries, 'forge-audit.json');
  },
});

/* ------------------------------------------------------------------- shell */

function startClock() {
  const element = document.querySelector('#clock');
  const format = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const tick = () => { element.textContent = format.format(new Date()); };
  tick();
  setInterval(tick, 1000);
}

function bindShell() {
  document.querySelectorAll('.nav-item').forEach(button => {
    button.onclick = () => Forge.navigate(button.dataset.view);
  });
  document.querySelector('#refresh-button').onclick = () => {
    Forge.show(state.view);
    toast('Dados recarregados a partir da plataforma.');
  };
  document.querySelector('#new-review-button').onclick = () => Forge.navigate('review');

  const dialog = document.querySelector('#access-dialog');
  document.querySelector('#access-button').onclick = () => dialog.showModal();
  document.querySelector('#close-access').onclick = () => dialog.close();
  document.querySelector('#access-form').onsubmit = event => {
    event.preventDefault();
    const field = document.querySelector('#api-token');
    Forge.setToken(field.value.trim());
    field.value = '';
    dialog.close();
    toast('Chave aplicada nesta aba.');
  };
  Forge.onTokenChange(() => Forge.show(state.view));
}

bindShell();
startClock();
Forge.show(new URLSearchParams(window.location.search).get('view') || 'overview');
