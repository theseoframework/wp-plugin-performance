/** Validated, triggered single-plugin Xdebug captures in disposable Playground sites. */
const fs = require( 'fs' );
const path = require( 'path' );
const crypto = require( 'crypto' );
const {
	ROOT, ENGINE_ROOT, allowedPath, engineSettings, engineDirectory, assertPerformanceEngine,
	prepareCandidate, phpFingerprint, stopSession,
} = require( './engine' );
const { control, launchSession, scenarios } = require( './benchmark' );
const { request, validate } = require( './measure' );
const cachegrind = require( './cachegrind' );
const report = require( './hotspot-report' );
const retention = require( './raw-retention' );
const disclaimer = require( './disclaimer' );

/** Rejects ambiguous budgets and cross-plugin plans before launching. */
function configuration( input, args = {} ) {

	const config = { warmups: 3, profiles: 1, timeoutMs: 60000, scenarios: [ 'home-blog', 'home-static', 'blog-page', 'post', 'page' ], ...input };
	for ( const key of [ 'warmups', 'profiles' ] ) if ( undefined !== args[key] ) config[key] = Number( args[key] );
	if ( args.scenarios ) config.scenarios = String( args.scenarios ).split( ',' );
	if ( ! /^\d+\.\d+$/.test( config.php ) || ! /^\d+\.\d+(?:\.\d+)?$/.test( config.wp ) )
		throw new Error( 'Profile plans require explicit wp and php versions; no automatic release resolution.' );

	for ( const key of [ 'warmups', 'profiles', 'timeoutMs' ] )
		if ( ! Number.isSafeInteger( config[key] ) || config[key] < 1 ) throw new Error( `${key} must be a positive integer.` );

	if ( ! config.plugin || config.candidates || ! /^[a-z0-9-]+$/.test( config.plugin.slug || '' ) || ! config.plugin.mainFile || config.plugin.source === 'wporg' || config.plugin.baseline || config.plugin.extraPlugins?.length )
		throw new Error( 'Profile one local plugin using plugin.slug, plugin.path and plugin.mainFile. Cross-plugin plans and package downloads are unsupported.' );

	if ( ! Array.isArray( config.scenarios ) || ! config.scenarios.length || config.scenarios.some( id => ! /^[a-z0-9-]+$/.test( id ) ) || new Set( config.scenarios ).size !== config.scenarios.length )
		throw new Error( 'Choose unique scenario IDs.' );

	return config;
}

/** Reads a completed profile after the HTTP request has fully shut down. */
async function completedProfile( directory, basename, prefix ) {

	if ( ! /^cachegrind\.[a-zA-Z0-9.-]+$/.test( basename || '' ) ) throw new Error( 'Missing or invalid profiler filename.' );

	const file = allowedPath( path.join( directory, basename ) );
	const deadline = Date.now() + 5000;
	while ( Date.now() < deadline ) {
		if ( fs.existsSync( file ) ) {
			if ( fs.lstatSync( file ).isSymbolicLink() || fs.statSync( file ).size > 128 * 1024 * 1024 ) throw new Error( 'Invalid or oversized raw profile.' );

			const text = fs.readFileSync( file, 'utf8' );
			if ( /\nsummary: [^\n]+\s*$/.test( text ) ) return cachegrind.parse( text, prefix );
		}
		await new Promise( resolve => setTimeout( resolve, 100 ) );
	}
	throw new Error( 'Incomplete Xdebug profile; raw evidence retained.' );
}

