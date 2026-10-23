/**
 * Reads operating-system CPU counters only at measured block boundaries.
 */

const os = require( 'os' );

/**
 * Distinguishes WSL guest counters from the current operating system's view.
 * Other virtual machines and containers still need operator-supplied context.
 *
 * @param {string} platform
 * @param {string} release
 * @return {string}
 */
function cpuScope( platform = process.platform, release = os.release() ) {
	return 'linux' === platform && /microsoft|wsl/i.test( release ) ? 'wsl-guest' : 'operating-system';
}

/**
 * Captures cumulative logical-CPU times without a sampling process or timer.
 * Raw counters remain available for independently checking the block average.
 *
 * @return {Object}
 */
function readCPUCounters() {

	const result = {
		at: new Date().toISOString(), monotonicMs: Number( process.hrtime.bigint() ) / 1e6,
		platform: process.platform, scope: cpuScope(), source: 'node:os.cpus', cpus: [], reason: '',
	};
	try {
		result.cpus = os.cpus().map( cpu => ( { model: cpu.model, times: cpu.times } ) );
		if ( ! result.cpus.length ) result.reason = 'The operating system returned no CPU counters.';
	} catch ( error ) {
		result.reason = error.message;
	}

	return result;
}

/**
 * Computes busy time across all logical CPUs between two counter snapshots.
 * Missing, unchanged, reset or changing CPU sets produce null, never idle 0%.
 *
 * @param {Object} before
 * @param {Object} after
 * @return {Object}
 */
function cpuLoad( before, after ) {

	const result = {
		startedAt: before?.at || '', endedAt: after?.at || '',
		percent: null, durationMs: null, logicalCPUs: before?.cpus?.length || 0,
		scope: before?.scope || '', source: 'node:os.cpus', reason: '',
	};
	try {
		if ( ! before || ! after || before.reason || after.reason )
			throw new Error( before?.reason || after?.reason || 'CPU interval was not sampled.' );

		if ( ! before.cpus.length || before.cpus.length !== after.cpus.length || before.scope !== after.scope || before.platform !== after.platform )
			throw new Error( 'CPU set or counter scope changed during the block.' );

		const duration = after.monotonicMs - before.monotonicMs;
		if ( ! Number.isFinite( duration ) || duration <= 0 )
			throw new Error( 'CPU interval has no positive monotonic duration.' );

		result.durationMs = duration;
		let total = 0;
		let idle = 0;
		for ( let index = 0; index < before.cpus.length; ++index ) {
			const first = before.cpus[index];
			const last  = after.cpus[index];
			if ( first.model !== last.model ) throw new Error( 'CPU identity changed during the block.' );

			for ( const key of [ 'user', 'nice', 'sys', 'idle', 'irq' ] ) {
				const start = first.times?.[key];
				const end   = last.times?.[key];
				if ( ! Number.isFinite( start ) || ! Number.isFinite( end ) || start < 0 || end < start )
					throw new Error( 'CPU counters are missing, invalid or reset.' );

				// libuv's Windows sys time already includes interrupt time.
				if ( 'win32' !== before.platform || 'irq' !== key ) total += end - start;
				if ( 'idle' === key ) idle += end - start;
			}
		}
		if ( ! Number.isFinite( total ) || ! total )
			throw new Error( 'CPU counters did not advance reliably; the interval may be below their resolution.' );

		result.percent = 100 * ( total - idle ) / total;
	} catch ( error ) {
		result.reason = error.message;
	}

	return result;
}

module.exports = { cpuScope, readCPUCounters, cpuLoad };
