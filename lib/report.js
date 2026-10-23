/**
 * Raw evidence, CSV exports, and a reproducible Markdown performance report.
 */

const fs       = require( 'fs' );
const path     = require( 'path' );
const readline = require( 'readline' );
const { statistics } = require( './measure' );
const { cpuLoad } = require( './cpu' );
const { attachBaselines } = require( './comparison' );
const { writeDashboard } = require( './dashboard' );
const { aggregateGroups } = require( './groups' );
const { normalizeConfig, assessControls } = require( './controls' );
const { assessCache, assessCacheWorkers } = require( './cache' );
const { outputComparisons, outputMarkdown } = require( './output' );

const SAMPLE_COLUMNS = [
	'blockId', 'candidate', 'pluginVersion', 'wp', 'php', 'round', 'scenario',
	'phase', 'sequence', 'at', 'elapsedMs', 'ttfbMs', 'status', 'bytes', 'sha256',
	'executionToken', 'responseToken', 'userId', 'route', 'contentType', 'location',
	'valid', 'reasons',
];

/**
 * Encodes a CSV field, preventing spreadsheet formula execution in text fields.
 *
 * @param {*} value
 * @return {string}
 */
function csvField( value ) {

	let text = null === value || undefined === value ? '' : String( value );
	if ( 'number' !== typeof value && /^[=+\-@\t\r]/.test( text ) ) text = `'${text}`;

	return `"${text.replace( /"/g, '""' )}"`;
}

/**
 * Writes an Excel-compatible UTF-8 CSV with stable columns.
 *
 * @param {string} file
 * @param {Object[]} rows
 * @param {string[]} columns
 * @param {Boolean} append
 */
function writeCSV( file, rows, columns, append = false ) {

	const fresh = ! append || ! fs.existsSync( file );
	const lines = rows.map( row => columns.map( key => csvField( row[key] ) ).join( ',' ) );
	if ( fresh ) lines.unshift( columns.map( csvField ).join( ',' ) );

	fs[append ? 'appendFileSync' : 'writeFileSync']( file, `${fresh ? '\uFEFF' : ''}${lines.join( '\r\n' )}\r\n` );
}

/**
 * Saves one completed block after the timing window closes.
 *
 * @param {string} output
 * @param {Object} block
 * @param {Object[]} samples
 */
function saveBlock( output, block, samples ) {

	if ( ! /^[a-z0-9-]+$/i.test( block.blockId ) ) throw new Error( 'Unsafe block checkpoint id.' );

	// Keep independent immutable evidence if an aggregate append is interrupted.
	fs.writeFileSync(
		path.join( output, `${block.blockId}.checkpoint.json` ),
		JSON.stringify( { kind: 'wp-performance-block-v1', block, samples } ) + '\n',
		{ encoding: 'utf8', flag: 'wx', flush: true },
	);
	fs.appendFileSync( path.join( output, 'blocks.ndjson' ), `${JSON.stringify( block )}\n`, { flush: true } );
	if ( ! samples.length ) return;

	fs.appendFileSync( path.join( output, 'samples.ndjson' ), samples.map( row => JSON.stringify( row ) ).join( '\n' ) + '\n', { flush: true } );
	writeCSV( path.join( output, 'samples.csv' ), samples, SAMPLE_COLUMNS, true );
}

/**
 * Reads newline-delimited JSON without loading response evidence into memory.
 *
 * @param {string} file
 * @param {Function} callback
 * @return {Promise<void>}
 */
async function readLines( file, callback ) {

	if ( ! fs.existsSync( file ) ) return;

	const stream = readline.createInterface( { input: fs.createReadStream( file ), crlfDelay: Infinity } );
	for await ( const line of stream ) {
		if ( line.trim() ) callback( JSON.parse( line ) );
	}
}

/**
 * Escapes table text and formats nullable milliseconds.
 *
 * @param {*} value
 * @return {string}
 */
function display( value ) {

	if ( null === value || undefined === value ) return 'n/a';

	return ( 'number' === typeof value && ! Number.isInteger( value ) ? value.toFixed( 3 ) : String( value ) ).replace( /\|/g, '\\|' ).replace( /[\r\n]+/g, ' ' );
}

