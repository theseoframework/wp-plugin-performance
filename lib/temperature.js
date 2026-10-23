/**
 * Reads real CPU temperature sensors outside request timing windows.
 */

const fs   = require( 'fs' );
const path = require( 'path' );
const { execFile } = require( 'child_process' );
const { cpuScope } = require( './cpu' );

/**
 * Executes an explicit command and arguments without a shell.
 *
 * @param {string[]} command
 * @param {string|undefined} cwd
 * @return {Promise<string>}
 */
function commandOutput( command, cwd ) {

	return new Promise( ( resolve, reject ) => {
		execFile(
			command[0],
			command.slice( 1 ),
			{ cwd, timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 },
			( error, stdout ) => error ? reject( error ) : resolve( stdout ),
		);
	} );
}

/**
 * Reads existing Linux CPU hwmon devices, preserving other readable sensors if
 * one device disappears or denies access. Board, storage and ACPI sensors stay out.
 *
 * @param {string} base
 * @return {Object}
 */
function readHwmon( base = '/sys/class/hwmon' ) {

	const result = { sensors: [], warnings: [] };
	for ( const directory of fs.readdirSync( base ).sort() ) {
		if ( ! /^hwmon\d+$/.test( directory ) ) continue;

		const root = path.join( base, directory );
		try {
			const name = fs.readFileSync( path.join( root, 'name' ), 'utf8' ).trim();
			if ( ! /^(k10temp|zenpower|coretemp|cpu_thermal)$/.test( name ) ) continue;

			for ( const file of fs.readdirSync( root ).filter( item => /^temp\d+_input$/.test( item ) ).sort() ) {
				try {
					const labelFile = path.join( root, file.replace( '_input', '_label' ) );
					const label = fs.existsSync( labelFile ) ? fs.readFileSync( labelFile, 'utf8' ).trim() : file;
					result.sensors.push( {
						sensor: `${name}/${directory}/${label}`,
						celsius: Number( fs.readFileSync( path.join( root, file ), 'utf8' ).trim() ) / 1000,
					} );
				} catch ( error ) {
					result.warnings.push( `${directory}/${file}: ${error.message}` );
				}
			}
		} catch ( error ) {
			result.warnings.push( `${directory}: ${error.message}` );
		}
	}

	return result;
}

/**
 * Queries existing Windows providers or Linux hwmon, with explicit macOS/WSL
 * limitations. Platform/root options allow isolated filesystem fixtures in tests.
 * An optional command must return JSON: [{ sensor, celsius }].
 * No ACPI thermal zone is presented as a CPU/package reading.
 *
 * @param {string[]|undefined} command
 * @param {Object} options
 * @return {Promise<Object>}
 */
async function readTemperature( command, options = {} ) {

	const platform = options.platform || process.platform;
	const scope = cpuScope( platform, options.release );
	const result = {
		at: new Date().toISOString(), platform, scope, source: 'none',
		sensors: [], celsius: null, reason: '', warnings: [],
	};
	try {
		if ( command ) {
			result.source = 'temperatureCommand';
			result.scope = 'external-provider';
			result.sensors = JSON.parse( await commandOutput( command, options.cwd ) );
		} else if ( 'win32' === platform ) {
			result.source = 'WMI:LibreHardwareMonitor/OpenHardwareMonitor';
			const script = [
				"$ErrorActionPreference='Stop'",
				"$readings=@()",
				"foreach($ns in @('root/LibreHardwareMonitor','root/OpenHardwareMonitor')) {",
				"try { $readings += @(Get-CimInstance -Namespace $ns -ClassName Sensor -ErrorAction Stop | Where-Object { $_.SensorType -eq 'Temperature' -and ($_.Identifier -match '/(amdcpu|intelcpu|cpu)/' -or $_.Name -match 'CPU Package|CPU [(]Tctl|CPU Die|Core [(]') } | ForEach-Object { @{sensor=($_.Identifier+' '+$_.Name);celsius=[double]$_.Value} }) } catch {}",
				'}',
				'ConvertTo-Json -InputObject @($readings) -Compress',
			].join( '\n' );
			result.sensors = JSON.parse( await commandOutput( [
				'powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script,
			] ) );
		} else if ( 'linux' === platform ) {
			result.source = 'sysfs:hwmon';
			Object.assign( result, readHwmon( options.hwmonRoot ) );
		} else if ( 'darwin' === platform ) {
			result.reason = 'macOS has no built-in Celsius reader in this engine. Configure temperatureCommand for an existing trusted CPU sensor provider; thermal pressure is not a temperature.';
		} else {
			result.reason = `No built-in CPU temperature reader for ${platform}. Configure temperatureCommand for an existing trusted provider.`;
		}
		if ( ! Array.isArray( result.sensors ) )
			throw new Error( 'Temperature command must return a JSON array.' );

		result.sensors = result.sensors.filter(
			item => item && 'string' === typeof item.sensor && item.sensor.trim() && Number.isFinite( item.celsius ) && item.celsius > 0 && item.celsius < 150,
		);
		if ( result.sensors.length ) {
			result.celsius = Math.max( ...result.sensors.map( item => item.celsius ) );
		} else if ( ! result.reason ) {
			result.reason = 'wsl-guest' === scope && ! command
				? 'WSL exposes no readable CPU hwmon sensor. A Windows host sensor needs an explicit temperatureCommand bridge to an existing provider.'
				: 'No readable CPU temperature sensor. Configure temperatureCommand or expose an existing CPU sensor provider.';
			if ( result.warnings.length ) result.reason += ` ${result.warnings.join( '; ' )}`;
		}
	} catch ( error ) {
		result.reason = 'wsl-guest' === scope && ! command
			? `WSL CPU sensors are unavailable: ${error.message}. A host provider requires an explicit temperatureCommand bridge.`
			: error.message;
	}

	return result;
}

module.exports = { commandOutput, readHwmon, readTemperature };
