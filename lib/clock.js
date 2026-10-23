/**
 * CPU clock context at block boundaries. Estimates keep their source and kind;
 * nominal/reference clocks never masquerade as hardware-effective clocks.
 */

const fs   = require( 'fs' );
const path = require( 'path' );
const { cpuScope } = require( './cpu' );
const { commandOutput } = require( './temperature' );

const CLOCK_KINDS = new Set( [ 'effective', 'hardware-current', 'hardware-average', 'driver-reported', 'os-performance-estimate' ] );

/**
 * Retains the Windows reference frequency and relative active performance used
 * in an estimated MHz value. This is not a wall-time effective-clock measurement.
 *
 * @param {Object[]} rows
 * @return {Object[]}
 */
function windowsClocks( rows ) {
	return rows.filter( row => /^\d+,\d+$/.test( row.sensor ) ).map( row => ( {
		...row, kind: 'os-performance-estimate',
		mhz: Number.isFinite( row.referenceMHz ) && row.referenceMHz > 0 && Number.isFinite( row.performancePercent ) && row.performancePercent > 0
			? row.referenceMHz * row.performancePercent / 100 : null,
	} ) );
}

/**
 * Reads each existing CPUFreq policy once, preferring hardware feedback over
 * the driver's potentially requested frequency. Never reads a nominal maximum.
 *
 * @param {string} base
 * @return {Object}
 */
function readCPUFreq( base = '/sys/devices/system/cpu/cpufreq' ) {

	const result = { sensors: [], warnings: [] };
	for ( const policy of fs.readdirSync( base ).filter( item => /^policy\d+$/.test( item ) ).sort() ) {
		const root = path.join( base, policy );
		for ( const [ file, kind ] of [ [ 'cpuinfo_cur_freq', 'hardware-current' ], [ 'cpuinfo_avg_freq', 'hardware-average' ], [ 'scaling_cur_freq', 'driver-reported' ] ] ) {
			try {
				const mhz = Number( fs.readFileSync( path.join( root, file ), 'utf8' ).trim() ) / 1000;
				if ( ! Number.isFinite( mhz ) || mhz <= 0 ) throw new Error( 'No positive clock reading.' );

				const members = path.join( root, 'affected_cpus' );
				result.sensors.push( {
					sensor: policy, mhz, kind, source: file,
					cpus: fs.existsSync( members ) ? fs.readFileSync( members, 'utf8' ).trim() : '',
				} );
				break;
			} catch ( error ) {
				if ( 'ENOENT' !== error.code ) result.warnings.push( `${policy}/${file}: ${error.message}` );
			}
		}
	}

	return result;
}

/**
 * Keeps per-policy/core readings and distinguishes their measurement kinds.
 * An explicit provider returns [{ sensor, mhz, kind }], optionally with raw data.
 *
 * @param {string[]|undefined} command
 * @param {Object} options
 * @return {Promise<Object>}
 */
async function readCPUClock( command, options = {} ) {

	const platform = options.platform || process.platform;
	const result = {
		at: new Date().toISOString(), platform, scope: cpuScope( platform, options.release ), source: 'none',
		sensors: [], kinds: [], minimumMHz: null, maximumMHz: null, reason: '', warnings: [],
	};
	try {
		if ( command ) {
			result.source = 'clockCommand';
			result.scope = 'external-provider';
			result.sensors = JSON.parse( await commandOutput( command, options.cwd ) );
		} else if ( 'win32' === platform && [ 'x64', 'ia32' ].includes( options.arch || process.arch ) ) {
			result.source = 'Windows:ProcessorInformation';
			const script = [
				"$ErrorActionPreference='Stop'",
				"$rows=@(Get-CimInstance -Namespace root/cimv2 -ClassName Win32_PerfFormattedData_Counters_ProcessorInformation -ErrorAction Stop | Where-Object {$_.Name -match '^\\d+,\\d+$'} | ForEach-Object {@{sensor=$_.Name;referenceMHz=[double]$_.ProcessorFrequency;performancePercent=[double]$_.PercentProcessorPerformance;providerTimestamp100ns=[string]$_.Timestamp_Sys100NS}})",
				'ConvertTo-Json -InputObject @($rows) -Compress',
			].join( '\n' );
			result.sensors = windowsClocks( JSON.parse( await commandOutput( [ 'powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script ] ) ) );
		} else if ( 'linux' === platform ) {
			result.source = 'sysfs:cpufreq';
			Object.assign( result, readCPUFreq( options.cpufreqRoot ) );
		} else {
			result.reason = `No built-in measured CPU clock reader for ${platform}/${options.arch || process.arch}. Configure clockCommand for an existing provider; nominal CPU speed is not a live clock.`;
		}
		if ( ! Array.isArray( result.sensors ) ) throw new Error( 'Clock command must return a JSON array.' );

		result.sensors = result.sensors.filter( item => item && 'string' === typeof item.sensor && item.sensor.trim() && Number.isFinite( item.mhz ) && item.mhz > 0 && CLOCK_KINDS.has( item.kind ) );
		result.kinds = [ ...new Set( result.sensors.map( item => item.kind ) ) ];
		if ( 1 === result.kinds.length ) {
			result.minimumMHz = Math.min( ...result.sensors.map( item => item.mhz ) );
			result.maximumMHz = Math.max( ...result.sensors.map( item => item.mhz ) );
		} else if ( result.kinds.length > 1 ) {
			result.reason = 'Clock kinds differ; inspect individual readings instead of combining measured, requested or estimated clocks.';
		} else if ( ! result.reason ) {
			result.reason = 'wsl-guest' === result.scope
				? 'WSL exposes no usable CPUFreq clocks. Configure an explicit host provider; guest-reported nominal MHz are not physical effective clocks.'
				: 'No usable CPU clock readings. Configure clockCommand for an existing provider; readings need sensor, positive mhz and an explicit supported kind.';
		}
	} catch ( error ) {
		result.reason = `${'wsl-guest' === result.scope ? 'WSL CPU clock unavailable: ' : ''}${error.message}`;
	}

	return result;
}

module.exports = { CLOCK_KINDS, windowsClocks, readCPUFreq, readCPUClock };
