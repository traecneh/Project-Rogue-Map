// Run against a local server with playwright-cli run-code --filename tests/floor_navigation.browser.js.
// The active page's origin is reused. No production test hook is enabled by default.
async (page) => {
  const origin = await page.evaluate(() => location.origin);
  const results = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.addInitScript(() => { window.__PROJECT_ROGUE_TEST_HOOKS__ = {}; });
  const ready = async (query = '') => {
    await page.goto(origin + '/' + query);
    await page.waitForFunction(() => window.__PROJECT_ROGUE_TEST_HOOKS__?.api && !document.querySelector('#monsterLevelMin').disabled);
    await page.evaluate(() => {
      window.floorTestMap = window.__PROJECT_ROGUE_TEST_HOOKS__.api.groups.localeLabelsFG._map;
      window.floorTestZooms = [];
      window.floorTestMap.on('zoomend', () => window.floorTestZooms.push(window.floorTestMap.getZoom()));
    });
  };
  const view = () => page.evaluate(() => {
    const map = window.floorTestMap, c = map.getCenter();
    const monsters = Object.values(map._layers).filter(layer => layer.options?.pane === 'chunk' && layer.getLatLng);
    return {
      x: c.lng, y: 4096 - c.lat, zoom: map.getZoom(),
      floor: document.querySelector('#btnFloorUnderground').getAttribute('aria-pressed') === 'true' ? 'underground' : 'overworld',
      west: map.options.maxBounds.getWest(), zooms: [...window.floorTestZooms],
      monsters: monsters.map(layer => ({ x: layer.getLatLng().lng, text: layer.getElement()?.textContent })),
      layers: [...document.querySelectorAll('.panel-layers button')].map(el => el.getAttribute('aria-pressed'))
    };
  });
  const setView = (x, y, zoom) => page.evaluate(({ x, y, zoom }) => {
    window.floorTestMap.setView([4096 - y, x], zoom, { animate: false });
  }, { x, y, zoom });
  const switchTo = async (name) => {
    await page.getByRole('button', { name, exact: true }).click();
    await page.waitForTimeout(250); // Includes the old delayed bounce window.
    return view();
  };
  const sameView = (actual, expected, label) => {
    check(Math.abs(actual.x - expected.x) < 0.001 && Math.abs(actual.y - expected.y) < 0.001 && actual.zoom === expected.zoom, label);
  };

  await ready();
  await setView(576.25, 2240.75, 2);
  const overworld = await view();
  const firstUnderground = await switchTo('Underground');
  check(firstUnderground.x === 6144 && firstUnderground.y === 2048, 'First manual visit should show the floor overview');
  check(firstUnderground.zooms.length === overworld.zooms.length + 1, 'First visit must not bounce the zoom');
  await setView(5320.5, 680.25, 1);
  const underground = await view();
  sameView(await switchTo('Overworld'), overworld, 'Overworld view must be restored exactly');
  sameView(await switchTo('Underground'), underground, 'Underground view must be restored exactly');
  results.push('Independent floor views, fractional coordinates, first-visit overview, no zoom bounce');

  for (const name of ['Monsters', 'Warfronts', 'Safe Zones', 'Caves']) {
    await page.getByRole('button', { name, exact: true }).click();
  }
  await setView(5320, 680, 2);
  const ugMonsters = await view();
  check(ugMonsters.monsters.length > 0 && ugMonsters.monsters.every(m => m.x >= 4096 && m.text), 'Underground monster labels must load');
  const owMonsters = await switchTo('Overworld');
  check(owMonsters.monsters.length > 0 && owMonsters.monsters.every(m => m.x < 4096 && m.text), 'Overworld labels must replace Underground labels');
  const beforeSameZoom = owMonsters.zooms.length;
  const sameZoomUG = await switchTo('Underground');
  check(sameZoomUG.zooms.length === beforeSameZoom, 'Same-zoom switching must not create zoom events');
  check(sameZoomUG.monsters.length > 0 && sameZoomUG.monsters.every(m => m.x >= 4096 && m.text), 'Same-zoom switch must refresh labels directly');
  check(JSON.stringify(sameZoomUG.layers) === JSON.stringify(ugMonsters.layers), 'Layer toggles must remain selected');
  results.push('Detailed monster labels refresh at the same zoom; layer selections persist');

  await setView(6144, 2048, -2);
  const ugOverview = await view();
  check(ugOverview.monsters.length > 0 && ugOverview.monsters.every(m => m.x >= 4096 && m.text), 'Underground overview labels must load');
  await switchTo('Overworld');
  await setView(2048, 2048, -2);
  const owOverview = await view();
  check(owOverview.monsters.length > 0 && owOverview.monsters.every(m => m.x < 4096 && m.text), 'Overworld overview labels must load');
  sameView(await switchTo('Underground'), ugOverview, 'Zoomed-out Underground view must be restored');
  results.push('Zoomed-out monster overviews on both floors');

  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) {
      document.querySelector('#btnFloorOverworld').click();
      document.querySelector('#btnFloorUnderground').click();
    }
    document.querySelector('#btnFloorOverworld').click();
    window.floorTestMap.setView([1850, 600], 1, { animate: false });
  });
  await page.waitForTimeout(400);
  const rapid = await view();
  sameView(rapid, { x: 600, y: 2246, zoom: 1 }, 'Delayed floor work must not overwrite a newer camera action');
  check(rapid.floor === 'overworld' && rapid.west === -288, 'Rapid switches must leave the correct floor bounds');
  results.push('Rapid switching preserves the latest user action and floor bounds');

  await ready('?x=5703&y=1176&label=Floor%20test');
  const link = await view();
  sameView(link, { x: 5703, y: 1176, zoom: 2 }, 'First Underground coordinate link must honor its destination and zoom');
  check(link.floor === 'underground', 'Coordinate link selects Underground');
  results.push('First-visit coordinate deep link');

  await ready();
  await page.getByRole('searchbox', { name: 'Search names' }).fill('Grell');
  await page.getByRole('searchbox', { name: 'Search names' }).press('Enter');
  const search = await view();
  check(search.floor === 'underground' && Math.abs(search.x - 5320) < 1 && Math.abs(search.y - 680) < 1, 'First Underground search must focus Grell');
  results.push('First-visit search destination');

  await ready();
  await page.getByRole('button', { name: 'Caves', exact: true }).click();
  await setView(1095.5, 1862.5, 2);
  // Find the visible marker for a known paired cave and click its actual DOM icon.
  await page.evaluate(() => {
    const cave = Object.values(window.floorTestMap._layers).find(layer => layer.getElement?.()?.classList.contains('cave-icon') && layer.getLatLng().lng === 1095.5);
    if (!cave) throw new Error('Cave marker not found');
    cave.getElement().dataset.floorTestCave = 'entry';
  });
  await page.locator('[data-floor-test-cave="entry"]').click();
  const cave = await view();
  sameView(cave, { x: 5176.5, y: 1895.5, zoom: 2 }, 'First cave trip must land at its paired exit');
  await switchTo('Overworld');
  await setView(800, 1800, 1);
  await page.locator('[data-floor-test-cave="entry"]').click();
  const repeatCave = await view();
  sameView(repeatCave, { x: 5176.5, y: 1895.5, zoom: 1 }, 'Explicit cave destination and zoom must override a remembered view');
  results.push('First and repeat cave travel, explicit destination overrides memory');

  await page.evaluate(() => window.floorTestMap.flyTo([3000, 6000], 0, { duration: 1 }));
  await page.waitForTimeout(80);
  const interrupted = await switchTo('Overworld');
  await page.waitForTimeout(1100);
  sameView(await view(), interrupted, 'Interrupted animation must not move the new floor');
  results.push('Switching during a camera animation');

  await page.setViewportSize({ width: 390, height: 844 });
  await setView(1095, 1862, 2);
  const mobileOW = await view();
  const mobileUG = await switchTo('Underground');
  sameView(await switchTo('Overworld'), mobileOW, 'Mobile floor controls must restore the Overworld view');
  sameView(await switchTo('Underground'), mobileUG, 'Mobile floor controls must restore the Underground view');
  await page.screenshot({ path: 'output/playwright/floor-navigation-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await setView(5320, 680, 2);
  await page.getByRole('button', { name: 'Monsters', exact: true }).click();
  await page.screenshot({ path: 'output/playwright/floor-navigation-desktop.png' });
  results.push('Mobile floor controls');
  check(errors.length === 0, 'Browser errors: ' + errors.join('; '));
  return { passed: results, browserErrors: errors };
}
