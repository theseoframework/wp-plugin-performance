/**
 * Common-scenario weighting, save isolation, counts and missing-data behavior.
 */

const assert = require( 'assert/strict' );
const { aggregateGroups } = require( '../lib/groups' );

/**
 * @return {void}
 */
function checkGroups() {

	const manifest = { config: { scenarios: [ 'post', 'page', 'dashboard', 'posts-list', 'editor-save', 'sitemap' ] }, candidates: [ { id: 'core', baseline: true }, { id: 'plugin' } ] };
	const rows = [];
	for ( const candidate of [ 'core', 'plugin' ] ) {
		for ( const [ scenario, fastest, count ] of [ [ 'post', 10, 2 ], [ 'page', 30, 8 ], [ 'dashboard', 50, 2 ], [ 'posts-list', 70, 2 ], [ 'editor-save', 1000, 100 ], [ 'sitemap', 9999, 100 ] ] ) {
			const leading = fastest + ( 'plugin' === candidate ? -1 : 0 );
			rows.push( {
				candidate, baseline: 'core' === candidate, baselineCandidate: 'core', pluginVersion: '1',
				wp: '7.1', php: '8.5', runtimeGroup: '["7.1","8.5","theme"]', scenario, cohort: `${scenario}|matched`,
				eligible: true, status: 'valid', leadingMs: leading, medianMs: leading + 2, meanMs: leading + 5,
				valid: count, attempted: count, warmupValid: 1,
			} );
		}
	}
	const result = aggregateGroups( rows, manifest );
	const group = name => result.find( row => row.candidate === 'plugin' && row.group === name );
	assert.equal( group( 'front-end' ).averageLeadingMs, 19 );
	assert.equal( group( 'front-end' ).averageMedianMs, 21 );
	assert.equal( group( 'front-end' ).averageRequestMs, 24 );
	assert.equal( group( 'front-end' ).measuredCalls, 10 );
	assert.equal( group( 'front-end' ).warmupCalls, 2 );
	assert.equal( group( 'front-end' ).baselineDeltaMs, -1 );
	assert.equal( group( 'back-end' ).averageLeadingMs, 59 );
	assert.equal( group( 'back-end' ).saveCalls, 0 );
	assert( ! group( 'back-end' ).scenarios.includes( 'editor-save' ) );
	assert.equal( group( 'saving' ).averageLeadingMs, 999 );
	assert.equal( group( 'saving' ).saveCalls, 100 );
	assert.equal( group( 'saving' ).scenarioCount, 1 );
	assert( ! result.some( row => row.scenarios.includes( 'sitemap' ) ) );
	for ( const scenario of [ 'rss', 'robots', 'sitemap-xsl', 'sitemap-css' ] ) {
		const endpoints = rows.filter( row => row.scenario === 'sitemap' ).map( row => ( { ...row, scenario } ) );
		const withEndpoint = { ...manifest, config: { scenarios: [ ...manifest.config.scenarios, scenario ] } };
		const isolated = aggregateGroups( [ ...rows, ...endpoints ], withEndpoint );
		assert.equal( isolated.find( row => row.candidate === 'plugin' && row.group === 'front-end' ).averageLeadingMs, 19 );
		assert( ! isolated.some( row => row.scenarios.split( '; ' ).includes( scenario ) ) );
	}
	const missing = structuredClone( rows );
	missing.find( row => row.candidate === 'plugin' && row.scenario === 'page' ).eligible = false;
	const partial = aggregateGroups( missing, manifest ).filter( row => row.group === 'front-end' );
	assert( partial.every( row => row.scenarios === 'post' && row.scenarioCount === 1 && row.requestedScenarioCount === 2 && row.status === 'partial coverage' ) );
	assert.equal( partial.find( row => row.candidate === 'core' ).averageLeadingMs, 10 );
	const mismatch = structuredClone( rows );
	mismatch.find( row => row.candidate === 'plugin' && row.scenario === 'post' ).cohort = 'different-cache';
	assert( aggregateGroups( mismatch, manifest ).filter( row => row.group === 'front-end' ).every( row => row.scenarios === 'page' ) );
	const failedCandidate = { ...manifest, candidates: [ ...manifest.candidates, { id: 'failed' } ] };
	assert( aggregateGroups( rows, failedCandidate ).every( row => row.averageLeadingMs === null && row.measuredCalls === 0 ) );
	const deferred = { ...failedCandidate, exclusions: [ { candidate: 'failed', reason: 'User deferred' } ] };
	assert.equal( aggregateGroups( rows, deferred ).length, 6 );
	const noSaves = { ...manifest, config: { scenarios: [ 'post' ] } };
	assert( aggregateGroups( rows, noSaves ).filter( row => row.group === 'saving' ).every( row => row.averageLeadingMs === null && row.saveCalls === 0 && row.scenarioCount === 0 ) );
	const otherPHP = structuredClone( rows ).map( row => ( { ...row, php: '8.3', runtimeGroup: '["7.1","8.3","theme"]', cohort: row.cohort.replace( 'matched', 'php83' ), leadingMs: row.leadingMs + 100 } ) );
	const matrix = aggregateGroups( [ ...rows, ...otherPHP ], manifest );
	assert.equal( matrix.length, 12 );
	assert.equal( matrix.find( row => row.candidate === 'plugin' && row.group === 'front-end' && row.php === '8.3' ).averageLeadingMs, 119 );
}

module.exports = { checkGroups };
