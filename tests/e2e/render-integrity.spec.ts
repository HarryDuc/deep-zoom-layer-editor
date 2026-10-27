import { expect, test } from '@playwright/test';
import { ensureFixtureImage, uploadAndOpenImage, createLayer, selectTool, clickCanvas, dragCanvas } from './support';

/**
 * Guards the regression where a freshly drawn (not yet persisted) object
 * rendered with `undefined` numeric style values, which React turns into `NaN`
 * SVG attributes and which produced invisible, non-interactive shapes.
 */
test('newly drawn objects render complete attributes and no NaN', async ({ page, request }) => {
  const consoleProblems: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error' && /NaN|Received NaN/.test(text)) {
      consoleProblems.push(text);
    }
  });

  const fixture = await ensureFixtureImage(512, 512);
  const imageId = await uploadAndOpenImage(page, fixture, 'Ảnh kiểm thử NaN');

  try {
    await createLayer(page, 'Lớp NaN');

    // Point: radius/strokeWidth used to be undefined before the first save.
    await selectTool(page, 'point');
    await clickCanvas(page, 0.4, 0.4);
    const pointCircle = page.locator('[data-testid^="object-point-"] circle').last();
    for (const attribute of ['r', 'stroke-width']) {
      const value = await pointCircle.getAttribute(attribute);
      expect(value, `point circle ${attribute}`).not.toBeNull();
      expect(Number(value), `point circle ${attribute}`).toBeGreaterThan(0);
    }

    // Rectangle: stroke width / opacities must be real numbers too.
    await selectTool(page, 'rectangle');
    await dragCanvas(page, { fx: 0.55, fy: 0.55 }, { fx: 0.8, fy: 0.8 });
    const rect = page.locator('[data-testid^="object-rectangle-"]').last();
    for (const attribute of ['width', 'height', 'stroke-width', 'fill-opacity', 'stroke-opacity']) {
      const value = await rect.getAttribute(attribute);
      expect(value, `rectangle ${attribute}`).not.toBeNull();
      expect(Number(value), `rectangle ${attribute}`).not.toBeNaN();
    }

    // Label: font size must be a positive number of pixels.
    await selectTool(page, 'label');
    await clickCanvas(page, 0.3, 0.7);
    const labelText = page.getByTestId('label-text').last();
    expect(Number(await labelText.getAttribute('font-size'))).toBeGreaterThan(0);

    expect(consoleProblems).toEqual([]);
  } finally {
    await request.delete(`http://localhost:${process.env.E2E_API_PORT ?? '3101'}/api/v1/images/${imageId}`);
  }
});
