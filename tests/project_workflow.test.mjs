import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.match(runbook, /python tools\\run_map_update_checks\.py/);
  assert.match(runbook, /powershell -ExecutionPolicy Bypass -File tools\\run_all_checks\.ps1/);
  assert.match(runbook, /node tools\\deploy_smoke\.mjs/);
});

test('local checks workflow runs the repository-contained CI verification script', () => {
  const workflow = readText('.github/workflows/local-checks.yml');

  assert.match(workflow, /runs-on:\s+windows-latest/);
  assert.match(workflow, /actions\/setup-node@v4/);
  assert.match(workflow, /actions\/setup-python@v5/);
  assert.match(workflow, /tools\/run_ci_checks\.ps1/);
  assert.doesNotMatch(workflow, /run_all_checks\.ps1/);
  assert.doesNotMatch(workflow, /numpy pillow/);
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
