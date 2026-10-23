/**
 * Exports recorded benchmark data with the bundled Artifact Tool runtime.
 * Follow the spreadsheet skill, including its operation marker, before running.
 *
 * Usage: node export-xlsx.js --modules <runtime-node_modules> --input <run-dir>
 */

const fs   = require( 'fs' );
const path = require( 'path' );
const { createRequire } = require( 'module' );
const { pathToFileURL } = require( 'url' );
const { argumentsFrom } = require( './benchmark' );
const { ROOT, allowedPath } = require( './engine' );
const { addCharts } = require( './chart-sheet' );
const { addGroupSheet } = require( './group-sheet' );

/**
 * Preserves numeric/Boolean types and escapes formula-like literal text.
 *
 * @param {*} value
 * @return {*}
 */
function cellValue( value ) {

	if ( undefined === value ) return null;

	if ( 'string' === typeof value && /^[=+\-@]/.test( value ) ) return `'${value}`;

	return value;
}

/**
 * Writes and formats a recorded-data sheet; measurements are immutable inputs.
 *
 * @param {Object} workbook
 * @param {string} name
 * @param {Object[]} rows
 * @param {Object[]} columns
 * @return {Object}
 */
function addSheet( workbook, name, rows, columns ) {

	if ( rows.length > 1048575 ) throw new Error( `${name} exceeds Excel's row limit. Use the complete CSV export.` );

	const sheet = workbook.worksheets.add( name );
	sheet.showGridLines = false;
	sheet.getRangeByIndexes( 0, 0, 1, columns.length ).values = [ columns.map( item => item.label ) ];
	for ( let start = 0; start < rows.length; start += 2000 ) {
		const batch = rows.slice( start, start + 2000 );
		sheet.getRangeByIndexes( start + 1, 0, batch.length, columns.length ).values = batch.map(
			row => columns.map(
				item => cellValue( item.date && row[item.key] ? new Date( row[item.key] ) : row[item.key] ),
			),
		);
	}
	const range = sheet.getRangeByIndexes( 0, 0, rows.length + 1, columns.length );
	range.format.font = { name: 'Arial', size: 10 };
	range.format.rowHeight = 21;
	range.format.verticalAlignment = 'center';
	const header = sheet.getRangeByIndexes( 0, 0, 1, columns.length );
	header.format.fill = '#243B53';
	header.format.font = { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' };
	header.format.horizontalAlignment = 'center';
	header.format.wrapText = true;
	header.format.rowHeight = 34;
	columns.forEach( ( item, index ) => {
		const column = sheet.getRangeByIndexes( 0, index, rows.length + 1, 1 );
		column.format.columnWidth = item.width || 18;
		if ( rows.length ) {
			const body = sheet.getRangeByIndexes( 1, index, rows.length, 1 );
			body.format.horizontalAlignment = item.numeric ? 'right' : 'left';
			if ( item.format ) body.setNumberFormat( item.format );

			if ( item.wrap ) {
				body.format.wrapText = true;
			}
		}
	} );
	if ( rows.length && columns.some( item => item.wrap ) )
		sheet.getRangeByIndexes( 1, 0, rows.length, columns.length ).format.autofitRows();

	sheet.freezePanes.freezeRows( 1 );
	sheet.freezePanes.freezeColumns( 1 );

	return sheet;
}

/**
 * Exports, inspects, and renders recorded data and editable comparison charts.
 *
 * @param {Object} args
 * @return {Promise<string>}
 */
async function main( args = argumentsFrom( process.argv.slice( 2 ) ) ) {

	if ( ! args.modules || ! args.input ) throw new Error( 'Pass --modules <bundled-node_modules> --input <run-directory>.' );

	const modules = allowedPath( path.resolve( ROOT, args.modules ) );
	const output  = allowedPath( path.resolve( ROOT, args.input ) );
	const results = JSON.parse( fs.readFileSync( path.join( output, 'results.json' ), 'utf8' ) );
	const scope = require( './plugin-scope' ).manifestScope( results.manifest );
	require( './plugin-scope' ).validateRows( scope, results.summaries );
	if ( results.reportVersion !== 3 || Object.hasOwn( results, 'fairness' ) || Object.hasOwn( results.manifest.config, 'fairness' ) )
		throw new Error( 'Regenerate the report from raw checkpoints before exporting the current comparison fields, baseline charts and group averages.' );

	const resolve = createRequire( path.join( modules, '../artifact-export.cjs' ) );
	const { Workbook, SpreadsheetFile } = await import(
		pathToFileURL( resolve.resolve( '@oai/artifact-tool' ) ).href,
	);
	const cohorts = [ ...new Set( results.summaries.map( row => row.cohort ) ) ];
	// Explicit flags avoid Boolean/empty-string COUNTIFS differences between engines.
	const summaryRows = results.summaries.map( row => ( {
		...row, issues: [ row.issues, ...( 'repeat-controls' === results.manifest.config.comparisonMode ? [ row.controlAssessment ] : [] ) ].filter( Boolean ).join( '; ' ), chartEligible: Number( row.eligible ), cohortNumber: cohorts.indexOf( row.cohort ) + 1,
		chartBaselineMatched: Number( !! row.baselineCandidate && Number.isFinite( row.baselineLeadingMs ) && Number.isFinite( row.baselineMedianMs ) ),
	} ) );
	const samples = [];
	const readline = require( 'readline' );
	const sampleFile = path.join( output, 'samples.ndjson' );
	if ( fs.existsSync( sampleFile ) ) {
		const lines = readline.createInterface( { input: fs.createReadStream( sampleFile ), crlfDelay: Infinity } );
		for await ( const line of lines ) {
			if ( line.trim() ) samples.push( JSON.parse( line ) );
		}
	}
	const workbook = Workbook.create();
	const summarySheet = addSheet( workbook, 'Summary', summaryRows, [
		{ key: 'candidate', label: 'Candidate', width: 25 },
		{ key: 'pluginVersion', label: 'Plugin version', width: 21 },
		{ key: 'wp', label: 'WordPress', width: 15 },
		{ key: 'php', label: 'PHP', width: 15 },
		{ key: 'scenario', label: 'Scenario', width: 21 },
		{ key: 'attempted', label: 'Measured attempts', numeric: true, format: '#,##0' },
		{ key: 'valid', label: 'Valid requests', numeric: true, format: '#,##0' },
		{ key: 'minimumMs', label: 'Fastest (ms)', numeric: true, format: '0.000' },
		{ key: 'medianMs', label: 'Median (ms)', numeric: true, format: '0.000' },
		{ key: 'trimmedMeanMs', label: 'Trimmed mean (ms)', numeric: true, format: '0.000' },
		{ key: 'highOutliers', label: 'High outliers', numeric: true, format: '#,##0' },
		{ key: 'invalid', label: 'Invalid requests', numeric: true, format: '#,##0' },
		{ key: 'pluginSlug', label: 'Plugin', width: 22 },
		{ key: 'status', label: 'Status', width: 18 },
		{ key: 'issues', label: 'Qualifications', width: 70, wrap: true },
		{ key: 'baselineCandidate', label: 'WordPress baseline', width: 22 },
		{ key: 'baselineLeadingMs', label: 'Core fastest (ms)', numeric: true, format: '0.000', width: 22 },
		{ key: 'baselineDeltaMs', label: 'Added fastest (ms)', numeric: true, format: '0.000', width: 23 },
		{ key: 'baselineMedianMs', label: 'Core median (ms)', numeric: true, format: '0.000', width: 22 },
		{ key: 'baselineMedianDeltaMs', label: 'Added median (ms)', numeric: true, format: '0.000', width: 23 },
		{ key: 'baselineReason', label: 'Baseline interpretation', width: 70, wrap: true },
		{ key: 'chartEligible', label: 'Eligible timing (1/0)', numeric: true, format: '0', width: 22 },
		{ key: 'cohortNumber', label: 'Chart cohort number', numeric: true, format: '0', width: 22 },
		{ key: 'chartBaselineMatched', label: 'Matched core (1/0)', numeric: true, format: '0', width: 22 },
		{ key: 'meanMs', label: 'Raw mean (ms)', numeric: true, format: '0.000', width: 22 },
		{ key: 'warmupValid', label: 'Validated warmups', numeric: true, format: '#,##0', width: 22 },
	] );
	summaryRows.forEach( ( row, index ) => {
		if ( Number.isFinite( row.baselineDeltaMs ) ) summarySheet.getRange( `R${index + 2}` ).formulas = [ [ `=H${index + 2}-Q${index + 2}` ] ];
		if ( Number.isFinite( row.baselineMedianDeltaMs ) ) summarySheet.getRange( `T${index + 2}` ).formulas = [ [ `=I${index + 2}-S${index + 2}` ] ];
	} );
	addSheet( workbook, 'Samples', samples, [
		{ key: 'candidate', label: 'Candidate', width: 25 },
		{ key: 'scenario', label: 'Scenario', width: 21 },
		{ key: 'wp', label: 'WordPress', width: 15 },
		{ key: 'php', label: 'PHP', width: 15 },
		{ key: 'round', label: 'Round', numeric: true, format: '0' },
		{ key: 'phase', label: 'Phase', width: 15 },
		{ key: 'sequence', label: 'Sequence', numeric: true, format: '#,##0' },
		{ key: 'elapsedMs', label: 'Full response (ms)', numeric: true, format: '0.000' },
		{ key: 'ttfbMs', label: 'TTFB (ms)', numeric: true, format: '0.000' },
		{ key: 'status', label: 'HTTP status', numeric: true, format: '0' },
		{ key: 'bytes', label: 'Response bytes', numeric: true, format: '#,##0' },
		{ key: 'valid', label: 'Valid', width: 12 },
		{ key: 'reasons', label: 'Rejection reason', width: 70, wrap: true },
		{ key: 'pluginVersion', label: 'Plugin version', width: 21 },
		{ key: 'at', label: 'Request time (UTC)', date: true, format: 'yyyy-mm-dd hh:mm:ss', width: 29 },
		{ key: 'blockId', label: 'Block identifier', width: 48 },
		{ key: 'sha256', label: 'Response SHA-256', width: 70 },
		{ key: 'route', label: 'WordPress route', width: 32 },
		{ key: 'userId', label: 'WordPress user ID', width: 23 },
		{ key: 'contentType', label: 'Content type', width: 45 },
		{ key: 'location', label: 'Redirect target', width: 65 },
		{ key: 'executionToken', label: 'Sent execution token', width: 43 },
		{ key: 'responseToken', label: 'Received execution token', width: 43 },
	] );
	const probes = results.blocks.flatMap( block => [ 'before', 'after' ].map( phase => {
		const clock = 'before' === phase ? block.clockBefore : block.clockAfter;

		return {
			candidate: block.candidate, scenario: block.scenario, round: block.round, phase,
			celsius: block[phase]?.celsius ?? null, at: block[phase]?.at,
			sensors: block[phase]?.sensors?.map( item => `${item.sensor}: ${item.celsius}` ).join( '; ' ),
			reason: block[phase]?.reason || block.unavailable || block.error || '',
			cpuPercent: 'after' === phase ? block.cpu?.load?.percent ?? null : null,
			cpuScope: 'after' === phase ? block.cpu?.load?.scope || '' : '',
			cpuReason: 'after' === phase ? block.cpu?.load?.reason || ( block.cpu ? '' : 'CPU counters were not recorded by this run.' ) : '',
			clockMinimumMHz: clock?.minimumMHz ?? null, clockMaximumMHz: clock?.maximumMHz ?? null,
			clockKinds: ( clock?.kinds || [] ).join( '; ' ), clockAt: clock?.at,
			clockSource: clock?.source || '', clockScope: clock?.scope || '',
			clockReason: clock?.reason || ( clock ? '' : ( block.unavailable || 'CPU clocks were not recorded by this run.' ) ),
		};
	} ) );
	addSheet( workbook, 'CPU context', probes, [
		{ key: 'candidate', label: 'Candidate', width: 25 },
		{ key: 'scenario', label: 'Scenario', width: 21 },
		{ key: 'round', label: 'Round', numeric: true, format: '0' },
		{ key: 'phase', label: 'Phase', width: 15 },
		{ key: 'cpuPercent', label: 'Block CPU busy (%)', numeric: true, format: '0.00', width: 24 },
		{ key: 'clockMinimumMHz', label: 'Clock minimum (MHz)', numeric: true, format: '0.0', width: 24 },
		{ key: 'clockMaximumMHz', label: 'Clock maximum (MHz)', numeric: true, format: '0.0', width: 24 },
		{ key: 'clockKinds', label: 'Clock kind', width: 28 },
		{ key: 'clockAt', label: 'Clock query time (UTC)', date: true, format: 'yyyy-mm-dd hh:mm:ss', width: 29 },
		{ key: 'cpuScope', label: 'CPU counter scope', width: 25 },
		{ key: 'clockSource', label: 'Clock source', width: 40 },
		{ key: 'clockScope', label: 'Clock scope', width: 25 },
		{ key: 'cpuReason', label: 'CPU counter limitation', width: 65, wrap: true },
		{ key: 'clockReason', label: 'Clock limitation', width: 65, wrap: true },
		{ key: 'celsius', label: 'CPU temperature (C)', numeric: true, format: '0.0', width: 23 },
		{ key: 'at', label: 'Reading time (UTC)', date: true, format: 'yyyy-mm-dd hh:mm:ss', width: 29 },
		{ key: 'sensors', label: 'CPU sensors', width: 55, wrap: true },
		{ key: 'reason', label: 'Missing reading or test limitation', width: 75, wrap: true },
	] );
	const manifest = results.manifest;
	const baselineIds = [ ...new Set( summaryRows.map( row => row.baselineCandidate ).filter( Boolean ) ) ];
	const primary = manifest.config.baselineCandidate || ( 1 === baselineIds.length ? baselineIds[0] : '' );
	const repeats = ( manifest.candidates || [] ).filter( item => item.baseline && item.negativeControl ).map( item => item.id );
	const information = [
		{ field: 'Interpretation', value: require( './disclaimer' ) },
		{ field: 'Leading metric', value: 'Fastest validated complete HTTP response; raw median also recorded.' },
		{ field: 'Run type', value: manifest.smoke ? 'Preflight / smoke, not a performance conclusion' : ( manifest.exploratory ? 'Exploratory comparison' : 'Full comparison' ) },
		{ field: 'Started (UTC)', value: new Date( manifest.startedAt ) },
		{ field: 'Finished (UTC)', value: manifest.finishedAt ? new Date( manifest.finishedAt ) : null },
		{ field: 'Measured attempts per supported scenario/candidate', value: manifest.config.samples },
		{ field: 'Fresh-install rounds', value: manifest.config.rounds },
		{ field: 'Warmups per block', value: manifest.config.warmups },
		{ field: 'HTTP concurrency', value: 1 },
		{ field: 'Playground workers', value: manifest.config.workers },
		{ field: 'Playground CLI', value: manifest.environment.selectedPlaygroundVersion || manifest.environment.playground },
		{ field: 'CPU', value: manifest.environment.cpus?.[0]?.trim() || '' },
		{ field: 'Outlier trimming', value: `Only values >${1 + manifest.config.outlierFraction} times raw ${manifest.config.outlierReference}; raw observations remain intact.` },
		{ field: 'Measurement boundary', value: 'Warmed local HTTP, PHP-WASM and SQLite; excludes browser JavaScript/assets/visual readiness. Not native PHP-FPM/MySQL.' },
		{ field: 'CPU busy percentage', value: 'CPU context sheet, after rows: block-average activity across all OS-visible logical CPUs, not plugin CPU time. WSL counters describe the guest, not the Windows host. Missing/reset/unchanged counters stay unavailable.' },
		{ field: 'CPU clocks', value: 'CPU context sheet: endpoint min/max across the reported cores/policies. Keep clock kind, source and scope. Windows active-performance estimates and Linux driver-reported/requested clocks are not hardware-effective measurements. Do not normalize timings by these values.' },
		{ field: 'Temperature context', value: 'Optional readings only. A temperature cap, drift or missing reading does not itself prove reduced performance or change measurement status. Evaluate clocks, load and repeated timings together.' },
		{ field: 'WordPress subtraction baseline', value: primary || 'No single primary baseline; see each Summary row.' },
		{ field: 'WordPress repeat check', value: repeats.length ? `${repeats.join( ', ' )}; independently measured to show run variation; never substituted for or averaged into the subtraction baseline.` : 'No separate WordPress repeat check.' },
		{ field: 'Baseline differences', value: `Summary added-time formulas subtract ${primary || 'the matched WordPress control'} for the same metric. Negative values are observed savings; blanks are unavailable. Independent minima are not paired request CPU costs. Feature endpoint workloads are not yet matched.` },
		{ field: 'Charts', value: 'Impact charts has editable cohort and metric selectors; 1 = fastest, 2 = median. Both native charts link to formulas reading Summary. report.html also has per-page heatmaps and separate reference/row added-overhead and full-response factors. No factor for zero/savings or envelopes reaching zero.' },
		{ field: 'Repeat controls', value: manifest.config.comparisonMode === 'repeat-controls' ? 'Repeat controls sheet: observed minimum/median round ranges are widened by no-plugin control spread. Unresolved comparisons do not establish speedups or slowdowns. These empirical ranges are not confidence intervals. HTML factors require both pairwise metric ranges to agree beyond both control spreads; self-reference is 1 by definition.' : ( repeats.length ? 'WordPress repeat checks are recorded; this exploratory run has no full position-balanced repeat-control assessment.' : 'No separate no-plugin repeat-control assessment was requested.' ) },
		{ field: 'Group averages', value: 'Front end: ordinary HTML page/archive routes; RSS and robots stay separate. Back end: five admin GET scenarios. Saves: editor-save POST only, excluded from back end. Each candidate uses the same common exact-cohort scenarios with equal scenario weight. Mean minima, mean medians and raw mean requests are distinct. Counts are included validated measured calls, with warmups separate. Features stay separate; no traffic model or global rank.' },
		...( manifest.analysis || [] ).map( value => ( { field: 'Finding / qualification', value } ) ),
		...( manifest.exclusions || [] ).map( item => ( { field: `Deferred: ${item.candidate} ${item.version || ''}`, value: item.reason } ) ),
		...( manifest.candidates || [] ).flatMap( item => [
			{ field: `Candidate: ${item.id}`, value: item.baseline ? ( item.id === primary ? 'Primary WordPress subtraction baseline; no SEO plugin active' : ( item.negativeControl ? 'WordPress repeatability check; no SEO plugin active' : 'Additional WordPress control; no SEO plugin active' ) ) : `${item.slug} ${item.version}` },
		] ),
	];
	const informationSheet = addSheet( workbook, 'Run information', information, [
		{ key: 'field', label: 'Field', width: 57, wrap: true },
		{ key: 'value', label: 'Recorded value / explanation', width: 115, wrap: true },
	] );
	informationSheet.getRange( 'B5:B6' ).setNumberFormat( 'yyyy-mm-dd hh:mm:ss' );
	const chartInfo = addCharts( workbook, summaryRows, manifest );
	fs.writeFileSync( path.join( output, 'xlsx-charts.json' ), JSON.stringify( { ...chartInfo, sheet: undefined }, null, '\t' ) + '\n' );
	const groupInfo = addGroupSheet( workbook, results, addSheet );
	fs.writeFileSync( path.join( output, 'xlsx-groups.json' ), JSON.stringify( groupInfo, null, '\t' ) + '\n' );
	if ( 'repeat-controls' === manifest.config.comparisonMode ) {
		addSheet( workbook, 'Repeat controls', results.controls || [], [
			{ key: 'candidate', label: 'Candidate', width: 18 },
			{ key: 'scenario', label: 'Scenario', width: 22 },
			{ key: 'primaryControl', label: 'Primary control', width: 20 },
			{ key: 'negativeControls', label: 'No-plugin repeat', width: 22 },
			{ key: 'controlMinimumSpreadMs', label: 'Control minimum spread ms', numeric: true, format: '0.000', width: 24 },
			{ key: 'controlMedianSpreadMs', label: 'Control median spread ms', numeric: true, format: '0.000', width: 24 },
			{ key: 'minimumDeltaMs', label: 'Fastest delta ms', numeric: true, format: '0.000', width: 20 },
			{ key: 'minimumLowMs', label: 'Observed minimum low ms', numeric: true, format: '0.000', width: 24 },
			{ key: 'minimumHighMs', label: 'Observed minimum high ms', numeric: true, format: '0.000', width: 24 },
			{ key: 'medianDeltaMs', label: 'Median delta ms', numeric: true, format: '0.000', width: 20 },
			{ key: 'medianLowMs', label: 'Observed median low ms', numeric: true, format: '0.000', width: 24 },
			{ key: 'medianHighMs', label: 'Observed median high ms', numeric: true, format: '0.000', width: 24 },
			{ key: 'assessment', label: 'Descriptive assessment, not a confidence interval', width: 75, wrap: true },
		] );
	}
	workbook.recalculate();
	const inspection = await workbook.inspect( {
		kind: 'table', range: 'Summary!A1:O8', include: 'values,formulas',
		tableMaxRows: 8, tableMaxCols: 15, maxChars: 5000,
	} );
	fs.writeFileSync( path.join( output, 'xlsx-inspection.ndjson' ), inspection.ndjson );
	const groupInspection = await workbook.inspect( {
		kind: 'table', range: 'Group averages!A1:R8', include: 'values,formulas',
		tableMaxRows: 8, tableMaxCols: 18, maxChars: 6000,
	} );
	fs.writeFileSync( path.join( output, 'xlsx-group-inspection.ndjson' ), groupInspection.ndjson );
	const errors = await workbook.inspect( {
		kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!',
		options: { useRegex: true, maxResults: 20 }, maxChars: 2000,
	} );
	fs.writeFileSync( path.join( output, 'xlsx-errors.ndjson' ), errors.ndjson );
	const sheetNames = [ 'Summary', 'Samples', 'CPU context', 'Run information', 'Impact charts', 'Group averages', ...( 'repeat-controls' === manifest.config.comparisonMode ? [ 'Repeat controls' ] : [] ) ];
	for ( const sheetName of sheetNames ) {
		const range = 'Repeat controls' === sheetName ? `A1:M${Math.min( 16, ( results.controls || [] ).length + 1 )}` : ( 'Group averages' === sheetName ? `A1:R${Math.min( 20, results.groupSummaries.length + 1 )}` : ( 'Impact charts' === sheetName ? 'A1:U43' : ( 'Run information' === sheetName ? 'A1:B14' : ( 'CPU context' === sheetName ? 'A1:R10' : ( 'Summary' === sheetName ? 'A1:W10' : 'A1:M10' ) ) ) ) );
		const preview = await workbook.render( { sheetName, range, scale: 1, format: 'png' } );
		fs.writeFileSync( path.join( output, `xlsx-${sheetName.toLowerCase().replace( /\s+/g, '-' )}.png` ), new Uint8Array( await preview.arrayBuffer() ) );
	}
	const file = await SpreadsheetFile.exportXlsx( workbook );
	const destination = path.join( output, 'performance.xlsx' );
	await file.save( destination );
	console.log( destination );

	return destination;
}

if ( require.main === module ) {
	main().catch( error => {
		console.error( error.message );
		process.exitCode = 1;
	} );
}

module.exports = { cellValue, addSheet, main };
