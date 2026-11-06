/** Retention for raw Xdebug captures after a verified report has been saved. */
const crypto = require( 'crypto' );
const fs = require( 'fs' );
const path = require( 'path' );
const { isDeepStrictEqual } = require( 'util' );
const { ROOT, allowedPath } = require( './engine' );
const { embedJSON } = require( './hotspot-report' );

const JOURNAL = 'raw-prune.json';

/** An unset preference keeps evidence and does not pin the run. */
function policy( override, configured ) {

	const value = override === undefined ? configured : override;
	if ( value !== undefined && ! [ 'keep', 'prune' ].includes( value ) )
		throw new Error( 'rawRetention and --raw-retention must be keep or prune.' );

	return value;
}

function sha256( data ) {
	return crypto.createHash( 'sha256' ).update( data ).digest( 'hex' );
}

/** Checks entry type before a file is opened or removed. */
function entry( file, directory = false ) {

	const info = fs.lstatSync( allowedPath( file ), { throwIfNoEntry: false } );
	if ( info && ( directory ? ! info.isDirectory() : ! info.isFile() ) )
		throw new Error( 'Pruning requires regular files and directories: ' + file );

	return info;
}

function read( file ) {
	if ( ! entry( file ) ) throw new Error( 'Missing retention evidence: ' + file );

	return fs.readFileSync( file );
}

/** Verifies that the saved viewer and data refer to this complete capture. */
function verifyReport( run, manifest, digest ) {

	const reportBytes = read( path.join( run, 'hotspots.json' ) );
	const report = JSON.parse( reportBytes );
	const provenance = JSON.parse( read( path.join( run, 'provenance.json' ) ) );
	if ( report.kind !== 'wp-hotspot-report-v1' || report.sourceManifestSha256 !== digest
		|| provenance.sourceManifestSha256 !== digest
		|| ! Array.isArray( report.profiles ) || report.profiles.length !== manifest.profiles.length
		|| ! manifest.profiles.every( ( item, index ) => {
			const saved = report.profiles[index];
			return saved?.sha256 === item.sha256 && isDeepStrictEqual( saved.request, item )
				&& Array.isArray( saved.nodes ) && saved.nodes.length && Array.isArray( saved.edges );
		} ) )
		throw new Error( 'Saved report does not match the run manifest.' );

	const embedded = embedJSON( reportBytes.toString( 'utf8' ).trimEnd() );
	const html = read( path.join( run, 'report.html' ) ).toString( 'utf8' );
	if ( ! html.includes( '<script id="data" type="application/json">' + embedded + '</script>' ) || ! html.endsWith( '</html>' ) )
		throw new Error( 'Saved HTML is incomplete or differs from the hotspot data.' );

	for ( const name of [ 'functions.csv', 'edges.csv', 'report.md' ] )
		if ( ! entry( path.join( run, name ) )?.size ) throw new Error( 'Missing retention evidence: ' + name );
}

/** Preflights every file in one run before removing any of them. */
function prune( args ) {

	if ( typeof args.input !== 'string' || ! args.input )
		throw new Error( 'prune requires --input <run-directory>.' );
	if ( args.apply !== undefined && args.apply !== true )
		throw new Error( 'Use --apply by itself to remove the previewed files.' );

	const run = allowedPath( path.resolve( ROOT, args.input ) );
	const runInfo = entry( run, true );
	if ( ! runInfo ) throw new Error( 'Missing run directory: ' + run );
	const raw = path.join( run, 'raw' );
	const rawInfo = entry( raw, true );
	if ( ! rawInfo ) throw new Error( 'Missing raw profile directory.' );
	const bytes = read( path.join( run, 'manifest.json' ) );
	const digest = sha256( bytes );
	const manifest = JSON.parse( bytes );
	if ( manifest.kind !== 'wp-hotspot-run-v1' || manifest.complete !== true || manifest.stopped !== true
		|| ! Array.isArray( manifest.failures ) || manifest.failures.length
		|| ! Array.isArray( manifest.profiles ) || ! manifest.profiles.length )
		throw new Error( 'Pruning requires a complete, stopped profiling run without failures.' );
	if ( manifest.rawRetention === 'keep' ) throw new Error( 'This run is marked to keep raw profiles.' );

	verifyReport( run, manifest, digest );

	const journal = path.join( run, JOURNAL );
	const prior = entry( journal ) && JSON.parse( read( journal ) );
	if ( prior && ( prior.sourceManifestSha256 !== digest || prior.kind !== 'wp-hotspot-prune-v1'
		|| ! Array.isArray( prior.files ) || prior.files.length !== manifest.profiles.length ) )
		throw new Error( 'Cleanup journal does not match the run manifest.' );

	const seen = new Set();
	const files = manifest.profiles.map( ( item, index ) => {
		if ( ! /^raw\/cachegrind\.[a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test( item.raw || '' ) || ! /^[0-9a-f]{64}$/.test( item.sha256 || '' )
			|| seen.has( item.raw.toLowerCase() ) )
			throw new Error( 'Unsafe or duplicate raw profile in the run manifest.' );

		seen.add( item.raw.toLowerCase() );
		const file = path.join( run, item.raw );
		const info = entry( file );
		const recorded = prior?.files[index];
		if ( prior && ( recorded?.raw !== item.raw || recorded.sha256 !== item.sha256 || ! Number.isSafeInteger( recorded.bytes ) || recorded.bytes < 1 ) )
			throw new Error( 'Cleanup journal does not match the listed raw profiles.' );
		if ( ! info && ! recorded ) throw new Error( 'A listed raw profile is missing: ' + item.raw );
		if ( info && ( ! info.size || info.size > 128 * 1024 * 1024 || sha256( read( file ) ) !== item.sha256 ) )
			throw new Error( 'Raw profile hash changed or the file is oversized: ' + item.raw );

		return { file, info, raw: item.raw, sha256: item.sha256, bytes: info?.size ?? recorded.bytes };
	} );
	const pending = files.filter( item => item.info );
	const result = { run, files: pending.length, bytes: pending.reduce( ( sum, item ) => sum + item.bytes, 0 ), removed: 0, removedBytes: 0, alreadyPruned: files.length - pending.length };
	if ( ! args.apply || ! pending.length ) return result;

	// Record the verified deletion set first so an interrupted cleanup can resume.
	if ( ! prior ) fs.writeFileSync( journal, JSON.stringify( {
		kind: 'wp-hotspot-prune-v1', sourceManifestSha256: digest, startedAt: new Date().toISOString(),
		files: files.map( ( { raw, sha256, bytes } ) => ( { raw, sha256, bytes } ) ),
	}, null, '\t' ) + '\n', { flag: 'wx', flush: true } );

	for ( const item of pending ) {
		for ( const [ directory, original ] of [ [ run, runInfo ], [ raw, rawInfo ] ] ) {
			const current = entry( directory, true );
			if ( ! current || current.dev !== original.dev || current.ino !== original.ino )
				throw new Error( 'Run directory changed after preview: ' + directory );
		}
		const now = entry( item.file );
		if ( ! now ) continue;
		if ( [ 'dev', 'ino', 'size', 'mtimeMs', 'ctimeMs' ].some( key => now[key] !== item.info[key] ) )
			throw new Error( 'Raw profile changed after preview: ' + item.raw );

		fs.unlinkSync( item.file );
		result.removed++;
		result.removedBytes += item.bytes;
	}
	return result;
}

module.exports = { JOURNAL, policy, prune };
