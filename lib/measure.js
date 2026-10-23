/**
 * Serial HTTP measurements and semantic response validation.
 */

const crypto = require( 'crypto' );
const http   = require( 'http' );
const https  = require( 'https' );

/**
 * Sends one request without following redirects or sharing cookies.
 * Timing ends at the final response byte, before hashing or validation.
 *
 * @param {string} url
 * @param {Object} options
 * @return {Promise<Object>}
 */
function request( url, options = {} ) {

	return new Promise( resolve => {
		const target = new URL( url );
		const client = 'https:' === target.protocol ? https : http;
		const start  = process.hrtime.bigint();
		let first    = null;
		let finished = false;
		const chunks = [];
		let bytes    = 0;
		const finish = data => {
			if ( finished ) return;

			finished = true;
			resolve( data );
		};
		const req = client.request(
			target,
			{
				method:  options.method || 'GET',
				agent:   options.agent,
				headers: {
					'Accept-Encoding': 'identity',
					...options.headers,
				},
			},
			res => {
				first = Number( process.hrtime.bigint() - start ) / 1e6;
				res.on( 'data', chunk => {
					bytes += chunk.length;
					if ( bytes > ( options.maxBytes || 16 * 1024 * 1024 ) ) {
						req.destroy( new Error( 'Response exceeds byte limit.' ) );
					} else {
						chunks.push( chunk );
					}
				} );
				res.on( 'end', () => {
					const elapsed = Number( process.hrtime.bigint() - start ) / 1e6;
					const body    = Buffer.concat( chunks );
					finish( {
						elapsedMs: elapsed,
						ttfbMs:    first,
						status:    res.statusCode,
						headers:   res.headers,
						bytes,
						body:      body.toString( 'utf8' ),
						sha256:    crypto.createHash( 'sha256' ).update( body ).digest( 'hex' ),
					} );
				} );
				res.on( 'error', err => req.destroy( err ) );
			},
		);
		const timer = setTimeout(
			() => req.destroy( new Error( 'Request deadline exceeded.' ) ),
			options.timeoutMs || 30000,
		);
		req.on( 'close', () => clearTimeout( timer ) );
		req.on( 'error', err => finish( {
			elapsedMs: Number( process.hrtime.bigint() - start ) / 1e6,
			ttfbMs:    first,
			status:    0,
			headers:   {},
			bytes,
			body:      '',
			sha256:    '',
			error:     err.message,
		} ) );
		if ( options.body ) req.write( options.body );

		req.end();
	} );
}

/**
 * Rejects failed, cached, misrouted, unauthenticated, or incomplete responses.
 *
 * @param {Object} response
 * @param {Object} scenario
 * @param {string} token
 * @param {number} userId
 * @param {string} origin
 * @return {string[]} Rejection reasons.
 */
function validate( response, scenario, token, userId, origin ) {

	const errors = [];
	const expect = scenario.expect;
	if ( response.error ) errors.push( response.error );
	if ( response.status !== expect.status )
		errors.push( `HTTP ${response.status}; expected ${expect.status}` );

	if ( response.headers['x-wpr-perf-token'] !== token )
		errors.push( 'Missing fresh PHP execution token' );

	if ( String( userId ) !== response.headers['x-wpr-perf-user'] )
		errors.push( 'Unexpected authentication state' );

	if ( expect.route && response.headers['x-wpr-perf-route'] !== expect.route )
		errors.push( `Unexpected WordPress route: ${response.headers['x-wpr-perf-route'] || 'missing'}` );

	if ( expect.type && ! new RegExp( expect.type, 'i' ).test( response.headers['content-type'] || '' ) )
		errors.push( 'Unexpected Content-Type' );

	if ( response.bytes < ( expect.minBytes ?? 100 ) )
		errors.push( 'Response too short' );

	for ( const pattern of expect.contains || [] ) {
		if ( ! new RegExp( pattern, 'i' ).test( response.body ) )
			errors.push( `Missing semantic marker: ${pattern}` );
	}
	for ( const pattern of expect.excludes || [] ) {
		if ( new RegExp( pattern, 'i' ).test( response.body ) )
			errors.push( `Unexpected semantic marker: ${pattern}` );
	}
	if ( /(?:Fatal error|Parse error|Uncaught (?:Error|Exception)|<b>Warning<\/b>|critical error on this website|Error establishing a database connection)/i.test( response.body ) )
		errors.push( 'PHP or WordPress error page' );

	if ( expect.location ) {
		const wanted = new URL( expect.location, origin ).href;
		const actual = new URL( response.headers.location || '/__missing_location__', origin ).href;
		if ( actual !== wanted ) errors.push( `Unexpected redirect: ${actual}` );
	}
	if ( scenario.saveTitle ) {
		try {
			const data = JSON.parse( response.body );
			if ( data.id !== scenario.postId || data.title?.raw !== scenario.saveTitle )
				errors.push( 'REST save did not return the requested edit' );
		} catch {
			errors.push( 'REST save returned invalid JSON' );
		}
	}

	return errors;
}

/**
 * Computes a quantile by linear interpolation, including even medians.
 *
 * @param {number[]} sorted
 * @param {number} fraction
 * @return {number|null}
 */
function quantile( sorted, fraction ) {

	if ( ! sorted.length ) return null;

	const index = ( sorted.length - 1 ) * fraction;
	const low   = Math.floor( index );
	const high  = Math.ceil( index );

	return sorted[low] + ( sorted[high] - sorted[low] ) * ( index - low );
}

/**
 * Summarizes accepted requests without deleting raw data or low observations.
 * An isolated minimum is retained but cannot lead an unqualified comparison.
 *
 * @param {Object[]} rows
 * @param {Object} settings
 * @return {Object}
 */
function statistics( rows, settings = {} ) {

	const values = rows.filter( row => row.valid ).map( row => row.elapsedMs ).sort( ( a, b ) => a - b );
	const median = quantile( values, 0.5 );
	const mean   = values.length ? values.reduce( ( a, b ) => a + b, 0 ) / values.length : null;
	const reference = 'mean' === settings.outlierReference ? mean : median;
	const cutoff = null === reference ? null : reference * ( 1 + ( settings.outlierFraction ?? 0.8 ) );
	const kept   = values.filter( value => value <= cutoff );
	const fastest = values.slice( 0, settings.fastestCount || 1000 );
	const min    = values[0] ?? null;
	// Require a second nearby observation only for a conspicuously low minimum.
	const suspect = values.length > 1 && min < median * 0.5 && values[1] > min * 1.1;

	return {
		attempted:        rows.length,
		valid:            values.length,
		invalid:          rows.length - values.length,
		minimumMs:        min,
		leadingMs:        suspect ? null : min,
		minimumSuspect:   suspect,
		medianMs:         median,
		meanMs:           mean,
		p95Ms:            quantile( values, 0.95 ),
		outlierCutoffMs:  cutoff,
		highOutliers:     values.length - kept.length,
		trimmedMeanMs:    kept.length ? kept.reduce( ( a, b ) => a + b, 0 ) / kept.length : null,
		trimmedMedianMs:  quantile( kept, 0.5 ),
		fastestCount:     fastest.length,
		fastestMeanMs:    fastest.length ? fastest.reduce( ( a, b ) => a + b, 0 ) / fastest.length : null,
	};
}

module.exports = { request, validate, quantile, statistics };
