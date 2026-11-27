#!/usr/bin/env bash
#
# Integration tests for the agent-browser browser endpoints.
# Requires: Docker, curl, jq
# Usage: ./test-browser-integration.sh
#
# Tests both the local browser path (Chrome inside container) and the
# host browser path (Chrome connected via --cdp).
#
set -euo pipefail

CONTAINER_NAME="ab-integration-test-$$"
PORT=3399
PASS=0
FAIL=0
IMAGE="${1:-superagent-container}"
RESP_FILE=$(mktemp)

cleanup() {
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rm "$CONTAINER_NAME" 2>/dev/null || true
  rm -f "$RESP_FILE"
}
trap cleanup EXIT

assert_json() {
  local label="$1" field="$2" expected="$3"
  local actual
  actual=$(jq -r "$field" < "$RESP_FILE" 2>/dev/null) || actual="<jq: $field does not apply>"
  if [[ "$actual" == "$expected" ]]; then
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label (expected $field=$expected, got $actual)"
    echo "    Response: $(cat "$RESP_FILE")"
    FAIL=$((FAIL + 1))
  fi
}

post() {
  curl -sf -X POST "http://localhost:$PORT$1" \
    -H 'Content-Type: application/json' \
    -d "$2" \
    -o "$RESP_FILE" 2>/dev/null || echo '{"error":"curl failed"}' > "$RESP_FILE"
}

get() {
  curl -sf "http://localhost:$PORT$1" \
    -o "$RESP_FILE" 2>/dev/null || echo '{"error":"curl failed"}' > "$RESP_FILE"
}

# Like post, but keeps the body of an error answer (4xx/5xx) for assertions.
post_any() {
  curl -s -X POST "http://localhost:$PORT$1" \
    -H 'Content-Type: application/json' \
    -d "$2" \
    -o "$RESP_FILE" 2>/dev/null || echo '{"error":"curl failed"}' > "$RESP_FILE"
}

