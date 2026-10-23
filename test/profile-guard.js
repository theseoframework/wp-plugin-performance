/** Optional integration test: node test/profile-guard.js <php> <wordpress-src>. */
const assert = require( 'assert/strict' );
const path = require( 'path' );
const { spawnSync } = require( 'child_process' );

function main( php, core ) {
	if ( ! php || ! core ) throw new Error( 'Supply an installed PHP executable and WordPress source directory.' );

	for ( const mode of [ 'normal', 'conflict-http', 'conflict-hosts' ] ) {
		const child = spawnSync( php, [ path.join( __dirname, 'profile-guard.php' ), core, mode ], { encoding: 'utf8', windowsHide: true } );
		if ( child.error ) throw child.error;

		assert.equal( child.status, 0, child.stderr || child.stdout );
		assert.equal( child.stderr, '' );
		const data = JSON.parse( child.stdout );
		if ( 'normal' === mode ) {
			assert.equal( data.httpPre, false );
			assert.deepEqual( data.blocked, [ true, true, true ] );
			assert.equal( data.mailPre, null );
			assert.equal( data.mailBlocked, true );
		} else assert.equal( data.rejected, true );
	}
	console.log( 'WordPress HTTP/mail guard integration checks passed; no transport was invoked.' );
}

if ( require.main === module ) main( ...process.argv.slice( 2 ) );
module.exports = { main };
