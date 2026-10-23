#!/usr/bin/env node
/**
 * Loads an existing bundled Xdebug extension into the installed Playground CLI.
 * Each owned session supplies its own private configuration through the environment.
 */
const fs = require( 'fs' );
const path = require( 'path' );
const { createRequire } = require( 'module' );
const { pathToFileURL } = require( 'url' );
const { allowedPath } = require( '../lib/engine' );

/** Locates only an already installed extension; never installs a package. */
async function artifact( engine, php, explicit ) {

	if ( ! /^\d+\.\d+$/.test( php ) ) throw new Error( 'Profiling requires an explicit PHP branch.' );

	const fromEngine = createRequire( path.join( engine, 'package.json' ) );
	const build = await import( pathToFileURL( fromEngine.resolve( `@php-wasm/node-${php.replace( '.', '-' )}` ) ).href );
	if ( ! build.getXdebugExtensionPath ) throw new Error( `Installed PHP ${php} build does not expose Xdebug. Supply a supported installed build; no download is attempted.` );

	const features = await import( pathToFileURL( fromEngine.resolve( 'wasm-feature-detect' ) ).href );
	const jspi = features.jspi || features.default?.jspi;
	if ( 'function' !== typeof jspi || ! await jspi() ) throw new Error( 'The profiling launcher requires a JSPI-capable Node.js runtime for extension manifests. Offline hotspot inspection remains available.' );

	const file = allowedPath( explicit || await build.getXdebugExtensionPath() );
	if ( ! fs.existsSync( file ) || ! fs.statSync( file ).isFile() ) throw new Error( `Existing Xdebug artifact unavailable for PHP ${php}. Install the matching software manually.` );

	return file;
}

/** Starts the normal Playground CLI with a session-specific extension manifest. */
function extensionManifest( config, extension ) {
	return {
		name: 'wp-plugin-hotspots', loadWithIniDirective: 'zend_extension',
		iniEntries: {
			'xdebug.mode': 'profile', 'xdebug.start_with_request': 'trigger',
			'xdebug.trigger_value': config.trigger, 'xdebug.output_dir': '/profiles',
			'xdebug.profiler_output_name': `cachegrind.${config.id}.%p.%r`, 'xdebug.use_compression': '0',
		},
		artifacts: [ { phpVersion: config.php, sourcePath: pathToFileURL( extension ).href } ],
	};
}

/** Starts the normal Playground CLI with a session-specific extension manifest. */
async function main( argv = process.argv.slice( 2 ) ) {

	if ( ! process.env.WPR_HOTSPOT_CONFIG ) throw new Error( 'This launcher is internal to the profile command.' );

	const configFile = allowedPath( process.env.WPR_HOTSPOT_CONFIG );
	const config = JSON.parse( fs.readFileSync( configFile, 'utf8' ) );
	const fromEngine = createRequire( path.join( allowedPath( config.engine ), 'package.json' ) );
	const extension = await artifact( config.engine, config.php, config.artifact );
	const manifest = path.join( path.dirname( configFile ), 'xdebug-extension.json' );
	fs.writeFileSync( manifest, JSON.stringify( extensionManifest( config, extension ), null, '\t' ), { flag: 'wx' } );
	const { parseOptionsAndRunCLI } = fromEngine( '@wp-playground/cli' );
	const result = await parseOptionsAndRunCLI( [ ...argv, '--php-extension', manifest, '--mount-dir-before-install', allowedPath( config.profiles ), '/profiles' ] );
	if ( 'exitCode' in result ) {
		process.exitCode = result.exitCode;
		return;
	}
	let stopping = false;
	for ( const signal of [ 'SIGINT', 'SIGTERM' ] ) process.on( signal, async () => {
		if ( stopping ) return;

		stopping = true;
		await result[Symbol.asyncDispose]();
		process.exit( 0 );
	} );
}

if ( require.main === module ) main().catch( error => { console.error( error ); process.exitCode = 1; } );
module.exports = { artifact, extensionManifest, main };