/** Captures selected native WordPress routes, preserving evidence and exact ownership. */
async function main( args ) {

	const engine = engineDirectory(); // Consent is checked before files, packages or launch.
	assertPerformanceEngine( engine );
	if ( ! args.config ) throw new Error( 'profile requires --config <single-plugin plan.json>.' );

	const configFile = allowedPath( path.resolve( ROOT, args.config ) );
	const config = configuration( JSON.parse( fs.readFileSync( configFile, 'utf8' ) ), args );
	const rawRetention = retention.policy( args['raw-retention'], engineSettings().rawRetention );
	const plugin = await prepareCandidate( { id: 'plugin', ...config.plugin, source: 'directory' } );
	const extension = await require( '../tools/profile-cli' ).artifact( engine, config.php, config.xdebugArtifact && allowedPath( path.resolve( ROOT, config.xdebugArtifact ) ) );
	const output = allowedPath( path.resolve( ROOT, args.output || `.local/playground/performance/profile-${Date.now()}-${crypto.randomUUID().slice( 0, 8 )}` ) );
	if ( fs.existsSync( output ) ) throw new Error( 'Use a new output directory; evidence is never overwritten.' );

	fs.mkdirSync( path.join( output, 'raw' ), { recursive: true } );
	fs.mkdirSync( path.join( output, 'responses' ) );
	const launchFile = path.join( output, 'profile-launch.json' );
	const launch = { engine, php: config.php, profiles: path.join( output, 'raw' ), artifact: extension, trigger: crypto.randomUUID(), id: crypto.randomUUID() };
	fs.writeFileSync( launchFile, JSON.stringify( launch, null, '\t' ), { flag: 'wx', mode: 0o600 } );
	const manifest = { kind: 'wp-hotspot-run-v1', startedAt: new Date().toISOString(), disclaimer, config, plugin, profiles: [], failures: [], environment: { type: 'Playground PHP-WASM', database: 'SQLite translation', node: process.version, concurrency: 1 } };
	const save = () => fs.writeFileSync( path.join( output, 'manifest.json' ), JSON.stringify( manifest, null, '\t' ) + '\n' );
	if ( rawRetention ) manifest.rawRetention = rawRetention;
	const parsed = [], used = new Set();
	let session;
	save();
	try {
		session = await launchSession( engine, plugin, config.wp, config.php, {
			output, configFile, round: 0, expectedWP: config.wp,
			config: { workers: 1, opcacheMode: 'auto', playgroundCli: path.join( ENGINE_ROOT, 'tools/profile-cli.js' ) },
			launchEnvironment: { WPR_HOTSPOT_CONFIG: launchFile },
			extraShims: [ path.join( ENGINE_ROOT, 'mu-plugin/wpr-hotspots.php' ) ],
		} );
		manifest.runtime = session.runtime;
		manifest.sourceSnapshot = session.sourceSnapshot;
		// Configuration is explicit for the profiled plugin, without competitive wizard presets.
		await control( session, { action: 'configure', options: config.options || {} } );
		const auth = await control( session, { action: 'login' } );
		const available = scenarios( session, { ...plugin, baseline: true } ).filter( item => config.scenarios.includes( item.id ) );
		if ( available.length !== config.scenarios.length || available.some( item => item.unavailable || item.save ) )
			throw new Error( 'Unknown, unavailable or save scenario. Use supported GET routes for profiling.' );

		for ( const scenario of available.filter( item => ! item.admin && item.expect.status === 200 ) )
			scenario.expect.contains = [ ...( scenario.expect.contains || [] ), ...( plugin.frontContains || [] ) ];

		const diagnostics = path.join( session.siteDirectory, 'wpr-performance-errors.log' );
		const startLog = fs.existsSync( diagnostics ) ? fs.statSync( diagnostics ).size : 0;
		for ( const scenario of available ) {
			await control( session, { action: 'frame', frame: scenario.frame } );
			for ( const phase of [ 'warmup', 'profile' ] ) {
				const count = 'warmup' === phase ? config.warmups : config.profiles;
				for ( let index = 0; index < count; ++index ) {
					const token = crypto.randomUUID();
					const cookies = [ ...( scenario.admin ? [ auth.cookies ] : [] ), ...( 'profile' === phase ? [ `XDEBUG_TRIGGER=${launch.trigger}` ] : [] ) ].filter( Boolean ).join( '; ' );
					const response = await request( new URL( scenario.path, session.run.url ).href, { headers: { 'X-WPR-Perf-Token': token, Cookie: cookies }, timeoutMs: config.timeoutMs } );
					const errors = validate( response, scenario, token, scenario.admin ? auth.data.userId : 0, session.run.url );
					const raw = response.headers['x-wpr-profile-file'];
					if ( response.headers['x-wpr-profile-available'] !== '1' ) errors.push( 'Xdebug profiler is unavailable in the actual runtime.' );
					if ( ( phase === 'profile' ) !== !! raw ) errors.push( 'Xdebug trigger state does not match this request.' );
					if ( used.has( raw ) ) errors.push( 'Profiler filename was reused.' );
					const row = { scenario: scenario.id, phase, index, requestToken: token, status: response.status, responseSha256: response.sha256, diagnosticHttpMs: response.elapsedMs, raw: raw || null, errors };
					fs.appendFileSync( path.join( output, 'requests.ndjson' ), JSON.stringify( row ) + '\n' );
					if ( errors.length ) throw new Error( `${scenario.id}: ${errors.join( '; ' )}` );

					if ( raw ) {
						used.add( raw );
						const profile = await completedProfile( launch.profiles, raw, `/wordpress/wp-content/plugins/${plugin.slug}` );
						fs.writeFileSync( path.join( output, 'responses', `${scenario.id}-${index}.html` ), response.body, { flag: 'wx' } );
						manifest.profiles.push( { scenario: scenario.id, index, raw: `raw/${raw}`, sha256: profile.sha256, requestToken: token, responseSha256: response.sha256 } );
						parsed.push( { label: `${scenario.id} #${index + 1}`, request: manifest.profiles.at( -1 ), raw: `raw/${raw}`, ...profile } );
						save();
					}
				}
			}
			if ( phpFingerprint( plugin ) !== plugin.phpSourceSha256 ) throw new Error( 'Plugin PHP source changed during profiling.' );
			if ( phpFingerprint( { ...plugin, directory: session.sourceSnapshot.directory } ) !== session.sourceSnapshot.phpSourceSha256 ) throw new Error( 'Executed plugin snapshot changed during profiling.' );

			const runtime = ( await control( session, { action: 'manifest' } ) ).data;
			if ( JSON.stringify( runtime.activePlugins ) !== JSON.stringify( session.runtime.activePlugins ) ) throw new Error( 'Plugin activation changed during profiling.' );
			if ( fs.existsSync( diagnostics ) && fs.statSync( diagnostics ).size !== startLog ) throw new Error( 'PHP/SQL diagnostics were written; profiles are not qualified.' );

			console.log( `${scenario.id}: ${config.profiles} validated Xdebug captures` );
		}
		manifest.complete = true;
	} catch ( error ) {
		manifest.failures.push( error.message );
		throw error;
	} finally {
		if ( session ) {
			try { stopSession( engine, session ); manifest.stopped = true; }
			catch ( error ) { manifest.failures.push( `Cleanup failed: ${error.message}; session: ${session.file}` ); manifest.complete = false; process.exitCode = 1; }
		}
		manifest.finishedAt = new Date().toISOString();
		save();
		if ( manifest.complete && ! manifest.failures.length ) report.write( output, parsed, reportMetadata( manifest, fs.readFileSync( path.join( output, 'manifest.json' ) ) ) );
	}
	if ( manifest.complete && ! manifest.failures.length ) {
		console.log( `Hotspots: ${path.join( output, 'report.html' )}` );
		if ( rawRetention === 'prune' ) {
			const result = retention.prune( { input: output, apply: true } );
			console.log( `Pruned ${result.removed} raw Cachegrind files (${result.removedBytes} bytes).` );
		}
	}

	return manifest;
}

