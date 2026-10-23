# Evaluating a change to one plugin

Start with the Xdebug workflow in the README. Profile findings are hypotheses,
not production latency or comparative product claims. Keep plugin output and
filter behavior intact, then test the change without profiling.

## Optional before/after timing

Adapt `examples/plugin-before-after.json` to two materialized snapshots of the
same plugin. Set paths, slug, main file, installed WP/PHP versions and an output
marker actually emitted by the plugin. Plans and saved-report/export commands
require explicit identities sharing one slug and main file; additional plugins
and legacy ranked summaries are rejected. No ranks are computed or exported.
For a plugin requiring no setup, declare `setup: { "method": "plugin-defaults" }`.
Otherwise record its deliberate version-specific local options using the
existing setup profile mechanism. Do not bypass onboarding or omit required
features to produce a faster response.

```text
node run.js run --root ../my-plugin --config .local/profiling/before-after.json
```

A hundred samples on one install are exploratory. Core controls provide context,
not isolated plugin CPU attribution. Keep signed differences, minima and medians,
raw failures and runtime identities. Fresh execution tokens, authentication,
native route/content checks and output provenance still apply.

The optional `examples/plugin-repeat-controls.json` illustrates balanced
repeated rounds with an identical no-plugin negative control. Use only when
requested: it increases the budget. Never select samples until a change wins.

## Production confirmation

Confirm useful gains on representative native WordPress hosting with Xdebug
disabled. Do not translate Playground costs using a multiplier. Keep PHP/WordPress,
database, theme, extensions, caches, content and settings explicit; compare only
matching workloads. Report disagreement instead of tuning the experiment to
reproduce an expected winner.

RSS, sitemap XML/XSL/CSS, admin and save workloads belong in their own cohorts.
They do not enter an ordinary HTML average. Different endpoint bodies are not
equivalent work merely because both respond successfully.

The tool is for understanding a plugin and testing its changes. Public competitor
recipes, product rankings and production-performance promises are not provided.
