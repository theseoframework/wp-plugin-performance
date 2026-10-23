/**
 * Local regression-engine integration, pinned packages, and session ownership.
 */

const crypto = require( 'crypto' );
const fs     = require( 'fs' );
const os     = require( 'os' );
const path   = require( 'path' );
const { spawnSync } = require( 'child_process' );

const ENGINE_ROOT = path.resolve( __dirname, '..' );
const SKILL       = ENGINE_ROOT;
const ROOT        = allowedPath( optionValue( 'root' ) || process.env.WP_PLUGIN_PERFORMANCE_ROOT || process.cwd() );

/**
 * Reads an early path option before the benchmark module is loaded.
 * The last occurrence wins, matching the main argument parser.
 *
 * @param {string} name
 * @return {string|undefined}
 */
function optionValue( name ) {

	const argv = process.argv.slice( 2 );
	let value;
	for ( let index = 0; index < argv.length; ++index ) {
		if ( argv[index].startsWith( `--${name}=` ) ) {
			value = argv[index].slice( name.length + 3 );
			if ( ! value ) throw new Error( `--${name} requires a path.` );
		} else if ( argv[index] === `--${name}` ) {
			value = argv[++index];
			if ( ! value || value.startsWith( '--' ) )
				throw new Error( `--${name} requires a path.` );
		}
	}

	return value;
}

/**
 * Reads consumer-local engine locations without storing machine paths publicly.
 *
 * @return {Object}
 */
function engineSettings() {

	const file = allowedPath( path.join( ROOT, '.local/playground/performance/engine.json' ) );

	return fs.existsSync( file ) ? JSON.parse( fs.readFileSync( file, 'utf8' ) ) : {};
}

/**
 * Reads the user's existing consumer-specific Playground permission.
 * Reading documentation and offline tests do not create or imply consent.
 *
 * @param {string} root
 * @return {Boolean}
 */
function readPermission( root = ROOT ) {

	const permission = allowedPath( path.join( root, '.local/playground/permission.txt' ) );
	if ( ! fs.existsSync( permission ) )
		throw new Error( 'Missing .local/playground/permission.txt. Ask the user for PLAYGROUND=True|False before installation or live tests.' );

	const text = fs.readFileSync( permission, 'utf8' ).trim();
	if ( ! [ 'PLAYGROUND=True', 'PLAYGROUND=False' ].includes( text ) )
		throw new Error( 'permission.txt must contain exactly PLAYGROUND=True or PLAYGROUND=False.' );

	return 'PLAYGROUND=True' === text;
}

/**
 * Enforces the private Cursor boundary, including symlink targets.
 *
 * @param {string} file
 * @return {string}
 */
function allowedPath( file ) {

	const absolute = path.resolve( file );
	if ( /(?:^|[\\/])\.local[\\/]\.cursor(?:[\\/]|$)/i.test( absolute ) )
		throw new Error( 'The private Cursor directory is outside this workflow.' );

	let existing = absolute;
	while ( ! fs.existsSync( existing ) && path.dirname( existing ) !== existing )
		existing = path.dirname( existing );

	const real = fs.realpathSync( existing );
	if ( /(?:^|[\\/])\.local[\\/]\.cursor(?:[\\/]|$)/i.test( real ) )
		throw new Error( 'A symlink resolves into the private Cursor directory.' );

	return absolute;
}

/**
 * Reads the existing permission flag and finds the installed engine.
 *
 * @return {string}
 */
function engineDirectory() {

	if ( ! readPermission() )
		throw new Error( 'Playground skipped: PLAYGROUND=False. Do not install or launch.' );

	const directory = allowedPath( path.resolve(
		ROOT,
		optionValue( 'regression-dir' )
		|| process.env.WP_PLUGIN_REGRESSION_DIR
		|| engineSettings().regressionDirectory
		|| path.join( ROOT, '.local/playground/wp-plugin-regression' ),
	) );
	if ( ! fs.existsSync( path.join( directory, 'run.js' ) ) )
		throw new Error( 'wp-plugin-regression is missing. Supply --regression-dir, WP_PLUGIN_REGRESSION_DIR, or the consumer-local engine.json. Never acquire it without user permission.' );

	return directory;
}