assert_contains() {
  local label="$1" field="$2" expected="$3"
  local actual
  actual=$(jq -r "$field" < "$RESP_FILE" 2>/dev/null) || actual="<jq: $field does not apply>"
  if [[ "$actual" == *"$expected"* ]]; then
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label (expected $field to contain: $expected)"
    echo "    Response: $(cat "$RESP_FILE")"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_contains() {
  local label="$1" field="$2" unexpected="$3"
  local actual
  actual=$(jq -r "$field" < "$RESP_FILE" 2>/dev/null) || actual="<jq: $field does not apply>"
  if [[ "$actual" != *"$unexpected"* ]]; then
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label (expected $field not to contain: $unexpected)"
    echo "    Response: $(cat "$RESP_FILE")"
    FAIL=$((FAIL + 1))
  fi
}

# The ref of the first line of the last snapshot that contains $1 (a fixed
# string); empty when there is none, so the checks that use it fail instead
# of the script stopping.
ref_of() {
  { jq -r '.snapshot' < "$RESP_FILE" | grep -F -- "$1" | head -1 | grep -oE 'ref=e[0-9]+' | head -1 | cut -d= -f2; } || true
}

echo "=== Agent-Browser Integration Tests ==="
echo "Image: $IMAGE"
echo ""

# ─── Start container ───────────────────────────────────────────────
echo "Starting container..."
docker run -d --name "$CONTAINER_NAME" -p "$PORT:3000" \
  -e ANTHROPIC_API_KEY=fake \
  --init \
  "$IMAGE" >/dev/null

# Wait for health
for i in $(seq 1 10); do
  if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo ""

# ─── Test 1: Local Browser Path ───────────────────────────────────
echo "── Local Browser Path ──"

post /browser/open '{"sessionId":"local","url":"https://example.com"}'
assert_json "open" ".success" "true"

post /browser/snapshot '{"sessionId":"local","interactive":true,"compact":true}'
assert_json "snapshot returns text" "(.snapshot | length > 0)" "true"
assert_json "snapshot has tabCount" "(.tabCount | type)" "number"

post /browser/click '{"sessionId":"local","ref":"@e1"}'
assert_json "click" ".success" "true"

post /browser/screenshot '{"sessionId":"local"}'
assert_json "screenshot" ".success" "true"

# tab new — previously required a workaround in 0.12.0
post /browser/run '{"sessionId":"local","command":"tab new https://example.org"}'
assert_json "tab new (no workaround)" ".success" "true"
assert_json "tab new returns tabInfo" ".tabInfo.tabCount" "2"

post /browser/run '{"sessionId":"local","command":"tab"}'
assert_json "tab list" ".success" "true"

post /browser/run '{"sessionId":"local","command":"get url"}'
assert_json "get url" ".success" "true"

post /browser/run '{"sessionId":"local","command":"eval document.title"}'
assert_json "eval" ".success" "true"

post /browser/close '{"sessionId":"local"}'
assert_json "close" ".success" "true"

get /browser/status
assert_json "status inactive" ".active" "false"

echo ""

# ─── Test 1b: agent-browser 0.45 behaviors ─────────────────────────
# Fixture pages served inside the container on two ports (two origins, for a
# cross-origin iframe), driven through the server's own browser routes.
echo "── agent-browser 0.45 behaviors ──"

docker exec -i "$CONTAINER_NAME" sh -c 'mkdir -p /tmp/fx && cat > /tmp/fx/hints.html' <<'HTML'
<!doctype html><html><head><title>Hints</title></head><body>
<ul>
<li><span id="row1">Price: $5 Blue mug</span> <button data-testid="rm-mug"><svg width="10" height="10"><path d="M0 0L10 10"/></svg></button> <button>Remove</button></li>
<li>Price: $9 Red cup <button data-testid="rm-cup"><svg width="10" height="10"><path d="M0 0L10 10"/></svg></button> <button>Remove</button></li>
</ul>
<button onclick="document.getElementById('row1').textContent='Price: $6 Blue mug'">Reprice</button>
<label>Note <input id="note"></label> <label>Short <input id="short" maxlength="3"></label>
</body></html>
HTML
docker exec -i "$CONTAINER_NAME" sh -c 'cat > /tmp/fx/select.html' <<'HTML'
<!doctype html><html><head><title>Select</title></head><body>
<label>Native <select id="native"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
<label>Ambiguous <select id="amb"><option value="CA">California</option><option value="NY">CA</option></select></label>
<form action="select.html" method="get"><label>Reloads <select name="sort" onchange="this.form.submit()"><option value="new">Newest</option><option value="old">Oldest</option></select></label></form>
<span id="lbl">Fruit</span>
<button role="combobox" aria-labelledby="lbl" aria-expanded="false" aria-controls="lb" id="cb">Pick one</button>
<div role="listbox" id="lb" hidden><div role="option" aria-selected="false">Apple</div><div role="option" aria-selected="false">Pear</div></div>
<div role="listbox" aria-multiselectable="true" aria-label="Toppings"><div role="option" aria-selected="false" tabindex="0">Cheese</div><div role="option" aria-selected="true" tabindex="0">Ham</div></div>
<button id="fake">Not a dropdown</button>
<script>
const cb=document.getElementById('cb'), lb=document.getElementById('lb');
cb.onclick=()=>{const open=lb.hidden; lb.hidden=!open; cb.setAttribute('aria-expanded', String(open));};
lb.querySelectorAll('[role=option]').forEach(o=>o.onclick=()=>{o.setAttribute('aria-selected','true');cb.textContent=o.textContent;lb.hidden=true;cb.setAttribute('aria-expanded','false');});
document.querySelectorAll('[aria-multiselectable] [role=option]').forEach(o=>o.onclick=()=>o.setAttribute('aria-selected', o.getAttribute('aria-selected')==='true'?'false':'true'));
</script>
</body></html>
HTML
docker exec -i "$CONTAINER_NAME" sh -c 'cat > /tmp/fx/frame.html' <<'HTML'
<!doctype html><html><head><title>Top page</title></head><body><h1>Top</h1>
<iframe id="cross" name="payframe" src="http://127.0.0.1:8766/inner.html" width="400" height="150"></iframe>
</body></html>
HTML
docker exec -i "$CONTAINER_NAME" sh -c 'cat > /tmp/fx/inner.html' <<'HTML'
<!doctype html><html><head><title>Inner frame</title></head><body><label>Card <input id="card"></label></body></html>
HTML
docker exec -d "$CONTAINER_NAME" python3 -m http.server 8765 --bind 127.0.0.1 --directory /tmp/fx
docker exec -d "$CONTAINER_NAME" python3 -m http.server 8766 --bind 127.0.0.1 --directory /tmp/fx
for i in $(seq 1 10); do
  docker exec "$CONTAINER_NAME" curl -sf http://127.0.0.1:8766/inner.html >/dev/null 2>&1 && break
  sleep 0.5
done
FX=http://127.0.0.1:8765
S='"sessionId":"ab45"'

# Snapshot hints (0.43, #2578): shown on the line, never read as its value,
# and a hint that changes with its row is not a change.
post /browser/open "{$S,\"url\":\"$FX/hints.html\",\"location\":\"container\"}"
assert_json "open fixture" ".success" "true"
post /browser/snapshot "{$S,\"interactive\":true,\"compact\":true}"
assert_contains "snapshot shows a hint" ".snapshot" 'hint="data-testid:rm-mug; in:Price: $5 Blue mug'
REPRICE=$(ref_of 'button "Reprice"')
NOTE=$(ref_of 'textbox "Note')
SHORT=$(ref_of 'textbox "Short')
post_any /browser/click "{$S,\"ref\":\"@$REPRICE\"}"
assert_json "click" ".success" "true"
assert_not_contains "a hint that changed with its row is no change" ".treeDiff.diff.changed | map(.line.text) | join(\"|\")" 'rm-mug'

# Values that look like flags are filled as text (sent after --).
for v in '--json' '-v' '--'; do
  post_any /browser/fill "{$S,\"ref\":\"@$NOTE\",\"value\":\"$v\"}"
  assert_json "fill \"$v\" as text" ".committedValue" "$v"
done
# The CLI's own warning reaches a raw command (it is on stderr).
post_any /browser/run "{$S,\"args\":[\"fill\",\"@$SHORT\",\"abcdef\"]}"
assert_contains "browser_run passes the CLI's warning on" ".output" '⚠ value_truncated'

# browser_run refusals.
post_any /browser/run "{$S,\"args\":[\"download\",\"@$NOTE\",\"/tmp/x\"]}"
assert_contains "download is refused" ".error" 'browser_download'
post_any /browser/run "{$S,\"args\":[\"get\",\"url\",\"--session\",\"default\"]}"
assert_contains "--session is refused" ".error" '`--session` is an agent-browser option'
post_any /browser/press "{$S,\"key\":\"Option+a\"}"
assert_contains "Option+a names Alt" ".error" 'press "Alt+a"'

# select (0.44, #2592/#2687): native read back, widgets trusted, refusals in the tool's terms.
post /browser/open "{$S,\"url\":\"$FX/select.html\",\"location\":\"container\"}"
post /browser/snapshot "{$S,\"interactive\":true,\"compact\":true}"
NATIVE=$(ref_of 'combobox "Native')
AMB=$(ref_of 'combobox "Ambiguous')
RELOADS=$(ref_of 'combobox "Reloads')
FRUIT=$(ref_of 'combobox "Fruit"')
TOPPINGS=$(ref_of 'listbox "Toppings"')
FAKE=$(ref_of 'button "Not a dropdown"')
post_any /browser/select "{$S,\"ref\":\"@$NATIVE\",\"value\":\"Beta\"}"
assert_json "native select reads back its value" ".committedValue" "b"
post_any /browser/select "{$S,\"ref\":\"@$FRUIT\",\"value\":\"Pear\"}"
assert_json "combobox select succeeds" ".widget" "true"
assert_json "combobox shows the option" ".shows" "Pear"
post_any /browser/select "{$S,\"ref\":\"@$TOPPINGS\",\"value\":\"Cheese\"}"
assert_json "listbox select keeps both options" ".selected | join(\",\")" "Cheese,Ham"
post_any /browser/select "{$S,\"ref\":\"@$AMB\",\"value\":\"CA\"}"
assert_contains "ambiguous value names by:" ".error" 'by: "value"'
post_any /browser/select "{$S,\"ref\":\"@$AMB\",\"value\":\"CA\",\"by\":\"label\"}"
assert_json "by label picks the label" ".committedValue" "NY"
post_any /browser/select "{$S,\"ref\":\"@$FAKE\",\"value\":\"x\"}"
assert_contains "a non-dropdown gets the click recipe" ".error" 'For a dropdown without select/combobox/listbox roles'
post_any /browser/select "{$S,\"ref\":\"@$RELOADS\",\"value\":\"Oldest\"}"
assert_json "a select that reloads the page succeeds" ".navigated" "true"
post_any /browser/click "{$S,\"ref\":\"@$NATIVE\"}"
assert_contains "a ref from the replaced document is named" ".error" 'on the previous page load'

# The harness reads the top page while the agent has a frame selected (0.45, #2738).
post /browser/open "{$S,\"url\":\"$FX/frame.html\",\"location\":\"container\"}"
post_any /browser/run "{$S,\"args\":[\"frame\",\"#cross\"]}"
assert_json "select the cross-origin frame" ".success" "true"
post_any /browser/eval "{$S,\"script\":\"location.href\"}"
assert_contains "the agent's eval runs in the frame" ".output" '8766/inner.html'
post /browser/snapshot "{$S,\"interactive\":true,\"compact\":true}"
assert_json "the status line is the top page's" ".page.title" "Top page"
assert_contains "the status line URL is the top page's" ".page.url" '8765/frame.html'
post_any /browser/eval "{$S,\"script\":\"location.href\"}"
assert_contains "the agent's frame is selected again after the probe" ".output" '8766/inner.html'
post_any /browser/read "{$S}"
assert_contains "browser_read reads the top document" ".text" 'Top'
post_any /browser/run "{$S,\"args\":[\"frame\",\"main\"]}"
post_any /browser/eval "{$S,\"script\":\"location.href\"}"
assert_contains "frame main returns eval to the top" ".output" '8765/frame.html'
# By ref: a snapshot inside the frame replaces the CLI's ref table, and the
# probes still select the frame again (they read the page to restore the ref).
post /browser/snapshot "{$S,\"interactive\":true,\"compact\":true}"
PAYFRAME=$(ref_of 'Iframe "payframe"')
post_any /browser/run "{$S,\"args\":[\"frame\",\"@$PAYFRAME\"]}"
assert_json "select the frame by its ref" ".success" "true"
post /browser/snapshot "{$S,\"interactive\":true,\"compact\":true}"
assert_json "the status line is the top page's with a ref-selected frame" ".page.title" "Top page"
post_any /browser/eval "{$S,\"script\":\"location.href\"}"
assert_contains "a ref-selected frame is still selected after an in-frame snapshot" ".output" '8766/inner.html'
post_any /browser/run "{$S,\"args\":[\"frame\",\"main\"]}"

post /browser/close "{$S}"
assert_json "close" ".success" "true"

echo ""

# ─── Test 2: Host Browser Path (--cdp) ────────────────────────────
echo "── Host Browser Path (--cdp simulation) ──"

# Start a separate Chrome inside the container to simulate a host browser.
# Find Chrome binary dynamically — it may be in agent-browser's cache (x86_64)
# or in Playwright's cache (ARM64).
docker exec "$CONTAINER_NAME" bash -c '
  CHROME=$(find /home/claude/.agent-browser/browsers /opt/playwright-browsers \( -name chrome -o -name headless_shell -o -name chrome-headless-shell \) -type f 2>/dev/null | head -1)
  if [ -z "$CHROME" ]; then echo "No Chrome binary found" >&2; exit 1; fi
  "$CHROME" --headless --no-sandbox --disable-gpu \
    --remote-debugging-port=9444 \
    --user-data-dir=/tmp/host-profile &
  for i in $(seq 1 10); do
    curl -sf http://localhost:9444/json/version >/dev/null 2>&1 && break
    sleep 1
  done
' 2>/dev/null

# Get CDP URL
CDP_WS=$(docker exec "$CONTAINER_NAME" \
  curl -sf http://localhost:9444/json/version 2>/dev/null | jq -r .webSocketDebuggerUrl)

if [[ -z "$CDP_WS" || "$CDP_WS" == "null" ]]; then
  echo "  ✗ Could not get CDP WebSocket URL for host browser simulation"
  FAIL=$((FAIL + 1))
else
  # Test agent-browser --cdp directly (what execBrowser does in host mode)
  docker exec "$CONTAINER_NAME" timeout 15 \
    agent-browser open https://example.com --cdp "$CDP_WS" --json > "$RESP_FILE" 2>&1
  assert_json "cdp open" ".success" "true"

  docker exec "$CONTAINER_NAME" timeout 10 \
    agent-browser snapshot --cdp "$CDP_WS" -i -c --json > "$RESP_FILE" 2>&1
  assert_json "cdp snapshot" ".success" "true"
  assert_json "cdp snapshot has refs" "(.data.refs | keys | length > 0)" "true"

  docker exec "$CONTAINER_NAME" timeout 10 \
    agent-browser click '@e1' --cdp "$CDP_WS" --json > "$RESP_FILE" 2>&1
  assert_json "cdp click" ".success" "true"

  docker exec "$CONTAINER_NAME" timeout 10 \
    agent-browser tab new https://example.org --cdp "$CDP_WS" --json > "$RESP_FILE" 2>&1
  assert_json "cdp tab new" ".success" "true"

  docker exec "$CONTAINER_NAME" timeout 10 \
    agent-browser close --cdp "$CDP_WS" --json > "$RESP_FILE" 2>&1
  assert_json "cdp close" ".success" "true"

  # Kill the simulated host Chrome
  docker exec "$CONTAINER_NAME" pkill -f "remote-debugging-port=9444" 2>/dev/null || true
fi

echo ""

# ─── Summary ──────────────────────────────────────────────────────
TOTAL=$((PASS + FAIL))
echo "=== Results: $PASS/$TOTAL passed ==="
if [[ $FAIL -gt 0 ]]; then
  echo "FAILED"
  exit 1
else
  echo "ALL PASSED"
fi
