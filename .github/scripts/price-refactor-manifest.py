"""GitHub-only: package deterministic generated text, never fetch source data."""
import base64
import gzip
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

root = Path.cwd()
out = Path(sys.argv[1]).resolve()
paths = [
    'tools/icloud_price_comparison/index.html',
    'tools/icloud_price_comparison/script.js',
    'tools/icloud_price_comparison/data-contract.js',
    'tools/chatgpt_price_comparison/index.html',
]
changed = subprocess.check_output(['git', 'diff', '--name-only'], text=True).splitlines()
unexpected = sorted(set(changed) - set(paths))
if unexpected:
    raise RuntimeError('Generation changed unauthorized paths: ' + repr(unexpected))
out.mkdir(parents=True, exist_ok=True)
files = []
for name in paths:
    data = (root / name).read_bytes()
    target = out / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(root / name, target)
    files.append({'path': name, 'sha256': hashlib.sha256(data).hexdigest(),
                  'bytes': len(data), 'gzip9_bytes': len(gzip.compress(data, compresslevel=9, mtime=0)),
                  'changed_by_generation': name in changed})
manifest = {'input_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
            'changed_paths': changed, 'files': files}
manifest['supporting_sha256'] = {}
for name in [
    'tools/icloud_price_comparison/data-model.js',
    'tools/icloud_price_comparison/style.css',
    'tools/icloud_price_comparison/vendor/lucide-subset.js',
    'tools/icloud_price_comparison/data/prices.json',
    'tools/icloud_price_comparison/data/history.json',
    'tools/icloud_price_comparison/data/minimum-history.json',
    'tools/chatgpt_price_comparison/app.js',
    'tools/chatgpt_price_comparison/style.css',
    'tools/chatgpt_price_comparison/index.template.html',
    'tools/chatgpt_price_comparison/data/prices.json',
    'tools/chatgpt_price_comparison/data/minimum-history.json',
]:
    manifest['supporting_sha256'][name] = hashlib.sha256((root / name).read_bytes()).hexdigest()
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print(json.dumps(manifest, indent=2))
# Lossless fallback if the artifact ZIP connector cannot be materialized.
# Text is public repository content; no environment or credentials are emitted.
for entry in files:
    name = entry['path']
    encoded = base64.b64encode((root / name).read_bytes()).decode('ascii')
    print('BEGIN_GENERATED_BASE64 ' + name)
    for start in range(0, len(encoded), 3072):
        print(encoded[start:start + 3072])
    print('END_GENERATED_BASE64 ' + name)
