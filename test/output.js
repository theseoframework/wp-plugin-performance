/** Behavioral checks for saved-output provenance, parsing and generated-page filters. */

const assert = require( 'assert/strict' );
const crypto = require( 'crypto' );
const fs = require( 'fs' );
const path = require( 'path' );
const vm = require( 'vm' );
const { parseOutput, outputCells } = require( '../lib/output' );
const { saveBlock, report } = require( '../lib/report' );
const { writeDashboard } = require( '../lib/dashboard' );

/** Exercises quoted HTML, inert markup, footer JSON-LD and local entity roles. */
function checkParser() {

	const graph = { '@context': 'https://schema.org', '@graph': [
		{ '@type': 'WebPage', author: { '@id': '#person' }, primaryImageOfPage: { '@id': '#photo' } },
		{ '@type': [ 'Person', 'Organization' ], '@id': '#person', name: 'Example', logo: { '@id': '#photo' } },
		{ '@type': 'ImageObject', '@id': '#photo', url: '/photo.png' },
	] };
	const body = `<html><head><!-- <meta name="description" content="fake"> --><title>A &amp; B &#x1f600;</title><meta content="real > value &amp; more" name='description'><meta name=keywords content=''><meta property='og:title' content='Alternative'><script>var fake='<meta name="description" content="script">';</script><style>.x{content:'<meta name="description" content="style">'}</style><template><meta name=description content=template></template></head><body><script type='APPLICATION/LD+JSON'>${JSON.stringify( graph )}</script></body></html>`;
	const parsed = parseOutput( body );
	assert.equal( parsed.tags.filter( tag => 'description' === tag.key ).length, 1 );
	assert.equal( parsed.tags.find( tag => 'description' === tag.key ).value, 'real > value & more' );
	assert.equal( parsed.tags.find( tag => 'title' === tag.key ).value, 'A & B \u{1f600}' );
	assert.equal( parsed.schemas[0].location, 'body/footer' );
	assert( parsed.entities.find( entity => entity.types.includes( 'Person' ) ).roles.includes( 'author' ) );
	assert.deepEqual( parsed.entities.find( entity => entity.types.includes( 'ImageObject' ) ).roles.sort(), [ 'graph', 'logo', 'primaryImageOfPage' ].sort() );
	const cells = outputCells( parsed ).cells;
	assert.equal( cells.keywords, 'Empty' );
	assert.equal( cells['twitter.title.source'], 'Open Graph available' );
	assert.equal( cells['schema.Person'], 'Yes' );
	assert.equal( cells['schema.Article'], 'No' );
	assert.equal( cells['schema.ImageObject'], 'URL only' );
	assert.equal( parseOutput( '<script type="application/ld+json">{bad}</script>' ).errors.length, 1 );
	assert.equal( outputCells( parseOutput( '<script type="application/ld+json">{bad}</script>' ) ).cells['schema.Person'], 'Unparsed JSON-LD' );
	assert.equal( outputCells( parseOutput( '<head><meta name=description content="&unknownentity;"></head>' ) ).cells['description.characters'], 'Unresolved HTML entities' );
	assert.equal( outputCells( parseOutput( '<head><meta name=description content="&constructor;"></head>' ) ).cells['description.characters'], 'Unresolved HTML entities' );
	assert.equal( outputCells( parseOutput( '<head><meta name=description content="&#x1f600;"></head>' ) ).cells['description.characters'], '1' );
}

