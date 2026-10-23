# Project guidance

Read and follow [AGENTS.md](../AGENTS.md) before working in this repository.
For plugin hotspot profiling, consumer integration or saved-report generation, use
[the performance skill](../skills/playground-performance/SKILL.md).
Include the offline hotspot HTML report and raw Cachegrind evidence. Playground
diagnostics do not predict production performance. Use the real consumer plugin
as `--root` and preserve its permission gate and requested measurement budget.
