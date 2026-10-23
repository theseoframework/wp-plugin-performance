/**
 * Optional installed-runtime smoke: real Xdebug, synthetic PHP, no WordPress,
 * downloads or live benchmark. Invoke with the existing regression engine path.
 */
const assert = require( 'assert/strict' );
const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );
const { createRequire } = require( 'module' );
const { artifact, extensionManifest } = require( '../tools/profile-cli' );
const { parse } = require( '../lib/cachegrind' );

/** Exercises the same extension manifest and validates trigger-only capture. */
async function main( engine, version = '8.3' ) {

	if ( ! engine ) throw new Error( 'Supply the existing regression engine directory.' );

	const fromEngine = createRequire( path.join( path.resolve( engine ), 'package.json' ) );
	const extension = await artifact( path.resolve( engine ), version );
	const temporary = fs.mkdtempSync( path.join( os.tmpdir(), 'wpp-xdebug-runtime-' ) );
	const manifest = path.join( temporary, 'xdebug.json' );
	fs.writeFileSync( manifest, JSON.stringify( extensionManifest( { php: version, trigger: 'runtime-test', id: 'runtime-test' }, extension ) ) );
	// This API loads the same existing extension artifact without a WordPress download.
	const { PHP } = fromEngine( '@php-wasm/universal' );
	const { loadNodeRuntime } = fromEngine( '@php-wasm/node' );
	const php = new PHP( await loadNodeRuntime( version, { emscriptenOptions: { processId: 1 }, extensions: [ { source: { format: 'manifest', manifestUrl: manifest } } ] } ) );
	try {
		php.mkdir( '/profiles' );
		const code = '<?php function hotspot_fixture() { return str_repeat("x", 128); } for ($i=0; $i<8; ++$i) hotspot_fixture(); echo json_encode(["available"=>function_exists("xdebug_get_profiler_filename"),"file"=>xdebug_get_profiler_filename(),"php"=>PHP_VERSION]);';
		const warm = await php.run( { code } );
		const warmResult = JSON.parse( warm.text );
		assert.equal( warmResult.available, true );
		assert.equal( warmResult.file, false );
		const wrong = await php.run( { code, headers: { cookie: 'XDEBUG_TRIGGER=incorrect' } } );
		assert.equal( JSON.parse( wrong.text ).file, false );
		const response = await php.run( { code, headers: { cookie: 'XDEBUG_TRIGGER=runtime-test' } } );
		const captured = JSON.parse( response.text );
		assert( captured.file && captured.file.startsWith( '/profiles/cachegrind.runtime-test.' ) );
		const text = php.readFileAsText( captured.file );
		const profile = parse( text );
		const observed = profile.nodes.find( node => node.function === 'hotspot_fixture' );
		assert( observed );
		assert.equal( observed.calls, 8 );
		fs.writeFileSync( path.join( temporary, 'cachegrind.out' ), text );
		const result = { passed: true, php: captured.php, creator: profile.creator, calls: observed.calls, untriggeredFiles: false, raw: path.join( temporary, 'cachegrind.out' ), scope: 'Synthetic installed-runtime validation; no WordPress or performance conclusion.' };
		fs.writeFileSync( path.join( temporary, 'result.json' ), JSON.stringify( result, null, '\t' ) );
		console.log( JSON.stringify( result ) );
		return result;
	} finally {
		php[Symbol.dispose]();
	}
}

if ( require.main === module ) main( ...process.argv.slice( 2 ) ).catch( error => { console.error( error ); process.exitCode = 1; } );
module.exports = { main };