/**
 * Rejects launchers that silently ignore the required startup-profile flags.
 * Metadata is checked before preparing packages or starting WordPress.
 *
 * @param {string} directory
 * @return {number}
 */
function assertPerformanceEngine( directory ) {

	const file = allowedPath( path.join( directory, 'package.json' ) );
	const api = fs.existsSync( file ) ? JSON.parse( fs.readFileSync( file, 'utf8' ) ).wpPluginPerformanceApi : undefined;
	if ( 1 !== api )
		throw new Error( 'Update wp-plugin-regression: this runner requires wpPluginPerformanceApi: 1, with per-site OPcache profiles and CLI overrides. Publish/install the matching regression engine before benchmarking.' );

	return api;
}

/**
 * Runs an engine command, preserving diagnostics and propagating spawn failures.
 *
 * @param {string} engine
 * @param {string[]} args
 * @return {string}
 */
function engineCommand( engine, args, environment = {} ) {

	const result = spawnSync(
		process.execPath,
		[ path.join( engine, 'run.js' ), ...args, '--root', ROOT ],
		{ cwd: engine, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...environment } },
	);
	if ( result.error || result.status )
		throw new Error( result.error?.message || result.stderr || result.stdout || `Engine exited ${result.status}` );

	return result.stdout;
}

/**
 * Downloads a public package or version manifest with a finite deadline.
 *
 * @param {string} url
 * @param {Boolean} json
 * @return {Promise<Object|Buffer>}
 */
async function download( url, json = false ) {

	const response = await fetch( url, { signal: AbortSignal.timeout( 120000 ) } );
	if ( ! response.ok ) throw new Error( `Download HTTP ${response.status}: ${url}` );

	return json ? response.json() : Buffer.from( await response.arrayBuffer() );
}

/**
 * Resolves the newest stable PHP branch supported by this installed Playground.
 * Candidate phpMax values must have an evidence-backed explanation in the plan.
 *
 * @param {string} engine
 * @param {Object} config
 * @return {Promise<Object>}
 */
async function resolvePHP( engine, config ) {

	const runtime = config.playgroundCli ? path.dirname( allowedPath( config.playgroundCli ) ) : engine;
	const universal = require( require.resolve( '@php-wasm/universal', { paths: [ runtime ] } ) );
	const supported = universal.SupportedPHPVersions.filter( item => /^\d+\.\d+$/.test( item ) );
	if ( ! config.php.includes( 'auto' ) ) {
		for ( const version of config.php ) {
			if ( ! supported.includes( version ) )
				throw new Error( `PHP ${version} is unavailable in the installed Playground.` );
		}

		return { versions: config.php, supported, reason: 'Explicit matrix', checkedAt: new Date().toISOString() };
	}
	const source  = 'https://www.php.net/releases/index.php?json';
	const releases = Object.values( await download( source, true ) ).filter(
		item => /^\d+\.\d+\.\d+$/.test( item.version ) && item.supported_versions?.length,
	).sort( ( a, b ) => compareVersion( b.version, a.version ) );
	const release = releases[0] || {};
	const stable  = releases.flatMap( item => item.supported_versions );
	if ( ! Array.isArray( stable ) || ! /^\d+\.\d+\.\d+$/.test( release.version ) )
		throw new Error( 'Cannot establish stable PHP versions. Specify an explicit verified matrix.' );

	const ceilings = config.candidates.filter( item => item.phpMax );
	for ( const item of ceilings ) {
		if ( ! /^\d+\.\d+$/.test( item.phpMax ) || ! item.phpMaxReason )
			throw new Error( `${item.id}: phpMax needs a branch, reason, and source.` );
	}
	const choices = supported.filter(
		version => stable.includes( version ) && ceilings.every( item => compareVersion( version, item.phpMax ) <= 0 ),
	).sort( ( a, b ) => compareVersion( b, a ) );
	if ( ! choices.length ) throw new Error( 'No stable PHP branch satisfies this comparison plan.' );

	const versions = [ ...new Set( config.php.map( item => 'auto' === item ? choices[0] : item ) ) ];
	for ( const version of versions ) {
		if ( ! supported.includes( version ) ) throw new Error( `PHP ${version} is unavailable in the installed Playground.` );
	}

	return {
		versions,
		latestStable: release.version,
		selected:     choices[0],
		supported,
		source,
		reason:       'Newest stable branch available in Playground and within documented comparison ceilings',
		ceilings:     ceilings.map( item => ( { id: item.id, max: item.phpMax, reason: item.phpMaxReason } ) ),
		checkedAt:    new Date().toISOString(),
	};
}

