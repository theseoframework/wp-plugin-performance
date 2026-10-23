/**
 * Deterministic behavioral checks for false positives, statistics and exports.
 * This uses synthetic fixtures. It is separate from live Playground smoke tests.
 */

const assert = require( 'assert/strict' );
const crypto = require( 'crypto' );
const fs     = require( 'fs' );
const http   = require( 'http' );
const os     = require( 'os' );
const path   = require( 'path' );
const { once } = require( 'events' );
const { request, validate, statistics } = require( '../lib/measure' );
const { allowedPath, prepareCandidate, readPermission, assertPerformanceEngine, phpFingerprint } = require( '../lib/engine' );
const { scenarios, configuration, setup } = require( '../lib/benchmark' );
const { csvField, saveBlock, report } = require( '../lib/report' );
const { readTemperature } = require( '../lib/temperature' );

/**
 * Checks error rejection and real HTTP behavior without a WordPress dependency.
 *
 * @return {Promise<void>}
 */
async function checkHTTP() {

	const server = http.createServer( ( req, res ) => {
		res.setHeader( 'Content-Type', 'text/html' );
		res.setHeader( 'X-WPR-Perf-Token', req.headers['x-wpr-perf-token'] || '' );
		res.setHeader( 'X-WPR-Perf-User', '0' );
		res.setHeader( 'X-WPR-Perf-Route', 'home-blog' );
		if ( '/redirect' === req.url ) {
			res.writeHead( 301, { Location: '/destination' } );
			res.end();
		} else if ( '/slow' === req.url ) {
			setTimeout( () => res.end( 'late' ), 60 );
		} else {
			res.end( '<html><title>Fixture</title>WPRPERFBODY The SEO Framework</html>' );
		}
	} );
	server.listen( 0, '127.0.0.1' );
	await once( server, 'listening' );
	const origin = `http://127.0.0.1:${server.address().port}`;
	try {
		const response = await request( origin, { headers: { 'X-WPR-Perf-Token': 'abcd' } } );
		const expect = { status: 200, type: 'text/html', minBytes: 20, contains: [ 'WPRPERFBODY' ], route: 'home-blog' };
		assert.deepEqual( validate( response, { expect }, 'abcd', 0, origin ), [] );
		assert( response.elapsedMs >= response.ttfbMs && response.sha256.length === 64 );
		assert( validate( response, { expect }, 'stale', 0, origin ).length );
		assert( validate( response, { expect }, 'abcd', 1, origin ).length );
		assert( validate( { ...response, body: '<b>Warning</b>' }, { expect }, 'abcd', 0, origin ).length );
		const fixture = { pageId: 5, postId: 6, frontId: 7, blogId: 8, target: `${origin}/target` };
		const catalog = scenarios( { fixture }, { slug: 'autodescription' } );
		for ( const id of [ 'category', 'tag', 'search', 'blog-page' ] ) {
			const scenario = catalog.find( item => item.id === id );
			assert( validate( response, scenario, 'abcd', 0, origin ).some( item => item.includes( 'route' ) ) );
		}
		const redirect = await request( `${origin}/redirect`, { headers: { 'X-WPR-Perf-Token': 'abcd' } } );
		assert.equal( redirect.status, 301 );
		assert.deepEqual( validate( redirect, { expect: { status: 301, minBytes: 0, location: '/destination' } }, 'abcd', 0, origin ), [] );
		assert( validate( redirect, { expect: { status: 301, minBytes: 0, location: '/other' } }, 'abcd', 0, origin ).length );
		const timeout = await request( `${origin}/slow`, { timeoutMs: 10 } );
		assert.equal( timeout.status, 0 );
		assert.match( timeout.error, /deadline/ );
		const saved = {
			...response, headers: { ...response.headers, 'content-type': 'application/json' },
			body: JSON.stringify( { id: 5, title: { raw: 'changed' } } ),
		};
		const save = { expect: { status: 200, type: 'json', minBytes: 0 }, postId: 5, saveTitle: 'changed' };
		assert.deepEqual( validate( saved, save, 'abcd', 0, origin ), [] );
		assert( validate( saved, { ...save, saveTitle: 'not changed' }, 'abcd', 0, origin ).length );
	} finally {
		server.closeAllConnections();
		server.close();
		await once( server, 'close' );
	}
}

/**
 * Checks distribution math and separation of invalid/high-tail/low observations.
 */
