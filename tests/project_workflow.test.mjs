import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

function readText(path) {
  return readFileSync(path, 'utf8');
}

test('future update runbook documents the full safe map update path', () => {
  const readme = readText('README.md');
  const runbook = readText('docs/future-update-runbook.md');

  assert.match(readme, /\[future update runbook\]\(docs\/future-update-runbook\.md\)/i);
  assert.match(runbook, /C:\\Users\\traec\\Desktop\\Project Rogue\\Client/);
  assert.match(runbook, /python tools\\render_map_candidate\.py/);
  assert.match(runbook, /--underground-transform identity/);
  assert.match(runbook, /--allow-live-output/);
  assert.match(runbook, /python tools\\generate_safezone_overlay\.py/);
  assert.match(runbook, /python tools\\generate_locale_overlay\.py/);
  assert.match(runbook, /locales\.json/);
  assert.match(runbook, /python tools\\generate_warfront_overlay\.py/);
  assert.match(runbook, /warfronts\.json/);
  assert.match(runbook, /python tools\\run_map_update_checks\.py/);
  assert.match(runbook, /powershell -ExecutionPolicy Bypass -File tools\\run_all_checks\.ps1/);
  assert.match(runbook, /node tools\\deploy_smoke\.mjs/);
});

test('generated locale metadata preserves the confirmed classifications and search geometry', () => {
  const data = JSON.parse(readText('data/locales.json'));
  const byId = new Map(data.locales.map(locale => [locale.id, locale]));

  assert.equal(data.locales.length, 67);
  assert.equal(data.locales.filter(locale => locale.chunks > 0).length, 62);
  assert.deepEqual(data.locales.filter(locale => locale.chunks === 0).map(locale => locale.id), [45, 51, 52, 59, 66]);
  assert.equal(byId.get(10).category_label, 'Criminal Town');
  assert.equal(byId.get(34).category_label, 'Criminal Town');
  assert.equal(byId.get(4).category_label, 'Lawful Town');
  assert.equal(byId.get(6).category_label, 'Lawful Town');
  assert.equal(byId.get(15).category_label, 'Lawful Town');
  assert.equal(byId.get(16).category_label, 'Lawful Town');
  assert.equal(byId.get(26).category_label, 'Point of Interest');
  assert.ok(data.labels.every(label => (
    Number.isFinite(label.x)
    && Number.isFinite(label.y)
    && Array.isArray(label.bounds)
    && label.bounds.length === 4
    && label.bounds.every(Number.isFinite)
  )));
});

test('generated warfront metadata preserves the confirmed identities', () => {
  const data = JSON.parse(readText('data/warfronts.json'));
  const byId = new Map(data.warfronts.map(warfront => [warfront.id, warfront]));

  assert.equal(byId.get(1).name, 'Talazarian Warfront');
  assert.equal(byId.get(1).label, 'Talazarian');
  assert.equal(byId.get(5).name, 'Abyssal Warfront');
  assert.equal(byId.get(5).label, 'Abyssal');
});

test('local checks workflow runs the repository-contained CI verification script', () => {
  const workflow = readText('.github/workflows/local-checks.yml');

  assert.match(workflow, /runs-on:\s+windows-latest/);
  assert.match(workflow, /actions\/setup-node@v4/);
  assert.match(workflow, /node-version:\s+'24'/);
  assert.match(workflow, /actions\/setup-python@v5/);
  assert.match(workflow, /tools\/run_ci_checks\.ps1/);
  assert.doesNotMatch(workflow, /run_all_checks\.ps1/);
  assert.doesNotMatch(workflow, /numpy pillow/);
});

test('static GitHub Pages deployment disables Jekyll processing', () => {
  const readme = readText('README.md');
  const runbook = readText('docs/future-update-runbook.md');

  assert.equal(existsSync('.nojekyll'), true);
  assert.match(readme, /\.nojekyll/);
  assert.match(runbook, /\.nojekyll/);
});

test('live deploy smoke workflow runs after main pushes and successful Pages deployments', () => {
  const workflow = readText('.github/workflows/live-deploy-smoke.yml');
  const readme = readText('README.md');
  const runbook = readText('docs/future-update-runbook.md');

  assert.match(workflow, /name:\s+Live deploy smoke/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /pages build and deployment/);
  assert.match(workflow, /branches:\s*\n\s+- main/);
  assert.match(workflow, /types:\s*\n\s+- completed/);
  assert.match(workflow, /github\.event_name != 'workflow_run' \|\| github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /node-version:\s+'24'/);
  assert.match(workflow, /node tools\/deploy_smoke\.mjs/);
  assert.match(workflow, /sleep 10/);
  assert.match(readme, /Live deploy smoke/);
  assert.match(runbook, /Live deploy smoke/);
});

test('ci checks do not require local extracted client data', () => {
  const script = readText('tools/run_ci_checks.ps1');

  assert.match(script, /tests\\project_workflow\.test\.mjs/);
  assert.match(script, /python', '-m', 'unittest', 'tests\.test_run_map_update_checks'/);
  assert.match(script, /python', '-m', 'py_compile'/);
  assert.doesNotMatch(script, /tools\\run_map_update_checks\.py/);
  assert.doesNotMatch(script, /\.analysis/);
});

test('run all checks includes the workflow and runbook contract test', () => {
  const script = readText('tools/run_all_checks.ps1');

  assert.match(script, /tests\\project_workflow\.test\.mjs/);
  assert.match(script, /node', '--test', 'tests\\project_workflow\.test\.mjs'/);
});

test('check scripts discover JavaScript syntax targets dynamically', () => {
  for (const path of ['tools/run_ci_checks.ps1', 'tools/run_all_checks.ps1']) {
    const script = readText(path);

    assert.match(script, /Get-ChildItem -Path 'js', 'tools', 'tests'/);
    assert.match(script, /-Include '\*\.js', '\*\.mjs'/);
    assert.doesNotMatch(script, /\$jsFiles\s*=\s*@\(/);
  }
});
