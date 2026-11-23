import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preview } from 'astro';
import { chromium, type Page } from 'playwright-core';

async function assertAlignedEdges(page: Page) {
  const edges = await page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    return {
      header: [rect('.top .logo').left, rect('.top .gh').right],
      hero: [rect('.hero h1').left, rect('.team-demo').right],
      format: [rect('#format h2').left, rect('#format .panel').right],
    };
  });
  for (const section of ['hero', 'format'] as const) {
    const [left, right] = edges[section];
    assert.ok(Math.abs(left - edges.header[0]) <= 0.5, `${section} left edge ${left}, header ${edges.header[0]}`);
    assert.ok(Math.abs(right - edges.header[1]) <= 0.5, `${section} right edge ${right}, header ${edges.header[1]}`);
  }
}

test('the first screen shows the Spawnfile and ends where Format begins', async (t) => {
  const server = await preview({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
  t.after(() => server.stop());
  const origin = `http://127.0.0.1:${server.port}`;
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const [width, height, single] of [
    [320, 320, true], [390, 664, true], [844, 390, true], [744, 1133, true],
    [768, 1024, false], [1024, 768, false], [1440, 800, false], [1440, 896, false], [2560, 1440, false],
  ] as const) {
    await t.test(`${width} x ${height}`, async () => {
      const page = await browser.newPage({ viewport: { width, height }, javaScriptEnabled: !single, hasTouch: single });
      try {
        await page.route((url) => url.origin !== origin, (route) => route.abort());
        await page.goto(origin);
        await page.evaluate(() => document.fonts.ready);
        const source = page.locator('.demo-file pre');
        const docker = page.locator('.demo-docker');
        assert.ok(await source.isVisible(), 'the authored source is visible on first load');
        assert.ok(await page.locator('.source-line[data-peer="coordinator"]').isVisible(), 'the excerpt includes a member reference');
        const frame = await page.locator('.team-demo').boundingBox();
        assert.ok(frame && frame.y >= 0 && frame.y + frame.height <= height + 1, 'the whole example fits');
        await assertAlignedEdges(page);
        const format = await page.locator('#format').boundingBox();
        assert.ok(format && Math.abs(format.y - height) <= 1, 'Format begins at the fold');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.equal(await page.locator('.example-views').isVisible(), single);
        if (single) {
          const fileMode = page.getByRole('radio', { name: 'Spawnfile', exact: true });
          assert.ok(await fileMode.isChecked());
          assert.equal(await docker.isVisible(), false);
          await page.locator('label[for="example-team-mode"]').tap();
          assert.equal(await source.isVisible(), false);
          assert.ok(await docker.isVisible());
          assert.equal(await docker.locator('.demo-role a:visible').count(), 5);
          await page.keyboard.press('ArrowLeft');
          assert.ok(await fileMode.isChecked());
          assert.ok(await source.isVisible());
        } else {
          const left = await source.boundingBox();
          const right = await docker.boundingBox();
          assert.ok(left && right && right.x >= left.x + left.width - 1, 'Docker sits beside the source');
          await page.locator('.source-line[data-peer="scout observer"]').focus();
          assert.equal(await docker.locator('.demo-role.demo-highlight').count(), 2, 'the field reference highlights its two agents');
          await docker.locator('summary').click();
          await docker.getByRole('button', { name: 'Replay the example startup' }).click();
          assert.equal(await docker.locator('.demo-role a:visible').count(), 5);
        }
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '200%';
          window.scrollTo({ top: document.getElementById('format')!.offsetTop, behavior: 'instant' });
        });
        await assertAlignedEdges(page);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'enlarged text fits horizontally');
      } finally {
        await page.close();
      }
    });
  }
});