/**
 * Aggregates only matched runtime/scenario cohorts; baseline deltas stay separate.
 * Failed, partial, and semantically invalid groups retain their qualification.
 *
 * @param {string} output
 * @param {Object} manifest
 * @return {Promise<Object>}
 */
async function report( output, manifest ) {

	const scope = require( './plugin-scope' ).manifestScope( manifest );
	manifest = {
		...manifest,
		config: normalizeConfig( { ...manifest.config } ),
		exploratory: ! manifest.smoke && ( !! manifest.exploratory || 1 === manifest.config.rounds ),
	};
	const groups = new Map();
	const blocks = [];
	await readLines( path.join( output, 'blocks.ndjson' ), block => {
		if ( block.cpu?.before && block.cpu?.after )
			block.cpu.load = cpuLoad( block.cpu.before, block.cpu.after );

		blocks.push( block );
		block.cacheReuse = block.cacheBeforeWorkers || block.cacheAfterWorkers
			? assessCacheWorkers( block.cacheBeforeWorkers, block.cacheAfterWorkers, manifest.config.workers )
			: assessCache( block.cacheBefore, block.cacheAfter );
		const key = `${block.candidate}|${block.wp}|${block.php}|${block.scenario}`;
		if ( ! groups.has( key ) ) groups.set( key, { blocks: [], rows: [], warmupAttempted: 0, warmupValid: 0 } );

		groups.get( key ).blocks.push( block );
	} );
	const byBlock = new Map();
	for ( const group of groups.values() ) {
		for ( const block of group.blocks ) byBlock.set( block.blockId, group );
	}
	// NDJSON is authoritative; an interrupted CSV checkpoint may be incomplete.
	const sampleExport = path.join( output, 'samples.csv' );
	require( './plugin-scope' ).validateRows( scope, blocks );
	writeCSV( sampleExport, [], SAMPLE_COLUMNS );
	let exportBatch = [];
	const rawMinima = new Map();
	await readLines( path.join( output, 'samples.ndjson' ), row => {
		exportBatch.push( row );
		if ( exportBatch.length >= 1000 ) {
			writeCSV( sampleExport, exportBatch, SAMPLE_COLUMNS, true );
			exportBatch = [];
		}
		const group = byBlock.get( row.blockId );
		if ( ! group ) return;
		if ( 'measure' === row.phase && true === row.valid && ( ! rawMinima.has( row.blockId ) || row.elapsedMs < rawMinima.get( row.blockId ).elapsedMs ) )
			rawMinima.set( row.blockId, row );

		if ( 'measure' === row.phase ) group.rows.push( { elapsedMs: row.elapsedMs, valid: row.valid, blockId: row.blockId } );
		else if ( 'warmup' === row.phase ) {
			group.warmupAttempted++;
			if ( row.valid ) group.warmupValid++;
		}
	} );
	if ( exportBatch.length ) writeCSV( sampleExport, exportBatch, SAMPLE_COLUMNS, true );

	const summaries = [];
	for ( const group of groups.values() ) {
		const first = group.blocks[0];
		const stats = statistics( group.rows, manifest.config );
		const failed = group.blocks.filter( block => block.error );
		const unavailable = group.blocks.every( block => block.unavailable );
		const preTemps = group.blocks.map( block => block.before?.celsius ).filter( value => null != value );
		const runtimeKeys = group.blocks.filter( block => block.runtime ).map( block => {
			const runtime = block.runtime;
			const fixture = runtime.fixture || {};
			const cache   = runtime.opcache || {};

			return JSON.stringify( [
				runtime.theme, runtime.themeVersion, runtime.locale, runtime.permalink,
				runtime.blogPublic, runtime.phpSapi, runtime.phpMemoryLimit,
				fixture.version, fixture.posts, fixture.pages, fixture.contentHash,
				cache.enabled, cache.enableCli, cache.maxFiles, cache.memoryMb, cache.jit,
				cache.fileOnly, cache.validateTimestamps, cache.revalidateFreq,
				block.frame, block.featureDocument || '',
			] );
		} );
		const issues = [];
		if ( failed.length ) issues.push( ...new Set( failed.map( block => block.error ) ) );

		if ( stats.invalid ) issues.push( `${stats.invalid} invalid measured responses` );

		if ( stats.minimumSuspect ) issues.push( 'Isolated fast minimum needs investigation' );

		if ( stats.attempted !== manifest.config.samples && ! unavailable ) issues.push( 'Incomplete sample budget' );

		if ( group.blocks.length !== manifest.config.rounds && ! unavailable ) issues.push( 'Incomplete rounds' );

		if ( new Set( runtimeKeys ).size > 1 ) issues.push( 'Runtime changed between rounds' );

		if ( manifest.failures?.some( failure => failure.candidate === first.candidate && 'source drift' === failure.stage ) )
			issues.push( 'Plugin PHP source changed during the experiment' );

		const eligible = ! unavailable && ! issues.length;
		const roundStats = group.blocks.map( block => statistics( group.rows.filter( row => row.blockId === block.blockId ), manifest.config ) );
		const leading = roundStats.map( item => item.minimumMs ).filter( Number.isFinite );
		const medians = roundStats.map( item => item.medianMs ).filter( Number.isFinite );
		const caveats  = [];
		if ( group.blocks.some( block => block.runtime?.opcache?.full ) )
			caveats.push( 'OPcache capacity exhausted' );

		summaries.push( {
			candidate: first.candidate,
			pluginSlug: scope.slug,
			pluginVersion: first.pluginVersion,
			baseline: first.baseline,
			wp: first.wp,
			php: first.php,
			scenario: first.scenario,
			frame: first.frame,
			featureDocument: first.featureDocument || '',
			cohort: `${first.wp}|${first.php}|${first.scenario}|${runtimeKeys[0] || ''}`,
			runtimeGroup: JSON.stringify( [ first.wp, first.php, ...( runtimeKeys[0] ? JSON.parse( runtimeKeys[0] ).slice( 0, -2 ) : [] ) ] ),
			...stats,
			warmupAttempted: group.warmupAttempted, warmupValid: group.warmupValid,
			roundCount: group.blocks.length,
			roundMetrics: roundStats.map( ( item, index ) => ( { round: group.blocks[index].round, minimumMs: item.minimumMs, medianMs: item.medianMs, valid: item.valid } ) ),
			roundLeadingLowMs: leading.length ? Math.min( ...leading ) : null,
			roundLeadingHighMs: leading.length ? Math.max( ...leading ) : null,
			roundMedianLowMs: medians.length ? Math.min( ...medians ) : null,
			roundMedianHighMs: medians.length ? Math.max( ...medians ) : null,
			baselineDeltaMs: null,
			eligible,
			status: unavailable ? 'unavailable' : ( eligible ? ( caveats.length || manifest.smoke ? 'provisional' : 'valid' ) : 'invalid' ),
			issues: [ ...issues, ...caveats, ...( unavailable ? [ first.unavailable ] : [] ) ].join( '; ' ),
			minimumBeforeC: preTemps.length ? Math.min( ...preTemps ) : null,
			maximumBeforeC: preTemps.length ? Math.max( ...preTemps ) : null,
		} );
	}
	for ( const failure of manifest.failures || [] ) {
		const candidate = scope.byId.get( failure.candidate );
		summaries.push( {
			candidate: failure.candidate,
			pluginVersion: candidate?.version || 'unresolved', baseline: !! candidate?.baseline,
			wp: failure.wp, php: failure.php, scenario: `cell:${failure.stage || 'launch/setup'}`,
			frame: 'n/a', featureDocument: '', cohort: `failed|${failure.candidate}|${failure.wp}|${failure.php}|${failure.round || ''}`,
			runtimeGroup: JSON.stringify( [ failure.wp, failure.php ] ),
			...statistics( [], manifest.config ), pluginSlug: scope.slug, baselineDeltaMs: null,
			warmupAttempted: 0, warmupValid: 0,
			roundCount: 0, roundLeadingLowMs: null, roundLeadingHighMs: null, roundMedianLowMs: null, roundMedianHighMs: null,
			eligible: false, status: 'failed', issues: failure.error,
			minimumBeforeC: null, maximumBeforeC: null,
		} );
	}
	require( './plugin-scope' ).validateRows( scope, summaries );
	attachBaselines( summaries, manifest.config.baselineCandidate );
	const controls = assessControls( summaries, manifest );
	summaries.sort( ( a, b ) => a.cohort.localeCompare( b.cohort ) || a.candidate.localeCompare( b.candidate ) );
	writeCSV( path.join( output, 'summary.csv' ), summaries, Object.keys( summaries[0] || { candidate: '' } ).filter( key => 'roundMetrics' !== key ) );
	writeCSV( path.join( output, 'controls.csv' ), controls, Object.keys( controls[0] || { candidate: '' } ).filter( key => 'controlDifferences' !== key ) );
	fs.writeFileSync( path.join( output, 'controls.json' ), JSON.stringify( controls, null, '\t' ) + '\n' );
	writeCSV(
		path.join( output, 'temperatures.csv' ),
		blocks.flatMap( block => [ 'before', 'after' ].map( phase => ( {
			blockId: block.blockId,
			candidate: block.candidate,
			scenario: block.scenario,
			round: block.round,
			phase,
			at: block[phase]?.at || '',
			celsius: block[phase]?.celsius ?? null,
			source: block[phase]?.source || '',
			scope: block[phase]?.scope || '',
			sensors: JSON.stringify( block[phase]?.sensors || [] ),
			reason: block[phase]?.reason || block.unavailable || block.error || '',
		} ) ) ),
		[ 'blockId', 'candidate', 'scenario', 'round', 'phase', 'at', 'celsius', 'source', 'scope', 'sensors', 'reason' ],
	);
	writeCSV(
		path.join( output, 'cpu-load.csv' ),
		blocks.map( block => ( {
			blockId: block.blockId, candidate: block.candidate, scenario: block.scenario, round: block.round,
			startedAt: block.cpu?.load?.startedAt || '', endedAt: block.cpu?.load?.endedAt || '',
			percent: block.cpu?.load?.percent ?? null, durationMs: block.cpu?.load?.durationMs ?? null,
			logicalCPUs: block.cpu?.load?.logicalCPUs ?? null,
			source: block.cpu?.load?.source || '', scope: block.cpu?.load?.scope || '',
			reason: block.cpu?.load?.reason || ( block.cpu ? '' : ( block.unavailable || block.error || 'CPU counters were not recorded by this run.' ) ),
		} ) ),
		[ 'blockId', 'candidate', 'scenario', 'round', 'startedAt', 'endedAt', 'percent', 'durationMs', 'logicalCPUs', 'source', 'scope', 'reason' ],
	);
	const groupSummaries = aggregateGroups( summaries, manifest );
	const outputComparison = outputComparisons( output, summaries, blocks, rawMinima );
	const result = { reportVersion: 4, manifest, summaries, groupSummaries, controls, blocks, outputComparison };
	fs.writeFileSync( path.join( output, 'output-comparison.json' ), JSON.stringify( outputComparison, null, '\t' ) + '\n' );
	fs.writeFileSync( path.join( output, 'output-comparison.md' ), outputMarkdown( outputComparison ) );
	writeCSV( path.join( output, 'output-comparison.csv' ), outputComparison.records.flatMap( record => outputComparison.features.map( feature => ( {
		candidate: record.candidate, pluginVersion: record.pluginVersion, wp: record.wp, php: record.php,
		scenario: record.scenario, frame: record.frame, cohort: record.cohort, round: record.round,
		blockId: record.blockId, status: record.status, feature: feature.id,
		value: 'available' === record.status ? record.cells[feature.id] : 'Unavailable',
		source: record.source, sha256: record.sha256, route: record.route, reason: record.reason,
	} ) ) ), [ 'candidate', 'pluginVersion', 'wp', 'php', 'scenario', 'frame', 'cohort', 'round', 'blockId', 'status', 'feature', 'value', 'source', 'sha256', 'route', 'reason' ] );
	writeCSV(
		path.join( output, 'cache-reuse.csv' ),
		blocks.map( block => ( {
			blockId: block.blockId, candidate: block.candidate, scenario: block.scenario, round: block.round,
			...block.cacheReuse, workerIds: ( block.cacheReuse.workers || [] ).map( item => item.pid ).join( '; ' ),
			pidBefore: block.cacheBefore?.pid ?? null, pidAfter: block.cacheAfter?.pid ?? null,
			cachedScriptsBefore: block.cacheBefore?.cachedScripts ?? null, cachedScriptsAfter: block.cacheAfter?.cachedScripts ?? null,
			fullBefore: block.cacheBefore?.full ?? null, fullAfter: block.cacheAfter?.full ?? null,
		} ) ),
		[ 'blockId', 'candidate', 'scenario', 'round', 'status', 'hits', 'misses', 'probeFileBound', 'jitCodeGrowthBytes', 'expectedWorkers', 'observedWorkers', 'matchedWorkers', 'reuseWorkers', 'workerIds', 'pidBefore', 'pidAfter', 'cachedScriptsBefore', 'cachedScriptsAfter', 'fullBefore', 'fullAfter' ],
	);
	writeCSV(
		path.join( output, 'group-summary.csv' ), groupSummaries,
		Object.keys( groupSummaries[0] || { candidate: '' } ).filter( key => 'memberCohorts' !== key ),
	);
	writeCSV(
		path.join( output, 'clocks.csv' ),
		blocks.flatMap( block => [ 'before', 'after' ].map( phase => {
			const clock = 'before' === phase ? block.clockBefore : block.clockAfter;

			return {
				blockId: block.blockId, candidate: block.candidate, scenario: block.scenario, round: block.round, phase,
				at: clock?.at || '', minimumMHz: clock?.minimumMHz ?? null, maximumMHz: clock?.maximumMHz ?? null,
				kinds: ( clock?.kinds || [] ).join( '; ' ), source: clock?.source || '', scope: clock?.scope || '',
				sensors: JSON.stringify( clock?.sensors || [] ),
				reason: clock?.reason || ( clock ? '' : ( block.unavailable || block.error || 'CPU clocks were not recorded by this run.' ) ),
			};
		} ) ),
		[ 'blockId', 'candidate', 'scenario', 'round', 'phase', 'at', 'minimumMHz', 'maximumMHz', 'kinds', 'source', 'scope', 'sensors', 'reason' ],
	);
	fs.writeFileSync( path.join( output, 'results.json' ), JSON.stringify( result, null, '\t' ) + '\n' );
	writeDashboard( output, result );
	const baselineIds = [ ...new Set( summaries.map( row => row.baselineCandidate ).filter( Boolean ) ) ];
	const primary = manifest.config.baselineCandidate || ( 1 === baselineIds.length ? baselineIds[0] : '' );
	const repeats = ( manifest.candidates || [] ).filter( item => item.baseline && item.negativeControl ).map( item => item.id );
	const lines = [
		'# WordPress plugin timing diagnostics',
		'',
		require( './disclaimer' ),
		'',
		`${manifest.smoke ? 'Smoke test. These timings are not a performance conclusion.' : 'Leading metric: fastest semantically valid full HTTP response.'}`,
		...( manifest.exploratory ? [ '', `Exploratory comparison. ${1 === manifest.config.rounds ? 'One round does not establish a repeatable speedup.' : 'Limited repeated measurements do not establish a stable speedup.'} Valid status means the measurement checks passed, not statistical significance.` ] : [] ),
		'',
		`Measured budget: ${manifest.config.samples} attempts per scenario/candidate/WP/PHP cell across ${manifest.config.rounds} rounds. Warmups: ${manifest.config.warmups} per block. Concurrency: 1.`,
		'',
		`WordPress subtraction baseline: ${primary || 'no single primary control; see each workload'}. Added time = plugin time - matched baseline time.`,
		...( repeats.length ? [ '', `WordPress repeat check: ${repeats.join( ', ' )}. These independently measured controls show run variation; they are not subtracted or averaged into the primary baseline.` ] : [] ),
		'',
		'The HTML reference-version selector affects the ratio table only. Page and group impact charts keep their named WordPress subtraction baseline.',
		'',
		'| Candidate | Version | WP | PHP | Scenario | Fastest ms | Median ms | Trimmed mean ms | Invalid | High outliers | Plugin | Status |',
		'| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
		...summaries.map( row => `| ${[ row.candidate, row.pluginVersion, row.wp, row.php, row.scenario, row.minimumMs, row.medianMs, row.trimmedMeanMs, row.invalid, row.highOutliers, row.pluginSlug, row.status ].map( display ).join( ' | ' )} |` ),
		'',
		'## Opcode cache observations',
		'',
		'cache-reuse.csv retains hit/miss growth and worker/cache identity between untimed boundary probes. Observed reuse requires matching worker/cache instances, complete observed pool coverage and hit growth beyond each final probe\'s included-file count. Latest before and earliest after observations are matched by worker PID; missing coverage stays explicit. The probes also execute WordPress; these are cache observations, not isolated per-request hit rates or proof of a speed improvement. File-only statistics can be unavailable. A JIT enabled flag or startup buffer allocation does not prove generated application code or benefit. Older runs have no retrofitted evidence.',
		'',
		'| Candidate | Scenario | Round | Observation | Hit growth | Miss growth | JIT code growth bytes |',
		'| --- | --- | ---: | --- | ---: | ---: | ---: |',
		...blocks.map( block => `| ${[ block.candidate, block.scenario, block.round, block.cacheReuse.status, block.cacheReuse.hits, block.cacheReuse.misses, block.cacheReuse.jitCodeGrowthBytes ].map( display ).join( ' | ' )} |` ),
		'',
		'## Net impact against WordPress',
		'',
		'Positive deltas are added full-response time; negative deltas are observed savings. Efficient replacement of core work is one possible explanation, alongside boost/cache state and scheduling variation. Zero is retained. Fastest delta = plugin fastest minus matched core fastest; median delta uses both raw medians. These are differences between independent observations, not paired per-request CPU costs. A single-pass difference is exploratory and does not establish its cause.',
		'',
		'| Candidate | WP | PHP | Scenario | Core fastest ms | Added fastest ms | Core median ms | Added median ms | Baseline interpretation |',
		'| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |',
		...summaries.filter( row => ! row.baseline ).map( row => `| ${[ row.candidate, row.wp, row.php, row.scenario, row.baselineLeadingMs, row.baselineDeltaMs, row.baselineMedianMs, row.baselineMedianDeltaMs, row.baselineReason ].map( display ).join( ' | ' )} |` ),
		...( 'repeat-controls' === manifest.config.comparisonMode ? [
			'', '## Repeat-control evidence', '',
			'Candidate order completes balanced rotations. Observed delta ranges are widened by the largest absolute same-round difference between the primary and identical no-plugin repeat controls. These are observed ranges, not confidence intervals. Unresolved cells retain raw timings without a comparison factor. See controls.csv and controls.json for the per-round measurements.', '',
			'| Candidate | Scenario | Control minimum spread ms | Control median spread ms | Assessment |',
			'| --- | --- | ---: | ---: | --- |',
			...summaries.map( row => `| ${[ row.candidate, row.scenario, row.controlMinimumSpreadMs, row.controlMedianSpreadMs, row.controlAssessment ].map( display ).join( ' | ' )} |` ),
		] : [] ),
		'',
		'[Interactive charts](report.html) show signed impact, full-response times and a per-page heatmap, with separate fastest/median controls and exact runtime/workload cohorts. N/A never becomes zero. Sitemaps and configured redirects retain endpoint timings without a core subtraction until equivalent workloads are established. No global plugin score is formed by averaging pages.',
		'',
		'[Front-end output comparison](output-comparison.md) shows the observed metadata and JSON-LD for every tested HTML page, including the WordPress control and verified fastest-response provenance. The HTML report shows the matching matrix and exact markup beside each selected page. Missing saved evidence stays unavailable. Presence is not an SEO quality score; entity roles and content context matter.',
		'',
		'An added-overhead comparison of 200 ms / 1 ms is 200x, while total page-speed improvement is (core + 200) / (core + 1). Added-overhead factors are unavailable for zero, savings, ambiguous controls or observed round envelopes reaching zero. A positive single-round factor remains exploratory. Cross-round envelopes span observed round summaries, not confidence intervals. The HTML reference selector exposes both factors separately.',
		'',
		'## Front end, back end and saves',
		'',
		'Group averages use the same intersection of eligible, exact-cohort scenarios for every intended candidate in a runtime. Each scenario has equal weight. Mean of minima, mean of medians and mean request time are separate statistics; the first two are not the minimum or median of pooled calls. Counts show included measured calls and warmups separately. These are descriptive fixture averages, not traffic-weighted estimates or an overall plugin rank.',
		'',
		'Front end includes ordinary HTML page and archive routes. Back end includes dashboard, list and editor GET pages. Editor-save POST requests belong only to Save operations, with an explicit measured-save count. RSS, robots, sitemap and redirect endpoints stay in their individual cohorts because their workloads are not equivalent.',
		'',
		'| Candidate | WP | PHP | Group | Scenarios used / requested | Mean minima ms | Mean medians ms | Mean request ms | Added mean minima ms | Measured calls | Warmups | Measured saves | Status |',
		'| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
		...groupSummaries.map( row => `| ${[ row.candidate, row.wp, row.php, row.groupLabel, `${row.scenarioCount}/${row.requestedScenarioCount}`, row.averageLeadingMs, row.averageMedianMs, row.averageRequestMs, row.baselineDeltaMs, row.measuredCalls, row.warmupCalls, row.saveCalls, row.status ].map( display ).join( ' | ' )} |` ),
		'',
		'group-summary.csv retains included/excluded scenario lists, participants, scope and all three matched baseline differences. Missing group means stay unavailable, while genuine zero call counts remain zero.',
		'',
		'## Findings and qualifications',
		'',
		...summaries.filter( row => row.issues && 'failed' !== row.status ).map( row => `- ${display( row.candidate )}, WP ${row.wp}, PHP ${row.php}, ${row.scenario}: ${display( row.issues )}.` ),
		...( manifest.failures || [] ).map( item => `- Failed matrix cell: ${display( item.candidate )}, WP ${display( item.wp )}, PHP ${display( item.php )}: ${display( item.error )}.` ),
		...( manifest.analysis || [] ).map( item => `- ${item}` ),
		'',
		'## Method and interpretation',
		'',
		`High-tail trimming excludes only valid observations greater than ${( 1 + manifest.config.outlierFraction ).toFixed( 2 )} times the raw valid ${manifest.config.outlierReference}. Raw observations, raw medians, and the minimum remain intact. Invalid responses never enter timing statistics.`,
		'',
		`The fastest-${manifest.config.fastestCount} mean uses at most that many valid observations. It does not imply that ${manifest.config.fastestCount} requests survived. Repeated calls estimate a warmed lower bound, not average user latency or CPU execution time.`,
		'',
		'Only explicitly identified versions of one plugin are accepted, including when rebuilding saved reports. No product or version ranks are computed. A core baseline measures shared overhead; deltas are observations, not isolated plugin CPU costs or production speed predictions.',
		'',
		'Every measured response must echo a fresh PHP token, match the expected authentication state, status, content type, route content, and redirect target when applicable. A conspicuously isolated fast minimum remains in raw data but receives no leading metric until investigated. Failures and partial cells remain visible.',
		'',
		'CPU load and observed clock behavior are the main machine context. clocks.csv preserves before/after ranges, individual readings, source, scope and measurement kind. Windows os-performance-estimate values are reference MHz multiplied by relative active performance, not measured wall-time effective clocks. Requested, estimated and measured clocks must not be treated as interchangeable; endpoint readings do not describe every request or prove an absence of throttling. Timings are not normalized by clock speed.',
		'',
		'Temperature readings remain optional context in temperatures.csv. A temperature cap, stable high temperature, temperature drift or missing sensor alone does not establish a speed difference, invalidate a response, or change its measurement status. Boost controllers can operate at a thermal target while maximizing performance. Interpret actual clock behavior, load, power limits and repeated timings together. Probe commands and filesystem exports run outside timing windows.',
		'',
		'cpu-load.csv records the block-average busy percentage from two operating-system CPU-counter snapshots, taken after the starting temperature read and before the ending read. It covers the measured loop and validation across all logical CPUs and all activity visible to that OS, not isolated plugin CPU time or interrupt spikes. WSL is labeled wsl-guest; other VM/container limits require operator context. Missing, reset or unchanged counters remain unavailable, not idle. Raw snapshots are in results.json.',
		'',
		'HTTP timings include loopback transport, Node, PHP-WASM, SQLite, WordPress, theme, MU instrumentation, and the plugin. They do not establish native PHP-FPM/MySQL throughput or browser interaction speed. Admin editor GET measures server rendering; editor-save measures a real authenticated REST update. Browser JS, assets, and visual readiness require a separately labeled browser experiment. Save calls alternate titles; WordPress revision growth is preserved.',
		'',
		'Exact package hashes, requested/resolved versions, setup profiles, environment, per-block diagnostics, and launch failures are in results.json and manifest.json. Runtime snapshots and response evidence are retained. Review this generated report and add evidence-backed explanations to analysis.md before presenting a benchmark conclusion.',
		'',
	];
	fs.writeFileSync( path.join( output, 'report.md' ), lines.join( '\n' ) );

	return result;
}

module.exports = { csvField, writeCSV, saveBlock, report };
