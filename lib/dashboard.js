/**
 * Self-contained, offline HTML comparisons. No CDN, telemetry or browser fetches.
 */

const fs = require( 'fs' );
const path = require( 'path' );
const { METRICS, compare } = require( './comparison' );
const { GROUP_METRICS } = require( './groups' );
const disclaimer = require( './disclaimer' );

/**
 * Keeps untrusted names and notes inside a JSON script element.
 *
 * @param {*} value
 * @return {string}
 */
function scriptJSON( value ) {

	return JSON.stringify( value ).replace( /[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt( 0 ).toString( 16 ).padStart( 4, '0' )}` );
}

/**
 * Runs in the generated page, using DOM text rather than interpolated HTML.
 */
function dashboard() {

	const data = JSON.parse( document.getElementById( 'benchmark-data' ).textContent );
	const rows = data.summaries;
	const runtime = document.getElementById( 'runtime' );
	const scenario = document.getElementById( 'scenario' );
	const metric = document.getElementById( 'metric' );
	const reference = document.getElementById( 'reference' );
	const requestGroup = document.getElementById( 'request-group' );
	const averageMetric = document.getElementById( 'average-metric' );
	const visible = row => ! data.repeatControls.includes( row.candidate );
	const runtimeKeys = [ ...new Set( rows.filter( visible ).map( row => row.runtimeGroup ) ) ];
	const number = value => Number.isFinite( value ) ? value.toFixed( 3 ) : 'n/a';
	const signed = value => Number.isFinite( value ) ? `${value > 0 ? '+' : ''}${number( value )}` : 'n/a';
	const candidateLabel = row => row.baseline ? `${row.candidate} (${row.candidate === data.baselineCandidate ? 'baseline' : ( data.repeatControls.includes( row.candidate ) ? 'repeat check' : 'control' )})` : row.candidate;
	const baselineFor = records => {
		const ids = [ ...new Set( records.filter( row => ! row.baseline && row.baselineCandidate ).map( row => row.baselineCandidate ) ) ];

		return 1 === ids.length ? ids[0] : '';
	};
	const baselineCaption = ( records, value, delta ) => {
		const id = baselineFor( records );
		const row = records.find( row => ! row.baseline && row.baselineCandidate === id && Number.isFinite( row[value] ) && Number.isFinite( row[delta] ) );

		return row ? `Subtraction baseline: ${id}, ${number( row[value] - row[delta] )} ms. Added time = plugin time - ${id} time. Lower values mean a smaller observed response time.` : 'No single matched WordPress baseline for subtraction in this workload.';
	};
	const element = ( tag, text, parent ) => {
		const node = document.createElement( tag );
		if ( undefined !== text ) node.textContent = text;

		parent?.appendChild( node );

		return node;
	};
	const option = ( parent, value, label ) => {
		const node = element( 'option', label, parent );
		node.value = value;
	};
	const description = rows => {
		const row = rows[0];

		return `${row.scenario} (${row.frame}${row.featureDocument ? `, ${'sitemapindex' === row.featureDocument ? 'index document' : 'URL list'}` : ''})`;
	};
	const cohortsForRuntime = () => [ ...new Set( rows.filter( row => visible( row ) && row.runtimeGroup === runtime.value ).map( row => row.cohort ) ) ];
	const cohortRows = cohort => rows.filter( row => visible( row ) && row.cohort === cohort );
	const svgNode = ( tag, attributes, parent, text ) => {
		const node = document.createElementNS( 'http://www.w3.org/2000/svg', tag );
		Object.entries( attributes ).forEach( ( [ key, value ] ) => node.setAttribute( key, value ) );
		if ( undefined !== text ) node.textContent = text;

		parent.appendChild( node );

		return node;
	};
	const bars = ( id, records, key, isDelta ) => {
		const container = document.getElementById( id );
		container.replaceChildren();
		const values = records.filter( row => row.eligible && Number.isFinite( row[key] ) && ( ! isDelta || ! row.baseline ) );
		if ( ! values.length ) {
			element( 'p', isDelta ? 'No matched core workload for subtraction. See the endpoint timings and exclusions below.' : 'No eligible timings for this workload.', container );

			return;
		}
		values.sort( ( a, b ) => a[key] - b[key] );
		const low = Math.min( 0, ...values.map( row => row[key] ) );
		const high = Math.max( 0, ...values.map( row => row[key] ) );
		const span = high - low || 1;
		const left = 300, right = 820, width = right - left;
		const x = value => left + ( value - low ) / span * width;
		const height = 66 + values.length * 54;
		const svg = svgNode( 'svg', { viewBox: `0 0 1000 ${height}`, role: 'img', 'aria-label': isDelta ? `Signed added time against ${baselineFor( records ) || 'the matched WordPress baseline'} in milliseconds` : 'Full response times in milliseconds; gray bars are WordPress controls' }, container );
		for ( let tick = 0; tick <= 4; tick++ ) {
			const value = low + span * tick / 4;
			svgNode( 'line', { x1: x( value ), x2: x( value ), y1: 20, y2: height - 35, stroke: '#e2e8f0' }, svg );
			svgNode( 'text', { x: x( value ), y: height - 10, 'text-anchor': 'middle', fill: '#475569', 'font-size': 22 }, svg, value.toFixed( 1 ) );
		}
		svgNode( 'line', { x1: x( 0 ), x2: x( 0 ), y1: 15, y2: height - 35, stroke: '#64748b', 'stroke-width': 1.5 }, svg );
		values.forEach( ( row, index ) => {
			const y = 26 + index * 54;
			const name = candidateLabel( row );
			const label = name.length > 25 ? `${name.slice( 0, 24 )}…` : name;
			svgNode( 'text', { x: left - 12, y: y + 22, 'text-anchor': 'end', fill: '#0f172a', 'font-size': 22 }, svg, label );
			const bar = svgNode( 'rect', { x: Math.min( x( 0 ), x( row[key] ) ), y, width: Math.abs( x( row[key] ) - x( 0 ) ), height: 25, rx: 2, fill: row.baseline ? '#64748b' : ( isDelta ? ( row[key] < 0 ? '#087f8c' : '#ba4c2f' ) : '#3657a7' ) }, svg );
			svgNode( 'title', {}, bar, `${name}: ${number( row[key] )} ms, ${row.status}` );
			svgNode( 'text', { x: right + 18, y: y + 22, fill: '#0f172a', 'font-size': 24 }, svg, isDelta ? signed( row[key] ) : number( row[key] ) );
		} );
	};
	const renderGroups = () => {
		const records = data.groupSummaries.filter( row => visible( row ) && row.runtimeGroup === runtime.value && row.group === requestGroup.value );
		const field = GROUP_METRICS[averageMetric.value];
		const first = records[0];
		document.getElementById( 'group-baseline' ).textContent = baselineCaption( records, field.value, field.delta );
		document.getElementById( 'group-impact-title' ).textContent = `Average added time vs ${baselineFor( records ) || 'WordPress'} (ms)`;
		document.getElementById( 'group-scope' ).textContent = first ? `${first.scenarioCount}/${first.requestedScenarioCount} requested scenarios, using the same supported set for each displayed candidate. Included: ${first.scenarios || 'none'}. ${first.excludedScenarios ? `Excluded: ${first.excludedScenarios}.` : ''} ${first.note}` : 'No runtime snapshot supports group averages here. See the individual unavailable observations.';
		bars( 'group-impact', records, field.delta, true );
		bars( 'group-total', records, field.value, false );
		const table = document.getElementById( 'group-comparison' );
		table.replaceChildren();
		const head = element( 'tr', undefined, element( 'thead', undefined, table ) );
		[ 'Candidate / version', 'WordPress baseline', 'Mean minima ms', 'Mean medians ms', 'Mean request ms', 'Added selected mean ms', 'Scenarios used / requested', 'Measured calls used', 'Warmup calls', 'Measured saves', 'Status' ].forEach( text => element( 'th', text, head ) );
		const body = element( 'tbody', undefined, table );
		for ( const row of records ) {
			const tr = element( 'tr', undefined, body );
			[ `${candidateLabel( row )} ${row.pluginVersion}`, row.baselineCandidate || 'n/a', number( row.averageLeadingMs ), number( row.averageMedianMs ), number( row.averageRequestMs ), signed( row[field.delta] ), `${row.scenarioCount}/${row.requestedScenarioCount}`, row.measuredCalls, row.warmupCalls, row.saveCalls, row.status ].forEach( text => element( 'td', text, tr ) );
		}
	};
	const renderOutput = selected => {
		const table = document.getElementById( 'output-comparison' );
		const details = document.getElementById( 'output-details' );
		const scope = document.getElementById( 'output-scope' );
		table.replaceChildren();
		details.replaceChildren();
		if ( ! data.outputComparison ) {
			scope.textContent = 'This historical report has no output inventory. Rebuild it from saved checkpoints and fastest-response evidence; no new calls are needed.';
			return;
		}
		const records = [ ...selected ].sort( ( a, b ) => Number( b.baseline ) - Number( a.baseline ) || a.candidate.localeCompare( b.candidate ) ).map( row => ( {
			row, output: data.outputComparison.records.find( record => record.cohort === row.cohort && record.candidate === row.candidate ),
		} ) );
		if ( ! data.outputComparison.htmlScenarios.includes( selected[0]?.scenario ) ) {
			scope.textContent = 'This workload is not a public HTML page. XML feeds/sitemaps, plain-text robots, redirects, admin screens and saves do not receive a page-metadata presence score.';
			return;
		}
		const count = records.filter( record => 'available' === record.output?.status ).length;
		scope.textContent = `${count}/${records.length} verified saved responses. ${records.find( record => record.output )?.output.context || 'Public HTML query'}. Output is from each cell\'s fastest verified measured response, regardless of the selected timing metric. Footer JSON-LD is included. No = absent here; unavailable evidence is not No. See entity roles and exact values below.`;
		const head = element( 'tr', undefined, element( 'thead', undefined, table ) );
		[ 'Observed output', ...records.map( record => `${candidateLabel( record.row )} ${record.row.pluginVersion}` ) ].forEach( label => element( 'th', label, head ) );
		const body = element( 'tbody', undefined, table );
		let previous;
		for ( const feature of data.outputComparison.features ) {
			if ( feature.group !== previous ) {
				const section = element( 'th', feature.group, element( 'tr', undefined, body ) );
				section.colSpan = records.length + 1;
				section.className = 'output-group';
				previous = feature.group;
			}
			const tr = element( 'tr', undefined, body );
			element( 'th', feature.label, tr );
			for ( const record of records ) {
				const available = 'available' === record.output?.status;
				const td = element( 'td', available ? record.output.cells[feature.id] : 'Unavailable', tr );
				if ( ! available ) td.title = record.output?.reason || 'No saved output for this candidate in this exact cohort.';
			}
		}
		for ( const record of records ) {
			const item = element( 'details', undefined, details );
			element( 'summary', `${candidateLabel( record.row )} ${record.row.pluginVersion}: exact output`, item );
			const output = record.output;
			if ( 'available' !== output?.status ) {
				element( 'p', output?.reason || 'No verified saved response.', item );
				continue;
			}
			element( 'p', `Round ${output.round}; ${output.route}; HTTP ${output.responseStatus}; ${number( output.elapsedMs )} ms. Body SHA-256: ${output.sha256}.`, item );
			const link = element( 'a', 'Saved complete response', item );
			link.href = output.source;
			for ( const error of output.errors ) element( 'p', `JSON-LD parse issue: ${error}`, item );
			element( 'pre', output.tags.map( tag => tag.raw ).join( '\n' ), item );
			for ( const script of output.schemas ) {
				element( 'p', `JSON-LD location: ${script.location}`, item );
				element( 'pre', script.raw, item );
			}
		}
	};
	const render = () => {
		const selected = cohortRows( scenario.value );
		const field = METRICS[metric.value];
		const ref = selected.find( row => row.candidate === reference.value );
		renderOutput( selected );
		document.getElementById( 'workload' ).textContent = selected.length ? `${description( selected )}. ${data.rounds} fresh-install round(s), ${data.samples} measured attempts per supported cell.` : '';
		document.getElementById( 'page-baseline' ).textContent = baselineCaption( selected, metric.value, field.delta );
		document.getElementById( 'impact-title' ).textContent = `Added time vs ${baselineFor( selected ) || 'WordPress'} (ms)`;
		document.getElementById( 'reference-title' ).textContent = `Version ratios relative to ${ref?.candidate || 'the selected reference'}`;
		document.getElementById( 'ratio-scope' ).textContent = `The reference selector changes ratios in this table only. Added-time charts keep ${baselineFor( selected ) || 'their matched WordPress control'} as the subtraction baseline.`;
		bars( 'impact', selected, field.delta, true );
		bars( 'total', selected, metric.value, false );
		const table = document.getElementById( 'comparison' );
		table.replaceChildren();
		const head = element( 'tr', undefined, element( 'thead', undefined, table ) );
		[ 'Candidate / version', 'Full ms', 'WordPress baseline', 'Baseline ms', 'Added ms', 'Overhead factor (ref / row)', 'Full-response factor (ref / row)', 'Run assessment', 'Status and interpretation' ].forEach( label => element( 'th', label, head ) );
		const body = element( 'tbody', undefined, table );
		for ( const row of selected ) {
			const ratio = compare( row, ref, metric.value );
			const tr = element( 'tr', undefined, body );
			[ `${candidateLabel( row )} ${row.pluginVersion}`, row.eligible ? number( row[metric.value] ) : 'n/a', row.baselineCandidate || 'n/a', number( row[field.baseline] ), signed( row[field.delta] ), Number.isFinite( ratio.overheadRatio ) ? `${ratio.overheadRatio.toFixed( 2 )}×` : 'n/a', Number.isFinite( ratio.responseRatio ) ? `${ratio.responseRatio.toFixed( 2 )}×` : 'n/a', 'repeat-controls' === row.comparisonMode ? row.controlAssessment : 'Descriptive comparison; inspect observed round variation.', `${row.status}. ${row.issues || ''} ${row.baselineReason} ${ratio.reason}` ].forEach( text => element( 'td', text, tr ) );
		}
		const heatmap = document.getElementById( 'heatmap' );
		heatmap.replaceChildren();
		const candidates = [ ...new Set( rows.filter( row => row.runtimeGroup === runtime.value && ! row.baseline ).map( row => row.candidate ) ) ];
		const header = element( 'tr', undefined, element( 'thead', undefined, heatmap ) );
		[ 'Workload', ...candidates ].forEach( label => element( 'th', label, header ) );
		const heatBody = element( 'tbody', undefined, heatmap );
		const magnitude = Math.max( 1, ...rows.filter( row => row.runtimeGroup === runtime.value ).map( row => Math.abs( row[field.delta] || 0 ) ) );
		cohortsForRuntime().forEach( cohort => {
			const records = cohortRows( cohort );
			const tr = element( 'tr', undefined, heatBody );
			const button = element( 'button', description( records ), element( 'th', undefined, tr ) );
			button.onclick = () => { scenario.value = cohort; refreshReference(); render(); };
			candidates.forEach( candidate => {
				const row = records.find( item => item.candidate === candidate );
				const value = row?.[field.delta];
				const td = element( 'td', signed( value ), tr );
				td.title = row ? `${row.status}. ${row.baselineReason} ${row.issues} ${row.controlAssessment || ''}` : 'No observation in this exact cohort.';
				if ( Number.isFinite( value ) ) td.style.background = value < 0 ? `rgba(8,127,140,${0.08 + 0.32 * Math.abs( value ) / magnitude})` : `rgba(186,76,47,${0.05 + 0.32 * value / magnitude})`;
				if ( 'repeat-controls' === row?.comparisonMode && ( ! row.controlsComplete || row.controlAssessment.startsWith( 'Unresolved' ) ) ) td.style.background = '#eef0f2';
			} );
		} );
		renderGroups();
	};
	const refreshReference = () => {
		const previous = reference.value;
		reference.replaceChildren();
		cohortRows( scenario.value ).filter( row => ! row.baseline ).forEach( row => option( reference, row.candidate, row.candidate ) );
		if ( [ ...reference.options ].some( item => item.value === previous ) ) reference.value = previous;
	};
	const refreshScenarios = () => {
		scenario.replaceChildren();
		cohortsForRuntime().forEach( ( cohort, index ) => option( scenario, cohort, `${description( cohortRows( cohort ) )} · cohort ${index + 1}` ) );
		refreshReference();
		render();
	};
	runtimeKeys.forEach( ( key, index ) => {
		const row = rows.find( item => item.runtimeGroup === key );
		const context = JSON.parse( key );
		option( runtime, key, `WP ${row.wp} / PHP ${row.php} · ${context[2] || 'no runtime snapshot (N/A)'} · environment ${index + 1}` );
	} );
	document.getElementById( 'scope' ).textContent = `${data.smoke ? 'Smoke test; no performance conclusion.' : ( data.exploratory ? 'Exploratory comparison.' : 'Recorded comparison.' )} ${data.samples} attempts per supported scenario, ${data.rounds} round(s). Lower response times and signed deltas are faster. These are warmed local HTTP measurements, including PHP-WASM and SQLite.`;
	document.getElementById( 'baseline-policy' ).textContent = data.baselineCandidate ? `Baseline: ${data.baselineCandidate} (WordPress without an SEO plugin). Added time = plugin time - ${data.baselineCandidate} time. Gray bars identify WordPress controls.` : 'No single primary WordPress baseline is identified. Each workload reports whether subtraction is available.';
	document.getElementById( 'repeat-policy' ).textContent = data.repeatControls.length ? `Repeat check: ${data.repeatControls.join( ', ' )}. This separately measured WordPress setup shows run variation. It is not subtracted or averaged into the primary baseline.` : '';
	document.getElementById( 'diagnostic-controls' ).hidden = ! data.repeatControls.length;
	const notes = document.getElementById( 'notes' );
	data.notes.forEach( text => element( 'li', text, notes ) );
	const outputNotes = document.getElementById( 'output-notes' );
	data.outputComparison?.notes.forEach( text => element( 'li', text, outputNotes ) );
	for ( const [ label, url ] of data.outputComparison?.references || [] ) {
		const link = element( 'a', label, element( 'li', undefined, outputNotes ) );
		link.href = url;
	}
	runtime.onchange = refreshScenarios;
	scenario.onchange = () => { refreshReference(); render(); };
	metric.onchange = render;
	reference.onchange = render;
	requestGroup.onchange = renderGroups;
	averageMetric.onchange = renderGroups;
	if ( runtimeKeys.length ) refreshScenarios();
}

