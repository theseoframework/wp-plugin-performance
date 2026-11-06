# Editor integration

Install the canonical skill under the consumer's
`.cursor/skills/playground-performance/`. Its dispatcher invokes the shared
engine; do not copy implementation files into a plugin.

Cursor discovers that skill directly. For Copilot, add a link from the consumer's
existing `.github/copilot-instructions.md`:

> For WordPress plugin hotspot profiling, use the installed
> playground-performance skill. Honor recorded permission and the request budget.
> Playground diagnostics do not predict production performance.

For Claude Code, add a forwarding `.claude/skills/playground-performance/SKILL.md`
with the name `playground-performance`, a description about Xdebug hotspot
profiling, and a link to
`../../../.cursor/skills/playground-performance/SKILL.md`. Preserve existing
repository guidance. Do not duplicate the runtime or create consent flags.

```text
node .cursor/skills/playground-performance/scripts/performance.js --help
node .cursor/skills/playground-performance/scripts/performance.js profile --config .local/profiling/plan.json
node .cursor/skills/playground-performance/scripts/performance.js hotspots --input .local/profiling/run --output .local/profiling/review
node .cursor/skills/playground-performance/scripts/performance.js prune --input .local/profiling/run
```

The last two operations are offline. The cleanup command previews the raw files
until authorized with `--apply`. Reports and retained raw evidence stay private
to the consumer. Editor discovery does not grant installation or live profiling
permission.
