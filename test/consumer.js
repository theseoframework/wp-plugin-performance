/**
 * Exercises the installed dispatcher as a separate consumer process.
 * Synthetic engines prove permission ordering, root isolation and failure propagation.
 */

const assert = require( 'assert/strict' );
const fs     = require( 'fs' );
const os     = require( 'os' );
const path   = require( 'path' );
const { spawnSync } = require( 'child_process' );

/**
 * Checks real CLI boundaries without starting WordPress or downloading packages.
 *
 * @param {string} temporaryRoot Existing temporary directory, possibly symlinked.
 * @return {string}
 */
function main( temporaryRoot = os.tmpdir() ) {

	const engine = path.resolve( __dirname, '..' );
	// Node resolves the script's __dirname through links, including macOS /var.
	const temporary = fs.realpathSync( fs.mkdtempSync( path.join( temporaryRoot, 'wpp-consumer-test-' ) ) );
	const consumer = path.join( temporary, 'consumer' );
	const script = path.join( consumer, '.cursor/skills/playground-performance/scripts/performance.js' );
	const permission = path.join( consumer, '.local/playground/permission.txt' );
	const settings = path.join( consumer, '.local/playground/performance/engine.json' );
	const fake = path.join( temporary, 'fake-engine' );
	const record = path.join( fake, 'called.json' );
	for ( const directory of [ path.dirname( script ), path.dirname( settings ), fake ] )
		fs.mkdirSync( directory, { recursive: true } );

	fs.copyFileSync( path.join( engine, 'skills/playground-performance/scripts/performance.js' ), script );
	fs.writeFileSync( settings, JSON.stringify( { directory: fake } ) );
	fs.writeFileSync( path.join( fake, 'run.js' ), "require('fs').writeFileSync(require('path').join(__dirname,'called.json'),JSON.stringify(process.argv.slice(2)));process.exitCode=23;" );
	const invoke = ( command = 'run' ) => spawnSync( process.execPath, [ script, command ], {
		cwd: temporary, encoding: 'utf8', windowsHide: true,
		env: { ...process.env, WP_PLUGIN_PERFORMANCE_DIR: '', WP_PLUGIN_PERFORMANCE_ROOT: '', WP_PLUGIN_REGRESSION_DIR: '' },
	} );
	let result = invoke();
	assert.notEqual( result.status, 0 );
	assert.match( result.stderr, /Missing.*permission/ );
	assert.match( invoke( 'profile' ).stderr, /Missing.*permission/ );
	assert.equal( fs.existsSync( record ), false );
	fs.writeFileSync( permission, 'PLAYGROUND=False\n' );
	result = invoke();
	assert.equal( result.status, 0 );
	assert.equal( fs.existsSync( record ), false );
	fs.writeFileSync( permission, 'PLAYGROUND=invalid\n' );
	assert.notEqual( invoke().status, 0 );
	assert.equal( fs.existsSync( record ), false );
	fs.writeFileSync( permission, 'PLAYGROUND=True\n' );
	result = invoke();
	assert.equal( result.status, 23 );
	const argv = JSON.parse( fs.readFileSync( record, 'utf8' ) );
	assert.equal( argv[argv.indexOf( '--root' ) + 1], consumer );
	assert.equal( argv[argv.indexOf( '--config' ) + 1], path.join( consumer, '.cursor/skills/playground-performance/plan.json' ) );
	assert.equal( invoke( 'profile' ).status, 23 );
	const profileArgs = JSON.parse( fs.readFileSync( record, 'utf8' ) );
	assert.equal( profileArgs[0], 'profile' );
	assert.equal( profileArgs[profileArgs.indexOf( '--config' ) + 1], path.join( consumer, '.cursor/skills/playground-performance/plan.json' ) );
	fs.writeFileSync( permission, 'PLAYGROUND=False\n' );
	assert.equal( invoke( 'profile' ).status, 0 );
	assert.equal( invoke( 'hotspots' ).status, 23 ); // Offline inspection does not launch WordPress or need live consent.
	assert.equal( invoke( 'prune' ).status, 23 );
	result = spawnSync( process.execPath, [ path.join( engine, 'run.js' ), 'run', '--root', consumer ], {
		cwd: engine, encoding: 'utf8', windowsHide: true,
	} );
	assert.notEqual( result.status, 0 );
	assert.match( result.stderr, /PLAYGROUND=False/ );
	const regression = path.join( temporary, 'old-regression' );
	const launched = path.join( regression, 'launched.json' );
	fs.mkdirSync( regression );
	fs.writeFileSync( path.join( regression, 'run.js' ), "require('fs').writeFileSync(require('path').join(__dirname,'launched.json'),'true');" );
	fs.writeFileSync( path.join( regression, 'package.json' ), '{}' );
	fs.writeFileSync( permission, 'PLAYGROUND=True\n' );
	result = spawnSync( process.execPath, [ path.join( engine, 'run.js' ), 'run', '--root', consumer, '--regression-dir', regression, '--config', 'missing-plan.json' ], {
		cwd: engine, encoding: 'utf8', windowsHide: true,
	} );
	assert.notEqual( result.status, 0 );
	assert.match( result.stderr, /wpPluginPerformanceApi: 1/ );
	assert.equal( fs.existsSync( launched ), false );
	console.log( `Consumer permission/root/failure checks passed. Synthetic evidence: ${temporary}` );

	return temporary;
}

if ( require.main === module ) main();

module.exports = { main };
