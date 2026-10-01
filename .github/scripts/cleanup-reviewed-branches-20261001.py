import json, os, urllib.request, urllib.error, urllib.parse
REPO = "linchun7/linchun7.github.io"
TARGETS = [{"name":"fix/icloud-header-641-overflow-20260926","sha":"aef75165ff5d0b7cf048a692acf1a9602f84c790"},{"name":"fix/icloud-ignore-date-only-published-date","sha":"9ce75e102a868c380f80ba3e935959a28035df7a"},{"name":"fix/icloud-minimum-copy-20260926","sha":"018cef31d445df5ac868e65233bdfaa49b5ae970"},{"name":"fix/icloud-production-verifier-timeout-test-20260926","sha":"805ecbf47d00fd78f99229a7cddd839bac0292d3"},{"name":"verify/icloud-minimum-history-20260926","sha":"ad87f651f5d5b6c69bfb1b4f2a95623f20f3d7fd"}]
API = "https://api.github.com/repos/" + REPO
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
opener = urllib.request.build_opener(NoRedirect)
def api(path, method="GET"):
    req = urllib.request.Request(API + path, method=method, headers={
        "Authorization": "Bearer " + os.environ["GH_TOKEN"],
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    try:
        with opener.open(req, timeout=30) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return 404, None
        raise RuntimeError("GitHub request failed: " + str(error.code)) from None

assert os.environ["GITHUB_REPOSITORY"] == REPO
apply = os.environ.get("CLEANUP_APPLY") == "true"
if apply:
    assert os.environ["GITHUB_REF"] == "refs/heads/main"
    assert os.environ["GITHUB_EVENT_NAME"] == "push"
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as file:
        event = json.load(file)
    assert "[cleanup-reviewed-branches-20261001]" in event["head_commit"]["message"]
    assert api("/git/ref/heads/main")[1]["object"]["sha"] == os.environ["GITHUB_SHA"]
for page in range(1, 101):
    status, prs = api("/pulls?state=open&per_page=100&page=" + str(page))
    assert status == 200
    assert not any(pr["head"]["repo"] and pr["head"]["repo"]["full_name"] == REPO
        and pr["head"]["ref"] in {item["name"] for item in TARGETS} for pr in prs)
    if len(prs) < 100:
        break
else:
    raise RuntimeError("Open PR listing exceeded safe bound")
# Check the entire fixed manifest before any deletion.
for item in TARGETS:
    name = item["name"]
    assert name != "main" and not name.startswith(("prepare/", "duo/"))
    encoded = urllib.parse.quote(name, safe="")
    status, branch = api("/branches/" + encoded)
    assert status == 200 and not branch["protected"], name
    assert branch["commit"]["sha"] == item["sha"], name
    status, ref = api("/git/ref/heads/" + encoded)
    assert status == 200 and ref["object"]["sha"] == item["sha"], name
    print("REVIEWED", name, item["sha"], flush=True)
if apply:
    for item in TARGETS:
        encoded = urllib.parse.quote(item["name"], safe="")
        status, ref = api("/git/ref/heads/" + encoded)
        assert status == 200 and ref["object"]["sha"] == item["sha"]
        assert api("/git/refs/heads/" + encoded, method="DELETE")[0] == 204
        assert api("/git/ref/heads/" + encoded)[0] == 404
        print("DELETED_CONFIRMED", item["name"], item["sha"], flush=True)
else:
    print("Read-only preflight passed; no branch deleted.", flush=True)
