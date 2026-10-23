/**
 * Signed differences between matched complete responses, preserving savings.
 * Round envelopes describe observed variation; they are not confidence bounds.
 */

const METRICS = {
	leadingMs: { delta: 'baselineDeltaMs', baseline: 'baselineLeadingMs', low: 'roundLeadingLowMs', high: 'roundLeadingHighMs', deltaLow: 'baselineDeltaLowMs', deltaHigh: 'baselineDeltaHighMs', spread: 'controlMinimumSpreadMs' },
	medianMs: { delta: 'baselineMedianDeltaMs', baseline: 'baselineMedianMs', low: 'roundMedianLowMs', high: 'roundMedianHighMs', deltaLow: 'baselineMedianDeltaLowMs', deltaHigh: 'baselineMedianDeltaHighMs', spread: 'controlMedianSpreadMs' },
};

/**
 * Attaches one unambiguous eligible core control to an exact workload cohort.
 * Feature endpoints need a separate matched-workload experiment.
 *
 * @param {Object[]} rows
 */
function attachBaselines( rows, baselineCandidate ) {

	for ( const row of rows ) {
		row.baselineCandidate = '';
		row.baselineReason = '';
		for ( const metric of Object.values( METRICS ) ) {
			for ( const key of [ metric.delta, metric.baseline, metric.deltaLow, metric.deltaHigh ] ) row[key] = null;
		}
		const controls = rows.filter( item => item.baseline && item.eligible && item.cohort === row.cohort && ( ! baselineCandidate || item.candidate === baselineCandidate ) );
		if ( ! row.eligible ) row.baselineReason = 'Timing is unavailable or ineligible.';
		else if ( [ 'sitemap', 'redirect' ].includes( row.scenario ) ) row.baselineReason = 'Feature workload is not matched to a core control; endpoint timings remain separate.';
		else if ( 1 !== controls.length ) row.baselineReason = controls.length ? 'Ambiguous core controls in this cohort.' : 'No eligible core control in this exact runtime/workload cohort.';
		else {
			const control = controls[0];
			row.baselineCandidate = control.candidate;
			for ( const [ key, metric ] of Object.entries( METRICS ) ) {
				if ( ! Number.isFinite( row[key] ) || ! Number.isFinite( control[key] ) ) continue;

				row[metric.baseline] = control[key];
				row[metric.delta] = row[key] - control[key];
				if ( [ row[metric.low], row[metric.high], control[metric.low], control[metric.high] ].every( Number.isFinite ) ) {
					row[metric.deltaLow] = row[metric.low] - control[metric.high];
					row[metric.deltaHigh] = row[metric.high] - control[metric.low];
				}
			}
			row.baselineReason = row.baseline ? 'WordPress control.' : ( row.roundCount > 1 ? 'Matched control; observed cross-round envelope, not a confidence interval.' : 'Matched control; single round, exploratory difference.' );
		}
	}
}

/**
 * Compares a selected plugin to a reference in the same exact cohort.
 * A factor means reference / selected, separately for total and added overhead.
 *
 * @param {Object} row
 * @param {Object} reference
 * @param {string} key
 * @return {Object}
 */
function compare( row, reference, key = 'leadingMs' ) {

	const metric = METRICS[key];
	const result = { responseRatio: null, overheadRatio: null, differenceMs: null, reason: '' };
	if ( ! metric || ! row?.eligible || ! reference?.eligible || row.cohort !== reference.cohort ) {
		result.reason = 'No eligible reference in the same cohort.';

		return result;
	}
	if ( row[key] > 0 && reference[key] > 0 ) {
		result.responseRatio = reference[key] / row[key];
		result.differenceMs = row[key] - reference[key];
	}
	const epsilon = Number.EPSILON * Math.max( 1, row[key] || 0, reference[key] || 0, row[metric.baseline] || 0 ) * 16;
	let responseNote = '';
	if ( row.candidate !== reference.candidate && [ row, reference ].some( item => 'repeat-controls' === item.comparisonMode ) ) {
		const metrics = Object.values( METRICS );
		const complete = [ row, reference ].every( item => item.controlsComplete && metrics.every( field => [ item[field.low], item[field.high], item[field.spread] ].every( Number.isFinite ) ) );
		const ranges = metrics.map( field => {
			const spread = row[field.spread] + reference[field.spread];

			return { low: row[field.low] - reference[field.high] - spread, high: row[field.high] - reference[field.low] + spread };
		} );
		const resolved = ranges.every( range => range.low > epsilon ) || ranges.every( range => range.high < -epsilon );
		if ( ! complete || ! resolved ) {
			result.responseRatio = null;
			responseNote = ' Full-response factor is unresolved: incomplete controls or the minimum/median pairwise ranges plus both control spreads reach zero or disagree in direction.';
		}
	}
	if ( ! row.baselineCandidate || row.baselineCandidate !== reference.baselineCandidate )
		result.reason = 'No common matched WordPress baseline.';
	else if ( [ row, reference ].some( item => 'repeat-controls' === item.comparisonMode && ! item.controlsComplete ) )
		result.reason = 'No complete repeat-control assessment; added-overhead factor is unresolved.';
	else if ( responseNote )
		result.reason = 'The comparison with this reference overlaps observed control variation; both factors are unresolved.';
	else if ( ! ( row[metric.delta] > epsilon && reference[metric.delta] > epsilon ) )
		result.reason = 'Overhead factor requires two positive, numerically resolved deltas; savings and zero stay signed milliseconds.';
	else if ( ( Number.isFinite( row[metric.deltaLow] ) && row[metric.deltaLow] <= epsilon ) || ( Number.isFinite( reference[metric.deltaLow] ) && reference[metric.deltaLow] <= epsilon ) )
		result.reason = 'Observed round envelope reaches or crosses zero; overhead factor is unresolved.';
	else {
		result.overheadRatio = reference[metric.delta] / row[metric.delta];
		result.reason = row.roundCount > 1 && reference.roundCount > 1 ? 'Descriptive added-overhead factor; no statistical confidence claim.' : 'Exploratory added-overhead factor from a single round.';
	}
	result.reason += responseNote;

	return result;
}

module.exports = { METRICS, attachBaselines, compare };
