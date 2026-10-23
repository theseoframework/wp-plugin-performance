/**
 * Checks neutral controls, balanced scheduling and unresolved effects.
 */

const assert = require( 'assert/strict' );
const { validateDesign, validatePreparedControls, candidateOrder, assessControls } = require( '../lib/controls' );
const { attachBaselines, compare } = require( '../lib/comparison' );

/**
 * Builds independent round summaries with a common response cohort.
 *
 * @param {string} candidate
 * @param {number[]} minimums
 * @param {number[]} medians
 * @param {Boolean} baseline
 * @return {Object}
 */
function observation( candidate, minimums, medians, baseline = false ) {

	const middle = values => [ ...values ].sort( ( a, b ) => a - b )[1];

	return {
		candidate, baseline, eligible: true, status: 'valid', cohort: 'same', scenario: 'post', wp: '7.1.3', php: '8.5.10',
		leadingMs: Math.min( ...minimums ), medianMs: middle( medians ), roundCount: 3,
		roundLeadingLowMs: Math.min( ...minimums ), roundLeadingHighMs: Math.max( ...minimums ),
		roundMedianLowMs: Math.min( ...medians ), roundMedianHighMs: Math.max( ...medians ),
		roundMetrics: minimums.map( ( minimumMs, index ) => ( { round: index + 1, minimumMs, medianMs: medians[index], valid: 100 } ) ),
	};
}

/**
 * Exercises effect signs independently of the declared SEO product.
 */
function checkControls() {

	const config = {
		comparisonMode: 'repeat-controls', baselineCandidate: 'core', samples: 300, rounds: 3,
		candidates: [ { id: 'core', baseline: true }, { id: 'plugin' }, { id: 'repeat', baseline: true, negativeControl: true } ],
	};
	validateDesign( config );
	const legacy = { ...config, comparisonMode: undefined, fairness: 'repeat-controls' };
	validateDesign( legacy );
	assert.equal( legacy.comparisonMode, 'repeat-controls' );
	assert.equal( Object.hasOwn( legacy, 'fairness' ), false );
	assert.throws( () => validateDesign( { ...config, fairness: 'standard' } ), /Conflicting/ );
	assert.throws( () => validateDesign( { ...config, comparisonMode: undefined, fairness: 'repeat-controls', rounds: 4 } ), /complete multiple/ );
	assert.throws( () => validateDesign( { ...config, rounds: 4 } ), /complete multiple/ );
	assert.throws( () => validateDesign( { ...config, samples: 301 } ), /divide evenly/ );
	assert.throws( () => validateDesign( { ...config, baselineCandidate: 'plugin' } ), /primary/ );
	assert.throws( () => validateDesign( { ...config, candidates: config.candidates.slice( 0, 2 ) } ), /separate/ );
	for ( const item of config.candidates ) {
		const positions = config.candidates.map( ( unused, round ) => candidateOrder( config.candidates, round ).findIndex( row => row.id === item.id ) );
		assert.deepEqual( positions.sort(), [ 0, 1, 2 ] );
	}
	const fingerprint = { slug: 'same', mainFile: 'same.php', version: '1.0', archiveSha256: 'a', mainFileSha256: 'b', phpSourceSha256: 'c', mounts: [ 'same.php' ] };
	const prepared = config.candidates.map( item => ( { ...item, ...fingerprint } ) );
	validatePreparedControls( config, prepared );
	assert.throws( () => validatePreparedControls( config, prepared.map( item => ( item.negativeControl ? { ...item, phpSourceSha256: 'different' } : item ) ) ), /identical inactive/ );
	for ( const [ minimums, medians, expected ] of [
		[ [ 99, 100, 98 ], [ 112, 113, 111 ], 'Unresolved' ],
		[ [ 103, 104, 102 ], [ 113, 114, 112 ], 'Unresolved' ],
		[ [ 50, 51, 49 ], [ 220, 221, 219 ], 'Unresolved' ],
		[ [ 200, 201, 199 ], [ 220, 221, 219 ], 'Higher' ],
		[ [ 50, 51, 49 ], [ 60, 61, 59 ], 'Lower' ],
	] ) {
		const rows = [ observation( 'core', [ 100, 101, 99 ], [ 110, 111, 109 ], true ), observation( 'plugin', minimums, medians ), observation( 'repeat', [ 99, 103, 98 ], [ 111, 113, 110 ], true ) ];
		attachBaselines( rows, 'core' );
		const original = rows[1].baselineDeltaMs;
		const evidence = assessControls( rows, { config } );
		assert.equal( evidence.length, 3 );
		assert.equal( rows[1].baselineDeltaMs, original );
		assert.equal( rows[1].controlMinimumSpreadMs, 2 );
		assert.equal( rows[1].controlMedianSpreadMs, 2 );
		assert( rows[1].controlAssessment.startsWith( expected ) );
		assert( rows[2].negativeControl );
		for ( const key of [ 'leadingMs', 'medianMs' ] ) {
			if ( 'Unresolved' === expected ) {
				assert.equal( compare( rows[1], rows[0], key ).overheadRatio, null );
				assert.equal( compare( rows[1], rows[0], key ).responseRatio, null );
			} else assert( compare( rows[1], rows[0], key ).responseRatio > 0 );
			assert.equal( compare( rows[1], rows[1], key ).responseRatio, 1 );
			const tiedReference = { ...rows[1], candidate: 'different-candidate-with-equal-timings' };
			assert.equal( compare( rows[1], tiedReference, key ).responseRatio, null );
			assert.equal( compare( rows[1], tiedReference, key ).overheadRatio, null );
		}
		rows[2].eligible = false;
		assessControls( rows, { config } );
		assert.equal( rows[1].controlsComplete, false );
		assert.equal( compare( rows[1], rows[1] ).overheadRatio, null );
		assert.equal( compare( rows[1], rows[0] ).responseRatio, null );
	}
}

module.exports = { checkControls };
