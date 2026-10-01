"""One-time maintenance: only the exact reviewed obsolete run IDs below."""
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request

REPO = 'linchun7/linchun7.github.io'
MARKER = '[approved-obsolete-actions-22-20261001]'
MANIFEST = json.loads(r'''{
  "36254772377": ".github/workflows/final-adversarial-icloud-seal.yml",
  "36251500571": ".github/workflows/adversarial-icloud-final-seal.yml",
  "36250457417": ".github/workflows/verify-icloud-adversarial-release.yml",
  "36250402465": ".github/workflows/verify-icloud-adversarial-release.yml",
  "36250402522": ".github/workflows/adversarial-icloud-ui-seal.yml",
  "36250320344": ".github/workflows/adversarial-icloud-ui-seal.yml",
  "36246906173": ".github/workflows/adversarial-icloud-ui-seal.yml",
  "36244981761": ".github/workflows/adversarial-icloud-ui-seal.yml",
  "36244716207": ".github/workflows/adversarial-icloud-ui-seal.yml",
  "36244597481": ".github/workflows/adversarial-icloud-ui-seal.yml",
  "36244527260": ".github/workflows/adversarial-icloud-ui-seal.yml",
  "36243318676": ".github/workflows/verify-icloud-visual-density-release.yml",
  "36242636551": ".github/workflows/verify-icloud-mobile-layout-release.yml",
  "36231436858": ".github/workflows/verify-icloud-minimum-history-timeline-release.yml",
  "36222329160": ".github/workflows/verify-icloud-history-projection-release.yml",
  "36216453587": ".github/workflows/verify-icloud-minimum-release.yml",
  "36215641540": ".github/workflows/icloud-minimum-upgrade-audit.yml",
  "36214890068": ".github/workflows/icloud-minimum-upgrade-audit.yml",
  "36214572088": ".github/workflows/icloud-minimum-upgrade-audit.yml",
  "36214369886": ".github/workflows/icloud-minimum-upgrade-audit.yml",
  "36212738793": ".github/workflows/icloud-minimum-upgrade-audit.yml",
  "36724158372": ".github/workflows/render-chatgpt-projection.yml"
}''')
assert len(MANIFEST) == 22 and len(set(MANIFEST.values())) == 11
assert sys.argv[1:] in (['--check'], ['--delete'])
delete = sys.argv[1:] == ['--delete']
assert os.environ['GITHUB_REPOSITORY'] == REPO
assert os.environ['GITHUB_RUN_ID'] not in MANIFEST

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect)
def api(method, resource):
    request = urllib.request.Request(
        'https://api.github.com/repos/' + REPO + '/' + resource,
        method=method,
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                 'Accept': 'application/vnd.github+json',
                 'X-GitHub-Api-Version': '2022-11-28'})
    try:
        with opener.open(request, timeout=30) as response:
            body = response.read()
            return response.status, json.loads(body) if body else None
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return 404, None
        raise RuntimeError(f'GitHub HTTP {error.code} for {method} {resource}') from None

if delete:
    assert os.environ['GITHUB_EVENT_NAME'] == 'push'
    assert os.environ['GITHUB_REF'] == 'refs/heads/main'
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    assert MARKER in event['head_commit']['message']

status, main = api('GET', 'commits/main')
assert status == 200
main_sha = main['sha']
if delete:
    assert main_sha == os.environ['GITHUB_SHA'], 'Main advanced; stop before any deletion'
for path in sorted(set(MANIFEST.values())):
    status, _ = api('GET', 'contents/' + path + '?ref=' + main_sha)
    assert status == 404, 'Workflow still exists: ' + path

def check_run(run_id, expected):
    status, run = api('GET', 'actions/runs/' + run_id)
    if status == 404:
        return None
    assert status == 200
    assert str(run['id']) == run_id
    assert run['repository']['full_name'] == REPO
    assert run['path'] == expected, 'Workflow path mismatch: ' + run_id
    assert run['status'] == 'completed', 'Run is not completed: ' + run_id
    return run

# All targets must pass before the first mutation. No wildcard discovery or age-based deletion.
ready = []
workflows = {}
for run_id, expected in MANIFEST.items():
    run = check_run(run_id, expected)
    if run:
        ready.append((run_id, expected))
        workflows[str(run['workflow_id'])] = expected
    print('PREFLIGHT', run_id, expected, 'completed' if run else 'already absent', flush=True)

deleted = []
if delete:
    status, current = api('GET', 'commits/main')
    assert status == 200 and current['sha'] == main_sha, 'Main advanced during preflight'
    for run_id, expected in ready:
        if check_run(run_id, expected) is None:
            continue
        status, _ = api('DELETE', 'actions/runs/' + run_id)
        assert status in (204, 404)
        status, _ = api('GET', 'actions/runs/' + run_id)
        assert status == 404, 'Deletion was not confirmed: ' + run_id
        deleted.append(run_id)
        print('DELETED_CONFIRMED', run_id, expected, flush=True)
    for run_id in MANIFEST:
        assert api('GET', 'actions/runs/' + run_id)[0] == 404

remaining = {}
for workflow_id, path in workflows.items():
    status, runs = api('GET', 'actions/workflows/' + workflow_id + '/runs?per_page=1')
    if status == 200:
        remaining[path] = runs['total_count']
    elif status == 404:
        remaining[path] = 0
    else:
        raise RuntimeError('Cannot check remaining runs for ' + path)
print('CLEANUP_RESULT', json.dumps({'mode': 'delete' if delete else 'check',
      'authorized': len(MANIFEST), 'deleted': deleted, 'remaining_by_workflow': remaining}), flush=True)
if os.environ.get('GITHUB_STEP_SUMMARY'):
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
        stream.write('## Approved obsolete Actions cleanup\n\n')
        stream.write(f'Mode: {"delete" if delete else "check"}; exact authorized targets: 22; deleted and verified: {len(deleted)}\n\n')
        for path, count in remaining.items():
            stream.write(f'- {path}: {count} retained runs\n')