/** Implements only the DOM operations used by the renderer; markup remains text. */
function documentFor( html ) {

	const all = [];
	class Node {
		constructor( tag ) { this.tag = tag; this.children = []; this.style = {}; this._text = ''; all.push( this ); }
		appendChild( child ) { this.children.push( child ); return child; }
		replaceChildren() { this.children = []; this._text = ''; this._value = undefined; }
		setAttribute( key, value ) { this[key] = value; }
		set textContent( value ) { this._text = String( value ); this.children = []; }
		get textContent() { return this._text + this.children.map( child => child.textContent ).join( '' ); }
		get options() { return this.children; }
		set value( value ) { this._value = value; }
		get value() { return this._value ?? ( 'select' === this.tag ? this.children[0]?.value || '' : '' ); }
	}
	const nodes = new Map( [ ...html.matchAll( /<([a-z]+)[^>]*\bid="([^"]+)"/g ) ].map( match => [ match[2], new Node( match[1] ) ] ) );
	for ( const select of html.matchAll( /<select id="([^"]+)">([\s\S]*?)<\/select>/g ) ) {
		for ( const match of select[2].matchAll( /<option value="([^"]*)">([^<]*)<\/option>/g ) ) {
			const option = new Node( 'option' );
			option.value = match[1];
			option.textContent = match[2];
			nodes.get( select[1] ).appendChild( option );
		}
	}
	nodes.get( 'benchmark-data' ).textContent = html.match( /<script id="benchmark-data" type="application\/json">([\s\S]*?)<\/script>/ )[1];

	return { nodes, all, getElementById: id => nodes.get( id ), createElement: tag => new Node( tag ), createElementNS: ( namespace, tag ) => new Node( tag ) };
}

/** Checks runtime/page changes, endpoint exclusion and literal hostile output. */
function checkClient( output, result ) {

	const ui = structuredClone( result );
	const plugin = ui.summaries.find( row => 'plugin' === row.candidate );
	const original = ui.outputComparison.records.find( row => 'plugin' === row.candidate );
	for ( const scenario of [ 'post', 'rss' ] ) {
		const cohort = `${plugin.cohort}-${scenario}`;
		ui.summaries.push( { ...plugin, scenario, cohort } );
		if ( 'post' === scenario ) ui.outputComparison.records.push( { ...original, cohort, scenario, context: 'WordPress post', cells: { ...original.cells, 'schema.Article': 'Yes' } } );
	}
	const runtime = JSON.stringify( [ '7.0', '8.4', 'other fixture' ] );
	ui.summaries.push( { ...plugin, wp: '7.0', php: '8.4', runtimeGroup: runtime, cohort: 'other-runtime-page' } );
	writeDashboard( output, ui );
	const html = fs.readFileSync( path.join( output, 'report.html' ), 'utf8' );
	const document = documentFor( html );
	const script = [ ...html.matchAll( /<script>([\s\S]*?)<\/script>/g ) ].map( match => match[1] ).join( '\n' );
	vm.runInNewContext( script, { document } );
	assert.match( document.nodes.get( 'output-scope' ).textContent, /2\/3 verified/ );
	assert( document.nodes.get( 'output-comparison' ).textContent.includes( 'Unavailable' ) );
	const before = document.nodes.get( 'output-details' ).textContent;
	assert( before.includes( '&lt;img src=x onerror=alert(1)&gt;' ) );
	assert( document.nodes.get( 'output-comparison' ).textContent.includes( '<img src=x onerror=alert(1)>' ) );
	assert.equal( document.all.some( node => 'img' === node.tag ), false );
	document.nodes.get( 'metric' ).value = 'medianMs';
	document.nodes.get( 'metric' ).onchange();
	assert.equal( document.nodes.get( 'output-details' ).textContent, before );
	const page = document.nodes.get( 'scenario' );
	page.value = ui.summaries.find( row => 'post' === row.scenario ).cohort;
	page.onchange();
	assert.match( document.nodes.get( 'output-scope' ).textContent, /WordPress post/ );
	page.value = ui.summaries.find( row => 'rss' === row.scenario ).cohort;
	page.onchange();
	assert.match( document.nodes.get( 'output-scope' ).textContent, /not a public HTML page/ );
	assert.equal( document.nodes.get( 'output-comparison' ).children.length, 0 );
	document.nodes.get( 'runtime' ).value = runtime;
	document.nodes.get( 'runtime' ).onchange();
	assert.match( document.nodes.get( 'output-scope' ).textContent, /0\/1 verified/ );
	assert( ! document.nodes.get( 'output-details' ).textContent.includes( '<img src=x' ) );
}

