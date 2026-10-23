---
name: playground-performance
description: >-
  Find WordPress plugin hotspots with triggered Xdebug profiles in Playground.
  Capture Cachegrind, inspect functions and caller/callee edges, and evaluate
  same-plugin changes. Playground timings do not predict production performance.
---

# Playground hotspot profiling

Shared implementation: [wp-plugin-performance](https://github.com/theseoframework/wp-plugin-performance).
Use the existing wp-plugin-regression launcher; keep consumer integrations thin.
Read the installed engine README before setup. Never modify a plugin to satisfy
broken instrumentation.

## Scope and interpretation

This tool finds candidate hotspots. PHP-WASM, SQLite translation, filesystem
behavior and profiling overhead change absolute and relative operation costs.
Measurements do not predict production performance. Confirm useful gains on
representative native WordPress hosting with profiling disabled. Inclusive times
overlap; instrumentation can disproportionately amplify frequent calls.
Do not publish product rankings, competitor comparisons or projected native
savings from these profiles.

## Permission and dependencies

Before any live command, read the consumer's
`.local/playground/permission.txt` explicitly. Its content must be exactly
`PLAYGROUND=True` or `PLAYGROUND=False`.

- Missing: obtain the user's decision before acquisition or live profiling.
- False: skip live work. Do not ask repeatedly.
- True: honor the authorized request and budget without reconfirming.

Never infer consent from installation, copy another consumer's permission or
write the flag without an actual decision. Offline `hotspots`, report rebuilding,
help, doctor and synthetic tests do not authorize or start WordPress.

Use already installed engines and matching Xdebug artifacts. Do not install
tools or download dependencies unless separately authorized. Missing Xdebug
must produce an actionable failure, not silently substitute timing.
The extension-manifest launcher requires a JSPI-capable Node runtime. Offline
inspection remains usable when the installed runtime cannot launch Xdebug.

## Consumer integration

Copy this skill to `.cursor/skills/playground-performance/` in the consumer.
Use [editor integration](references/editors.md) for discovery; do not copy
`lib/`, the launcher or the MU instrumentation into the plugin.
Store engine locations only in the consumer's private
`.local/playground/performance/engine.json`:
`directory` and `regressionDirectory`. Explicit `--regression-dir` is also
supported by the shared command. Pass the real consumer as `--root`.

## Capture

Adapt the engine's `examples/profile.json` to the actual local plugin.
Require explicit installed WordPress and PHP versions. The plan has one
`plugin`, not a product comparison matrix. Start with relevant GET routes.
Explain the budget: five routes × (three warmups + three profiles) = thirty
page requests, plus setup/control probes. Do not expand the user's budget.

```text
node .cursor/skills/playground-performance/scripts/performance.js profile --config .local/profiling/plan.json
```

The engine uses trigger-only profiling, separate unprofiled warmups, unique
Cachegrind files, fresh PHP tokens, native route/auth/status/body checks and real
admin cookies. It keeps source/runtime/request evidence, rejects PHP/SQL
diagnostics and incomplete files, and stops only the exact owned site.
It mounts independent source copies and checks original/executed PHP hashes;
runtime writes must never reach the consumer's working files.
The disposable probe blocks outbound WordPress HTTP and mail; do not install it
on a production site. Browser interaction and direct non-WordPress network
operations are outside that guard's scope.

## Inspect and evaluate

Deliver the offline `report.html`, `hotspots.json`, `functions.csv`,
`edges.csv`, `provenance.json` and raw Cachegrind paths. Use plugin-only self time to find local
work, then inspect callers/callees for child costs and repeated entries.
Do not add overlapping inclusive costs or mistake generators for independent
full executions. Keep requests and route cohorts separate.

```text
node .cursor/skills/playground-performance/scripts/performance.js hotspots --input .local/profiling/saved-run --output .local/profiling/review
```

Standalone Cachegrind imports are supported, but lack validated request
provenance. Rebuilding reports is offline and must preserve old evidence.
Saved-run reports retain recorded runtime and source identity, request records
and a hash of the original manifest. Missing historical fields stay unknown.
Keep paths, credentials, profiles and source backups consumer-private.

After exact output/filter checks, optionally use unprofiled same-plugin
before/after timing. Read the installed engine's `docs/comparisons.md`,
`docs/methodology.md` and `docs/runtimes.md`. Keep OPcache enabled;
do not automatically add cache-off or JIT experiments. Do not treat an isolated
helper percentage as a page gain. Competitor recipes and public leaderboards
are outside this skill.

On Windows keep child consoles hidden. Use only existing tools. Never run Git
commands when prohibited by the user; no workflow here needs Git.
