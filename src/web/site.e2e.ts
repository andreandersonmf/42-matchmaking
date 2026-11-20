import { expect, test } from '@playwright/test';
import type { Overview } from '../core/types';

test('overview loads data and the queue link preserves the route', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('starts on the');
  await expect(page.locator('.demo-chip')).toHaveText('Demo');
  await expect(page.locator('.overview-stats')).toContainText('36');
  await page.getByRole('link', { name: 'Follow the queue' }).click();
  await expect(page.locator('#queue')).toBeInViewport();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('starts on the');
  expect(page.url()).not.toContain('#queue');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'artifacts/site-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('ranking paginates and filters by position, name and rank', async ({ page }) => {
  await page.goto('/#/ranking');
  await expect(page.locator('tbody tr')).toHaveCount(10);
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator('.pagination-context')).toContainText('Page 2');
  await page.getByLabel('Filter by position', { exact: true }).selectOption('setter');
  await expect(page).not.toHaveURL(/page=2/);
  await expect(page.locator('tbody tr .player-meta').first()).toContainText('Setter');
  for (const text of await page.locator('tbody tr .player-meta').allTextContents()) expect(text).toContain('Setter');
  const panel = page.locator('.ranking-panel');
  await panel.getByLabel('Search player').fill('yuzuki');
  await panel.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText('yuzuki');
  await page.getByLabel('Filter by rank', { exact: true }).selectOption('Bronze');
  await expect(page.getByRole('heading', { name: 'No players found' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(10);
});

test('global search opens ranking and profile has real history', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Search player', { exact: true }).fill('kaizen');
  await page.getByRole('button', { name: 'Search the ranking' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('link', { name: 'View kaizen_42 profile', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('kaizen_42');
  await expect(page.locator('.profile-rank')).toContainText('Diamond IV');
  await expect(page.locator('.history-table tbody tr')).toHaveCount(10);
  await expect(page.getByRole('group', { name: /Elo progression/ })).toBeVisible();
  await page.getByRole('link', { name: /^View match/ }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Match');
  await expect(page.locator('.team-roster li')).toHaveCount(12);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('kaizen_42');
});

test('matches filter status and mode and show complete teams', async ({ page }) => {
  await page.goto('/#/partidas');
  await page.getByRole('link', { name: 'Active', exact: true }).click();
  await expect(page.locator('.match-card')).toHaveCount(1);
  await expect(page.locator('.match-card')).toContainText('Live');
  await page.locator('.match-card').click();
  await expect(page.locator('.team-roster li')).toHaveCount(12);
  await expect(page.locator('.roster-footer')).toHaveCount(2);
  await page.getByRole('link', { name: 'All matches', exact: true }).click();
  await page.getByRole('link', { name: 'History', exact: true }).click();
  await page.getByLabel('Filter match mode', { exact: true }).selectOption('captains');
  await expect(page.locator('.match-card')).toHaveCount(10);
  await expect(page.locator('.list-meta')).toContainText('10 matches');
  for (const text of await page.locator('.match-card').allTextContents()) expect(text).toContain('Captains');
  await page.locator('.match-card').first().click();
  await expect(page.locator('.mvp-banner')).toBeVisible();
  await expect(page.locator('.team-roster .elo-delta')).toHaveCount(12);
});

test('rules, ranks and Discord notice work without a configured invite', async ({ page }) => {
  await page.goto('/#/regras');
  await expect(page.locator('.rank-tier')).toHaveCount(9);
  await page.getByRole('button', { name: 'Explore the ranks' }).click();
  await expect(page.locator('#rank-system')).toBeInViewport();
  await page.locator('.rank-thresholds summary').click();
  await expect(page.locator('.rank-thresholds')).toContainText('Silver III');
  await page.goto('/#/vip');
  await expect(page.locator('.vip-plan')).toHaveCount(2);
  await expect(page.locator('.vip-plans')).toContainText('+10');
  await expect(page.locator('.vip-plans')).toContainText('+15');
  await page.getByRole('button', { name: 'Get to know VIP+', exact: true }).click();
  await expect(page.locator('.discord-modal')).toBeVisible();
  await expect(page.locator('.discord-modal')).toContainText('not configured yet');
  await page.keyboard.press('Escape');
  await expect(page.locator('.discord-modal')).not.toBeVisible();
});

test('unknown route and missing profile show recovery', async ({ page }) => {
  await page.goto('/#/desconhecida');
  await expect(page.getByRole('heading', { name: 'That play went out of bounds' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to start' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('starts on the');
  await page.goto('/#/perfil/999999');
  await expect(page.getByRole('alert')).toContainText('This record was not found');
});

test('network failure shows retry and recovers without reloading the page', async ({ page }) => {
  let fail = true;
  await page.route('**/api/overview', route => fail ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue());
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Could not update');
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('starts on the');
});

test('empty real environment shows zeros, not demo data', async ({ page, request }) => {
  const response = await request.get('/api/overview');
  const overview = await response.json() as Overview;
  await page.route('**/api/overview', route => route.fulfill({ json: {
    ...overview, config: { ...overview.config, demo: false, configured: false },
    stats: { players: 0, completedMatches: 0, activeMatches: 0, queued: 0 },
    queue: { players: [], spikers: 0, setters: 0, ready: false },
    topPlayers: [], activeMatches: [], recentMatches: [],
  } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'The next name could be yours' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The court is ready' })).toBeVisible();
  await expect(page.locator('.demo-chip')).toHaveCount(0);
  await expect(page.locator('.overview-stats .stat-card > strong').first()).toHaveText('0');
});

test('language switcher switches English, Portuguese and Spanish and persists', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('starts on the');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const switcher = page.locator('.lang-switcher');
  await switcher.getByRole('button', { name: 'Português' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('começa em');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt');
  await switcher.getByRole('button', { name: 'Español' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('empieza en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await switcher.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('starts on the');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('starts on the');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('mobile: menu, search and pages without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('starts on the');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'artifacts/site-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const menu = page.getByRole('dialog', { name: 'Navigation' });
  await expect(menu).toBeVisible();
  await menu.getByRole('link', { name: 'Ranking', exact: true }).click();
  await expect(menu).not.toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(10);
  for (const path of ['ranking', 'partidas', 'regras', 'vip', 'perfil/910000000000000000', 'partida/31']) {
    await page.goto(`/#/${path}`);
    await expect(page.locator('h1')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path).toBe(true);
  }
});
