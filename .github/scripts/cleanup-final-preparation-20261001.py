import json, os, urllib.request, urllib.error, urllib.parse
REPO = "linchun7/linchun7.github.io"
TARGETS = [{"name":"prepare/icloud-minimum-copy-20260926","sha":"31d5692f28868c6ac96e95dba81eed9dc14dbec2"}]
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

import base64, hashlib, zlib

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

# Inspect the transport blob as data only; never execute its contents.
status, blob = api("/git/blobs/c09a2c08a1acbee31cd65a63f5f02277b48ef645")
require(status == 200 and blob["encoding"] == "base64", "Missing exact transport blob")
raw = base64.b64decode(blob["content"])
git_hash = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
require(git_hash == "c09a2c08a1acbee31cd65a63f5f02277b48ef645", "Transport blob hash mismatch")
print("TRANSPORT_BLOB_VERIFIED", git_hash, len(raw), flush=True)
try:
    packed = base64.b64decode(raw, validate=False)
    decoder = zlib.decompressobj()
    decoded = decoder.decompress(packed, 2000000)
    require(decoder.eof and not decoder.unconsumed_tail, "Incomplete or oversized compressed transport")
    text = decoded.decode("utf-8")
    print("TRANSPORT_DECODED", len(decoded), hashlib.sha256(decoded).hexdigest(), flush=True)
    print(text[:24000], flush=True)
except Exception as error:
    print("TRANSPORT_DECODE_ERROR", type(error).__name__, str(error)[:500], flush=True)

require(os.environ["GITHUB_REPOSITORY"] == REPO, "Unexpected repository")
apply = os.environ.get("CLEANUP_APPLY") == "true"
if apply:
    require(os.environ["GITHUB_REF"] == "refs/heads/main", "Unexpected ref")
    require(os.environ["GITHUB_EVENT_NAME"] == "push", "Unexpected event")
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as file:
        event = json.load(file)
    require("[cleanup-final-preparation-20261001]" in event["head_commit"]["message"], "Missing cleanup marker")
    require(api("/git/ref/heads/main")[1]["object"]["sha"] == os.environ["GITHUB_SHA"], "Main moved")
for page in range(1, 101):
    status, prs = api("/pulls?state=open&per_page=100&page=" + str(page))
    require(status == 200, "Cannot list open PRs")
    require(not any(pr["head"]["repo"] and pr["head"]["repo"]["full_name"] == REPO
        and pr["head"]["ref"] in {item["name"] for item in TARGETS} for pr in prs), "A target has an open PR")
    if len(prs) < 100:
        break
else:
    raise RuntimeError("Open PR listing exceeded safe bound")
# Check the entire fixed manifest before any deletion.
for item in TARGETS:
    name = item["name"]
    require(name == "prepare/icloud-minimum-copy-20260926", "Invalid target")
    encoded = urllib.parse.quote(name, safe="")
    status, branch = api("/branches/" + encoded)
    require(status == 200 and not branch["protected"], "Protected or missing: " + name)
    require(branch["commit"]["sha"] == item["sha"], "Branch moved: " + name)
    status, ref = api("/git/ref/heads/" + encoded)
    require(status == 200 and ref["object"]["sha"] == item["sha"], "Ref moved: " + name)
    print("REVIEWED", name, item["sha"], flush=True)
if apply:
    for item in TARGETS:
        encoded = urllib.parse.quote(item["name"], safe="")
        require(api("/git/ref/heads/main")[1]["object"]["sha"] == os.environ["GITHUB_SHA"], "Main moved before deletion")
        status, prs = api("/pulls?state=open&head=" + urllib.parse.quote("linchun7:" + item["name"], safe="") + "&per_page=1")
        require(status == 200 and not prs, "Target acquired an open PR")
        status, branch = api("/branches/" + encoded)
        require(status == 200 and not branch["protected"] and branch["commit"]["sha"] == item["sha"], "Branch changed before deletion")
        status, ref = api("/git/ref/heads/" + encoded)
        require(status == 200 and ref["object"]["sha"] == item["sha"], "Ref changed before deletion")
        status, _ = api("/git/refs/heads/" + encoded, method="DELETE")
        require(status == 204, "Deletion was not confirmed")
        status, _ = api("/git/ref/heads/" + encoded)
        require(status == 404, "Deleted ref is still present")
        print("DELETED_CONFIRMED", item["name"], item["sha"], flush=True)
else:
    print("Read-only preflight passed; no branch deleted.", flush=True)
