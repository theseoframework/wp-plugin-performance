/**
 * Distinguishes observed, estimated and nominal clocks and checks that thermal
 * context cannot silently change the validity/rank of the same HTTP evidence.
 */

const assert = require( 'assert/strict' );
const fs     = require( 'fs' );
const path   = require( 'path' );
const { readCPUClock, readCPUFreq, windowsClocks } = require( '../lib/clock' );
const { saveBlock, report } = require( '../lib/report' );

/**
 * Checks platform clock readers and explicit provider contracts with fixtures.
 *
 * @param {string} output
 * @return {Promise<void>}
 */
async function checkClocks( output ) {

	const base = path.join( output, 'cpufreq-fixture' );
	for ( const [ policy, files ] of Object.entries( {
		policy0: { cpuinfo_cur_freq: '4500000', scaling_cur_freq: '3000000', affected_cpus: '0 1' },
		policy1: { cpuinfo_avg_freq: '4100000', scaling_cur_freq: '2800000' },
		policy2: { scaling_cur_freq: '2800000' },
		policy3: { cpuinfo_max_freq: '9900000' },
	} ) ) {
		const directory = path.join( base, policy );
		fs.mkdirSync( directory, { recursive: true } );
		for ( const [ name, value ] of Object.entries( files ) )
			fs.writeFileSync( path.join( directory, name ), value + '\n' );
	}
	const linux = readCPUFreq( base );
	assert.deepEqual( linux.sensors.map( item => [ item.sensor, item.mhz, item.kind ] ), [
		[ 'policy0', 4500, 'hardware-current' ], [ 'policy1', 4100, 'hardware-average' ], [ 'policy2', 2800, 'driver-reported' ],
	] );
	const mixed = await readCPUClock( undefined, { platform: 'linux', release: 'native', cpufreqRoot: base } );
	assert.equal( mixed.minimumMHz, null );
	assert.match( mixed.reason, /Clock kinds differ/ );
	const wsl = await readCPUClock( undefined, { platform: 'linux', release: 'microsoft-WSL2', cpufreqRoot: path.join( output, 'absent-cpufreq' ) } );
	assert.equal( wsl.minimumMHz, null );
	assert.match( wsl.reason, /WSL CPU clock unavailable/ );
	const mac = await readCPUClock( undefined, { platform: 'darwin' } );
	assert.equal( mac.minimumMHz, null );
	assert.match( mac.reason, /clockCommand.*nominal CPU speed is not a live clock/ );
	const windows = windowsClocks( [
		{ sensor: '0,0', referenceMHz: 3401, performancePercent: 125 },
		{ sensor: '_Total', referenceMHz: 3401, performancePercent: 125 },
		{ sensor: '0,1', referenceMHz: 3401, performancePercent: null },
	] );
	assert.equal( windows.length, 2 );
	assert.equal( windows[0].mhz, 4251.25 );
	assert.equal( windows[0].kind, 'os-performance-estimate' );
	assert.equal( windows[0].referenceMHz, 3401 );
	assert.equal( windows[1].mhz, null );
	fs.writeFileSync( path.join( output, 'clock-provider.cjs' ), 'process.stdout.write(JSON.stringify([{sensor:"synthetic CPU 0",mhz:3400,kind:"effective"},{sensor:"synthetic CPU 1",mhz:4200,kind:"effective"},{sensor:"nominal",mhz:9999,kind:"nominal"}]));\n' );
	const external = await readCPUClock( [ process.execPath, 'clock-provider.cjs' ], { platform: 'darwin', cwd: output } );
	assert.equal( external.minimumMHz, 3400 );
	assert.equal( external.maximumMHz, 4200 );
	assert.equal( external.sensors.length, 2 );
	assert.equal( external.scope, 'external-provider' );
	assert.equal( external.reason, '' );
}

/**
 * Missing readings, an 85 C cap, and a large temperature change must not
 * downgrade valid completed timing evidence or imply a clock/performance loss.
 *
 * @param {string} output
 * @return {Promise<void>}
 */
async function checkThermalContext( output ) {

	const directory = path.join( output, 'thermal-context' );
	fs.mkdirSync( directory );
	for ( const [ candidate, before, after ] of [ [ 'cool', 45, 45 ], [ 'capped', 85, 85 ], [ 'missing', null, null ], [ 'changed', 35, 85 ] ] ) {
		const block = {
			blockId: candidate, candidate, pluginVersion: '1.0', wp: '7.1', php: '8.5', round: 1, scenario: 'page', frame: 'static',
			before: { celsius: before, sensors: [], reason: null === before ? 'Unavailable fixture' : '' },
			after: { celsius: after, sensors: [], reason: null === after ? 'Unavailable fixture' : '' },
		};
		saveBlock( directory, block, [ 10, 11 ].map( ( elapsedMs, sequence ) => ( { blockId: candidate, candidate, phase: 'measure', elapsedMs, sequence, valid: true } ) ) );
	}
	const result = await report( directory, {
		config: { samples: 2, rounds: 1, warmups: 1, outlierFraction: 0.8, outlierReference: 'median', fastestCount: 1000, candidates: [ 'cool', 'capped', 'missing', 'changed' ].map( id => ( { id, slug: 'fixture', mainFile: 'fixture.php' } ) ) }, smoke: false, failures: [],
	} );
	assert( result.summaries.every( row => 'valid' === row.status && row.eligible && ! Object.hasOwn( row, 'rank' ) && '' === row.issues ) );
	assert( result.summaries.every( row => 10 === row.leadingMs ) );
}

module.exports = { checkClocks, checkThermalContext };
