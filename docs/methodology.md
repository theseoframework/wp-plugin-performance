# Optional same-plugin timing: measurement and interpretation

For Xdebug hotspot capture and inspection, start with the README. These timing
procedures are secondary diagnostics and do not predict production performance.


## What the number means

The clock is Node's monotonic `process.hrtime.bigint()`. Full-response duration
starts just before the HTTP request is created and ends when its final byte
arrives. TTFB is separately recorded at response headers. Hashing, semantic
validation, sensors, setup, and exports are outside this clock. Requests reuse
one keepalive connection, accept identity encoding, do not follow redirects, and
run serially. Concurrency is one even though Playground has multiple PHP workers.

These are end-to-end warmed local HTTP timings. They include scheduling,
transport, PHP-WASM, filesystem/SQLite translation, WordPress, theme, MU plugins,
and the tested plugin. They are neither measured CPU time nor isolated plugin
execution time. The no-plugin baseline gives context but subtraction is not an
exact attribution model. Native PHP-FPM/MySQL and real browser results need their
own experiments. Keep WP/PHP branches and environments separate.

The common MU plugin adds an execution-token header and authentication-state
header and enables local PHP diagnostics. Its control plane seeds the fixture
and creates real WordPress authentication cookies. Measured requests do not
bypass authentication or execute a lightweight harness substitute for the route.
Only the common performance fixture and the selected plugin's declared setup
are used; unrelated functional-test seeds and option shims are excluded.

## Samples, minima and outliers

Default `samples: 100, rounds: 1, warmups: 12` produces 100 measured attempts
per scenario on one fresh install, preceded by 12 separate warmups. This quick
comparison is labeled exploratory. Explicit plans or `--samples`, `--rounds` and
`--warmups` can request a more thorough experiment. Warmups are retained with
`phase: warmup`. The runner does not retry failures until it has 100 successes.
That would give failing candidates unequal sampling opportunities. It stops an
obviously broken route after three invalid measured attempts, or one invalid
warmup. Partial/invalid groups cannot establish a gain. A warmup failure appears in block
diagnostics even though it is not counted as an invalid *measured* request.

The minimum estimates the best observed valid path through the stack. It is
sensitive to sample count and chance. Equal counts, repeated rounds, and saved
fastest responses limit misleading comparisons. The median and p95 describe the
raw valid distribution and remain useful even on a preemptive desktop CPU.

By default only values **strictly greater than 1.8 times the raw valid median**
are excluded from trimmed summaries. This uses a robust reference because a huge
interrupt can inflate a mean and prevent useful trimming. Use `outlierReference:
"mean"` for the literal average-based alternative, or change `outlierFraction`.
Save the actual rule with every run. High outliers remain valid raw observations.
They do not disappear from the raw median, p95, raw mean, or exports. Lower
observations are never removed by high-tail trimming.

`fastestCount: 1000` reports the mean of up to the fastest 1,000 valid requests.
The default 100-attempt budget can supply at most 100 of those observations.
To collect a 1,000-fastest subset from a larger population, explicitly increase
`samples`. Report both sizes. Do not imply 1,000 accepted calls when fewer survived.

An isolated minimum less than half the raw median with no second valid request
within 10% is a suspicion, not proof of an error. `minimumMs` is retained;
`leadingMs` is null and the group is ineligible. Inspect the `.fastest.json`
response, its status/body/size/hash, PHP logs, and token/auth checks. Check warmup
stability, plugin activation/indexing, default cache state, redirects, route
selection, and other rounds. Rerun the whole matched affected comparison and
explain whether the low value was real. Keep both runs. Do not replace the raw
minimum with an arbitrary percentile and describe it as the fastest request.

## Signed impact against WordPress

For the same eligible runtime/workload cohort, subtract the no-plugin control:
`baselineDeltaMs = plugin.leadingMs - core.leadingMs` and
`baselineMedianDeltaMs = plugin.medianMs - core.medianMs`. Keep each control's
identity and source value in the summary. Matching includes the exact WP/PHP,
theme, fixture, permalink, locale, cache settings and scenario/frame. A missing,
invalid or ambiguous control leaves the difference unavailable, not zero.

Positive means added complete-response time; negative means an observed saving.
Replacing core functionality can produce real savings. Scheduling variation and
independent sample minima can also affect the difference. Preserve negative
values rather than clamping them or silently excluding them. These are observed
net effects on the complete stack, not isolated plugin CPU instructions or paired
request differences. Equal budgets and repeated, rotated fresh-install rounds
matter; a single pass remains exploratory.

