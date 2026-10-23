/**
 * Baseline arithmetic, invalid cohorts, signed savings and safe offline exports.
 */

const assert = require( 'assert/strict' );
const fs = require( 'fs' );
const path = require( 'path' );
const vm = require( 'vm' );
const { attachBaselines, compare } = require( '../lib/comparison' );
const { scriptJSON, writeDashboard } = require( '../lib/dashboard' );

/**
 * @param {string} output
 */
function checkComparisons( output ) {

	const fixture = ( candidate, delta, overrides = {} ) => ( {
		candidate, baseline: 'core' === candidate, eligible: true, status: 'valid',
		cohort: 'matched', runtimeGroup: 'runtime', scenario: 'page', frame: 'static',
		leadingMs: 100 + delta, medianMs: 150 + delta, roundCount: 1,
		roundLeadingLowMs: 100 + delta, roundLeadingHighMs: 100 + delta,
		roundMedianLowMs: 150 + delta, roundMedianHighMs: 150 + delta,
		...overrides,
	} );
	const rows = [ fixture( 'core', 0 ), fixture( 'small', 1 ), fixture( 'large', 200 ), fixture( 'savings', -20 ), fixture( 'zero', 0 ), fixture( 'missing-core', 10, { cohort: 'other-theme' } ), fixture( 'invalid', 2, { eligible: false } ), fixture( 'sitemap', 1, { scenario: 'sitemap' } ) ];
	attachBaselines( rows );
	const get = name => rows.find( row => row.candidate === name );
	assert.equal( get( 'small' ).baselineDeltaMs, 1 );
	assert.equal( get( 'large' ).baselineMedianDeltaMs, 200 );
	assert.equal( compare( get( 'small' ), get( 'large' ) ).overheadRatio, 200 );
	assert.equal( compare( get( 'small' ), get( 'large' ) ).responseRatio, 300 / 101 );
	assert.equal( get( 'savings' ).baselineDeltaMs, -20 );
	assert.equal( get( 'savings' ).baselineMedianDeltaMs, -20 );
	assert.equal( get( 'zero' ).baselineDeltaMs, 0 );
	for ( const name of [ 'savings', 'zero', 'missing-core', 'invalid', 'sitemap' ] )
		assert.equal( compare( get( name ), get( 'large' ) ).overheadRatio, null );

	assert.equal( get( 'missing-core' ).baselineDeltaMs, null );
	assert.equal( get( 'sitemap' ).baselineDeltaMs, null );
	assert.equal( compare( get( 'missing-core' ), get( 'small' ) ).responseRatio, null );
	const repeated = [ fixture( 'core', 0, { roundCount: 3, roundLeadingLowMs: 98, roundLeadingHighMs: 102 } ), fixture( 'near-zero', 1, { roundCount: 3, roundLeadingLowMs: 99, roundLeadingHighMs: 103 } ), fixture( 'positive', 30, { roundCount: 3, roundLeadingLowMs: 128, roundLeadingHighMs: 132 } ) ];
	attachBaselines( repeated );
	assert.equal( repeated[1].baselineDeltaLowMs, -3 );
	assert.equal( repeated[1].baselineDeltaHighMs, 5 );
	assert.equal( compare( repeated[1], repeated[2] ).overheadRatio, null );
	assert.match( compare( repeated[1], repeated[2] ).reason, /crosses zero/ );
	const ambiguous = [ fixture( 'core', 0 ), fixture( 'second-core', 0, { baseline: true } ), fixture( 'plugin', 1 ) ];
	attachBaselines( ambiguous );
	assert.equal( ambiguous[2].baselineDeltaMs, null );
	assert.match( ambiguous[2].baselineReason, /Ambiguous/ );
	get( 'small' ).candidate = '</script><script>globalThis.injected=true</script>';
	const candidates = [ ...new Map( rows.map( row => [ row.candidate, { id: row.candidate, slug: 'fixture', mainFile: 'fixture.php', baseline: row.baseline } ] ) ).values() ];
	const results = { summaries: rows, manifest: { config: { candidates, samples: 100, rounds: 1 }, exploratory: true } };
	writeDashboard( output, results );
	const html = fs.readFileSync( path.join( output, 'report.html' ), 'utf8' );
	const data = html.match( /<script id="benchmark-data" type="application\/json">([\s\S]*?)<\/script>/ )[1];
	assert.deepEqual( JSON.parse( data ).summaries, rows );
	assert( ! data.includes( '<' ) );
	assert( ! /<script[^>]+src=/i.test( html ) );
	assert.equal( JSON.parse( scriptJSON( '\u2028\u2029<&>' ) ), '\u2028\u2029<&>' );
	new vm.Script( html.match( /<script>([\s\S]*?)<\/script>/ )[1] );
	checkDashboardBaseline( path.join( output, 'baseline-ui' ) );
}

/**
 * Exercises actual page rendering and selectors with a faster repeat control.
 * The WordPress subtraction must stay fixed when the ratio reference changes.
 *
 * @param {string} output
 */