/**
 * Compares numeric release components, ignoring suffixes.
 *
 * @param {string} left
 * @param {string} right
 * @return {number}
 */
function compareVersion( left, right ) {

	const a = left.split( '.' ).map( item => parseInt( item, 10 ) || 0 );
	const b = right.split( '.' ).map( item => parseInt( item, 10 ) || 0 );
	for ( let index = 0; index < Math.max( a.length, b.length ); ++index ) {
		if ( ( a[index] || 0 ) !== ( b[index] || 0 ) )
			return ( a[index] || 0 ) - ( b[index] || 0 );
	}

	return 0;
}

/**
 * Hashes public PHP source under declared mounts, without opening asset files.
 * Hidden trees and links are excluded from traversal; symlinked mounts fail.
 *
 * @param {Object} candidate
 * @return {string}
 */
function phpFingerprint( candidate ) {

	const files = [];
	const visit = relative => {
		const full = allowedPath( path.join( candidate.directory, relative ) );
		const stat = fs.lstatSync( full );
		if ( stat.isSymbolicLink() ) throw new Error( 'Use a materialized plugin tree instead of symlinked benchmark source.' );

		if ( stat.isDirectory() ) {
			for ( const name of fs.readdirSync( full ) ) {
				if ( name.startsWith( '.' ) || 'node_modules' === name ) continue;

				visit( path.join( relative, name ) );
			}
		} else if ( /\.php$/i.test( relative ) ) {
			files.push( relative.replace( /\\/g, '/' ) );
		}
	};
	for ( const mount of candidate.mounts ) visit( mount );

	const hash = crypto.createHash( 'sha256' );
	for ( const file of [ ...new Set( files ) ].sort() ) {
		hash.update( file + '\0' );
		hash.update( fs.readFileSync( allowedPath( path.join( candidate.directory, file ) ) ) );
		hash.update( '\0' );
	}

	return hash.digest( 'hex' );
}

/**
 * Prepares one directory or pinned wordpress.org package outside the repository.
 * Main PHP headers and archive hashes identify releases without reading assets.
 *
 * @param {Object} candidate
 * @return {Promise<Object>}
 */