The `valid` status means response, fixture and budget checks passed. It is not
a statistical significance label or proof that a plugin caused a speedup.
Independent minima may come from different boost, cache and scheduling states.
Compare their signs with the median differences; a reversal is evidence that
the saving is not consistent across those summaries. Even matching signs in
one pass do not separate plugin effects from drift or other host activity.

When a primary control is named, every subtraction uses that control. For example,
`baselineCandidate: "core"` means `core` is the WordPress baseline throughout.
`core-repeat` is an independently measured identical setup used to expose run
variation. It never replaces or gets averaged into the primary baseline. Reports
name the actual control beside each page/group impact plot and in the tables.
The HTML reference-version selector changes the ratio table only; it leaves the
WordPress subtraction baseline fixed.

The runner rotates candidate order across fresh-install rounds when more than
one round is explicitly requested. A single round has one fixed order; an
early control and a later plugin are not a paired, simultaneous comparison.
Stronger saving claims need repeated matched observations with balanced/reversed
order, and ideally core controls before and after the plugin blocks. Profiling
which core work was replaced is a separate attribution experiment. More calls
in the same ordered block alone do not remove order or thermal bias.

### Optional measurement diagnostics

Ordinary before/after diagnostics use versions of one plugin and one no-plugin
WordPress baseline. Quick defaults remain 100 attempts, one round and 12 warmups.
Choose any larger budget explicitly; more requests alone do not establish
production performance or statistical significance.

Only when additional measurement diagnostics are explicitly requested, use
`examples/plugin-repeat-controls.json`, set `comparisonMode: "repeat-controls"`, name the primary
`baselineCandidate`, and include a second `baseline: true, negativeControl: true`
candidate with the identical inactive package and mounts. Both are
real WordPress sites without an active tested plugin. Preparation rejects different
control source fingerprints. Provided archive/main/PHP source hashes are enforced
as pins rather than overwritten with a different package's hashes.

Rounds must be a complete multiple of the candidate count; each candidate then
occupies every run position. The measured budget must divide evenly across rounds.
Versions and controls all refer to the same plugin identity. Cross-plugin plans
and saved reports are rejected; no rank is calculated or exported.

For each exact cohort and metric, compare the two no-plugin controls in each
round. Their largest absolute difference is the observed control spread. Widen
the original cross-round delta envelope by that spread at both ends. A plugin
is described as consistently lower/higher only when both minimum and median
envelopes have the same resolved sign. Otherwise the assessment is unresolved.
Missing or mismatched control evidence blocks both comparison factors.
Raw timings and signed deltas are retained, and unresolved heatmap cells use
neutral shading. Controls provide context rather than a separate product score.

For a comparison with another candidate, form the pairwise cross-round range
from the selected candidate's lowest minus the reference's highest round value
to its highest minus the reference's lowest. Widen both ends by the sum of their
control spreads. Both minimum and median ranges must agree in direction beyond
zero to show a full-response or added-overhead factor. Raw milliseconds remain
visible. A candidate compared
with itself has a full-response factor of one by definition, not evidence of a
performance difference.

`controls.json` retains per-round control differences; `controls.csv`, the HTML
assessment and the optional Repeat controls worksheet expose the result. The
extra control is omitted from the main HTML charts and comparison tables; a
collapsed diagnostic note identifies its role. Historical raw data is preserved. The
independent verifier checks source identity, actual candidate order, raw round
statistics, widened ranges and spreadsheet values. These deliberately
conservative observed ranges are not calibrated confidence intervals. Balanced
order and negative controls improve a comparison; they do not certify isolated
CPU conditions or guarantee the same result on another machine/runtime/release.

For each metric, the cross-round envelope runs from the plugin's lowest round
summary minus core's highest to the plugin's highest minus core's lowest. It
describes observed variation, not statistical confidence or a causal error bound.
If it reaches zero, a multiplicative added-overhead factor is unresolved. With
one round the envelope collapses to the observed delta and has no power to
estimate between-round variation. Medians use round medians, minima round minima.

For positive, numerically resolved overheads, `reference delta / selected delta`
is the descriptive added-overhead factor. Thus 200 ms / 1 ms is 200x less added
overhead. Total page-speed improvement is separately
`reference full response / selected full response`, or `(core + 200)/(core + 1)`.
Never divide zero/negative overheads or call that result an infinite/negative
speedup. Instead report signed milliseconds and, when both complete durations are
valid and positive and the applicable repeat-control check resolves the
comparison, their total-response ratio. Do not equate a very large ratio
of small noisy differences with a proven speed multiplier.