function checkDashboardBaseline( output ) {

	fs.mkdirSync( output );
	const runtime = JSON.stringify( [ '7.1', '8.5', 'theme' ] );
	const rows = [ [ 'core', 100, true ], [ 'core-repeat', 80, true ], [ 'small', 101, false ], [ 'large', 300, false ] ].map( ( [ candidate, leadingMs, baseline ] ) => ( {
		candidate, leadingMs, medianMs: leadingMs + 50, baseline,
		pluginVersion: '1', eligible: true, status: 'valid', roundCount: 1,
		cohort: 'page', runtimeGroup: runtime, scenario: 'page', frame: 'static', wp: '7.1', php: '8.5',
	} ) );
	attachBaselines( rows, 'core' );
	const groups = rows.map( row => ( {
		...row, group: 'front-end', groupLabel: 'Front end',
		averageLeadingMs: row.leadingMs, averageMedianMs: row.medianMs, averageRequestMs: row.leadingMs + 5,
		baselineRequestDeltaMs: row.baselineDeltaMs, scenarioCount: 1, requestedScenarioCount: 1,
		scenarios: 'page', measuredCalls: 100, warmupCalls: 12, saveCalls: 0, note: '',
	} ) );
	const feature = { ...rows[2], cohort: 'sitemap', scenario: 'sitemap', featureDocument: 'urlset' };
	attachBaselines( [ feature ], 'core' );
	writeDashboard( output, {
		summaries: [ ...rows, feature ], groupSummaries: groups,
		manifest: { config: { samples: 100, rounds: 1, baselineCandidate: 'core' }, candidates: [ { id: 'core', baseline: true }, { id: 'core-repeat', baseline: true, negativeControl: true }, { id: 'small' }, { id: 'large' } ].map( item => ( { ...item, slug: 'fixture', mainFile: 'fixture.php' } ) ) },
	} );
	const html = fs.readFileSync( path.join( output, 'report.html' ), 'utf8' );
	const createNode = tag => {
		const node = { tag, children: [], style: {}, attributes: {}, content: '', selected: undefined };
		node.appendChild = child => { node.children.push( child ); return child; };
		node.replaceChildren = () => { node.children = []; node.content = ''; node.selected = undefined; };
		node.setAttribute = ( key, value ) => { node.attributes[key] = value; };
		Object.defineProperties( node, {
			textContent: { get: () => node.content + node.children.map( child => child.textContent ).join( '' ), set: value => { node.content = String( value ); node.children = []; } },
			value: { get: () => node.selected ?? node.children[0]?.value ?? '', set: value => { node.selected = value; } },
			options: { get: () => node.children },
		} );

		return node;
	};
	const nodes = new Map( [ ...html.matchAll( /\bid="([^"]+)"/g ) ].map( match => [ match[1], createNode( 'div' ) ] ) );
	const get = id => {
		assert( nodes.has( id ), `Dashboard element is missing: ${id}` );

		return nodes.get( id );
	};
	for ( const select of html.matchAll( /<select id="([^"]+)">([\s\S]*?)<\/select>/g ) ) {
		for ( const item of select[2].matchAll( /<option value="([^"]+)">([^<]*)<\/option>/g ) ) {
			const option = createNode( 'option' );
			option.value = item[1];
			option.textContent = item[2];
			get( select[1] ).appendChild( option );
		}
	}
	get( 'benchmark-data' ).textContent = html.match( /<script id="benchmark-data" type="application\/json">([\s\S]*?)<\/script>/ )[1];
	vm.runInNewContext( html.match( /<script>([\s\S]*?)<\/script>/ )[1], {
		document: { getElementById: get, createElement: createNode, createElementNS: ( namespace, tag ) => createNode( tag ) },
	} );
	assert.match( get( 'baseline-policy' ).textContent, /Baseline: core / );
	assert.match( get( 'repeat-policy' ).textContent, /core-repeat/ );
	assert.equal( get( 'diagnostic-controls' ).hidden, false );
	assert.match( get( 'page-baseline' ).textContent, /core, 100\.000 ms/ );
	assert.match( get( 'group-baseline' ).textContent, /core, 100\.000 ms/ );
	assert.match( get( 'total' ).textContent, /core \(baseline\)/ );
	assert( ! get( 'total' ).textContent.includes( 'core-repeat' ) );
	assert( ! get( 'impact' ).textContent.includes( 'core-repeat' ) );
	assert( ! get( 'group-comparison' ).textContent.includes( 'core-repeat' ) );
	assert( ! get( 'comparison' ).textContent.includes( 'core-repeat' ) );
	const retained = JSON.parse( get( 'benchmark-data' ).textContent );
	assert( retained.summaries.some( row => row.candidate === 'core-repeat' ) );
	assert.deepEqual( get( 'reference' ).options.map( item => item.value ), [ 'small', 'large' ] );
	const originalImpact = get( 'impact' ).textContent;
	const originalGroups = get( 'group-impact' ).textContent;
	get( 'reference' ).value = 'large';
	get( 'reference' ).onchange();
	assert.equal( get( 'impact' ).textContent, originalImpact );
	assert.equal( get( 'group-impact' ).textContent, originalGroups );
	assert.match( get( 'reference-title' ).textContent, /large/ );
	const tableRows = get( 'comparison' ).children[1].children;
	const small = tableRows.find( row => row.children[0].textContent === 'small 1' );
	assert.equal( small.children[2].textContent, 'core' );
	assert.equal( small.children[3].textContent, '100.000' );
	assert.equal( small.children[4].textContent, '+1.000' );
	assert.equal( small.children[5].textContent, '200.00×' );
	get( 'metric' ).value = 'medianMs';
	get( 'metric' ).onchange();
	assert.match( get( 'page-baseline' ).textContent, /core, 150\.000 ms/ );
	get( 'average-metric' ).value = 'medianMs';
	get( 'average-metric' ).onchange();
	assert.match( get( 'group-baseline' ).textContent, /core, 150\.000 ms/ );
	get( 'scenario' ).value = 'sitemap';
	get( 'scenario' ).onchange();
	assert.match( get( 'page-baseline' ).textContent, /No single matched WordPress baseline/ );
}

module.exports = { checkComparisons };
