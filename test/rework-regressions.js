/** Reproductions of publication-review failures; all inputs are synthetic. */
const assert = require( 'assert/strict' );
const crypto = require( 'crypto' );
const fs = require( 'fs' );
const path = require( 'path' );
const { phpFingerprint } = require( '../lib/engine' );
const { snapshotPlugin, within } = require( '../lib/snapshot' );
const { pluginScope, manifestScope, validateRows } = require( '../lib/plugin-scope' );
const { report } = require( '../lib/report' );
const { writeDashboard } = require( '../lib/dashboard' );
const { offline } = require( '../lib/profile' );
const { fixture } = require( './profile' );

/** Runtime writes must reach independent copies, never the caller's source. */
function checkSnapshots( parent ) {

	const source = path.join( parent, 'source' );
	fs.mkdirSync( path.join( source, 'inc' ), { recursive: true } );
	fs.writeFileSync( path.join( source, 'main.php' ), '<?php // source\n' );
	fs.writeFileSync( path.join( source, 'inc/nested.php' ), '<?php // nested\n' );
	fs.writeFileSync( path.join( source, 'inc/template.html' ), '<p>original</p>' );
	fs.writeFileSync( path.join( source, 'inc/.private' ), 'excluded' );
	const candidate = { directory: source, mounts: [ 'main.php', 'inc', 'inc/nested.php' ] };
	candidate.phpSourceSha256 = phpFingerprint( candidate );
	const copy = snapshotPlugin( candidate, path.join( parent, 'snapshot' ) );
	assert.equal( phpFingerprint( copy ), candidate.phpSourceSha256 );
	assert( ! fs.existsSync( path.join( copy.directory, 'inc/.private' ) ) );
	fs.writeFileSync( path.join( copy.directory, 'main.php' ), '<?php // runtime overwrite\n' );
	fs.writeFileSync( path.join( copy.directory, 'inc/template.html' ), 'runtime overwrite' );
	fs.writeFileSync( path.join( copy.directory, 'inc/generated.php' ), '<?php // generated\n' );
	assert.equal( phpFingerprint( candidate ), candidate.phpSourceSha256 );
	assert.equal( fs.readFileSync( path.join( source, 'inc/template.html' ), 'utf8' ), '<p>original</p>' );
	assert( ! fs.existsSync( path.join( source, 'inc/generated.php' ) ) );
	assert.notEqual( phpFingerprint( copy ), candidate.phpSourceSha256 );
	assert.throws( () => snapshotPlugin( candidate, path.join( source, 'inc/snapshot' ) ), /outside/ );
	assert.throws( () => snapshotPlugin( { ...candidate, mounts: [ '../escape' ] }, path.join( parent, 'escaped' ) ), /outside/ );
	fs.appendFileSync( path.join( source, 'main.php' ), '// drift\n' );
	assert.throws( () => snapshotPlugin( candidate, path.join( parent, 'drift' ) ), /changed before/ );
	assert( within( source, path.join( source, 'inc' ) ) );
	assert( ! within( source, path.join( parent, 'source-other' ) ) );
	// Directory junction creation works on Windows without symlink privileges.
	const linked = path.join( parent, 'linked' );
	fs.mkdirSync( linked );
	fs.symlinkSync( source, path.join( linked, 'junction' ), process.platform === 'win32' ? 'junction' : 'dir' );
	assert.throws( () => snapshotPlugin( { directory: linked, mounts: [ 'junction' ], phpSourceSha256: '' }, path.join( parent, 'linked-copy' ) ), /symlink/i );
}

/** Both saved-report entry points and exports reject old multi-product input. */
async function checkScope( parent ) {

	const candidates = [ 'before', 'after' ].map( id => ( { id, slug: 'my-plugin', mainFile: 'main.php' } ) );
	const scope = pluginScope( candidates );
	validateRows( scope, [ { candidate: 'before' }, { candidate: 'after' } ] );
	assert.throws( () => pluginScope( [] ), /identity/ );
	assert.throws( () => pluginScope( [ candidates[0], { ...candidates[1], mainFile: 'other.php' } ] ), /Cross-plugin/ );
	assert.throws( () => pluginScope( [ { ...candidates[0], extraPlugins: [ 'companion' ] } ] ), /additional/ );
	assert.throws( () => manifestScope( { config: { candidates }, candidates: [ { ...candidates[0], slug: 'other' } ] } ), /differs/ );
	assert.throws( () => validateRows( scope, [ { candidate: 'unknown' } ] ), /identity/ );
	assert.throws( () => validateRows( scope, [ { candidate: 'before', baseline: true } ] ), /identity/ );
	assert.throws( () => validateRows( scope, [ { candidate: 'before', rank: 1 } ] ), /Ranking/ );
	const manifest = { config: { candidates: [ candidates[0], { ...candidates[1], slug: 'other' } ] } };
	const directory = path.join( parent, 'cross-product' );
	fs.mkdirSync( directory );
	const plan = path.join( parent, 'cross-product-plan.json' );
	fs.writeFileSync( plan, JSON.stringify( manifest.config ) );
	assert.throws( () => require( '../lib/benchmark' ).configuration( plan, {} ), /Cross-plugin/ );
	await assert.rejects( report( directory, manifest ), /Cross-plugin/ );
	assert.throws( () => writeDashboard( directory, { manifest, summaries: [] } ), /Cross-plugin/ );
	fs.writeFileSync( path.join( directory, 'results.json' ), JSON.stringify( { manifest, summaries: [] } ) );
	await assert.rejects( require( '../lib/export-xlsx' ).main( { input: directory, modules: directory } ), /Cross-plugin/ );
	assert.deepEqual( fs.readdirSync( directory ), [ 'results.json' ] );
	// Even failed legacy rows must not bypass the removed-rank check.
	const legacy = { manifest: { config: { candidates } }, summaries: [ { candidate: 'before', status: 'failed', rank: 1 } ] };
	assert.throws( () => writeDashboard( directory, legacy ), /Ranking/ );
	fs.writeFileSync( path.join( directory, 'results.json' ), JSON.stringify( legacy ) );
	await assert.rejects( require( '../lib/export-xlsx' ).main( { input: directory, modules: directory } ), /Ranking/ );
	await assert.rejects( report( directory, { config: {} } ), /identity/ );
	assert.deepEqual( fs.readdirSync( directory ), [ 'results.json' ] );
}

