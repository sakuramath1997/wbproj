#!/usr/bin/env bash
# =============================================================
# check-core-constraints.sh
#
# Core layer (src/core/) の制約を検証するスクリプト。
# ESLint 未導入のため、簡易的に grep ベースでチェックする。
#
# 制約 (whiteboard-architecture-spec v1.4 §3):
#   1. React 依存禁止 (react, react-dom)
#   2. Yjs 依存禁止 (yjs, y-*)
#   3. ブラウザ API 直接使用禁止 (document, window, localStorage, etc.)
#   4. __tests__/ 配下は制約対象外
# =============================================================

set -euo pipefail

CORE_DIR="src/core"
ERRORS=0

if [ ! -d "$CORE_DIR" ]; then
  echo "ERROR: $CORE_DIR not found"
  exit 1
fi

echo "=== Core Layer Constraint Check ==="
echo ""

# Collect .ts files (exclude __tests__)
FILES=$(find "$CORE_DIR" -name '*.ts' -not -path '*/__tests__/*')

for f in $FILES; do
  # 1. React imports
  if grep -nE "from\s+['\"]react['\"]|from\s+['\"]react-dom['\"]|require\(['\"]react" "$f" 2>/dev/null; then
    echo "  ❌ REACT import in $f"
    ERRORS=$((ERRORS + 1))
  fi

  # 2. Yjs imports
  if grep -nE "from\s+['\"]yjs['\"]|from\s+['\"]y-" "$f" 2>/dev/null; then
    echo "  ❌ YJS import in $f"
    ERRORS=$((ERRORS + 1))
  fi

  # 3. Browser globals (in non-type-only positions)
  #    Allow: type annotations, comments, string literals
  if grep -nE "^\s*(document\.|window\.|localStorage\.|sessionStorage\.|navigator\.)" "$f" 2>/dev/null; then
    echo "  ❌ Browser API in $f"
    ERRORS=$((ERRORS + 1))
  fi
done

echo ""
if [ "$ERRORS" -eq 0 ]; then
  echo "✅ All core constraints satisfied ($CORE_DIR)"
else
  echo "❌ $ERRORS constraint violation(s) found"
  exit 1
fi