Sitemaps and configured redirects currently retain separate endpoint timings.
An index document, a URL-list document and a whole sitemap crawl are different
workloads. Matching XML shape alone does not prove content/coverage equivalence.
Until a specific equivalent core workload is verified, no baseline subtraction
is provided for these features. Ordinary same-route core replacements such as
robots.txt retain signed comparisons when the rest of the cohort matches.

`report.html` is a self-contained offline JavaScript/SVG view: signed bars about
zero, full-response bars and a per-page heatmap. Select a runtime, exact page
cohort, fastest/median metric and reference plugin. Missing/invalid timings are
not plotted as zeros. Each heatmap row has its own control; no cross-page average
becomes a global winner. The workbook keeps typed raw data and adds two native,
formula-backed charts with cohort and metric selectors. Inspect exported charts
and test selector changes; previews alone do not establish Excel behavior.

## Group averages and save counts

The default report has three mutually exclusive groups:

- Front end: homepage as blog, static homepage, blog page, post, page, category,
  tag, search and 404 (ordinary HTML only).
- Back end: dashboard, posts list, pages list, post editor and page editor GETs.
- Save operations: the authenticated editor-save POST only.

Save requests never enter back-end averages. RSS, robots.txt, sitemaps and redirects retain their
separate endpoint comparisons because their workloads are not equivalent.
Only scenarios requested by the plan enter a group. Averages use the intersection
of eligible exact-cohort scenarios across every intended candidate, including
the control. A missing candidate cannot silently disappear. Explicitly deferred
candidates, such as a plugin awaiting cloud setup, have no timing and do not
participate. Show the included/excluded scenario lists and common-set coverage.

Each included scenario has equal weight. For example, the mean of minima is
`sum(scenario.leadingMs) / scenarioCount`; it is not the fastest call across all
pages. Mean of medians averages each scenario's raw median and is not a pooled
median. Mean request time averages the raw means with the same equal scenario
weight, retaining high outliers. These are descriptive averages of this fixture,
not a model of site traffic and not an overall plugin ranking. Never combine
different WP/PHP, theme, fixture or cache cohorts to increase coverage.

Subtract the corresponding mean over the same core scenarios. Preserve signed
savings. If no common set or matched control exists, the affected mean or delta
is unavailable. A zero count is real; it is not a zero response time. Counts are
the validated measured requests included in the common set, with warmups shown
separately. The measured-save count is nonzero only for Save operations.

`group-summary.csv` and the report retain all three means, baseline differences,
scope and counts. The Group averages worksheet links calculations to Summary
cells; export checks mutate a save duration temporarily, confirm the saving
average changes while the back-end average does not, and restore the source.
An offline `report --input <run>` rebuilds these views without benchmark calls.
The renderer and aggregation rules are shared engine modules, so other agents
can reproduce the page through the skill instead of authoring a new dashboard.

## CPU load, clocks and temperature context

The sensor readout occurs after warmup, immediately before the measured block,
and after the block, outside request timing. Keep before/after sensor IDs and
values, timestamps, and the reason for a missing reading. The summary maximum
across CPU sensors is conservative; review the individual package/die/core
readings when comparing machines. Do not compare a different sensor selection
as if it were the same temperature. Do not present WMI ACPI thermal zones as
AMD package or Tctl/Tdie readings.

