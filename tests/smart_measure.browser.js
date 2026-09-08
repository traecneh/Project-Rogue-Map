// Run with playwright-cli run-code --filename tests/smart_measure.browser.js.
async (page) => {
  const origin = await page.evaluate(() => location.origin);
  const errors = [], passed = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/data/navigation/')) requests.push(request.url()); });
  const check = (value, message) => { if (!value) throw new Error(message); };
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => { window.__PROJECT_ROGUE_TEST_HOOKS__ = {}; });
  const ready = async () => {
    await page.goto(origin + '/');
    await page.waitForFunction(() => window.__PROJECT_ROGUE_TEST_HOOKS__?.api && !document.querySelector('#monsterLevelMin').disabled);
    await page.evaluate(() => { window.smartTestMap = window.__PROJECT_ROGUE_TEST_HOOKS__.api.groups.localeLabelsFG._map; });
    await page.locator('.panel-layers > summary').click();
    await page.locator('.panel-tools > summary').click();
  };
  const fire = point => page.evaluate(point => window.smartTestMap.fire('click', { latlng: L.latLng(4096 - point.y, point.x) }), point);
  // Cancel in the same UI turn: fast cached searches may now finish before a
  // second Playwright call, which would test Undo of a completed route instead.
  const fireAndCancel = (point, selector) => page.evaluate(({ point, selector }) => {
    window.smartTestMap.fire('click', { latlng: L.latLng(4096 - point.y, point.x) });
    document.querySelector(selector).click();
  }, { point, selector });
  const settled = () => page.waitForFunction(() => document.querySelector('#measureHint').getAttribute('aria-busy') === 'false');
  const state = () => page.evaluate(() => ({
    smart: document.querySelector('#measureSmart').checked,
    stats: document.querySelector('#measureStats').textContent,
    hint: document.querySelector('#measureHint').textContent,
    points: document.querySelectorAll('.vertex').length,
    active: document.querySelector('#btnMeasure').getAttribute('aria-pressed'),
    lines: Object.values(window.smartTestMap._layers).filter(layer => layer.getLatLngs && layer.options?.pane === 'routes').map(layer => ({ points: layer.getLatLngs(), smooth: layer.options.smoothFactor }))
  }));
  const newRoute = async () => {
    if (await page.locator('#btnMeasure').getAttribute('aria-pressed') === 'true') await page.locator('#btnMeasure').click();
    await page.locator('#btnMeasure').click();
  };
  await ready();
  check(requests.length === 0 && (await state()).smart, 'Smart Measure defaults on without downloading navigation data');
  await newRoute();
  check(requests.length === 0, 'Navigation loading remains lazy until the first point');
  for (const point of [{ x: 2041, y: 638 }, { x: 1545, y: 783 }, { x: 1928, y: 618 }, { x: 1355, y: 3539 }]) {
    await fire(point); await settled();
    const current = await state();
    check(current.points === 0 && current.hint === 'Choose a walkable tile.', 'Confirmed blocked tile must be rejected');
  }
  await fire({ x: 1980, y: 640 }); await settled();
  await fire({ x: 2100, y: 640 }); await settled();
  let current = await state();
  check(current.points === 2 && current.stats.startsWith('120 tiles'), 'Smart route reports walking steps');
  check(current.lines[0].points.length > 2 && current.lines[0].smooth === 0, 'Route follows turns without Leaflet smoothing');
  const goodRoute = JSON.stringify(current.lines);
  check(!requests.some(url => url.includes('-hierarchy.bin')), 'Short routes must not download the hierarchy');
  await fire({ x: 2041, y: 638 }); await settled();
  check((await state()).points === 2 && JSON.stringify((await state()).lines) === goodRoute, 'Blocked click preserves the route');
  await fire({ x: 0, y: 0 }); await settled();
  check((await state()).hint === 'No walking route found from the previous point.' && (await state()).points === 2, 'Disconnected destination preserves the route');
  await page.locator('#btnMeasureUndo').click();
  check((await state()).points === 1 && (await state()).stats.startsWith('0 tiles'), 'Undo removes one waypoint and its segment');
  await fire({ x: 2100, y: 640 }); await settled();
  await page.locator('#measureSmart').uncheck();
  check((await state()).lines[0].points.length === 2, 'Turning Smart off restores straight waypoint lines');
  await page.locator('#measureSmart').check(); await settled();
  check(JSON.stringify((await state()).lines) === goodRoute, 'Turning Smart on recalculates existing waypoints');
  passed.push('Lazy loading, exact blocked IDs, A* detour, distance, no-route message, Undo, checkbox recalculation');

  await newRoute(); await fire({ x: 760, y: 1050 }); await settled();
  await fireAndCancel({ x: 1480, y: 1880 }, '#btnMeasureUndo');
  await page.waitForTimeout(200);
  check((await state()).points === 1, 'Undo cancels a pending waypoint without removing the previous one');
  await fireAndCancel({ x: 1480, y: 1880 }, '#btnClear');
  await page.waitForTimeout(200);
  check((await state()).points === 0 && (await state()).active === 'false', 'Clear cancels work and prevents stale route results');
  await newRoute(); await fire({ x: 760, y: 1050 }); await settled();
  await page.evaluate(() => {
    window.smartFrames = 0; window.countSmartFrames = true;
    const tick = () => { window.smartFrames++; if (window.countSmartFrames) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const started = Date.now();
  await fire({ x: 1480, y: 1880 });
  await page.evaluate(() => window.smartTestMap.panBy([64, 0], { animate: false }));
  await settled();
  const timing = await page.evaluate(() => { window.countSmartFrames = false; return window.smartFrames; });
  current = await state();
  check(current.points === 2 && current.stats.startsWith('1132 tiles'), 'Larger walking detour must complete');
  check(timing > 0, 'Map frames continue while pathfinding runs');
  check(requests.filter(url => url.includes('overworld-hierarchy.bin')).length === 1, 'Hierarchy is loaded once and reused');
  passed.push(`Larger detour completed in ${Date.now() - started} ms with ${timing} animation frames; cancellation works`);
  await fireAndCancel({ x: 2222, y: 3078 }, '#btnFloorUnderground');
  await page.waitForTimeout(200);
  check((await state()).points === 0 && (await state()).active === 'false', 'Floor switching cancels pending paths');
  await newRoute(); await fire({ x: 6099, y: 1762 }); await settled();
  check((await state()).hint === 'Choose a walkable tile.' && (await state()).points === 0, 'Underground void is blocked');
  await fire({ x: 5320, y: 680 }); await settled();
  await fire({ x: 5360, y: 760 }); await settled();
  check((await state()).stats.startsWith('117 tiles') && (await state()).points === 2, 'Underground coordinates route on the correct floor');
  await page.getByRole('button', { name: 'Overworld', exact: true }).click();
  check((await state()).stats.startsWith('1132 tiles'), 'Completed routes remain independent per floor');
  passed.push('Floor cancellation, Underground routing and void, saved floor routes');

  await newRoute(); await fire({ x: 800, y: 600 }); await settled();
  const longStarted = Date.now();
  await fire({ x: 2222, y: 3078 }); await settled();
  current = await state();
  check(current.points === 2 && current.stats.startsWith('3518 tiles'), 'Previously limited long route now completes');
  passed.push(`Previously limited route completed in ${Date.now() - longStarted} ms`);
  await fire({ x: 760, y: 1050 }); await settled();
  const multiRoute = await state();
  check(multiRoute.points === 3, 'Multiple long legs can be added');
  await page.locator('#measureSmart').uncheck();
  await page.locator('#measureSmart').check(); await settled();
  check((await state()).stats === multiRoute.stats && JSON.stringify((await state()).lines) === JSON.stringify(multiRoute.lines), 'Recalculating multiple waypoints preserves their routes and total');
  passed.push('Multiple hierarchical legs and checkbox recalculation');

  await page.evaluate(() => window.smartTestMap.setView([3456, 2040], 2, { animate: false }));
  await newRoute(); await fire({ x: 1980, y: 640 }); await settled(); await fire({ x: 2100, y: 640 }); await settled();
  await page.locator('.panel-sections').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: 'output/playwright/smart-measure-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#measureSmart').uncheck(); await page.locator('#measureSmart').check(); await settled();
  check((await state()).points === 2 && (await state()).smart, 'Mobile checkbox works');
  check(await page.locator('#panel').evaluate(el => el.scrollWidth <= el.clientWidth), 'Smart controls do not overflow on mobile');
  await page.screenshot({ path: 'output/playwright/smart-measure-mobile.png' });
  passed.push('Desktop and mobile controls');

  await page.route('**/*-hierarchy.bin*', route => route.fulfill({ status: 503, body: 'unavailable' }));
  await ready(); await page.locator('#measureSmart').check(); await newRoute();
  await fire({ x: 760, y: 1050 }); await settled(); await fire({ x: 1480, y: 1880 }); await settled();
  check((await state()).hint.includes('could not load') && (await state()).points === 1, 'Hierarchy download failure preserves the first waypoint');
  await page.unroute('**/*-hierarchy.bin*');
  await page.route('**/*-hierarchy.bin*', route => route.fulfill({ status: 200, body: 'corrupt-data' }));
  await fire({ x: 1480, y: 1880 }); await settled();
  check((await state()).hint.includes('could not load') && (await state()).points === 1, 'Corrupt hierarchy data is rejected');
  await page.unroute('**/*-hierarchy.bin*');
  await fire({ x: 1480, y: 1880 }); await settled();
  check((await state()).stats.startsWith('1132 tiles'), 'A failed hierarchy load can be retried');
  passed.push('Hierarchy failure, checksum rejection and retry');

  await page.route('**/data/navigation/**', route => route.fulfill({ status: 503, body: 'unavailable' }));
  await ready(); await page.locator('#measureSmart').check(); await newRoute();
  await fire({ x: 1980, y: 640 }); await settled();
  check((await state()).hint.includes('could not load'), 'Loading failure has a useful message');
  await page.locator('#measureSmart').uncheck(); await fire({ x: 1980, y: 640 });
  check((await state()).points === 1, 'Manual measure remains usable after a navigation failure');
  await page.unroute('**/data/navigation/**');
  passed.push('Data failure and manual fallback');
  check(errors.length === 0, 'Browser errors: ' + errors.join('; '));
  return { passed, browserErrors: errors };
}
