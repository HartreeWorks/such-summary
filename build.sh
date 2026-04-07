#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

SRC_DIR="extension"
BUILD_DIR="builds"
SKIP_CHECKS=false
[[ "${1:-}" == "--skip-checks" ]] && SKIP_CHECKS=true

ERRORS=0
WARNINGS=0

error() { echo "  ERROR: $1"; ERRORS=$((ERRORS + 1)); }
warn()  { echo "  WARN:  $1"; WARNINGS=$((WARNINGS + 1)); }

# ── Validation ─────────────────────────────────────────────────
if [[ "$SKIP_CHECKS" == false ]]; then
  echo "Running checks..."

  # 1. manifest.json is valid JSON
  if ! python3 -m json.tool "$SRC_DIR/manifest.json" > /dev/null 2>&1; then
    error "manifest.json is not valid JSON"
  fi

  # 2. Required manifest fields
  for field in name version manifest_version description permissions background icons; do
    if ! python3 -c "import json,sys; d=json.load(open('$SRC_DIR/manifest.json')); assert '$field' in d" 2>/dev/null; then
      error "manifest.json missing required field: $field"
    fi
  done

  # 3. manifest_version is 3
  MV=$(python3 -c "import json; print(json.load(open('$SRC_DIR/manifest.json')).get('manifest_version',''))" 2>/dev/null)
  if [[ "$MV" != "3" ]]; then
    error "manifest_version is $MV, expected 3"
  fi

  # 4. Version format (require x.y.z)
  VERSION=$(python3 -c "import json; print(json.load(open('$SRC_DIR/manifest.json')).get('version',''))" 2>/dev/null)
  if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
    error "Version '$VERSION' doesn't match expected format (e.g. 1.1.0)"
  fi

  # 5. Manifest-referenced files exist
  for icon in $(python3 -c "import json; icons=json.load(open('$SRC_DIR/manifest.json')).get('icons',{}); [print(v) for v in icons.values()]" 2>/dev/null); do
    [[ ! -f "$SRC_DIR/$icon" ]] && error "Manifest icon missing: $icon"
  done
  SW=$(python3 -c "import json; print(json.load(open('$SRC_DIR/manifest.json')).get('background',{}).get('service_worker',''))" 2>/dev/null)
  [[ -n "$SW" && ! -f "$SRC_DIR/$SW" ]] && error "Service worker missing: $SW"
  OP=$(python3 -c "import json; print(json.load(open('$SRC_DIR/manifest.json')).get('options_page',''))" 2>/dev/null)
  [[ -n "$OP" && ! -f "$SRC_DIR/$OP" ]] && error "Options page missing: $OP"

  # 6. HTML-referenced local files exist
  for html in "$SRC_DIR"/*.html; do
    refs=$(grep -oE '(src|href)="[^"]*"' "$html" 2>/dev/null | \
      sed 's/.*="\(.*\)"/\1/' | \
      grep -v '^http' | grep -v '^chrome://' | grep -v '^mailto:' | grep -v '^#' || true)
    for ref in $refs; do
      [[ ! -f "$SRC_DIR/$ref" ]] && error "File referenced in $(basename "$html") not found: $ref"
    done
  done

  # 7. No hardcoded API keys (exclude lib/ and the key-redaction regex)
  KEY_HITS=$(grep -rn --include='*.js' -E 'sk-ant-api[a-zA-Z0-9]|sk-proj-[a-zA-Z0-9]|AIza[a-zA-Z0-9]{30}' \
    --exclude-dir=lib "$SRC_DIR" 2>/dev/null | \
    grep -v 'REDACTED' | grep -v 'replace(' || true)
  if [[ -n "$KEY_HITS" ]]; then
    error "Possible hardcoded API key found:"
    echo "$KEY_HITS" | sed 's/^/    /'
  fi

  # 8. console.log count (informational)
  LOG_COUNT=$(grep -rn --include='*.js' --exclude-dir=lib 'console\.log' "$SRC_DIR" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$LOG_COUNT" -gt 0 ]]; then
    warn "$LOG_COUNT console.log statement(s) in source JS"
  fi

  # Summary
  if [[ $ERRORS -gt 0 ]]; then
    echo ""
    echo "FAILED: $ERRORS error(s), $WARNINGS warning(s)"
    exit 1
  fi
  echo "Checks passed ($WARNINGS warning(s))"
  echo ""
fi

# ── Build ──────────────────────────────────────────────────────
VERSION=$(python3 -c "import json; print(json.load(open('$SRC_DIR/manifest.json'))['version'])")
ZIP_NAME="such-summary-v${VERSION}.zip"
EXTRACT_DIR="$BUILD_DIR/latest"

mkdir -p "$BUILD_DIR"
rm -f "$BUILD_DIR/$ZIP_NAME"

# Copy extension source to a staging directory, then strip dev-only code
STAGE_DIR=$(mktemp -d)
trap 'rm -rf "$STAGE_DIR"' EXIT

rsync -a --exclude='.DS_Store' --exclude='dev-bridge.js' \
  "$SRC_DIR/" "$STAGE_DIR/"

# Strip dev bridge code: remove lines between @dev-bridge-start and @dev-bridge-end markers (inclusive)
find "$STAGE_DIR" -name '*.js' -not -path '*/lib/*' | while read -r file; do
  sed -i '' '/@dev-bridge-start/,/@dev-bridge-end/d' "$file"
done

# Remove devMode from allowedKeys and localFields in background.js setStorage handler
sed -i '' "s/'claudeApiKey', 'devMode', 'usageLogs'/'claudeApiKey', 'usageLogs'/g" "$STAGE_DIR/background.js"

# Clean manifest.json: remove content_scripts (dev-bridge.js) and <all_urls> from host_permissions
python3 -c "
import json
with open('$STAGE_DIR/manifest.json') as f:
    m = json.load(f)
m.pop('content_scripts', None)
if 'host_permissions' in m:
    m['host_permissions'] = [h for h in m['host_permissions'] if h != '<all_urls>']
with open('$STAGE_DIR/manifest.json', 'w') as f:
    json.dump(m, f, indent=2)
    f.write('\n')
"

echo "Stripped dev bridge code from build"

# Verify no dev bridge remnants
DEV_REMNANTS=$(grep -rn '@dev-bridge\|__ext_dev\|devGetStorage' \
  "$STAGE_DIR" --include='*.js' --include='*.json' --exclude-dir=lib 2>/dev/null || true)
if [[ -n "$DEV_REMNANTS" ]]; then
  error "Dev bridge code still present in build:"
  echo "$DEV_REMNANTS" | sed 's/^/    /'
  exit 1
fi

# Verify host_permissions does not contain <all_urls> (web_accessible_resources legitimately needs it)
if python3 -c "import json; m=json.load(open('$STAGE_DIR/manifest.json')); exit(0 if '<all_urls>' in m.get('host_permissions',[]) else 1)" 2>/dev/null; then
  error "Built manifest.json host_permissions still contains <all_urls> — this should be stripped for production"
  exit 1
fi

# Package from staging directory
(cd "$STAGE_DIR" && zip -r -q "$OLDPWD/$BUILD_DIR/$ZIP_NAME" .)

# ── Post-build verification ───────────────────────────────────
LEAKS=$(zipinfo -1 "$BUILD_DIR/$ZIP_NAME" | grep -iE '\.env|\.git|CLAUDE\.md|\.DS_Store|node_modules|^docs/|\.claude/|dev-bridge|\.worktreeinclude|PLAN-|MEMORY\.md' || true)
if [[ -n "$LEAKS" ]]; then
  echo "ERROR: Unwanted files in zip:"
  echo "$LEAKS" | sed 's/^/  /'
  rm -f "$BUILD_DIR/$ZIP_NAME"
  exit 1
fi

# Refresh an extracted build for easy "Load unpacked" testing in Chrome.
if [[ -d "$EXTRACT_DIR" ]]; then
  trash "$EXTRACT_DIR"
fi
mkdir -p "$EXTRACT_DIR"
unzip -oq "$BUILD_DIR/$ZIP_NAME" -d "$EXTRACT_DIR"

# ── Summary ───────────────────────────────────────────────────
SIZE=$(du -h "$BUILD_DIR/$ZIP_NAME" | cut -f1 | tr -d ' ')
COUNT=$(zipinfo -t "$BUILD_DIR/$ZIP_NAME" 2>/dev/null | grep -oE '[0-9]+ files' || echo "? files")

echo "Built $ZIP_NAME ($SIZE, $COUNT)"
echo "Extracted to $EXTRACT_DIR"
echo ""
zipinfo -1 "$BUILD_DIR/$ZIP_NAME" | sed 's/^/  /'
echo ""
echo "-> $BUILD_DIR/$ZIP_NAME"
echo "-> $EXTRACT_DIR"

# ── Sync to public GitHub repo ───────────────────────────────
bash sync-public.sh
