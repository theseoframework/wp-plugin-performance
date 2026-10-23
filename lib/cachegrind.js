/**
 * Reads Xdebug Cachegrind costs without inferring native execution time.
 * Copyright (C) 2026 Sybre Waaijer, CyberWire B.V.
 * Licensed under the GNU General Public License version 3.
 */
const fs = require( 'fs' );
const crypto = require( 'crypto' );

/** Resolves compressed names, including names first defined after an edge. */
function name( token, table ) {

	const match = /^\((\d+)\)(?: (.*))?$/.exec( token );
	if ( ! match ) return token;

	if ( undefined !== match[2] ) {
		if ( table.has( match[1] ) && table.get( match[1] ) !== match[2] ) throw new Error( 'Conflicting Cachegrind name definition.' );

		table.set( match[1], match[2] );
	}

	return { id: match[1], table };
}

/** Resolves a name after every definition has been collected. */
function resolve( value ) {

	if ( 'string' === typeof value ) return value;

	if ( ! value || ! value.table.has( value.id ) ) throw new Error( 'Undefined Cachegrind name reference.' );

	return value.table.get( value.id );
}

/**
 * Parses one complete Xdebug profile. Edge costs already include descendants.
 * Function calls count incoming edge entries, including generator resumptions.
 * @param {string} text Uncompressed Cachegrind text.
 * @param {string} pluginPrefix Exact virtual plugin directory, or empty.
 * @return {Object}
 */
function parse( text, pluginPrefix = '' ) {

	const files = new Map(), functions = new Map(), records = [];
	let file, fn, childFile, childFn, edge = null, events, summary;
	let creator = '', command = '', parts = 0;
	for ( const line of text.split( /\r?\n/ ) ) {
		if ( line.startsWith( 'creator: ' ) ) creator = line.slice( 9 );
		else if ( line.startsWith( 'cmd: ' ) ) command = line.slice( 5 );
		else if ( line.startsWith( 'part:' ) ) ++parts;
		else if ( line.startsWith( 'positions:' ) && 'positions: line' !== line ) throw new Error( 'Only line-position Xdebug profiles are supported.' );
		else if ( line.startsWith( 'events: ' ) ) events = line.slice( 8 ).trim().split( /\s+/ );
		else if ( line.startsWith( 'summary: ' ) ) {
			if ( summary ) throw new Error( 'Multiple Cachegrind summaries are unsupported.' );

			summary = line.slice( 9 ).trim().split( /\s+/ ).map( Number );
		} else if ( line.startsWith( 'fl=' ) ) file = name( line.slice( 3 ), files );
		else if ( line.startsWith( 'fn=' ) ) {
			fn = name( line.slice( 3 ), functions );
			childFile = childFn = undefined;
		} else if ( line.startsWith( 'cfl=' ) ) childFile = name( line.slice( 4 ), files );
		else if ( line.startsWith( 'cfn=' ) ) childFn = name( line.slice( 4 ), functions );
		else if ( line.startsWith( 'calls=' ) ) {
			const calls = Number( line.slice( 6 ).split( /\s+/ )[0] );
			if ( edge || ! Number.isSafeInteger( calls ) || calls < 0 || ! childFn ) throw new Error( 'Malformed Cachegrind call edge.' );

			edge = { file: childFile || file, fn: childFn, calls };
		} else if ( /^[+\-*\d]/.test( line ) ) {
			const [ position, ...values ] = line.trim().split( /\s+/ );
			const costs = values.map( Number );
			if ( ! file || ! fn || ! events || costs.length !== events.length || costs.some( value => ! Number.isSafeInteger( value ) ) )
				throw new Error( 'Malformed Cachegrind cost row.' );

			records.push( { file, fn, edge, position, costs } );
			edge = null;
		}
	}
	if ( ! /^xdebug\b/i.test( creator ) || ! events || ! summary || edge || parts > 1 || ! records.length )
		throw new Error( 'Expected one complete, uncompressed Xdebug Cachegrind profile with a summary.' );

	const units = { 'Time_(10ns)': 0.00001, 'Time_(ns)': 0.000001, 'Time_(us)': 0.001, 'Time_(ms)': 1 };
	const timeIndex = events.findIndex( event => undefined !== units[event] );
	if ( timeIndex < 0 || summary.length !== events.length || summary.some( value => ! Number.isSafeInteger( value ) || value < 0 ) )
		throw new Error( 'Unsupported Cachegrind events or summary.' );

	const factor = units[events[timeIndex]], nodes = new Map(), edges = new Map();
	const prefix = pluginPrefix.replace( /\\/g, '/' ).replace( /\/$/, '' );
	const node = ( rawFile, rawFn ) => {
		const fileName = resolve( rawFile ), functionName = resolve( rawFn );
		const key = JSON.stringify( [ fileName, functionName ] );
		if ( ! nodes.has( key ) ) nodes.set( key, {
			key, file: fileName, function: functionName, selfMs: 0, inclusiveMs: 0, calls: 0,
			plugin: !! prefix && ( fileName.replace( /\\/g, '/' ) === prefix || fileName.replace( /\\/g, '/' ).startsWith( prefix + '/' ) ),
		} );

		return nodes.get( key );
	};
	for ( const record of records ) {
		const parent = node( record.file, record.fn );
		const time = record.costs[timeIndex] * factor;
		if ( time < 0 ) throw new Error( 'Negative Cachegrind time cost.' );

		if ( record.edge ) {
			const child = node( record.edge.file, record.edge.fn );
			const key = JSON.stringify( [ parent.key, child.key ] );
			if ( ! edges.has( key ) ) edges.set( key, { caller: parent.key, callee: child.key, calls: 0, inclusiveMs: 0 } );

			const item = edges.get( key );
			item.calls += record.edge.calls;
			item.inclusiveMs += time;
			parent.inclusiveMs += time;
			child.calls += record.edge.calls;
		} else {
			parent.selfMs += time;
			parent.inclusiveMs += time;
		}
	}
	return {
		creator, command, events, totalMs: summary[timeIndex] * factor,
		pluginPrefix: prefix, sha256: crypto.createHash( 'sha256' ).update( text ).digest( 'hex' ),
		nodes: [ ...nodes.values() ], edges: [ ...edges.values() ],
	};
}

/** Reads a profile without mutating the original evidence. */
function read( file, prefix ) { return parse( fs.readFileSync( file, 'utf8' ), prefix ); }

module.exports = { parse, read };