function checkStatistics() {

	const rows = [ 10, 11, 12, 13, 10000 ].map( elapsedMs => ( { valid: true, elapsedMs } ) );
	rows.push( { valid: false, elapsedMs: 0.01 } );
	const result = statistics( rows, { fastestCount: 3, outlierFraction: 0.8 } );
	assert.equal( result.minimumMs, 10 );
	assert.equal( result.leadingMs, 10 );
	assert.equal( result.medianMs, 12 );
	assert.equal( result.highOutliers, 1 );
	assert.equal( result.trimmedMeanMs, 11.5 );
	assert.equal( result.fastestMeanMs, 11 );
	assert.equal( result.invalid, 1 );
	assert.equal( result.attempted, 6 );
	assert.equal( rows.length, 6 );
	const suspect = statistics( [ 1, 10, 11 ].map( elapsedMs => ( { valid: true, elapsedMs } ) ) );
	assert.equal( suspect.minimumMs, 1 );
	assert.equal( suspect.leadingMs, null );
	assert.equal( suspect.minimumSuspect, true );
	assert.equal( statistics( [] ).medianMs, null );
	assert.equal( statistics( [ { elapsedMs: 10, valid: true }, { elapsedMs: 20, valid: true } ] ).medianMs, 15 );
	assert.equal( csvField( '=1+1' ), '"\'=1+1"' );
	assert.equal( csvField( -12.5 ), '"-12.5"' );
	assert.equal( csvField( 'a,"b"' ), '"a,""b"""' );
}

/**
 * Checks cohort isolation, invalid/unavailable reports, and lossless raw exports.
 *
 * @param {string} output
 * @return {Promise<void>}
 */
async function checkReports( output ) {

	const runtime = {
		theme: 'same-theme', themeVersion: '1.0', locale: 'en_US', permalink: '/%postname%/',
		fixture: { version: 1, posts: 100, pages: 20, contentHash: 'same' },
		opcache: { enabled: '1', enableCli: '1', maxFiles: '7963', memoryMb: '256', jit: '0', full: false },
	};
	const config = { samples: 2, rounds: 1, outlierFraction: 0.8, outlierReference: 'median', fastestCount: 1000, warmups: 1 };
	config.candidates = [ 'a', 'b', 'invalid', 'unavailable', 'failed-package' ].map( id => ( { id, slug: 'fixture', mainFile: 'fixture.php' } ) );
	for ( const candidate of [ 'a', 'b', 'invalid', 'unavailable' ] ) {
		const block = {
			blockId: candidate, candidate, pluginVersion: '1.0', wp: '7.1', php: '8.5.8',
			round: 1, scenario: 'page', frame: 'static', runtime: structuredClone( runtime ),
			before: { celsius: null, reason: 'Synthetic missing sensor' },
			after: { celsius: null, reason: 'Synthetic missing sensor' },
		};
		if ( 'b' === candidate ) {
			block.runtime.fixture.version = 2;
			block.runtime.opcache.enabled = '0';
		}
		if ( 'a' === candidate ) {
			const before = {
				at: '2026-01-01T00:00:00.000Z', monotonicMs: 0, platform: 'win32', scope: 'operating-system',
				cpus: [ { model: 'synthetic', times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } } ],
			};
			const after = structuredClone( before );
			after.at = '2026-01-01T00:00:01.000Z';
			after.monotonicMs = 1000;
			after.cpus[0].times = { user: 10, nice: 0, sys: 10, idle: 80, irq: 5 };
			block.cpu = { before, after, load: { percent: 99 } };
		}
		if ( 'unavailable' === candidate ) block.unavailable = 'Feature absent in this edition';

		const rows = 'unavailable' === candidate ? [] : [ 10, 11 ].map( ( elapsedMs, sequence ) => ( {
			blockId: candidate, candidate, phase: 'measure', elapsedMs, sequence,
			valid: 'invalid' !== candidate, reasons: 'invalid' === candidate ? 'Rejected' : '',
		} ) );
		saveBlock( output, block, rows );
	}
	const rawBefore = fs.readFileSync( path.join( output, 'samples.ndjson' ), 'utf8' );
	const savedCheckpoint = JSON.parse( fs.readFileSync( path.join( output, 'a.checkpoint.json' ), 'utf8' ) );
	assert.equal( savedCheckpoint.kind, 'wp-performance-block-v1' );
	assert.deepEqual( savedCheckpoint.samples.map( row => row.elapsedMs ), [ 10, 11 ] );
	assert.equal( JSON.parse( fs.readFileSync( path.join( output, 'unavailable.checkpoint.json' ) ) ).samples.length, 0 );
	assert.throws( () => saveBlock( output, savedCheckpoint.block, savedCheckpoint.samples ), { code: 'EEXIST' } );
	assert.equal( fs.readFileSync( path.join( output, 'samples.ndjson' ), 'utf8' ), rawBefore );
	fs.writeFileSync( path.join( output, 'samples.csv' ), 'partial checkpoint\n' );
	const result = await report( output, {
		config, smoke: true,
		failures: [ { candidate: 'failed-package', wp: 'not launched', php: 'not launched', stage: 'package preparation', error: 'Synthetic missing package' } ],
	} );
	const a = result.summaries.find( row => 'a' === row.candidate );
	const b = result.summaries.find( row => 'b' === row.candidate );
	assert.notEqual( a.cohort, b.cohort );
	assert.equal( result.blocks.find( block => 'a' === block.blockId ).cpu.load.percent, 20 );
	assert.equal( a.status, 'provisional' );
	assert( result.summaries.every( row => ! Object.hasOwn( row, 'rank' ) ) );
	assert.equal( result.summaries.find( row => 'unavailable' === row.candidate ).status, 'unavailable' );
	assert.equal( result.summaries.find( row => 'failed-package' === row.candidate ).status, 'failed' );
	assert( fs.readFileSync( path.join( output, 'summary.csv' ), 'utf8' ).includes( 'failed-package' ) );
	assert.equal( fs.readFileSync( path.join( output, 'samples.ndjson' ), 'utf8' ).trim().split( '\n' ).length, 6 );
	assert.equal( fs.readFileSync( path.join( output, 'samples.ndjson' ), 'utf8' ), rawBefore );
	assert.equal( fs.readFileSync( path.join( output, 'samples.csv' ), 'utf8' ).trim().split( '\n' ).filter( line => line.trim() ).length, 7 );
	assert( ! fs.readFileSync( path.join( output, 'samples.csv' ), 'utf8' ).includes( 'partial checkpoint' ) );
	assert( fs.readFileSync( path.join( output, 'temperatures.csv' ), 'utf8' ).includes( 'Synthetic missing sensor' ) );
	assert( fs.readFileSync( path.join( output, 'report.md' ), 'utf8' ).includes( 'Smoke test' ) );
	assert( fs.readFileSync( path.join( output, 'cpu-load.csv' ), 'utf8' ).includes( 'CPU counters were not recorded by this run.' ) );
	assert.equal( result.manifest.exploratory, false );
	const manifest = { config, smoke: false, failures: [] };
	const exploratory = await report( output, manifest );
	assert.equal( exploratory.manifest.exploratory, true );
	assert.equal( manifest.exploratory, undefined );
	const html = fs.readFileSync( path.join( output, 'report.html' ), 'utf8' );
	const embedded = JSON.parse( html.match( /<script id="benchmark-data" type="application\/json">([\s\S]*?)<\/script>/ )[1] );
	assert.equal( embedded.exploratory, true );
	assert( fs.readFileSync( path.join( output, 'report.md' ), 'utf8' ).includes( 'One round does not establish a repeatable speedup' ) );
}

