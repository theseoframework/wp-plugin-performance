/**
 * Distinguishes enabled settings, boundary-probe hits and actual observed reuse.
 */

const assert = require( 'assert/strict' );
const { assessCache, collectCacheSnapshots, assessCacheWorkers, validateCacheProfile } = require( '../lib/cache' );

function checkCache() {

	const before = {
		running: true, fileOnly: '0', pid: 42, startTime: 100, lastRestartTime: 0,
		hits: 1000, misses: 50, oomRestarts: 0, hashRestarts: 0, manualRestarts: 0,
		includedScripts: 300, jitStatus: { on: true, buffer_free: 10000 },
	};
	const after = { ...before, hits: 10000, jitStatus: { on: true, buffer_free: 9000 } };
	assert.equal( assessCache().status, 'not-recorded' );
	assert.equal( assessCache( { enabled: '1', cachedScripts: 100 }, after ).status, 'not-recorded' );
	assert.equal( assessCache( { ...before, running: false }, after ).status, 'inactive' );
	assert.equal( assessCache( { ...before, running: false, fileOnly: '1' }, after ).status, 'file-cache-unobservable' );
	assert.equal( assessCache( before, { ...after, pid: 43 } ).status, 'instance-changed' );
	assert.equal( assessCache( before, { ...after, lastRestartTime: 101 } ).status, 'instance-changed' );
	assert.equal( assessCache( before, { ...after, hits: 1 } ).status, 'counter-reset' );
	assert.equal( assessCache( before, { ...after, oomRestarts: 1 } ).status, 'counter-reset' );
	assert.equal( assessCache( before, { ...after, hits: 1300 } ).status, 'no-confirmed-reuse' );
	assert.equal( assessCache( before, { ...after, includedScripts: undefined } ).status, 'no-confirmed-reuse' );
	assert.equal( assessCache( before, after ).status, 'observed-reuse' );
	assert.equal( assessCache( before, after ).hits, 9000 );
	assert.equal( assessCache( before, after ).jitCodeGrowthBytes, 1000 );
	assert.equal( assessCache( before, { ...after, jitStatus: before.jitStatus } ).jitCodeGrowthBytes, 0 );
	assert.doesNotThrow( () => validateCacheProfile( { enabled: '1', fileOnly: '0', running: true }, 'auto', '8.5' ) );
	assert.doesNotThrow( () => validateCacheProfile( { enabled: '1', fileOnly: '1', running: false }, 'auto', '7.4' ) );
	assert.doesNotThrow( () => validateCacheProfile( { enabled: '0', fileOnly: '0', running: false }, 'off', '8.5' ) );
	assert.throws( () => validateCacheProfile( { enabled: '1', fileOnly: '0', running: false }, 'memory', '8.5' ), /not initialized/ );
	assert.throws( () => validateCacheProfile( { enabled: '1', fileOnly: '0', running: true }, 'off', '8.5' ), /not initialized/ );
	assert.throws( () => validateCacheProfile( null, 'memory', '8.5' ), /not initialized/ );
	const pairBefore = [ before, { ...before, pid: 43, hits: 1 } ];
	const pairAfter = [ { ...after, pid: 43 }, after ];
	const batch = assessCacheWorkers( pairBefore, pairAfter, 2 );
	assert.equal( batch.status, 'observed-reuse' );
	assert.equal( batch.reuseWorkers, 2 );
	assert.equal( batch.hits, 18999 );
	assert.equal( assessCacheWorkers( pairBefore, [ after ], 2 ).status, 'partial-reuse' );
	assert.equal( assessCacheWorkers( pairBefore, pairAfter, 3 ).status, 'partial-reuse' );
	assert.equal( assessCacheWorkers( [ before, { ...before, hits: 9999 } ], [ after, { ...after, hits: 30000 } ], 1 ).status, 'no-confirmed-reuse' );
}

async function checkCacheCollection() {

	let calls = 0;
	const snapshots = await collectCacheSnapshots( async () => ( { pid: ++calls + 1 } ), 3, [ { pid: 1 } ] );
	assert.equal( calls, 2 );
	assert.equal( snapshots.length, 3 );
	calls = 0;
	const repeated = await collectCacheSnapshots( async () => { ++calls; return { pid: 1 }; }, 2 );
	assert.equal( repeated.length, 4 );
	assert.equal( calls, 4 );
	await assert.rejects( collectCacheSnapshots( async () => ( {} ), 0 ), /Invalid/ );
}

module.exports = { checkCache, checkCacheCollection };
