import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import sharp from 'sharp';

const source = new URL('../public/illustrations/spawnfile-hero.svg', import.meta.url);
const target = new URL('spawnfile-hero.gif', source);
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ reducedMotion: 'no-preference' });
  await page.goto(source.href);
  const size = await page.locator('svg').evaluate((svg) => {
    const { width, height } = (svg as SVGSVGElement).viewBox.baseVal;
    return { width, height };
  });
  await page.setViewportSize(size);
  const times = await page.locator('.scope-team').evaluate((group) => {
    const effect = group.getAnimations()[0].effect as KeyframeEffect;
    const duration = Number(effect.getComputedTiming().duration);
    return effect.getKeyframes().map((keyframe) => keyframe.computedOffset * duration);
  });
  const delays = times.slice(1).map((time, i) => time - times[i]);
  const frames: Buffer[] = [];
  for (const [i, delay] of delays.entries()) {
    await page.evaluate((time) => {
      for (const animation of document.getAnimations()) {
        animation.pause();
        animation.currentTime = time;
      }
    }, times[i] + delay / 2);
    frames.push(await page.screenshot({ omitBackground: true }));
  }
  await sharp(frames, { join: { animated: true } })
    .gif({ delay: delays, loop: 0, dither: 0 })
    .toFile(fileURLToPath(target));
} finally {
  await browser.close();
}
