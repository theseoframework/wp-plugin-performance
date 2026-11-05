# WordPress plugin hotspot profiling

Find expensive functions, repeated work and costly call paths in one WordPress
plugin using Xdebug in an isolated WordPress Playground site. Keep raw Cachegrind
files for KCachegrind/QCachegrind, or inspect the generated offline HTML viewer,
function/edge CSV and complete JSON. Node built-ins power the engine; it uses the
already installed [wp-plugin-regression](https://github.com/theseoframework/wp-plugin-regression)
launcher and an existing matching Playground Xdebug artifact.

**Playground diagnostics do not predict production performance.**

## Installation

### Instant implementation

In your open plugin repository, tell your AI agent:

```md
Implement https://github.com/theseoframework/wp-plugin-performance for this repo.
```

### Manual

1. Download or copy this repository's files into a private folder outside your plugin source.
2. Prepare the existing Node, wp-plugin-regression and Xdebug dependencies listed under [Requirements and configuration](#requirements-and-configuration). This engine itself needs no `npm install`.
3. Copy `skills/playground-performance/` into your plugin's `.cursor/skills/playground-performance/` and configure the private engine locations as described below.
4. Open a terminal in the engine folder and run `node run.js --help`. Follow [Capture profiles](#capture-profiles) when ready to profile.

Before an agent acquires missing dependencies or launches WordPress, obtain the
user's decision and follow the recorded permission workflow below.

## What these results mean

**Playground diagnostics do not predict production performance.** PHP-WASM,
SQLite translation, filesystem behavior and profiling overhead can change both
absolute timings and the relative cost of operations. Use profiles to identify
candidate improvements, then confirm useful gains on representative native
WordPress hosting with profiling disabled.

Inclusive times overlap: do not add parent and child costs. Xdebug can amplify
frequent function calls disproportionately. A large profiled saving does not
establish an equivalent normal-request improvement. Calls count profiler entries;
recursive calls and generator resumptions need interpretation. This tool does
not establish which plugin is fastest or publish competitor rankings.

## Requirements and configuration

- Node 20.18 or newer for offline inspection and tests. Live profiling additionally
  requires a JSPI-capable Node runtime for the extension-manifest workflow;
  unsupported runtimes fail before launching WordPress.
- An already installed compatible wp-plugin-regression declaring
  `wpPluginPerformanceApi: 1`, with per-site OPcache profiles and the `--cli` override.
- A Playground PHP build exposing `getXdebugExtensionPath()` and its existing,
  matching Xdebug artifact. The initial workflow was exercised with PHP 8.3;
  other branches must actually provide their extension. No branch silently falls
  back to another version or unprofiled timing.
- A materialized local plugin directory with a valid Version header.

No command installs tools, invokes Git or modifies the plugin source.
The launcher may need WordPress/runtime files; prepare these beforehand when
working offline. Missing software should be installed explicitly by the operator.

Copy `skills/playground-performance/` into the consumer's
`.cursor/skills/playground-performance/`. Keep runtime implementations here.
See [editor integration](skills/playground-performance/references/editors.md).
Store the existing engine locations privately in the consumer:

```json
{
  "directory": "../wp-plugin-performance",
  "regressionDirectory": "../wp-plugin-regression"
}
```

Save that JSON as `.local/playground/performance/engine.json`.
Before live use, obtain the user's decision and record exactly `PLAYGROUND=True`
or `PLAYGROUND=False` in `.local/playground/permission.txt`. Never invent consent,
copy another consumer's permission, or create the flag during installation.
Offline inspection does not require live consent.

## Capture profiles

Copy [examples/profile.json](examples/profile.json) into the consumer's private
workspace. Set the actual plugin slug, main PHP file, path and explicit installed
WordPress/PHP versions. The example versions are reproducible inputs, not a claim
about the latest releases. Optional `options` supplies deliberate local WordPress
options; optional `xdebugArtifact` selects an existing matching extension file.

```text
node run.js doctor --root ../my-plugin --regression-dir ../wp-plugin-regression
node run.js profile --root ../my-plugin --config .local/profiling/plan.json --regression-dir ../wp-plugin-regression
```

From an installed consumer skill:

```text
node .cursor/skills/playground-performance/scripts/performance.js profile --config .local/profiling/plan.json
```

The default example captures five routes: blog homepage, static homepage,
posts page, post and page. Each receives three unprofiled warmups and three
triggered profiles: **30 page requests**, plus untimed setup/control requests.
Override with `--warmups=3 --profiles=3 --scenarios=home-static,post`.
Each capture remains separate; routes and repeated samples are never pooled into
a product score. Other supported GET scenarios include category, tag, search,
404, dashboard, posts-list, pages-list, post-editor and page-editor. Unsupported
routes and editor-save are rejected before captures.

The command creates an owned disposable site, seeds identical local content,
activates only the selected plugin, blocks outbound WordPress HTTP/mail, and uses
real WordPress authentication for admin requests. It validates fresh execution
tokens, user state, native route, status, body and trigger state. Source
fingerprints, actual runtime and request evidence are retained. PHP/SQL diagnostics,
changed activation/source, missing Xdebug and incomplete profiles fail the run.
WordPress receives an independent copy of the selected plugin mounts, never
writable working-tree files. Both original and executed PHP fingerprints must
remain unchanged. Snapshots and evidence stay under the private run directory.
Only that owned session is stopped, including on failure; unrelated sessions
are never stopped. Site data remains disposable launcher state; raw evidence is
retained. Do not run this MU instrumentation on production sites.

## Inspect hotspots

Open the generated `report.html`. Filter plugin functions or inspect WordPress
and internal callees; sort by self time, inclusive time or call count. Select a
function for its direct caller/callee edges. Raw `raw/cachegrind.*` files work
in KCachegrind/QCachegrind without the custom viewer.

Build a fresh report from a validated saved run, without starting WordPress:

```text
node run.js hotspots --root ../my-plugin --input .local/profiling/saved-run --output .local/profiling/review
```

Or inspect an existing uncompressed Xdebug Cachegrind file:

```text
node run.js hotspots --root ../my-plugin --input .local/profiling/cachegrind.out --output .local/profiling/review --plugin-prefix /wordpress/wp-content/plugins/my-plugin
```

A standalone import has no request/source validation provenance; the report
labels that limitation. Raw profiles may contain private paths and function names:
keep consumer evidence private. Reports use no CDN, telemetry or remote assets.
Saved-run imports retain recorded runtime, plugin/source hashes, request identity
and the original manifest hash in HTML, Markdown, JSON and `provenance.json`.
Missing historical fields are explicitly unknown; a standalone file cannot
establish its hosting environment from its header alone.

## Validate an improvement

Use a profile as a hypothesis. Preserve output, filters and observable behavior;
reduce actual work, then measure without profiling. Optional same-plugin
before/after timing remains available through `run`, `prepare`, `resume`,
`stop`, `report` and `export`. Plans, saved reports and exports require explicit
identities with one shared plugin slug and main file. Cross-plugin data,
additional activated plugins, unknown identities and legacy ranked summaries
are rejected. Ranks are not computed or exported. Rebuild older same-plugin
reports from their raw checkpoints with explicit identity metadata.
See [before/after instructions](docs/comparisons.md),
[measurement scope](docs/methodology.md) and [runtimes](docs/runtimes.md).
Cross-runtime timing conversion and production leaderboards are unsupported.

## Development

```text
npm test
node run.js --help
node test/profile-runtime.js ../wp-plugin-regression 8.3
node test/profile-guard.js <installed-php> <wordpress-source>
```

Synthetic tests check the parser, reports, request validation, consent, source
identity and lifecycle failures. They are not evidence of a real-world speedup.
See [release checks](docs/releasing.md). License: GPL-3.0-only.
