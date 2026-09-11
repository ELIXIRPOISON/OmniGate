/**
 * Opens the dashboard in a real Chromium window, signed in, and leaves it there to drive by hand.
 *
 *   pnpm dashboard:open            # light theme
 *   pnpm dashboard:open -- --dark  # dark theme
 *
 * Requires the gateway (docker compose up -d) and the dashboard dev server (pnpm dev:dashboard).
 * Close the window, or press Ctrl+C here, to finish.
 */
import { chromium } from 'playwright';

const args = new Set(process.argv.slice(2));
const dark = args.has('--dark');
const url = process.env.DASHBOARD_URL ?? 'http://localhost:5173';
const email = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const password = process.env.ADMIN_PASSWORD ?? 'admin';

const browser = await chromium.launch({
  headless: false,
  args: ['--window-size=1560,1000', '--window-position=60,40'],
});
const context = await browser.newContext({ viewport: null, colorScheme: dark ? 'dark' : 'light' });
const page = await context.newPage();

page.on('console', (m) => {
  if (m.type() === 'error') console.error('[page error]', m.text());
});

console.log(`opening ${url} …`);
await page.goto(url, { waitUntil: 'domcontentloaded' });

// Sign in only if the login form is showing; a restored session skips straight through.
const emailField = page.locator('#email');
if (await emailField.isVisible().catch(() => false)) {
  await emailField.fill(email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
}

await page.waitForSelector('h1', { timeout: 20_000 });
if (dark) {
  await page.locator('button[aria-label="Dark"]:visible').first().click();
}

console.log('');
console.log('  Signed in. The window is yours - click around.');
console.log('    Overview   traffic, latency, refusals, top routes and recent anomalies');
console.log('    Logs       the supplied filter bar drives the query; click a row for detail');
console.log('    Anomalies  click a row for the review drawer');
console.log('    Theme      the three-state toggle sits top right');
console.log('');
console.log('  Close the browser window to exit.');

// Hold the process open until the window is closed.
await new Promise((resolve) => {
  browser.on('disconnected', resolve);
  page.on('close', resolve);
  process.on('SIGINT', resolve);
});
await browser.close().catch(() => undefined);
console.log('browser closed');