/**
 * Writes derived graphs only after measurement; raw samples remain untouched.
 *
 * @param {string} output
 * @param {Object} results
 */
function writeDashboard( output, results ) {

	const scope = require( './plugin-scope' ).manifestScope( results.manifest );
	require( './plugin-scope' ).validateRows( scope, results.summaries );
	const manifest = results.manifest;
	const baselineIds = [ ...new Set( results.summaries.map( row => row.baselineCandidate ).filter( Boolean ) ) ];
	const data = {
		summaries: results.summaries, samples: manifest.config.samples, rounds: manifest.config.rounds,
		groupSummaries: results.groupSummaries || [],
		outputComparison: results.outputComparison || null,
		smoke: !! manifest.smoke, exploratory: !! manifest.exploratory,
		baselineCandidate: manifest.config.baselineCandidate || ( 1 === baselineIds.length ? baselineIds[0] : '' ),
		repeatControls: ( manifest.candidates || [] ).filter( item => item.baseline && item.negativeControl ).map( item => item.id ),
		notes: [
			...( manifest.analysis || [] ),
			...( manifest.exclusions || [] ).map( item => `${item.candidate} ${item.version || ''}: ${item.reason}` ),
		],
	};
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'">
<title>WordPress plugin performance</title>
<style>
#output-panel .table-wrap{max-height:70vh;border:1px solid #dce3eb}#output-comparison{border-collapse:separate;border-spacing:0;min-width:900px}#output-comparison th,#output-comparison td{text-align:left;min-width:120px;max-width:260px;overflow-wrap:anywhere}#output-comparison th:first-child{position:sticky;left:0;background:#f4f7fa;min-width:210px;z-index:1}#output-comparison thead th{position:sticky;top:0;background:#eef2f7;z-index:2}#output-comparison thead th:first-child{z-index:3}#output-comparison .output-group{position:static;background:#e3eaf2}#output-details details{margin-top:12px;border-top:1px solid #dce3eb;padding-top:12px}#output-details summary{cursor:pointer;font-weight:600}#output-details pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f7fa;padding:14px;font-size:12px}#output-details p{overflow-wrap:anywhere}
*{box-sizing:border-box}body{margin:0;background:#f5f7fa;color:#172b40;font:16px/1.5 system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:32px}h1{font-size:30px;font-weight:650;margin:0 0 12px}h2{font-size:21px;margin:0 0 10px}p{max-width:1050px}a{color:#224e9c}header{border-bottom:1px solid #d5dce5;padding-bottom:20px}.controls{display:flex;flex-wrap:wrap;gap:16px;padding:24px 0}.controls label{display:grid;gap:5px;font-size:14px;font-weight:600}select{max-width:430px;padding:9px;border:1px solid #aebcca;border-radius:5px;background:white;color:inherit;font:inherit}.charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}section{background:white;border:1px solid #dce3eb;border-radius:8px;padding:22px;margin-bottom:20px}.chart svg{width:100%;min-width:420px;height:auto}.chart{overflow-x:auto}.muted{color:#52657a;font-size:14px}.table-wrap{overflow:auto}table{border-collapse:collapse;font-size:14px;width:100%;font-variant-numeric:tabular-nums}th,td{border-bottom:1px solid #e2e8f0;padding:12px;text-align:right;vertical-align:top}th:first-child,td:first-child{text-align:left}th:last-child,td:last-child{text-align:left}thead{background:#eef2f7}#comparison td:last-child{min-width:300px;font-size:12px}#heatmap th:last-child,#heatmap td:last-child{text-align:right}button{color:#224e9c;border:0;background:none;text-align:left;font:inherit;cursor:pointer;text-decoration:underline;text-underline-offset:3px}li{margin:8px 0}a:focus-visible,button:focus-visible,select:focus-visible{outline:3px solid #3b82f6;outline-offset:3px}@media(max-width:900px){.charts{grid-template-columns:1fr}main{padding:16px}}@media print{body{background:white}main{padding:0}.controls{display:none}section{break-inside:avoid}.charts{display:block}}
</style></head><body><main><header><h1>WordPress plugin timing diagnostics</h1><aside>${disclaimer}</aside><p id="scope"></p><nav><a href="summary.csv">Summary CSV</a> · <a href="group-summary.csv">Group averages CSV</a> · <a href="samples.csv">Raw samples CSV</a> · <a href="performance.xlsx">Excel workbook, when exported</a> · <a href="report.md">Method and findings</a></nav></header>
<div class="controls"><label>Runtime<select id="runtime"></select></label></div>
<section class="baseline-note"><h2>WordPress comparison baseline</h2><p id="baseline-policy"></p><details id="diagnostic-controls"><summary>Measurement diagnostics</summary><p id="repeat-policy" class="muted"></p></details></section>
<section><h2>Average times by request type</h2><p>Front end covers ordinary HTML pages and archives. Back end covers admin GET pages. Save operations are authenticated editor-save requests and are excluded from back end. RSS, robots.txt, sitemap and redirect endpoints remain separate.</p><div class="controls"><label>Request type<select id="request-group"><option value="front-end">Front end</option><option value="back-end">Back end</option><option value="saving">Save operations</option></select></label><label>Average metric<select id="average-metric"><option value="leadingMs">Mean of scenario minima</option><option value="medianMs">Mean of scenario medians</option><option value="meanMs">Mean request time</option></select></label></div><p class="muted">Each included scenario has equal weight. All candidates use the same matching scenarios in this runtime. Mean of minima and mean of medians are averages of page statistics, not a pooled minimum or median. Raw mean request time includes high outliers. These are descriptive fixture averages, not traffic-weighted estimates or a global plugin ranking.</p><p id="group-scope" class="muted"></p><p id="group-baseline"></p><div class="charts"><div><h2 id="group-impact-title">Average added time vs WordPress (ms)</h2><div id="group-impact" class="chart"></div></div><div><h2>Average full response (ms)</h2><div id="group-total" class="chart"></div></div></div><div class="table-wrap"><table id="group-comparison"></table></div></section>
<div class="controls"><label>Page / workload<select id="scenario"></select></label><label>Page metric<select id="metric"><option value="leadingMs">Fastest validated response</option><option value="medianMs">Raw median</option></select></label><label>Ratio reference (table only)<select id="reference"></select></label></div>
<p id="workload" class="muted"></p><p id="page-baseline"></p><div class="charts"><section><h2 id="impact-title">Added time vs WordPress (ms)</h2><p class="muted">Negative = observed savings. Positive = added time. Zero is the matched WordPress control.</p><div id="impact" class="chart"></div></section><section><h2>Full response (ms)</h2><p class="muted">Includes the WordPress baseline. Lower is faster. Invalid and unsupported observations are omitted.</p><div id="total" class="chart"></div></section></div>
<section><h2 id="reference-title">Version ratios</h2><p id="ratio-scope"></p><p class="muted">Factors are reference / row: above 1 means this row is faster or adds less overhead. For example, 200 ms / 1 ms = 200× less added overhead; total response speed is (core + 200) / (core + 1). Zero, savings and round envelopes crossing zero have no overhead factor. Repeat-control comparisons with incomplete evidence or pairwise ranges reaching zero show neither factor. Self-reference is 1× by definition. Single-round factors are exploratory.</p><div class="table-wrap"><table id="comparison"></table></div></section>
<section><h2>Added time by page (ms)</h2><p class="muted">Click a workload to inspect it. Each row uses its own matched baseline and the selected metric. Colors share a linear scale within this runtime; exact values retain small differences. N/A is unavailable, never zero. Pages are not averaged into a global score.</p><div class="table-wrap"><table id="heatmap"></table></div></section>
<section id="output-panel"><h2>Output on the selected front-end page</h2><p id="output-scope"></p><p><a href="output-comparison.md">All page matrices and exact markup</a> · <a href="output-comparison.csv">Output CSV</a> · <a href="output-comparison.json">Output evidence JSON</a></p><div class="table-wrap" tabindex="0" role="region" aria-label="Observed page metadata"><table id="output-comparison"></table></div><div id="output-details"></div><details><summary>How to interpret output differences</summary><ul id="output-notes"></ul></details></section>
<section><h2>Interpretation</h2><p>These are differences between independent warmed responses, not isolated plugin CPU costs. Negative results can reflect efficient replacement of core work, scheduling variation or both. Repeated rounds and matching clock/load context help interpretation. Cross-round envelopes describe observed round summaries and are not confidence intervals. Sitemaps and configured redirects require equivalent-workload experiments before subtracting core timings.</p><p>Probe queries run only at block boundaries. Clock estimates, requested frequencies and effective clocks are different measurements. Optional temperature readings provide context only. Inspect the workbook and raw evidence for source/scope details.</p><ul id="notes"></ul></section>
<noscript>This report needs JavaScript for interactive graphs. The CSV, workbook and Markdown links above contain the recorded data.</noscript>
<script id="benchmark-data" type="application/json">${scriptJSON( data )}</script>
<script>const METRICS = ${scriptJSON( METRICS )}; const GROUP_METRICS = ${scriptJSON( GROUP_METRICS )}; const compare = ${compare.toString()}; (${dashboard.toString()})();</script>
</main></body></html>\n`;
	fs.writeFileSync( path.join( output, 'report.html' ), html );
}

module.exports = { scriptJSON, writeDashboard };
