/** Copies selected public plugin mounts without sharing writable source inodes. */
const fs = require( 'fs' );
const path = require( 'path' );
const { allowedPath, phpFingerprint } = require( './engine' );

/** Tests containment across drives and platforms without following a link. */
function within( parent, child ) {
	const relative = path.relative( parent, child );
	return ! path.isAbsolute( relative ) && relative !== '..' && ! relative.startsWith( '..' + path.sep );
}

/**
 * Materializes independent files before any plugin activation. A source drift
 * during copying rejects the snapshot; no original mount reaches WordPress.
 */
function snapshotPlugin( candidate, destination ) {

	const source = allowedPath( candidate.directory );
	const target = allowedPath( destination );
	for ( const mount of candidate.mounts ) {
		const input = allowedPath( path.resolve( source, mount ) );
		if ( ! within( source, input ) || within( input, target ) ) throw new Error( 'Snapshot must stay outside the selected source mounts.' );
	}
	if ( phpFingerprint( candidate ) !== candidate.phpSourceSha256 ) throw new Error( 'Plugin source changed before snapshot.' );

	fs.mkdirSync( target, { recursive: false } );
	const copied = new Set();
	const copy = relative => {
		const input = allowedPath( path.join( source, relative ) );
		if ( copied.has( input ) ) return;

		copied.add( input );
		const output = allowedPath( path.join( target, relative ) );
		const stat = fs.lstatSync( input );
		if ( stat.isSymbolicLink() ) throw new Error( 'Plugin snapshots do not follow symbolic links.' );

		if ( stat.isDirectory() ) {
			fs.mkdirSync( output, { recursive: true } );
			for ( const name of fs.readdirSync( input ) ) {
				if ( name.startsWith( '.' ) || name === 'node_modules' ) continue;

				copy( path.join( relative, name ) );
			}
		} else if ( stat.isFile() ) {
			fs.mkdirSync( path.dirname( output ), { recursive: true } );
			// copyFile creates a new inode; hardlinks would expose the working tree.
			fs.copyFileSync( input, output, fs.constants.COPYFILE_EXCL );
		} else throw new Error( 'Unsupported plugin source entry.' );
	};
	for ( const mount of candidate.mounts ) copy( mount );

	const snapshot = { ...candidate, directory: target };
	if ( phpFingerprint( candidate ) !== candidate.phpSourceSha256 || phpFingerprint( snapshot ) !== candidate.phpSourceSha256 )
		throw new Error( 'Plugin source changed while creating the snapshot.' );

	return snapshot;
}

module.exports = { snapshotPlugin, within };
