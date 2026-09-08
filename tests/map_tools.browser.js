// With a local map open: playwright-cli run-code --filename tests/map_tools.browser.js
async (page) => {
  const origin = await page.evaluate(() => location.origin);
  const errors = [], passed = [];
  page.on('pageerror', error => errors.push(error.message));
  const check = (value, message) => { if (!value) throw new Error(message); };
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => { window.__PROJECT_ROGUE_TEST_HOOKS__ = {}; });
  await page.goto(origin + '/');
  await page.waitForFunction(() => window.__PROJECT_ROGUE_TEST_HOOKS__?.api && !document.querySelector('#monsterLevelMin').disabled);
  await page.evaluate(() => { window.toolsTestMap = window.__PROJECT_ROGUE_TEST_HOOKS__.api.groups.localeLabelsFG._map; });
  await page.locator('.panel-layers > summary').click();
  await page.locator('.panel-tools > summary').click();
  check(await page.locator('#measureSmart').isChecked(), 'Smart Measure defaults on');
  check(await page.locator('.panel-tools .tool-title').allTextContents().then(titles => JSON.stringify(titles) === JSON.stringify(['Measure', 'Elite Zones', 'Crim Respawn'])), 'Map tools contains only the three supported tools');
  await page.locator('#measureSmart').uncheck(); // Exercise manual measurement explicitly.
  const setView = (x, y, zoom = 1) => page.evaluate(({ x, y, zoom }) => {
    window.toolsTestMap.setView([4096 - y, x], zoom, { animate: false });
  }, { x, y, zoom });
  const pointPixel = (x, y) => page.evaluate(({ x, y }) => {
    const map = window.toolsTestMap, p = map.latLngToContainerPoint([4096 - y, x]), r = map.getContainer().getBoundingClientRect();
    return { x: p.x + r.left, y: p.y + r.top };
  }, { x, y });
  const clickPoint = async (x, y) => {
    const p = await pointPixel(x, y);
    await page.mouse.click(p.x, p.y);
  };
  const state = () => page.evaluate(() => ({
    stats: document.querySelector('#measureStats').textContent,
    active: ['btnMeasure', 'btnEliteShow', 'btnCrimRespawn'].filter(id => document.getElementById(id).getAttribute('aria-pressed') === 'true'),
    points: document.querySelectorAll('.vertex').length,
    elitePins: document.querySelectorAll('.elite-position-pin').length,
    eliteRows: document.querySelector('#elitePositions').textContent,
    respawnPoints: document.querySelectorAll('.respawn-point').length,
    floor: document.querySelector('#btnFloorUnderground').getAttribute('aria-pressed') === 'true' ? 'underground' : 'overworld',
    doubleClickZoom: window.toolsTestMap.doubleClickZoom.enabled(),
    shapes: Object.values(window.toolsTestMap._layers).filter(layer => layer.getLatLngs && ['elite', 'routes'].includes(layer.options?.pane)).map(layer => ({
      pane: layer.options.pane, points: layer.getLatLngs(), bounds: layer.getBounds(), dash: layer.options.dashArray
    }))
  }));

  await setView(1000, 2000);
  await page.locator('#btnMeasure').click();
  await clickPoint(1000, 2000); await clickPoint(1010, 2010);
  let current = await state();
  check(current.stats === '10 tiles · Estimated travel time: 2.0s' && current.points === 2, 'Manual diagonal measurement');
  check(await page.locator('#btnMeasure').textContent() === 'Finish', 'Measure must offer Finish');
  await page.locator('#btnMeasureUndo').click();
  check((await state()).points === 1 && (await state()).stats.startsWith('0 tiles'), 'Undo last point');
  await clickPoint(1020, 2010);
  await page.getByRole('button', { name: 'Underground', exact: true }).click();
  current = await state();
  check(current.active.length === 0 && current.points === 0 && current.doubleClickZoom, 'Floor switch finishes measurement and hides the outgoing route');
  await setView(5500, 2000); await clickPoint(5500, 2000);
  check((await state()).points === 0, 'Floor change must not append a cross-floor segment');
  await page.getByRole('button', { name: 'Overworld', exact: true }).click();
  check((await state()).stats.startsWith('20 tiles') && (await state()).points === 2, 'Returning to a floor restores its completed measurement');
  await page.locator('#btnClear').click();
  check((await state()).points === 0, 'Clear measurement');
  await page.keyboard.press('m');
  check((await state()).active[0] === 'btnMeasure', 'M starts measurement');
  await page.keyboard.press('m');
  await clickPoint(1000, 2000);
  await page.keyboard.press('Escape');
  check((await state()).active.length === 0 && (await state()).points === 1, 'Escape finishes without clearing');
  await page.getByRole('searchbox', { name: 'Search names' }).focus();
  await page.keyboard.press('m');
  check((await state()).active.length === 0, 'Typing M in search must not activate measurement');
  await page.getByRole('searchbox', { name: 'Search names' }).fill('');
  await page.locator('#btnMeasure').click();
  const doublePoint = await pointPixel(1000, 2000);
  await page.mouse.dblclick(doublePoint.x, doublePoint.y);
  current = await state();
  check(current.active.length === 0 && current.points === 1, 'Double click finishes without adding duplicate points');
  passed.push('Measure distance, Undo, Finish, Clear, shortcuts, double click, floor isolation');

  await setView(1500, 2000);
  await page.locator('#btnMeasure').click();
  await page.locator('#btnEliteShow').click();
  check(JSON.stringify((await state()).active) === JSON.stringify(['btnEliteShow']), 'Elite placement must finish Measure');
  const hover = await pointPixel(1500, 2000);
  await page.mouse.move(hover.x, hover.y);
  check((await state()).shapes.some(shape => shape.pane === 'elite' && shape.dash), 'Elite hover preview');
  await clickPoint(1500, 2000); await clickPoint(1560, 2040);
  check((await state()).elitePins === 2, 'Multiple elite positions');
  await page.locator('#btnEliteShow').click();
  check((await state()).active.length === 0, 'Elite Done cancels placement');
  const firstPin = page.locator('.elite-position-pin').first();
  const box = await firstPin.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 64, box.y + box.height / 2 + 32, { steps: 8 });
  await page.mouse.up();
  check((await state()).eliteRows.includes('1532') && (await state()).eliteRows.includes('2016'), 'Dragging updates the elite position and list');
  await page.getByRole('button', { name: 'Underground', exact: true }).click();
  check((await state()).elitePins === 0, 'Other-floor elite positions are hidden');
  await page.locator('#btnEliteShow').click();
  await page.evaluate(() => window.toolsTestMap.fire('click', { latlng: L.latLng(4096, 4096) }));
  await page.keyboard.press('Escape');
  current = await state();
  check(current.elitePins === 1, 'Independent Underground elite position');
  check(current.shapes.filter(shape => shape.pane === 'elite').every(shape => shape.bounds._southWest.lng >= 4096 && shape.bounds._northEast.lat <= 4096), 'Elite bounds are clipped to this floor');
  await page.getByRole('button', { name: 'Overworld', exact: true }).click();
  check((await state()).elitePins === 2, 'Returning restores elite positions');
  await page.getByRole('button', { name: 'Remove elite position 1', exact: true }).click();
  check((await state()).elitePins === 1, 'Remove an individual position');
  await page.locator('#btnEliteShow').click(); await page.locator('#btnEliteClear').click();
  await clickPoint(1500, 2000);
  check((await state()).elitePins === 0 && (await state()).active.length === 0, 'Clear all cancels pending placement');
  await page.locator('#btnEliteShow').click(); await page.keyboard.press('Escape'); await clickPoint(1500, 2000);
  check((await state()).elitePins === 0, 'Escape cancels elite placement');
  passed.push('Elite preview, multiple positions, drag, per-floor bounds, individual remove, Clear/Escape');

  await setView(1500, 2000);
  await page.locator('#btnEliteShow').click();
  await page.locator('#btnCrimRespawn').click();
  check(JSON.stringify((await state()).active) === JSON.stringify(['btnCrimRespawn']), 'Respawn replaces elite placement');
  await clickPoint(1500, 2000);
  current = await state();
  check(current.active.length === 0 && current.respawnPoints === 2 && current.elitePins === 0, 'Respawn selects once with two visual endpoints');
  const respawnShapes = JSON.stringify(current.shapes);
  await clickPoint(1550, 2020);
  check(JSON.stringify((await state()).shapes) === respawnShapes, 'Ordinary map clicks must not change a completed respawn preview');
  await page.locator('#btnCrimRespawn').click(); await page.locator('#btnCrimRespawnClear').click();
  check((await state()).respawnPoints === 0 && (await state()).active.length === 0, 'Respawn Clear cancels selection');
  await page.getByRole('button', { name: 'Underground', exact: true }).click();
  await setView(5596, 2000);
  await page.locator('#btnCrimRespawn').click(); await clickPoint(5596, 2000);
  current = await state();
  check(current.floor === 'overworld' && current.respawnPoints === 2 && current.active.length === 0, 'Underground respawn projects to Overworld');
  const line = current.shapes.find(shape => shape.pane === 'routes');
  check(line.points[0].lng === 1500 && line.points[1].lng === 1209, 'Respawn still selects the same destination');
  passed.push('Simple respawn preview, one-click selection, Clear, Underground projection, shared tool modes');

  await page.locator('#btnCrimRespawnClear').click();
  await setView(1500, 2000, 0);
  await page.locator('#btnEliteShow').click(); await clickPoint(1500, 2000); await clickPoint(1700, 2080);
  await page.keyboard.press('Escape');
  await page.locator('.panel-sections').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: 'output/playwright/map-tools-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#btnMeasure').click();
  // A point in the visible map below the panel verifies touch-sized controls can
  // start/undo/finish while the panel remains open.
  await page.mouse.click(350, 780);
  check((await state()).points === 1, 'Mobile map click adds a measure point');
  await page.locator('#btnMeasureUndo').click();
  check((await state()).points === 0, 'Mobile Undo');
  await page.locator('#btnMeasure').click();
  await page.locator('.panel-sections').evaluate(el => { el.scrollTop = 0; });
  check(await page.locator('#panel').evaluate(el => el.scrollWidth <= el.clientWidth), 'Panel must not overflow horizontally');
  await page.screenshot({ path: 'output/playwright/map-tools-mobile.png' });
  passed.push('Mobile Measure controls and panel layout');
  await page.locator('#btnCrimRespawn').click();
  await page.evaluate(() => window.toolsTestMap.fire('click', { latlng: L.latLng(2096, 1500) }));
  check(await page.locator('.respawn-point').evaluateAll(elements => {
    const panel = document.querySelector('#panel').getBoundingClientRect();
    return elements.length === 2 && elements.every(element => {
      const r = element.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      return x > 0 && x < innerWidth && y > 0 && y < innerHeight && !(x >= panel.left && x <= panel.right && y >= panel.top && y <= panel.bottom);
    });
  }), 'Mobile respawn endpoints must be visible outside the panel');
  await page.screenshot({ path: 'output/playwright/map-tools-mobile-respawn.png' });
  passed.push('Mobile respawn result remains visible');
  check(errors.length === 0, 'Browser errors: ' + errors.join('; '));
  return { passed, browserErrors: errors };
}
