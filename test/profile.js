/** Profiling-specific tests use synthetic costs, never marketing measurements. */
const assert = require( 'assert/strict' );
const fs = require( 'fs' );
const path = require( 'path' );
const { parse } = require( '../lib/cachegrind' );
const { write } = require( '../lib/hotspot-report' );
const { configuration, completedProfile, offline, reportMetadata } = require( '../lib/profile' );
const { JOURNAL, policy, prune } = require( '../lib/raw-retention' );
const disclaimer = require( '../lib/disclaimer' );

const fixture = `version: 1
creator: xdebug 3.4.0 (PHP 8.3.0)
cmd: /wordpress/index.php
part: 1
positions: line
events: Time_(10ns) Memory_(bytes)
fl=(1) /wordpress/wp-content/plugins/my-plugin/main.php
fn=(1) main
1 100000 16
cfl=(2)
cfn=(2)
calls=2 0 0
2 50000 0
fl=(2) php:internal
fn=(2) php::str_replace
3 50000 -8
summary: 150000 8
`;

/** Checks cost units, compression, edge accounting, escaping and rejection. */
async function checkProfile( output ) {

	const prefix = '/wordpress/wp-content/plugins/my-plugin';
	const parsed = parse( fixture, prefix );
	assert( Math.abs( parsed.totalMs - 1.5 ) < 1e-9 );
	assert.equal( parsed.nodes[0].selfMs, 1 );
	assert( Math.abs( parsed.nodes[0].inclusiveMs - 1.5 ) < 1e-9 );
	assert.equal( parsed.nodes[0].plugin, true );
	assert.equal( parsed.nodes[1].calls, 2 );
	assert.equal( parsed.nodes[1].selfMs, 0.5 );
	assert.equal( parsed.nodes[1].plugin, false );
	assert.equal( parsed.edges[0].inclusiveMs, 0.5 );
	assert.throws( () => parse( fixture.replace( /summary:.*\n/, '' ) ), /complete/ );
	assert.throws( () => parse( fixture.replace( 'cfn=(2)', 'cfn=(999)' ) ), /Undefined/ );
	assert.throws( () => parse( fixture + 'fl=(1) conflicting.php\n' ), /Conflicting/ );
	assert.throws( () => parse( fixture.replace( '100000 16', 'NaN 16' ) ), /cost row/ );
	assert.throws( () => parse( fixture.replace( 'Time_(10ns)', 'Ticks' ) ), /Unsupported/ );
	assert.throws( () => parse( fixture + 'part: 2\n' ), /complete/ );
	const recursive = parse( fixture.replace( 'cfl=(2)', 'cfl=(1)' ).replace( 'cfn=(2)', 'cfn=(1)' ) );
	assert.equal( recursive.edges[0].caller, recursive.edges[0].callee );
	const plan = { wp: '7.1.1', php: '8.3', plugin: { slug: 'my-plugin', mainFile: 'main.php' } };
	assert.equal( configuration( plan ).profiles, 1 );
	assert.equal( configuration( { ...plan, profiles: 2 }, { profiles: '3' } ).profiles, 3 );
	assert.throws( () => configuration( { ...plan, php: 'auto' } ), /explicit/ );
	assert.throws( () => configuration( { ...plan, candidates: [] } ), /one local plugin/ );
	assert.throws( () => configuration( { ...plan, plugin: { ...plan.plugin, baseline: true } } ), /one local plugin/ );
	assert.throws( () => configuration( { ...plan, plugin: { ...plan.plugin, source: 'wporg' } } ), /one local plugin/ );
	assert.throws( () => configuration( plan, { profiles: 'NaN' } ), /positive/ );
	const raw = path.join( output, 'raw-profile-test' );
	fs.mkdirSync( raw );
	fs.writeFileSync( path.join( raw, 'cachegrind.test.1' ), fixture );
	assert( Math.abs( ( await completedProfile( raw, 'cachegrind.test.1', prefix ) ).totalMs - 1.5 ) < 1e-9 );
	await assert.rejects( completedProfile( raw, '../escape', prefix ), /filename/ );
	const report = path.join( output, 'hotspot-report' );
	write( report, [ { label: '</script><img onerror=alert(1)>', ...parsed } ] );
	const page = fs.readFileSync( path.join( report, 'report.html' ), 'utf8' );
	assert( page.includes( disclaimer ) );
	assert( ! page.includes( '</script><img' ) );
	assert( ! /(?:src|href)="https?:/i.test( page ) );
	assert( page.includes( '\\u003c/script' ) );
	assert.equal( JSON.parse( fs.readFileSync( path.join( report, 'hotspots.json' ) ) ).profiles.length, 1 );
	assert.throws( () => write( report, [] ), /EEXIST/ );
	checkRetention( output, parsed );
}

/** Verifies deletion scope, complete evidence, preview and safe repeat calls. */
function checkRetention( output, parsed ) {

	assert.equal( policy(), undefined );
	assert.equal( policy( undefined, 'prune' ), 'prune' );
	assert.equal( policy( 'keep', 'prune' ), 'keep' );
	assert.throws( () => policy( true ), /keep or prune/ );
	const run = path.join( output, 'retention-test' );
	const raw = path.join( run, 'raw' );
	fs.mkdirSync( raw, { recursive: true } );
	const manifestFile = path.join( run, 'manifest.json' );
	const profiles = [ 0, 1 ].map( index => ( {
		scenario: 'post', index, raw: `raw/cachegrind.test.${index}`, sha256: parsed.sha256,
		requestToken: `request-${index}`,
	} ) );
	for ( const item of profiles ) fs.writeFileSync( path.join( run, item.raw ), fixture );
	const extra = path.join( raw, 'cachegrind.unlisted' );
	fs.writeFileSync( extra, fixture );
	const manifest = { kind: 'wp-hotspot-run-v1', complete: true, stopped: true, failures: [], profiles };
	const bytes = JSON.stringify( manifest );
	fs.writeFileSync( manifestFile, JSON.stringify( { ...manifest, stopped: false } ) );
	assert.throws( () => prune( { input: run, apply: true } ), /complete, stopped/ );
	fs.writeFileSync( manifestFile, JSON.stringify( { ...manifest, rawRetention: 'keep' } ) );
	assert.throws( () => prune( { input: run, apply: true } ), /marked to keep/ );
	fs.writeFileSync( manifestFile, bytes );
	assert.throws( () => prune( { input: run, apply: true } ), /Missing retention evidence/ );
	write( run, profiles.map( request => ( { label: `post ${request.index}`, request, ...parsed } ) ), reportMetadata( manifest, bytes ) );
	const htmlFile = path.join( run, 'report.html' );
	const page = fs.readFileSync( htmlFile, 'utf8' );
	fs.writeFileSync( htmlFile, page.slice( 0, -9 ) );
	assert.throws( () => prune( { input: run, apply: true } ), /HTML is incomplete/ );
	fs.writeFileSync( htmlFile, page );
	const first = path.join( run, profiles[0].raw );
	const second = path.join( run, profiles[1].raw );
	fs.appendFileSync( second, '\n' );
	assert.throws( () => prune( { input: run, apply: true } ), /hash changed/ );
	assert( fs.existsSync( first ) );
	fs.writeFileSync( second, fixture );
	assert.equal( prune( { input: run } ).files, 2 );
	assert( fs.existsSync( first ) && fs.existsSync( second ) );
	assert( ! fs.existsSync( path.join( run, JOURNAL ) ) );
	assert.equal( prune( { input: run, apply: true } ).removed, 2 );
	assert( fs.existsSync( extra ) );
	assert.equal( fs.readFileSync( htmlFile, 'utf8' ), page );
	assert.equal( fs.readFileSync( manifestFile, 'utf8' ), bytes );
	assert.equal( prune( { input: run, apply: true } ).alreadyPruned, 2 );
	assert.throws( () => offline( { input: run, output: run + '-offline' } ), /Raw profiles were pruned/ );
}

module.exports = { checkProfile, fixture };