async function prepareCandidate( candidate ) {

	if ( ! /^[a-z0-9-]+$/.test( candidate.slug ) ) throw new Error( 'Invalid plugin slug.' );

	let directory = allowedPath( path.resolve( ROOT, candidate.path || '.' ) );
	let archiveSha256 = null;
	let packageUrl    = null;
	let resolved      = candidate.version;
	if ( 'wporg' === candidate.source ) {
		if ( ! resolved || 'latest' === resolved ) {
			const info = await download(
				`https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=${candidate.slug}`,
				true,
			);
			resolved = info.version;
		}
		if ( ! /^[0-9][a-zA-Z0-9._-]*$/.test( resolved ) )
			throw new Error( 'A pinned plugin version is required.' );

		const cache = allowedPath( path.join( os.homedir(), '.wordpress-playground/performance/packages', candidate.slug, resolved ) );
		const zip   = path.join( cache, 'plugin.zip' );
		fs.mkdirSync( cache, { recursive: true } );
		packageUrl = `https://downloads.wordpress.org/plugin/${candidate.slug}.${resolved}.zip`;
		if ( ! fs.existsSync( zip ) ) fs.writeFileSync( zip, await download( packageUrl ) );

		archiveSha256 = crypto.createHash( 'sha256' ).update( fs.readFileSync( zip ) ).digest( 'hex' );
		const extract = path.join( cache, 'source' );
		directory = path.join( extract, candidate.slug );
		if ( ! fs.existsSync( path.join( directory, candidate.mainFile ) ) ) {
			const args = 'win32' === process.platform
				? [ '-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace( /'/g, "''" )}' -DestinationPath '${extract.replace( /'/g, "''" )}' -Force` ]
				: [ '-o', zip, '-d', extract ];
			const result = spawnSync(
				'win32' === process.platform ? 'powershell.exe' : 'unzip',
				args,
				{ encoding: 'utf8', windowsHide: true },
			);
			if ( result.error || result.status )
				throw new Error( result.error?.message || result.stderr || 'Plugin extraction failed.' );
		}
	}
	const mainFile = allowedPath( path.join( directory, candidate.mainFile ) );
	if ( path.relative( directory, mainFile ).startsWith( '..' ) || ! /\.php$/i.test( mainFile ) )
		throw new Error( 'mainFile must be PHP within the plugin directory.' );

	const header  = fs.readFileSync( mainFile, 'utf8' );
	const version = /^\s*\*?\s*Version:\s*(.+)$/im.exec( header )?.[1]?.trim();
	if ( ! version ) throw new Error( `${candidate.id}: missing plugin Version header.` );

	if ( resolved && resolved !== version )
		throw new Error( `${candidate.id}: expected plugin ${resolved}, found ${version}.` );

	const mounts = candidate.mounts || fs.readdirSync( directory ).filter(
		item => ! item.startsWith( '.' ) && ! [ 'node_modules', 'tests' ].includes( item ),
	);
	for ( const mount of mounts ) {
		const full = allowedPath( path.join( directory, mount ) );
		if ( path.relative( directory, full ).startsWith( '..' ) || mount.split( /[\\/]/ ).some( part => part.startsWith( '.' ) ) )
			throw new Error( 'Plugin mounts must stay within public plugin content.' );
	}

	const prepared = {
		...candidate,
		directory,
		mounts,
		version,
		packageUrl,
		archiveSha256,
		mainFileSha256: crypto.createHash( 'sha256' ).update( header ).digest( 'hex' ),
		requiresPHP:    /^\s*\*?\s*Requires PHP:\s*(.+)$/im.exec( header )?.[1]?.trim() || null,
		requiresWP:     /^\s*\*?\s*Requires at least:\s*(.+)$/im.exec( header )?.[1]?.trim() || null,
	};
	prepared.phpSourceSha256 = phpFingerprint( prepared );
	for ( const field of [ 'archiveSha256', 'mainFileSha256', 'phpSourceSha256' ] ) {
		if ( candidate[field] && candidate[field] !== prepared[field] )
			throw new Error( `${candidate.id}: pinned ${field} does not match the installed package.` );
	}

	return prepared;
}

/**
 * Stops only the exact process recorded by this benchmark session.
 *
 * @param {string} engine
 * @param {Object} session
 */
function stopSession( engine, session ) {

	const { readRuns } = require( path.join( engine, 'lib/state.js' ) );
	const owned = readRuns().find(
		run => run.pid === session.run.pid && run.site === session.run.site && run.root === ROOT && run.url === session.run.url,
	);
	if ( owned ) engineCommand( engine, [ 'stop', `--port=${owned.port}` ] );
}

module.exports = {
	ROOT, SKILL, ENGINE_ROOT, optionValue, engineSettings, readPermission,
	allowedPath, engineDirectory, assertPerformanceEngine, engineCommand, download,
	resolvePHP, compareVersion, phpFingerprint, prepareCandidate, stopSession,
};
