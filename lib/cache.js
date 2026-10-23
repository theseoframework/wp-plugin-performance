/**
 * Evidence of cache activity between untimed boundary probes. Configuration,
 * startup allocation and a warm script count alone do not prove reuse or JIT.
 */

/**
 * Assesses the observed worker only. The final probe itself loads PHP files;
 * require hit growth beyond that included-file allowance. This is diagnostic;
 * strict attribution also needs control-only hit-cost calibration.
 *
 * @param {Object} before
 * @param {Object} after
 * @return {Object}
 */
function assessCache( before, after ) {

	const result = { status: 'not-recorded', hits: null, misses: null, probeFileBound: null, jitCodeGrowthBytes: null };
	if ( ! before || ! after || undefined === before.running || undefined === after.running )
		return result;

	if ( ! before.running || ! after.running ) {
		result.status = '1' === before.fileOnly || '1' === after.fileOnly ? 'file-cache-unobservable' : 'inactive';

		return result;
	}
	if ( [ 'pid', 'startTime', 'lastRestartTime' ].some( key => null == before[key] || before[key] !== after[key] ) ) {
		result.status = 'instance-changed';

		return result;
	}
	if ( [ 'hits', 'misses', 'oomRestarts', 'hashRestarts', 'manualRestarts' ].some( key =>
		! Number.isFinite( before[key] ) || ! Number.isFinite( after[key] ) || after[key] < before[key]
		|| ( key.endsWith( 'Restarts' ) && before[key] !== after[key] )
	) ) {
		result.status = 'counter-reset';

		return result;
	}
	result.hits = after.hits - before.hits;
	result.misses = after.misses - before.misses;
	result.probeFileBound = Number.isInteger( after.includedScripts ) && after.includedScripts >= 0 ? after.includedScripts : null;
	result.status = null != result.probeFileBound && result.hits > result.probeFileBound ? 'observed-reuse' : 'no-confirmed-reuse';
	if ( before.jitStatus?.on && after.jitStatus?.on && [ before.jitStatus.buffer_free, after.jitStatus.buffer_free ].every( Number.isFinite ) )
		result.jitCodeGrowthBytes = after.jitStatus.buffer_free <= before.jitStatus.buffer_free
			? before.jitStatus.buffer_free - after.jitStatus.buffer_free : null;

	return result;
}

/**
 * Stops once the configured pool has been seen, with a finite cap for alternate
 * schedulers. These control requests run outside HTTP timing and CPU counters.
 *
 * @param {Function} read
 * @param {number} workers
 * @param {Object[]} initial
 * @return {Promise<Object[]>}
 */
async function collectCacheSnapshots( read, workers, initial = [] ) {

	if ( ! Number.isInteger( workers ) || workers < 1 ) throw new Error( 'Invalid cache observation worker count.' );

	const snapshots = [ ...initial ];
	const seen = new Set( snapshots.map( item => item?.pid ).filter( pid => null != pid ) );
	while ( seen.size < workers && snapshots.length < workers * 2 ) {
		const snapshot = await read();
		snapshots.push( snapshot );
		if ( null != snapshot?.pid ) seen.add( snapshot.pid );
	}

	return snapshots;
}

/**
 * Matches workers by PID before comparing their cache instances. Serial HTTP
 * requests may rotate through the pool; never subtract counters across workers.
 * Keep the latest before and earliest after observation for each worker.
 *
 * @param {Object[]} before
 * @param {Object[]} after
 * @param {number} expectedWorkers
 * @return {Object}
 */
function assessCacheWorkers( before, after, expectedWorkers ) {

	const first = new Map();
	const last = new Map();
	for ( const snapshot of before || [] ) {
		if ( null != snapshot?.pid ) first.set( snapshot.pid, snapshot );
	}
	for ( const snapshot of after || [] ) {
		if ( null != snapshot?.pid && ! last.has( snapshot.pid ) ) last.set( snapshot.pid, snapshot );
	}
	const ids = [ ...new Set( [ ...first.keys(), ...last.keys() ] ) ].sort( ( a, b ) => a - b );
	const workers = ids.map( pid => ( { pid, ...assessCache( first.get( pid ), last.get( pid ) ) } ) );
	const matchedWorkers = ids.filter( pid => first.has( pid ) && last.has( pid ) ).length;
	const reuseWorkers = workers.filter( item => 'observed-reuse' === item.status ).length;
	const complete = matchedWorkers === ids.length && matchedWorkers >= expectedWorkers;
	const statuses = new Set( workers.map( item => item.status ) );
	let status = 'not-recorded';
	if ( workers.length ) {
		status = complete && 1 === statuses.size ? workers[0].status : ( reuseWorkers ? 'partial-reuse' : 'incomplete-observation' );
	}
	const sum = key => workers.length && workers.every( item => Number.isFinite( item[key] ) )
		? workers.reduce( ( total, item ) => total + item[key], 0 ) : null;

	return {
		status, hits: sum( 'hits' ), misses: sum( 'misses' ), probeFileBound: sum( 'probeFileBound' ),
		jitCodeGrowthBytes: sum( 'jitCodeGrowthBytes' ),
		expectedWorkers, observedWorkers: ids.length, matchedWorkers, reuseWorkers, workers,
	};
}

/**
 * Rejects a profile the launcher did not actually initialize. This also catches
 * an older regression engine silently ignoring the requested startup option.
 *
 * @param {Object} snapshot
 * @param {string} requested
 * @param {string} php
 */
function validateCacheProfile( snapshot, requested = 'auto', php ) {

	const profile = 'auto' === requested ? ( /^8\.[1-9]\d*$/.test( php ) ? 'memory' : 'file' ) : requested;
	const enabled = 'off' !== profile;
	if ( ! snapshot || snapshot.enabled !== ( enabled ? '1' : '0' )
		|| snapshot.fileOnly !== ( 'file' === profile ? '1' : '0' )
		|| ( 'memory' === profile && snapshot.running !== true )
		|| ( 'off' === profile && snapshot.running !== false )
	) throw new Error( `Requested OPcache profile ${profile} was not initialized by the launcher; use a compatible regression engine.` );
}

module.exports = { assessCache, collectCacheSnapshots, assessCacheWorkers, validateCacheProfile };
