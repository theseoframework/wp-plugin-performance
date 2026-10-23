# Agent instructions

- Read `README.md` for engine layout and commands. Shared implementations live
  in `lib/` and `mu-plugin/`; consumer integrations stay thin.
- Hotspot profiling is the primary workflow. Playground diagnostics do not predict
  production performance. Keep public examples generic and limited to one plugin;
  preserve self/inclusive/call-count distinctions and native confirmation guidance.
- For benchmarks or consumer installation, read
  `skills/playground-performance/SKILL.md`. Obtain and honor the consumer's
  recorded permission before acquiring dependencies or launching live tests.
  A setup-only request does not authorize an otherwise unapproved live benchmark.
- Do not create, amend or publish commits, change Git refs/remotes, or modify
  GitHub state. Git inspection is read-only. Do not run clone/fetch/pull here.
- Never access a path containing `.local/.cursor/`, including symlink targets.
  Do not inspect or edit minified JS/CSS. Keep private paths, setup credentials,
  runtime configuration, consent and benchmark evidence under consumer `.local/`.
- Do not add hardware drivers, change host security/power/cooling settings, or
  trigger UAC as an implicit part of benchmarking.
- Do not change plugin code to satisfy a broken harness. Fix the harness and
  preserve invalid evidence. Never weaken response validation or treat N/A as fast.
- Use Node built-ins for the core engine. Run `npm test` after implementation
  changes and relevant live smoke checks after launcher/instrumentation changes.
  Honor the user's sample budget; synthetic fixtures are not performance evidence.
- Keep paths relative to the consumer `--root`, propagate child-process failures,
  and clean up only the exact sessions this run owns. Never stop all consumers.
- Follow existing CommonJS/tab formatting. Use LF and final newlines. Preserve
  GPL notices and never copy machine-local benchmark data into public source.
