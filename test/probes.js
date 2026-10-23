/**
 * Exercises platform boundaries with synthetic sensors and CPU counter failures.
 */

const assert = require( 'assert/strict' );
const fs     = require( 'fs' );
const path   = require( 'path' );
const { cpuScope, readCPUCounters, cpuLoad } = require( '../lib/cpu' );
const { readTemperature } = require( '../lib/temperature' );

/**
 * Keeps board/ACPI readings, broken devices and unsupported OSes out of the CPU
 * temperature result. Checks real idle separately from missing/reset counters.
 *
 * @param {string} output
 * @return {Promise<void>}
 */
async function checkProbes( output ) {

	const base = path.join( output, 'hwmon-fixture' );
	for ( const [ device, files ] of Object.entries( {
		hwmon0: { name: 'k10temp', temp1_label: 'Tctl', temp1_input: '62000', temp2_label: 'Tdie', temp2_input: '59000', temp3_input: 'invalid' },
		hwmon1: { name: 'acpitz', temp1_input: '95000' },
		hwmon2: { name: 'nvme', temp1_input: '99000' },
		hwmon3: {},
		hwmon4: { name: 'coretemp', temp1_label: 'Package id 1', temp1_input: '58000' },
	} ) ) {
		const directory = path.join( base, device );
		fs.mkdirSync( directory, { recursive: true } );
		for ( const [ name, value ] of Object.entries( files ) )
			fs.writeFileSync( path.join( directory, name ), value + '\n' );
	}
	const linux = await readTemperature( undefined, { platform: 'linux', release: '6.12-generic', hwmonRoot: base } );
	assert.equal( linux.celsius, 62 );
	assert.equal( linux.sensors.length, 3 );
	assert( linux.sensors.some( item => item.sensor.includes( '/Tdie' ) && 59 === item.celsius ) );
	assert( linux.warnings.length && ! linux.reason );
	const empty = path.join( output, 'empty-hwmon' );
	fs.mkdirSync( empty );
	const wsl = await readTemperature( undefined, { platform: 'linux', release: '6.6-microsoft-standard-WSL2', hwmonRoot: empty } );
	assert.equal( wsl.celsius, null );
	assert.equal( wsl.scope, 'wsl-guest' );
	assert.match( wsl.reason, /WSL.*explicit temperatureCommand bridge/ );
	const absent = await readTemperature( undefined, { platform: 'linux', hwmonRoot: path.join( output, 'absent-hwmon' ) } );
	assert.equal( absent.celsius, null );
	assert( absent.reason );
	const mac = await readTemperature( undefined, { platform: 'darwin' } );
	assert.equal( mac.celsius, null );
	assert.match( mac.reason, /temperatureCommand.*thermal pressure is not a temperature/ );
	fs.writeFileSync( path.join( output, 'provider.cjs' ), 'process.stdout.write(JSON.stringify([null,{sensor:"synthetic CPU",celsius:55},{sensor:"board",celsius:200}]));\n' );
	const provider = await readTemperature( [ process.execPath, 'provider.cjs' ], { platform: 'darwin', cwd: output } );
	assert.equal( provider.celsius, 55 );
	assert.equal( provider.sensors.length, 1 );
	assert.equal( provider.scope, 'external-provider' );
	const invalid = await readTemperature( [ process.execPath, '-e', 'process.stdout.write("{}")' ] );
	assert.equal( invalid.celsius, null );
	assert.match( invalid.reason, /JSON array/ );
	assert.equal( cpuScope( 'linux', '6.6-microsoft-standard-WSL2' ), 'wsl-guest' );
	for ( const platform of [ 'win32', 'darwin', 'linux' ] )
		assert.equal( cpuScope( platform, 'native' ), 'operating-system' );
	const first = {
		at: '2026-01-01T00:00:00.000Z', monotonicMs: 100, platform: 'linux', scope: 'operating-system',
		cpus: [ 0, 1 ].map( () => ( { model: 'synthetic', times: { user: 10, nice: 0, sys: 5, idle: 100, irq: 0 } } ) ),
	};
	const last = structuredClone( first );
	last.at = '2026-01-01T00:00:01.000Z';
	last.monotonicMs = 1100;
	last.cpus[0].times.user += 80;
	last.cpus[0].times.idle += 20;
	last.cpus[1].times.user += 20;
	last.cpus[1].times.idle += 80;
	assert.equal( cpuLoad( first, last ).percent, 50 );
	assert.equal( cpuLoad( first, last ).durationMs, 1000 );
	const windowsBefore = structuredClone( first );
	windowsBefore.platform = 'win32';
	windowsBefore.cpus = [ windowsBefore.cpus[0] ];
	const windowsAfter = structuredClone( windowsBefore );
	windowsAfter.monotonicMs += 1000;
	Object.assign( windowsAfter.cpus[0].times, { user: 20, nice: 0, sys: 45, idle: 150, irq: 20 } );
	assert.equal( cpuLoad( windowsBefore, windowsAfter ).percent, 50 );
	const idle = structuredClone( first );
	idle.monotonicMs += 1000;
	for ( const cpu of idle.cpus ) cpu.times.idle += 100;
	assert.equal( cpuLoad( first, idle ).percent, 0 );
	for ( const change of [
		item => item.cpus.pop(),
		item => item.cpus[0].times.user = 1,
		item => item.cpus[0].times.idle = NaN,
		item => item.cpus[0].model = 'different',
		item => item.scope = 'wsl-guest',
		item => item.monotonicMs = 0,
		item => item.cpus = structuredClone( first.cpus ),
	] ) {
		const changed = structuredClone( last );
		change( changed );
		const load = cpuLoad( first, changed );
		assert.equal( load.percent, null );
		assert( load.reason );
	}
	assert.equal( cpuLoad( undefined, undefined ).percent, null );
	const counters = readCPUCounters();
	assert( Array.isArray( counters.cpus ) && Number.isFinite( Date.parse( counters.at ) ) );
}

module.exports = { checkProbes };