/**
 * Runs the deterministic suite and leaves its explicitly synthetic evidence.
 *
 * @return {Promise<void>}
 */
async function main() {

	const output = fs.mkdtempSync( path.join( os.tmpdir(), 'wp-plugin-performance-self-test-' ) );
	checkStatistics();
	assert.throws( () => readPermission( output ), /Missing/ );
	const permission = path.join( output, '.local/playground/permission.txt' );
	fs.mkdirSync( path.dirname( permission ), { recursive: true } );
	fs.writeFileSync( permission, 'PLAYGROUND=False\n' );
	assert.equal( readPermission( output ), false );
	fs.writeFileSync( permission, 'PLAYGROUND=maybe\n' );
	assert.throws( () => readPermission( output ), /exactly/ );
	fs.writeFileSync( permission, 'PLAYGROUND=True\n' );
	assert.equal( readPermission( output ), true );
	const compatibility = path.join( output, 'regression-compatibility' );
	fs.mkdirSync( compatibility );
	assert.throws( () => assertPerformanceEngine( compatibility ), /wpPluginPerformanceApi: 1/ );
	fs.writeFileSync( path.join( compatibility, 'package.json' ), JSON.stringify( { wpPluginPerformanceApi: 1 } ) );
	assert.equal( assertPerformanceEngine( compatibility ), 1 );
	fs.writeFileSync( path.join( compatibility, 'package.json' ), JSON.stringify( { wpPluginPerformanceApi: 2 } ) );
	assert.throws( () => assertPerformanceEngine( compatibility ), /wpPluginPerformanceApi: 1/ );
	assert.throws( () => allowedPath( path.join( process.cwd(), '.local/.cursor/forbidden' ) ) );
	await assert.rejects( prepareCandidate( { id: 'missing', slug: 'autodescription', path: output, mainFile: 'missing.php' } ) );
	const pinned = path.join( output, 'pinned-source' );
	fs.mkdirSync( pinned );
	fs.writeFileSync( path.join( pinned, 'plugin.php' ), '<?php\n/* Plugin Name: Synthetic fixture\nVersion: 1.0\n*/\n' );
	await assert.rejects( prepareCandidate( { id: 'pinned', slug: 'synthetic', path: pinned, mainFile: 'plugin.php', phpSourceSha256: 'wrong' } ), /pinned phpSourceSha256/ );
	const portable = path.join( output, 'portable-source' );
	fs.mkdirSync( path.join( portable, 'a' ), { recursive: true } );
	const phpFiles = [ [ 'a/nested.php', '<?php // nested\n' ], [ 'a0.php', '<?php // root\n' ] ];
	const expectedSource = crypto.createHash( 'sha256' );
	for ( const [ file, body ] of phpFiles ) {
		fs.writeFileSync( path.join( portable, file ), body );
		expectedSource.update( file + '\0' ).update( body ).update( '\0' );
	}
	assert.equal( phpFingerprint( { directory: portable, mounts: [ 'a0.php', 'a' ] } ), expectedSource.digest( 'hex' ) );
	const plan = path.join( output, 'plan.json' );
	fs.writeFileSync( plan, JSON.stringify( { candidates: [ { id: 'a', slug: 'autodescription', mainFile: 'autodescription.php' } ] } ) );
	assert.equal( configuration( plan, {} ).samples, 100 );
	assert.equal( configuration( plan, {} ).rounds, 1 );
	assert.equal( configuration( plan, {} ).warmups, 12 );
	assert.equal( configuration( plan, {} ).opcacheMode, 'auto' );
	assert.equal( configuration( plan, { 'opcache-mode': 'off' } ).opcacheMode, 'off' );
	assert.throws( () => configuration( plan, { 'opcache-mode': 'jit' } ), /JIT is unavailable/ );
	assert.equal( configuration( plan, { samples: '1000' } ).samples, 1000 );
	assert.equal( configuration( plan, { rounds: '3', warmups: '120' } ).rounds, 3 );
	assert.equal( configuration( plan, { rounds: '3', warmups: '120' } ).warmups, 120 );
	assert.equal( configuration( plan, { smoke: true } ).samples, 3 );
	const thorough = path.join( __dirname, '../examples/plugin-before-after.json' );
	const ordinary = configuration( thorough, {} );
	assert.equal( ordinary.comparisonMode, 'standard' );
	assert.equal( ordinary.candidates.filter( item => item.baseline ).length, 1 );
	assert.equal( ordinary.candidates.some( item => item.negativeControl ), false );
	const diagnostics = path.join( __dirname, '../examples/plugin-repeat-controls.json' );
	assert.equal( configuration( diagnostics, {} ).comparisonMode, 'repeat-controls' );
	assert.equal( configuration( diagnostics, { fairness: 'repeat-controls' } ).comparisonMode, 'repeat-controls' );
	assert.equal( configuration( diagnostics, { 'comparison-mode': 'repeat-controls' } ).comparisonMode, 'repeat-controls' );
	assert.throws( () => configuration( diagnostics, { fairness: 'standard', 'comparison-mode': 'repeat-controls' } ), /Conflicting/ );
	const preparing = configuration( thorough, { prepare: true, candidate: 'after' } );
	assert.equal( preparing.candidates.length, 1 );
	assert.equal( preparing.comparisonMode, 'standard' );
	assert.equal( preparing.baselineCandidate, undefined );
	await assert.rejects( setup( {}, { id: 'plugin', slug: 'my-plugin', version: '2.0', setup: { version: '1.0' } } ) );
	await checkHTTP();
	await checkReports( output );
	await require( './profile' ).checkProfile( output );
	await require( './rework-regressions' ).checkRework( output );
	await require( './output' ).checkOutput( output );
	require( './comparison' ).checkComparisons( output );
	require( './groups' ).checkGroups();
	require( './controls' ).checkControls();
	require( './cache' ).checkCache();
	await require( './cache' ).checkCacheCollection();
	await require( './probes' ).checkProbes( output );
	await require( './clocks' ).checkClocks( output );
	await require( './clocks' ).checkThermalContext( output );
	require( './consumer' ).main();
	const mock = await readTemperature( [ process.execPath, '-e', 'process.stdout.write(JSON.stringify([{sensor:"synthetic CPU",celsius:55.2}]))' ] );
	assert.equal( mock.celsius, 55.2 );
	const absent = await readTemperature( [ process.execPath, '-e', 'process.stdout.write("[]")' ] );
	assert.equal( absent.celsius, null );
	assert( absent.reason );
	console.log( `Deterministic smoke checks passed. Synthetic evidence: ${output}` );
}

if ( require.main === module ) {
	main().catch( error => {
		console.error( error );
		process.exitCode = 1;
	} );
}

module.exports = { main };
