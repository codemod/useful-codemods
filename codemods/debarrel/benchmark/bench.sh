#!/usr/bin/env bash
#
# Benchmark build & test wall-clock time for a target repository.
#
# Intended workflow: run this once BEFORE applying the debarrel codemod
# (label "baseline") and once AFTER (label "debarreled"), then diff the two
# result files to see how removing barrel files affected build/test time.
#
# The script is repo-agnostic: point it at any repo and override the build /
# test / clean commands to match that repo's tooling.
#
# ---------------------------------------------------------------------------
# Usage:
#   bench.sh [label] [--repo <path>] [options]
#
# Options (all have env-var equivalents in parentheses):
#   --repo <path>        Repo to benchmark            (TARGET_REPO, default: $PWD)
#   --label <name>       Label for this run           (LABEL, default: baseline)
#   --build-cmd <cmd>    Build command                (BUILD_CMD, default: "yarn build --force")
#   --test-cmd <cmd>     Test command                 (TEST_CMD,  default: "yarn test")
#   --clean-cmd <cmd>    Cleanup run before each build and once before tests,
#                        for a cold measurement       (CLEAN_CMD, default: "rm -rf apps/web/.next")
#   --build-runs <n>     Build repetitions            (BUILD_RUNS, default: 3)
#   --test-runs <n>      Test repetitions             (TEST_RUNS,  default: 3)
#   --out <dir>          Output directory             (OUTDIR, default: <repo>/bench-results)
#   --no-build           Skip the build phase         (DO_BUILD=0)
#   --no-test            Skip the test phase          (DO_TEST=0)
#   -h, --help           Show this help
#
# Output:
#   <out>/<timestamp>_<label>_<sha>.md   Markdown summary (min/mean/max)
#   <out>/<timestamp>_<label>_<sha>.log  Full command output for debugging
#
# The defaults target the cal.com monorepo. For other repos, override
# --build-cmd / --test-cmd / --clean-cmd accordingly (see README.md).
# ---------------------------------------------------------------------------

set -uo pipefail

TARGET_REPO="${TARGET_REPO:-$PWD}"
LABEL="${LABEL:-baseline}"
BUILD_CMD="${BUILD_CMD:-yarn build --force}"
TEST_CMD="${TEST_CMD:-yarn test}"
CLEAN_CMD="${CLEAN_CMD:-rm -rf apps/web/.next}"
BUILD_RUNS="${BUILD_RUNS:-3}"
TEST_RUNS="${TEST_RUNS:-3}"
DO_BUILD="${DO_BUILD:-1}"
DO_TEST="${DO_TEST:-1}"
OUTDIR="${OUTDIR:-}"

show_help() { sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)       TARGET_REPO="$2"; shift 2;;
    --label)      LABEL="$2"; shift 2;;
    --build-cmd)  BUILD_CMD="$2"; shift 2;;
    --test-cmd)   TEST_CMD="$2"; shift 2;;
    --clean-cmd)  CLEAN_CMD="$2"; shift 2;;
    --build-runs) BUILD_RUNS="$2"; shift 2;;
    --test-runs)  TEST_RUNS="$2"; shift 2;;
    --out)        OUTDIR="$2"; shift 2;;
    --no-build)   DO_BUILD=0; shift;;
    --no-test)    DO_TEST=0; shift;;
    -h|--help)    show_help; exit 0;;
    -*)           echo "Unknown option: $1" >&2; exit 2;;
    *)            LABEL="$1"; shift;;
  esac
done

if [ ! -d "$TARGET_REPO" ]; then
  echo "Target repo not found: $TARGET_REPO" >&2
  exit 1
fi
TARGET_REPO="$(cd "$TARGET_REPO" && pwd)"
cd "$TARGET_REPO"

: "${OUTDIR:=$TARGET_REPO/bench-results}"
mkdir -p "$OUTDIR"

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
BRANCH="$(git branch --show-current 2>/dev/null || echo nogit)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$OUTDIR/${STAMP}_${LABEL}_${SHA}.md"
LOG="$OUTDIR/${STAMP}_${LABEL}_${SHA}.log"

# Run a command under `/usr/bin/time -p` and echo "<real_seconds> <exit_code>".
# Uses `real` (wall clock) which reflects the full process tree.
time_real() {
  local tmp real code
  tmp="$(mktemp)"
  /usr/bin/time -p bash -c "$1" >>"$LOG" 2>"$tmp"
  code=$?
  cat "$tmp" >>"$LOG"
  real="$(grep '^real' "$tmp" | tail -1 | awk '{print $2}')"
  rm -f "$tmp"
  echo "${real:-NaN} ${code}"
}

# min / mean / max from a list of numbers.
stats() {
  python3 - "$@" <<'PY'
import sys
vals = [float(x) for x in sys.argv[1:] if x not in ("", "NaN")]
if not vals:
    print("n/a"); sys.exit(0)
mean = sum(vals) / len(vals)
print(f"min={min(vals):.2f}s  mean={mean:.2f}s  max={max(vals):.2f}s")
PY
}

{
  echo "# Benchmark: $LABEL"
  echo
  echo "- Date: $(date)"
  echo "- Repo: \`$TARGET_REPO\`"
  echo "- Git: \`$SHA\` on \`$BRANCH\`"
  echo "- Node: $(node --version 2>/dev/null)"
  echo "- Build cmd: \`$BUILD_CMD\`  (runs: $BUILD_RUNS)"
  echo "- Test cmd: \`$TEST_CMD\`  (runs: $TEST_RUNS)"
  echo "- Clean cmd: \`${CLEAN_CMD:-<none>}\`"
  echo
} | tee "$OUT"

if [ "$DO_BUILD" = "1" ]; then
  echo "## Build (\`$BUILD_CMD\`)" | tee -a "$OUT"
  echo | tee -a "$OUT"
  build_times=()
  for i in $(seq 1 "$BUILD_RUNS"); do
    [ -n "$CLEAN_CMD" ] && eval "$CLEAN_CMD" >>"$LOG" 2>&1
    read -r t c < <(time_real "$BUILD_CMD")
    echo "- run $i: ${t}s (exit $c)" | tee -a "$OUT"
    build_times+=("$t")
  done
  echo | tee -a "$OUT"
  echo "**Build: $(stats "${build_times[@]}")**" | tee -a "$OUT"
  echo | tee -a "$OUT"
fi

if [ "$DO_TEST" = "1" ]; then
  echo "## Test (\`$TEST_CMD\`)" | tee -a "$OUT"
  echo | tee -a "$OUT"
  # Clean once so tests run on source, not on stale build output. A leftover
  # build dir (e.g. apps/web/.next) makes some runners discover compiled
  # *.test.js files, adding noise and false failures.
  [ -n "$CLEAN_CMD" ] && eval "$CLEAN_CMD" >>"$LOG" 2>&1
  test_times=()
  for i in $(seq 1 "$TEST_RUNS"); do
    read -r t c < <(time_real "$TEST_CMD")
    echo "- run $i: ${t}s (exit $c)" | tee -a "$OUT"
    test_times+=("$t")
  done
  echo | tee -a "$OUT"
  echo "**Test: $(stats "${test_times[@]}")**" | tee -a "$OUT"
  echo | tee -a "$OUT"
fi

echo "Full command output logged to: $LOG" | tee -a "$OUT"
echo | tee -a "$OUT"
echo "Results written to $OUT"
