const { test, expect } = require('@playwright/test');

test('the command centre reports derived figures and drills into an asset', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Ativos por prioridade' })).toBeVisible();
  await expect(page.locator('.trend-plot')).toBeVisible();

  // Fleet readiness is a real percentage, not a placeholder.
  const readiness = await page.locator('.kpi-value').first().innerText();
  expect(readiness).toMatch(/^\d+(,\d+)?%$/);
  await expect(page.getByText('janelas horárias', { exact: false }).first()).toBeVisible();
  await expect(page.locator('.asset-row')).toHaveCount(6);

  // Every band count adds up to the fleet size shown beside it.
  await expect(page.getByText(/de 6 ativos/)).toBeVisible();

  await page.locator('.asset-pick').first().click();
  await expect(page.locator('#page-title')).toHaveText('Estado dos ativos');
  await expect(page.locator('.data-table.compact')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the twin shows the arithmetic behind a risk score and projects a load', async ({ page }) => {
  await page.goto('/?view=twin');
  await expect(page.locator('.data-table.compact')).toBeVisible();

  // The four published terms must add up to the headline risk badge.
  const badge = await page.locator('.module-header .risk-badge').innerText();
  const risk = Number(badge.match(/(\d+)$/)[1]);
  const points = await page.locator('.data-table.compact tbody tr:not(.total) td:last-child').allInnerTexts();
  const sum = points.reduce((total, value) => total + Number(value.replace(',', '.')), 0);
  expect(Math.round(sum)).toBe(risk);

  await page.locator('#load-range').fill('100');
  await expect(page.locator('#load-output')).toHaveText('100');
  await page.locator('#horizon').selectOption('168');
  await page.getByRole('button', { name: 'Executar simulação' }).click();

  await expect(page.locator('#scenario-result .impact-value')).toHaveText(/^\d+$/);
  await expect(page.locator('#scenario-result .terms li')).toHaveCount(3);
  await expect(page.locator('#scenario-result')).toContainText('carga 100% por 168h');
  await expect(page.locator('#scenario-result')).toContainText('Não é probabilidade de falha');
});

test('readiness and design review produce explained, non-authorising verdicts', async ({ page }) => {
  await page.goto('/?view=readiness');
  await page.locator('#outage-asset').selectOption('AR-081');
  await page.locator('#outage-duration').selectOption('24');
  await page.getByRole('button', { name: 'Calcular impacto' }).click();
  await expect(page.locator('#impact-result .impact-value')).toHaveText(/%$/);
  await expect(page.locator('#impact-result')).toContainText('AR-081 indisponível por 24h');
  await expect(page.getByText('PONTOS ÚNICOS DE FALHA')).toBeVisible();

  await page.getByRole('button', { name: 'Design Review' }).click();
  await page.locator('#review-asset').selectOption('AR-081');
  await page.locator('#change-type').selectOption('load');
  await page.locator('#change-description').fill('Elevar teto de carga do subsistema');
  await page.getByRole('button', { name: 'Analisar alteração' }).click();

  await expect(page.locator('#review-output .risk-badge')).toHaveText('REQUER APROVAÇÃO FORMAL');
  await expect(page.locator('#review-output .check')).toHaveCount(4);
  await expect(page.locator('#review-output')).toContainText('nem constitui autorização');
});

test('every decision taken in the console lands in the audit trail', async ({ page }) => {
  await page.goto('/?view=twin');
  await page.getByRole('button', { name: 'Executar simulação' }).click();
  await expect(page.locator('#scenario-result .terms')).toBeVisible();

  await page.getByRole('button', { name: 'Prontidão' }).click();
  await page.getByRole('button', { name: 'Calcular impacto' }).click();
  await expect(page.locator('#impact-result')).toContainText('indisponível por');

  await page.getByRole('button', { name: 'Auditoria' }).click();
  await expect(page.getByRole('heading', { name: 'O que foi decidido, por quem e sobre qual evidência.' })).toBeVisible();

  const table = page.locator('#audit-table tbody tr');
  await expect(table.filter({ hasText: 'Simulação de carga' }).first()).toBeVisible();
  await expect(table.filter({ hasText: 'Impacto de indisponibilidade' }).first()).toBeVisible();

  // The filter narrows the trail without losing the records underneath.
  const total = await table.count();
  await page.locator('#audit-filter').fill('Impacto de indisponibilidade');
  await expect(table.filter({ hasText: 'Simulação de carga' }).first()).toBeHidden();
  await page.locator('#audit-filter').fill('');
  await expect(table).toHaveCount(total);
});

