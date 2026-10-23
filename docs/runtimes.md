# PHP runtimes and caching

## Xdebug hotspot workflow

The primary `profile` command loads an existing matching Xdebug artifact through
the installed Playground extension-manifest API. This launcher requires a
JSPI-capable Node runtime. Unsupported builds fail before WordPress is launched;
there is no automatic installation or fallback to another PHP version.
The installed-runtime smoke is `node test/profile-runtime.js <regression-dir> 8.3`.

Profiling uses `xdebug.mode=profile`, `start_with_request=trigger`, a unique
session trigger, uncompressed Cachegrind and a dedicated output mount. Warmups
do not receive the trigger. Each profiled request must identify its own complete
raw file. Actual runtime/version checks, fresh PHP tokens, route/auth/body
validation and source fingerprints remain required.

These are diagnostic costs. Xdebug changes execution costs, inclusive times
overlap, and call-heavy code can look disproportionately expensive. Confirm any
useful change on representative native hosting with profiling disabled. Native
Cachegrind imports can also be inspected offline; standalone imports do not
establish request/source validation provenance.

The remaining sections describe optional unprofiled same-plugin timing.

The current runner uses WordPress Playground's PHP-WASM runtime. The `--php`
option selects a supported WebAssembly PHP version. It does not select a host
PHP executable.

## OPcache and PHP JIT

OPcache can run in Playground. It caches Zend bytecode; PHP JIT compiles selected
PHP execution paths to native machine code. These are separate capabilities.
Playground's PHP build enables OPcache and explicitly disables PHP JIT with
`--disable-opcache-jit`. Changing `opcache.jit` in php.ini cannot add a compiler
backend missing from that build. The JavaScript engine's WebAssembly compilation
is also separate from PHP JIT.

OPcache behavior depends on the PHP build, SAPI and memory/file-cache settings.
The regression launcher can stage its own php.ini, so upstream default settings
do not establish the configuration of an individual benchmark. Inspect the
recorded runtime and launcher configuration. An enabled ini setting alone does
not establish a working cache, warmed scripts or a running JIT.

The plan's `opcacheMode` (or `--opcache-mode`) accepts `auto`, `memory`, `file`
and `off`. `auto` selects in-memory caching for PHP 8.1+ and file-only caching
for PHP 7.4/8.0. Each fresh site receives its own startup manifest and php.ini;
the shared configuration is never edited during an experiment. Unsupported
profiles fail instead of silently falling back. Timestamp validation and PHP's
file-age protection remain enabled. Changing the profile requires a new server.

New runs retain actual running status, file-only mode, hits, misses, worker PID,
cache start/restart counters and JIT status at untimed block boundaries.
`cache-reuse.csv` distinguishes observed reuse from an enabled setting, different
worker/cache instances, resets, absent evidence and file-only caches without
public statistics. Hit growth must exceed the final observation request's own
included-file count before it is called observed reuse. The runner takes bounded batches
of untimed probes, matches the latest before and earliest after snapshot by
worker PID, and checks cache start/restart identity before subtracting counters.
Coverage and per-worker results remain visible; missing workers stay explicit.
Probing stops as soon as the configured pool is observed, with a cap of twice
the worker count per boundary. These are extra control requests outside timing;
the requested route-specific warmup and measured budgets remain separate.
These are not isolated hit rates for measured requests.
The included-file allowance is a diagnostic heuristic. A strict attribution
check also measures control-only hit costs on each observed worker. A new cache-
benefit claim needs a matched disabled/enabled diagnostic explicitly requested
by the user; normal plugin comparisons keep the standard enabled profile.
Observed reuse does not establish a completely warmed route. Retain additional
misses/script growth and investigate later includes or background activity before
claiming a settled cache plateau; do not discard those raw requests.

For an explicitly requested cache-benefit diagnostic, compare the same pinned fixture with
`off` and `memory` in separate outputs, identical request budgets and reversed
profile order. Keep each profile's plugin comparisons in its own cohort. A
compile-heavy positive control can prove bytecode reuse even when a database-
or I/O-heavy route changes little. It cannot stand in for WordPress timings.

See the [Playground build configuration](https://github.com/WordPress/wordpress-playground/blob/trunk/packages/php-wasm/compile/php/Dockerfile),
[runtime initialization](https://github.com/WordPress/wordpress-playground/blob/trunk/packages/php-wasm/universal/src/lib/php.ts)
and [PHP OPcache configuration](https://www.php.net/manual/en/opcache.configuration.php).

## Standard performance profile

Use enabled OPcache only for ordinary plugin performance comparisons. The
performance runner and public plans default to `opcacheMode: "auto"`; this
selects memory OPcache on PHP 8.1+ and file-only caching on PHP 7.4/8.0. Check
its actual initialized state and keep reuse/late-miss observations in the
report. An unsupported requested profile fails rather than falling back to
a disabled cache. All versions and WordPress controls use the same profile.

Do not add a disabled-cache pass to a normal comparison. Earlier paired cache
experiments remain separate historical evidence. A normal benchmark need not
repeat the cache implementation investigation for every plugin release. PHP
JIT remains unavailable in this Playground build. This chosen testing profile
does not establish universal OPcache use by hosting providers.

## Explicit cache diagnostics

The `off` profile remains available only for an explicitly requested cache
diagnostic. Use fresh servers, separate outputs, matching pinned packages,
fixtures, setup, budgets and worker counts. Each profile needs its own WordPress
controls; reverse candidate/profile order across requested repeated rounds.
Do not pool profiles or substitute a disabled-cache baseline into cached results.

Report full-response ratios and same-profile signed baseline differences with
observed round/control variation. OPcache off still uses warmed plugin caches,
the same WebAssembly runtime and database; it is not a completely cold site.
Retain differing results and direction reversals. Do not divide by a near-zero,
negative or unresolved added-overhead estimate, assume a universal 1:1 relative
effect, or normalize by temperature, clocks or a native-PHP speed factor.

## Native PHP

Playground instantiates an Emscripten module with its own filesystem and request
API. A native PHP executable does not implement that interface. There is no
host-executable setting in this runner; pointing `--php` at a binary will not
replace PHP-WASM. See the [runtime architecture](https://developer.wordpress.org/playground/developers/architecture/wasm-php-overview/).

A native execution option would require a separate launcher for a local WordPress
server. It could reuse this suite's fixtures, plugin setup, HTTP probes, control
measurements and report generation. The server should persist across requests
so OPcache and optional JIT can warm; starting a fresh PHP process per measured
request changes the workload.

Such a launcher must record the execution type, actual PHP/SAPI, database,
extensions, ini configuration and observed cache/JIT status. Keep native PHP and
PHP-WASM in separate comparison cohorts. Changing SQLite to MySQL/MariaDB is
another runtime change, not just a PHP speed adjustment. Compare JIT enabled and
disabled as separate experiments. Native execution is not implemented here yet.

For a native diagnostic, use a persistent server rather than a new CLI process
per HTTP request. On Windows, give the diagnostic a unique `opcache.cache_id`
so it cannot attach to another server's cache. Cache hits must increase after
warmup while misses stabilize. With OPcache held on, heat a checksum-verified
numeric loop and compare tracing JIT on/off. Confirm code-buffer growth beyond
startup; PHP's `opcache.jit_debug=16384` can report compiled traces in a separate
untimed diagnostic. Turn debug output off during measurements. A positive-control
speedup establishes that the mechanism works on that workload; report any actual
WordPress gain or regression separately. JIT cannot remove database or I/O costs.