/** Reconciles real report plumbing using explicitly synthetic recorded samples. */
async function checkOutput( parent ) {

	checkParser();
	const output = path.join( parent, 'output-comparison' );
	fs.mkdirSync( output );
	const runtime = { theme: 'fixture', themeVersion: '1', locale: 'en_US', permalink: '/%postname%/', fixture: {}, opcache: {} };
	for ( const candidate of [ 'control', 'plugin', 'broken-evidence' ] ) {
		for ( const round of [ 1, 2 ] ) {
			const body = `<html><head><title>Fixture</title>${'plugin' === candidate ? '<meta name=description content="&lt;img src=x onerror=alert(1)&gt;"><meta property=og:type content="&lt;img src=x onerror=alert(1)&gt;">' : ''}</head><body><script type="application/ld+json">{"@type":"WebPage","name":"Example"}</script></body></html>`;
			const sha256 = crypto.createHash( 'sha256' ).update( body ).digest( 'hex' );
			const blockId = `${candidate}-r${round}`, token = crypto.randomUUID();
			const elapsedMs = 1 === round ? 12 : 10;
			const sample = { blockId, candidate, pluginVersion: '1', wp: '7.0', php: '8.5', round, scenario: 'page', phase: 'measure', sequence: 1, valid: true, elapsedMs, sha256,
				executionToken: token, responseToken: token, userId: '0', route: 'page:5', status: 200, contentType: 'text/html; charset=UTF-8' };
			const block = { blockId, candidate, pluginVersion: '1', baseline: 'control' === candidate, wp: '7.0', php: '8.5', round, scenario: 'page', frame: 'static', runtime };
			saveBlock( output, block, [ sample ] );
			fs.writeFileSync( path.join( output, `${blockId}.fastest.json` ), JSON.stringify( { elapsedMs, sha256, status: 200, contentType: sample.contentType, executionToken: token, userId: '0', route: sample.route, body: 'broken-evidence' === candidate ? body + 'changed' : body } ) );
		}
	}
	const before = fs.readFileSync( path.join( output, 'samples.ndjson' ), 'utf8' );
	const candidates = [ 'control', 'plugin', 'broken-evidence' ].map( id => ( { id, slug: 'fixture', mainFile: 'fixture.php', baseline: 'control' === id } ) );
	const result = await report( output, { config: { candidates, samples: 2, rounds: 2, warmups: 0, outlierFraction: 0.8, outlierReference: 'median', fastestCount: 100, baselineCandidate: 'control' }, failures: [] } );
	const records = result.outputComparison.records;
	assert.equal( records.length, 3 );
	assert.equal( records.find( row => 'plugin' === row.candidate ).round, 2 );
	assert.equal( records.find( row => 'control' === row.candidate ).cells.description, 'No' );
	assert.equal( records.find( row => 'broken-evidence' === row.candidate ).status, 'unavailable' );
	assert.deepEqual( records.find( row => 'broken-evidence' === row.candidate ).cells, {} );
	assert.equal( fs.readFileSync( path.join( output, 'samples.ndjson' ), 'utf8' ), before );
	assert.deepEqual( JSON.parse( fs.readFileSync( path.join( output, 'output-comparison.json' ) ) ), result.outputComparison );
	assert( fs.readFileSync( path.join( output, 'output-comparison.csv' ), 'utf8' ).includes( 'Unavailable' ) );
	const markdown = fs.readFileSync( path.join( output, 'output-comparison.md' ), 'utf8' );
	assert( markdown.includes( '&lt;img src=x onerror=alert(1)&gt;' ) );
	assert( ! markdown.includes( '| <img src=x' ) );
	checkClient( output, result );
}

module.exports = { checkOutput };
