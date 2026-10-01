#!/usr/bin/env bash
set -euo pipefail
echo "superseded=false" >> "$GITHUB_OUTPUT"
[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::Missing exact production baseline."; exit 1; }
git fetch origin main --depth=1
current_main_sha=$(git rev-parse origin/main)
git fetch origin "$BASE_SHA" --depth=1
diff_status=0
python3 tools/chatgpt_price_comparison/scripts/deployment_scope.py --base "$BASE_SHA" --head "$current_main_sha" || diff_status=$?
case "$diff_status" in
  1)
    echo "::notice title=SUPERSEDED_CHATGPT_VERIFY_RECHECK::A newer ChatGPT project commit took over during verification."
    echo "superseded=true" >> "$GITHUB_OUTPUT"
    ;;
  0) echo "::error::Production verification failed and the expected ChatGPT snapshot is still current."; exit 1 ;;
  *) echo "::error::Cannot establish ChatGPT deployment supersession."; exit "$diff_status" ;;
esac