CPU load and observed clocks are the main machine context. Temperature by itself
does not identify how fast a request ran. Modern boost controls can reach a
thermal target while maximizing performance, as AMD explains for
[Ryzen 7000](https://community.amd.com/t5/gaming/ryzen-7000-series-processors-let-s-talk-about-power-temperature/ba-p/554629).
Limits and boost behavior are model-specific; an example 85 C cap is not a
universal throttling threshold. Missing sensors, temperature drift, or a stable
cap do not automatically invalidate a sample or downgrade its
status. A stable temperature also does not prove the absence of throttling.

For serious comparisons, close heavy competing jobs, keep the power/cooling
policy fixed and repeat runs with candidate order reversed/rotated. Interpret
load, clock behavior, power limits and repeated timings together. Keep any
temperature readings as secondary context, not an automatic performance verdict.
Do not normalize timings by temperature or a clock reading.

These probes observe conditions; they do not equalize them. Whole-system busy
percentage includes other applications and averages logical CPUs, so low overall
load does not prove the core running PHP was idle or at the same boost state.
Boundary clock/temperature readings can miss changes within the block and cannot
certify a temperature-controlled or CPU-isolated experiment. Timing summary
calculations do not use sensor readings to manufacture savings or penalties.

`clocks.csv` records each boundary query's min/max MHz across its reported
cores/policies, individual readings, measurement kind, source and scope. The
same context is in the workbook's CPU context sheet. Clock queries occur after
warmup and before CPU-load counters start, then after those counters stop. They
are outside HTTP timing and do not poll during requests. Provider startup and
query latency can still disturb idle/boost state; keep the same setup across
candidates and do not treat endpoint clocks as a trace of the whole block.

The supported kinds are `effective`, `hardware-current`, `hardware-average`,
`driver-reported` and `os-performance-estimate`. Mixed kinds retain individual
readings but have no combined min/max. No nominal/reference-only fallback is
presented as live CPU clock data. Sleeping cores and heterogeneous policies can
make endpoint ranges misleading; they are not a performance normalization factor.

- On x86 Windows, existing Processor Information counters supply reference MHz
  and relative performance while executing. The engine retains both and labels
  their product `os-performance-estimate`. The provider's previous sampling
  interval is not the benchmark interval. This is not a measured wall-time
  effective clock or proof that boost/throttling was absent. The provider's raw
  timestamp is retained. Windows ARM requires an explicit provider rather than
  assuming that performance units map linearly to MHz.
- Linux prefers `cpuinfo_cur_freq`, then `cpuinfo_avg_freq`, then labels
  `scaling_cur_freq` as `driver-reported`. The [CPUFreq documentation](https://docs.kernel.org/admin-guide/pm/cpufreq.html)
  distinguishes hardware feedback from a last requested P-state; driver reports
  are not guaranteed to be the actual hardware clock. Policy membership and the
  selected attribute are retained. Nominal/max frequencies are not substituted.
- macOS and unavailable VM clocks need an explicitly configured existing
  provider. `os.cpus().speed`, SMBIOS clock speed, fixed TSC rates and advertised
  boost clocks are not effective-clock measurements. WSL does not automatically
  expose the Windows host's physical clocks.

An optional consumer-private `clockCommand` uses the same shell-free command
array/timeout/cwd contract as `temperatureCommand`. Its stdout is an array of
real CPU readings such as `[{ "sensor": "CPU 0", "mhz": 4100, "kind": "effective" }]`.
Keep the provider's actual measurement kind, sensor identity and scope; do not
label an estimate as effective. An already trusted lightweight provider can
supply this without adding a driver or launching a continuous sampler.

### Platform support

The Node engine targets Windows, macOS and Linux. Sensor availability is a
separate hardware and OS capability; installing the benchmark does not install
drivers or elevate access.

| Runtime | CPU busy percentage | Built-in CPU temperature |
| --- | --- | --- |
| Windows | OS-visible logical-CPU counters | Existing LibreHardwareMonitor/OpenHardwareMonitor WMI CPU sensors |
| Native Linux | OS-visible logical-CPU counters | Existing `k10temp`, `zenpower`, `coretemp` or `cpu_thermal` hwmon devices |
| macOS, Intel or Apple silicon | OS-visible logical-CPU counters | No built-in Celsius reader; use an explicitly configured existing provider |
| WSL | Guest-visible logical-CPU counters, labeled `wsl-guest` | Only CPU sensors actually exposed to the guest; commonly none |

Two [`os.cpus()`](https://nodejs.org/api/os.html#oscpus) snapshots surround the
measured loop, after the starting temperature query and before the ending query.
They add no sampling process, background polling, sleep or subprocess per request.
`cpu-load.csv` records the percent of advancing CPU-counter time spent outside
idle, summed across all logical CPUs. It includes all activity visible to that OS
and the loop's response validation, not just the plugin. Raw snapshots, timestamps,
scope and unavailable reasons stay in `results.json`. Counter resets, CPU-set
changes, absent counters and intervals below counter resolution produce null;
genuine advancing idle counters may produce 0%. Brief spikes remain unobserved.
The workbook's CPU context sheet includes this average on each `after` row.
On Windows, [libuv's `sys` counter](https://github.com/libuv/libuv/blob/v1.x/src/win/util.c)
already includes interrupt time, so the separate `irq` field is retained in raw
snapshots but excluded from the sum. Other platforms use the available Node
counter categories; these are not guaranteed to include every scheduler category.

Other VMs, containers, CPU quotas and affinity can change what the OS counters
describe. Record these explicitly; `operating-system` does not certify bare metal
or the CPUs available to the benchmark process. Counter categories differ by OS,
so these percentages are contextual evidence, not a cross-platform ranking metric.

Linux reads the standard OS hwmon interface, preserving driver/device labels and
read failures. [`k10temp`](https://docs.kernel.org/hwmon/k10temp.html) may expose
Tctl, Tdie and CCD channels; Tctl can include a control offset. Keep those identities
and do not equate a control reading with die temperature. A readable CPU sensor
survives another missing/inaccessible device. Board, ACPI and NVMe readings do not
substitute for CPU sensors. The engine does not load kernel modules.

Apple's [thermal state API](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/RespondToThermalStateChanges.html)
reports nominal/fair/serious/critical conditions, not degrees Celsius. Do not
convert these into temperatures. A trusted, already available macOS sensor tool
can be wrapped with `temperatureCommand`; no `sudo`, privileged sampler or native
extension is launched automatically. Intel and Apple silicon need separate
hardware validation; synthetic platform fixtures are not a live Mac test.

[WSL2 runs a Linux kernel in a VM](https://learn.microsoft.com/en-us/windows/wsl/about#what-is-wsl-2).
A missing guest hwmon device is not proof of a Windows permission failure, and
running Linux as root does not grant access to absent host sensors. An explicitly
configured Windows-provider bridge can supply a physical CPU reading; it does
not turn guest CPU counters into whole-host load. Do not benchmark through a
Windows `node.exe` and label the result native Linux.

`temperatureCommand` is an executable/argument array run without a shell, with a
15-second timeout and the consumer root as its working directory. Its stdout must
be a JSON array such as `[{ "sensor": "CPU package", "celsius": 55.2 }]` containing
real CPU readings. Configure a consumer-private adapter, for example:

```json
{
  "temperatureCommand": ["node", ".local/playground/performance/read-temperature.cjs"]
}
```

That adapter is operator-supplied, not installed by this example. Preserve provider
and sensor identity in `sensor`; choose a provider that does not start a continuous
sampler. External readings are labeled `external-provider` because the engine
cannot verify their hardware origin. Do not use a fabricated fallback or convert
thermal pressure to Celsius. Keep workstation paths in ignored configuration.

## Cache and fixtures

Record actual OPcache enablement, capacity, memory, JIT, and full-cache status.
Also retain `cache-reuse.csv` and the before/after status in each block. An ini
switch or script count does not prove reused bytecode or generated JIT code.
The boundary checks match workers before comparing cache instances and include
control-request activity; missing workers, changed instances and unavailable
file-only statistics remain explicit.
Use controlled disabled/enabled experiments to establish a timing benefit.
Keep the same Playground version, worker count, Node version, theme and versions,
fixture, permalink structure, locale, and plugin setup within a comparison.
An OPcache-full state or materially different warmup plateau needs investigation.
Do not increase only one version's OPcache limit or silently disable a module.
Do not average cold-start/setup/index-building costs into warmed route timings.
If requested, measure them separately with their own timing boundary.

Plugin object/transient/output caches retain their default behavior. A new
execution token must still pass through WordPress, preventing a full-page cache
or static response from becoming a false fast sample. Token headers do not
prove output correctness alone; route-specific body checks are also required.
Anonymous routes receive no cookies; admin and REST routes receive the same real
admin account and nonce. Login redirects are never followed or accepted.

The fixture uses fixed post dates and the same content volume. Home-as-blog and
static-home-with-posts-page are separate frames, changed outside timing. REST
saves really alternate titles. WordPress revisions accumulate normally, making
save timings a sequence with growing history. Record this distinction rather
than disabling revision behavior only for a faster result.

## Sources to recheck when version-sensitive

- [PHP stable release metadata](https://www.php.net/releases/index.php?json)
- [PHP supported branches](https://www.php.net/supported-versions.php)
- [Playground architecture](https://developer.wordpress.org/playground/architecture/)
- [Playground limitations](https://developer.wordpress.org/playground/developers/limitations/)
- [Regression engine](https://github.com/theseoframework/wp-plugin-regression)

Verify current compatibility claims against official WordPress/plugin release
notes or source. Record URLs and the date checked in the local experiment plan.