/** Builds a fresh offline report from one Cachegrind file or saved run manifest. */
function offline( args ) {

	if ( ! args.input || ! args.output ) throw new Error( 'hotspots requires --input <profile-or-run> and --output <new-directory>.' );

	const input = allowedPath( path.resolve( ROOT, args.input ) ), output = allowedPath( path.resolve( ROOT, args.output ) );
	if ( fs.existsSync( output ) ) throw new Error( 'Use a new report directory.' );

	let profiles, metadata;
	if ( fs.statSync( input ).isDirectory() ) {
		const bytes = fs.readFileSync( allowedPath( path.join( input, 'manifest.json' ) ) );
		const manifest = JSON.parse( bytes );
		if ( manifest.kind !== 'wp-hotspot-run-v1' || ! manifest.complete || manifest.failures.length || ! manifest.profiles?.length ) throw new Error( 'Only a complete validated profiling run can be reported.' );

		profiles = manifest.profiles.map( item => {
			const file = allowedPath( path.resolve( input, item.raw ) );
			if ( path.relative( input, file ).startsWith( '..' ) ) throw new Error( 'Raw profile path escapes the run.' );
			if ( ! fs.existsSync( file ) && fs.existsSync( allowedPath( path.join( input, retention.JOURNAL ) ) ) )
				throw new Error( 'Raw profiles were pruned. Open the saved report.html or hotspots.json in the run directory.' );

			const parsed = cachegrind.read( file, `/wordpress/wp-content/plugins/${manifest.plugin.slug}` );
			if ( parsed.sha256 !== item.sha256 ) throw new Error( 'Raw profile hash changed.' );

			return { label: `${item.scenario} #${item.index + 1}`, request: item, ...parsed };
		} );
		metadata = reportMetadata( manifest, bytes );
	} else {
		profiles = [ { label: path.basename( input ), ...cachegrind.read( input, args['plugin-prefix'] || '' ) } ];
		metadata = { environment: null, runtime: null, plugin: null, requestValidation: 'Standalone Cachegrind import: request validation, execution environment and source identity were not recorded.' };
	}
	return report.write( output, profiles, { ...metadata, imported: true } );
}

/** Carries portable, non-credential provenance into every profiling export. */
function reportMetadata( manifest, bytes ) {

	const plugin = {};
	for ( const key of [ 'slug', 'mainFile', 'version', 'phpSourceSha256', 'mainFileSha256' ] )
		if ( undefined !== manifest.plugin?.[key] ) plugin[key] = manifest.plugin[key];

	return {
		environment: manifest.environment || null, runtime: manifest.runtime || null, plugin,
		sourceSnapshot: manifest.sourceSnapshot || null,
		sourceManifestSha256: crypto.createHash( 'sha256' ).update( bytes ).digest( 'hex' ),
		requestValidation: 'Completed run with recorded request validation and matching raw-profile hashes. Missing historical provenance fields remain unknown.',
	};
}

module.exports = { configuration, completedProfile, reportMetadata, main, offline };
