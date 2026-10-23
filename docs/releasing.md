# Release checks

The tool's primary purpose is Xdebug hotspot discovery, not production
performance claims. Publish usage instructions and limitations; do not publish
consumer measurements, source backups, credentials or competitor leaderboards.

Before release:

- Run `npm test`, `node run.js --help`, and the profiling launcher smoke test
  with an already installed matching PHP/Xdebug build.
  `node test/profile-runtime.js ../wp-plugin-regression 8.3` exercises the
  existing extension with synthetic PHP and no WordPress download.
- Exercise one authorized disposable WordPress plugin profile. Verify
  unprofiled warmups, triggered files, actual extension availability, complete
  Cachegrind summaries, source/runtime/response hashes and ownership cleanup.
- Check missing extension, malformed/truncated profiles, reused names, source
  drift, wrong auth/route/status, PHP/SQL errors and failure cleanup.
- Open the offline report. Check plugin/all filtering, sorting, request selection,
  keyboard-accessible caller/callee inspection, HTML escaping and no remote assets.
- Confirm the production-performance disclaimer appears in README, skill and
  generated profiling/timing reports.
- Run `node test/profile-guard.js <installed-php> <wordpress-source>` against
  installed WordPress hooks. A later filter resuming HTTP/mail must not reach a
  transport; conflicting outbound-HTTP constants must reject fixture startup.
- Verify runtime writes affect only independent plugin copies. Rebuild a saved
  hotspot report and check its portable runtime/source/request provenance.
- Verify cross-plugin and unidentified saved reports/exports are rejected and
  no rank field or ranking computation is shipped.
- Verify the package contains generic instructions/examples, no machine paths
  or consumer evidence, and only existing dependency requirements.

The matching regression launcher must declare `wpPluginPerformanceApi: 1` and
actually support per-site OPcache configuration and the CLI override. A metadata
field alone does not implement the required capabilities.

Windows, macOS and Linux synthetic tests do not prove live behavior on every
platform. Label actual tested runtimes and remaining limitations. A publishable
diagnostic tool does not require a claim that a particular plugin is fastest.