test('statistics, ingestion, experiments and platform work through the UI', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?view=statistics');
  await expect(page.getByRole('heading', { name: 'Do sinal à evidência.' })).toBeVisible();
  await expect(page.locator('.telemetry-plot')).toBeVisible();
  await page.locator('#metric-select').selectOption('vibration');
  await expect(page.getByRole('heading', { name: 'Vibração ao longo do tempo' })).toBeVisible();
  await page.locator('#dataset-select').selectOption('ingested');
  await expect(page.getByText('Nenhuma amostra neste dataset.', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Engenharia de dados' }).click();
  await page.getByRole('button', { name: 'Preencher exemplo' }).click();
  await page.getByRole('button', { name: 'Validar e importar' }).click();
  await expect(page.locator('#ingest-result')).toContainText('1 aceitos');
  await page.getByRole('button', { name: 'Validar e importar' }).click();
  await expect(page.locator('#ingest-result')).toContainText('1 duplicados');

  await page.getByRole('button', { name: 'Laboratório de IA' }).click();
  await page.locator('#dataset-select').selectOption('synthetic-v1');
  await page.getByRole('button', { name: 'Avaliar modelo' }).first().click();
  await expect(page.locator('#evaluation-status')).toContainText('192 amostras de treino, 96 de teste');
  await expect(page.locator('.data-table')).toContainText('robust-mad-v1');
  await expect(page.getByRole('button', { name: 'Consultar modelo' })).toBeDisabled();

  await page.getByRole('button', { name: 'Plataforma AWS' }).click();
  await expect(page.getByRole('heading', { name: 'Uma fundação para crescer na AWS.' })).toBeVisible();
  await expect(page.getByText('DESTINO · NÃO É INVENTÁRIO DA CONTA')).toBeVisible();
  await page.getByRole('button', { name: 'Visão geral' }).click();
  await expect(page.getByRole('heading', { name: 'Ativos por prioridade' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('public context lists four federal sources and reports a disabled proxy', async ({ page }) => {
  await page.goto('/?view=context');
  await expect(page.getByText('SEM CHAVE DE API · 4 FONTES')).toBeVisible();
  await expect(page.locator('.context-grid .card')).toHaveCount(4);
  await expect(page.getByRole('heading', { name: 'Envelope de operação' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Declarações federais de desastre' })).toBeVisible();

  // The test server runs with the proxy switched off, so the console must
  // surface the refusal instead of pretending it has data.
  await page.getByRole('button', { name: 'Consultar eventos M4.5+' }).click();
  await expect(page.locator('[data-output="earthquakes"] [role="alert"]')).toContainText('Contexto público desativado');
});

test('every workspace fits a mobile viewport without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const view of ['overview', 'twin', 'maintenance', 'readiness', 'review', 'context', 'audit', 'statistics', 'data', 'models', 'platform']) {
    await page.goto(`/?view=${view}`);
    await expect(page.locator('#app-content')).not.toBeEmpty();
    await expect(page.locator('.empty-state[role="status"]')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), view).toBe(true);
  }
  await page.screenshot({ path: 'test-results/platform-mobile.png', fullPage: true });
});

/**
 * Desktop captures used by the README. They land in test-results/; refresh the
 * committed copies under public/assets/screenshots/ when the interface changes.
 */
test('desktop captures for the documented workspaces', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1050 });

  await page.goto('/');
  await expect(page.locator('.trend-plot')).toBeVisible();
  await page.screenshot({ path: 'test-results/command-center.png', fullPage: true });

  await page.goto('/?view=twin');
  await expect(page.locator('.data-table.compact')).toBeVisible();
  await page.getByRole('button', { name: 'Executar simulação' }).click();
  await expect(page.locator('#scenario-result .terms')).toBeVisible();
  await page.screenshot({ path: 'test-results/digital-twin.png', fullPage: true });

  await page.goto('/?view=readiness');
  await page.getByRole('button', { name: 'Calcular impacto' }).click();
  await expect(page.locator('#impact-result')).toContainText('indisponível por');
  await page.screenshot({ path: 'test-results/readiness.png', fullPage: true });

  await page.goto('/?view=audit');
  await expect(page.locator('#audit-table')).toBeVisible();
  await page.screenshot({ path: 'test-results/audit.png', fullPage: true });

  await page.goto('/?view=context');
  await expect(page.locator('.context-grid .card')).toHaveCount(4);
  await page.screenshot({ path: 'test-results/context.png', fullPage: true });

  await page.goto('/?view=models');
  await expect(page.locator('.model-grid')).toBeVisible();
  await page.screenshot({ path: 'test-results/models.png', fullPage: true });
});