/** An offline report carries identity without leaking arbitrary plan options. */
function checkProvenance( parent ) {

	const input = path.join( parent, 'saved' );
	fs.mkdirSync( input );
	fs.writeFileSync( path.join( input, 'cachegrind.test' ), fixture );
	const hash = bytes => crypto.createHash( 'sha256' ).update( bytes ).digest( 'hex' );
	const request = { scenario: 'post', index: 0, raw: 'cachegrind.test', sha256: hash( fixture ), requestToken: 'synthetic-token' };
	const manifest = {
		kind: 'wp-hotspot-run-v1', complete: true, failures: [], profiles: [ request ],
		environment: { platform: 'synthetic' }, runtime: { phpVersion: '8.3.test', xdebug: '</pre><script>bad()</script>' },
		plugin: { slug: 'my-plugin', mainFile: 'main.php', version: '1', phpSourceSha256: 'synthetic-source', options: { password: 'never-export-this' } },
		sourceSnapshot: { directory: 'synthetic-copy', phpSourceSha256: 'synthetic-source' },
	};
	const bytes = JSON.stringify( manifest );
	fs.writeFileSync( path.join( input, 'manifest.json' ), bytes );
	const output = path.join( parent, 'offline' );
	offline( { input, output } );
	const data = JSON.parse( fs.readFileSync( path.join( output, 'hotspots.json' ) ) );
	const provenance = JSON.parse( fs.readFileSync( path.join( output, 'provenance.json' ) ) );
	assert.deepEqual( data.runtime, manifest.runtime );
	assert.deepEqual( data.environment, manifest.environment );
	assert.deepEqual( data.sourceSnapshot, manifest.sourceSnapshot );
	assert.deepEqual( data.profiles[0].request, request );
	assert.equal( data.sourceManifestSha256, hash( bytes ) );
	assert.equal( provenance.plugin.phpSourceSha256, 'synthetic-source' );
	for ( const file of [ 'hotspots.json', 'provenance.json', 'report.html', 'report.md' ] ) {
		const text = fs.readFileSync( path.join( output, file ), 'utf8' );
		assert( text.includes( '8.3.test' ) );
		assert( ! text.includes( 'never-export-this' ) );
	}
	assert( ! fs.readFileSync( path.join( output, 'report.html' ), 'utf8' ).includes( '</pre><script>bad()' ) );
	const standalone = path.join( parent, 'standalone' );
	offline( { input: path.join( input, 'cachegrind.test' ), output: standalone } );
	const unknown = JSON.parse( fs.readFileSync( path.join( standalone, 'provenance.json' ) ) );
	assert.equal( unknown.runtime, 'Not recorded' );
	assert.equal( unknown.plugin, 'Not recorded' );
	assert.match( unknown.requestValidation, /Standalone/ );
	// Older complete runs may lack runtime fields: preserve uncertainty explicitly.
	delete manifest.runtime;
	delete manifest.environment;
	delete manifest.sourceSnapshot;
	fs.writeFileSync( path.join( input, 'manifest.json' ), JSON.stringify( manifest ) );
	const historical = path.join( parent, 'historical' );
	offline( { input, output: historical } );
	const missing = JSON.parse( fs.readFileSync( path.join( historical, 'provenance.json' ) ) );
	assert.equal( missing.runtime, 'Not recorded' );
	assert.equal( missing.environment, 'Not recorded' );
	assert.equal( missing.sourceSnapshot, 'Not recorded' );
	fs.appendFileSync( path.join( input, 'cachegrind.test' ), '\n' );
	assert.throws( () => offline( { input, output: path.join( parent, 'tampered' ) } ), /hash changed/ );
	assert( ! fs.existsSync( path.join( parent, 'tampered' ) ) );
}

async function checkRework( output ) {
	const parent = path.join( output, 'publication-regressions' );
	fs.mkdirSync( parent );
	checkSnapshots( parent );
	await checkScope( parent );
	checkProvenance( parent );
}

module.exports = { checkRework };
