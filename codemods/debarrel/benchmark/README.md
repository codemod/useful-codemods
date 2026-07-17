# debarrel benchmark

A small, dependency-free shell script to measure **build** and **test** wall-clock
time of a target repository, so you can quantify the impact of the `debarrel`
codemod.

The intended workflow is:

1. Measure a **baseline** on the untouched repo.
2. Run the `debarrel` codemod on that repo.
3. Measure again (**debarreled**).
4. Diff the two result files.

## Requirements

- `bash`, `python3`, and `/usr/bin/time` (preinstalled on macOS and most Linux distros)
- Whatever toolchain the target repo needs to build and test (e.g. `yarn`)
- The target repo already has its dependencies installed (`yarn install`, etc.)

No packages are installed by the script itself.

## Inputs

Everything is configurable via flags or environment variables. Flags win over
env vars.

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--repo <path>` | `TARGET_REPO` | `$PWD` | Repository to benchmark |
| `[label]` / `--label <name>` | `LABEL` | `baseline` | Label for this run (used in output filenames) |
| `--build-cmd <cmd>` | `BUILD_CMD` | `yarn build --force` | Command used to build |
| `--test-cmd <cmd>` | `TEST_CMD` | `yarn test` | Command used to test |
| `--clean-cmd <cmd>` | `CLEAN_CMD` | `rm -rf apps/web/.next` | Runs before **each** build run and once before the test phase, for a cold measurement |
| `--build-runs <n>` | `BUILD_RUNS` | `3` | Number of build repetitions |
| `--test-runs <n>` | `TEST_RUNS` | `3` | Number of test repetitions |
| `--out <dir>` | `OUTDIR` | `<repo>/bench-results` | Where to write results |
| `--no-build` | `DO_BUILD=0` | — | Skip the build phase |
| `--no-test` | `DO_TEST=0` | — | Skip the test phase |
| `-h`, `--help` | — | — | Print usage |

> The defaults target the [cal.com](https://github.com/calcom/cal.com) monorepo.
> For other repos, override `--build-cmd`, `--test-cmd`, and `--clean-cmd`.

### Why a "clean" command?

Build tools cache aggressively (Turbo, Next.js, etc.). To measure the *real*
build cost — which is what debarreling changes — each build run first runs the
clean command and the build uses a cache-busting flag (`--force` for Turbo).

The clean command also runs once before the test phase: a leftover build
directory (like `apps/web/.next`) can make the test runner pick up compiled
`*.test.js` files, which adds noise and can cause false failures.

## Outputs

Two files per invocation, written to the output directory:

- `<timestamp>_<label>_<sha>.md` — human-readable summary with per-run times
  and `min / mean / max` for each phase.
- `<timestamp>_<label>_<sha>.log` — full stdout/stderr of every command, for
  debugging failures.

Example summary:

```md
# Benchmark: baseline

- Date: Fri Jul 17 01:20:00 PDT 2026
- Repo: `/Users/you/cal.com`
- Git: `f004349273` on `main`
- Node: v20.17.0
- Build cmd: `yarn build --force`  (runs: 3)
- Test cmd: `yarn test`  (runs: 3)
- Clean cmd: `rm -rf apps/web/.next`

## Build (`yarn build --force`)

- run 1: 74.35s (exit 0)
- run 2: 72.10s (exit 0)
- run 3: 73.02s (exit 0)

**Build: min=72.10s  mean=73.16s  max=74.35s**

## Test (`yarn test`)

- run 1: 27.01s (exit 0)
- run 2: 26.44s (exit 0)
- run 3: 26.88s (exit 0)

**Test: min=26.44s  mean=26.78s  max=27.01s**
```

## How to run

From this directory (or reference it by full path):

```bash
# 1) Baseline — before running the codemod
./bench.sh baseline --repo /path/to/cal.com

# 2) Run the debarrel codemod on the target repo
#    (from the target repo)
codemod run debarrel

# 3) Debarreled — after the codemod
./bench.sh debarreled --repo /path/to/cal.com
```

Custom commands for a non-cal.com repo:

```bash
./bench.sh baseline \
  --repo /path/to/app \
  --build-cmd "pnpm build" \
  --test-cmd "pnpm test" \
  --clean-cmd "rm -rf dist .turbo" \
  --build-runs 5 --test-runs 5
```

Only benchmark tests (skip the slow build phase):

```bash
./bench.sh baseline --repo /path/to/app --no-build
```

## Comparing results

The `min` (fastest, least-noisy) run is usually the most reliable single number
to compare. Diff the two summary files:

```bash
diff \
  bench-results/<baseline>.md \
  bench-results/<debarreled>.md
```

## Notes on accuracy

- Close other heavy apps; wall-clock time is sensitive to CPU/thermal load.
- Stop any running dev server for the target repo before benchmarking to avoid
  file/CPU contention.
- Run on power (not battery) on laptops.
- Prefer comparing `min` across runs; use `mean`/`max` to judge variance.
