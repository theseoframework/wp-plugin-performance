/**
 * Repeat-control design and conservative empirical comparison checks.
 * These observed ranges are not confidence intervals or causal estimates.
 */

/**
 * Reads the former plan key while leaving saved source files unchanged.
 *
 * @param {Object} config
 * @return {Object}
 */
function normalizeConfig( config ) {

	if ( undefined !== config.fairness ) {
		if ( undefined !== config.comparisonMode && config.comparisonMode !== config.fairness )
			throw new Error( 'Conflicting comparisonMode and legacy plan setting.' );

		config.comparisonMode = config.fairness;
	}
	delete config.fairness;

	return config;
}

/**
 * Requires an explicit control and complete position-balanced rotations.
 *
 * @param {Object} config
 */
function validateDesign( config ) {

	normalizeConfig( config );
	if ( ! [ undefined, 'standard', 'repeat-controls' ].includes( config.comparisonMode ) )
		throw new Error( 'comparisonMode must be standard or repeat-controls.' );

	const primary = config.candidates.find( item => item.id === config.baselineCandidate );
	if ( config.baselineCandidate && ( ! primary?.baseline || primary.negativeControl ) )
		throw new Error( 'baselineCandidate must identify the primary no-plugin control.' );

	if ( 'repeat-controls' !== config.comparisonMode ) return;

	const controls = config.candidates.filter( item => item.negativeControl );
	if ( ! primary || ! controls.length || controls.some( item => ! item.baseline || item.id === primary.id ) )
		throw new Error( 'Repeat-control mode needs baselineCandidate and a separate baseline:true, negativeControl:true candidate.' );

	if ( config.candidates.some( item => item.baseline && item.id !== primary.id && ! item.negativeControl ) )
		throw new Error( 'Every additional baseline must be an identified negative control.' );

	if ( config.rounds < config.candidates.length || config.rounds % config.candidates.length )
		throw new Error( 'Repeat-control rounds must be a complete multiple of the candidate count, so each candidate occupies every position.' );

	if ( config.samples % config.rounds )
		throw new Error( 'Repeat-control samples must divide evenly across rounds.' );
}

/**
 * Verifies that negative controls mount the same inactive package as primary.
 *
 * @param {Object} config
 * @param {Object[]} candidates
 */
function validatePreparedControls( config, candidates ) {

	if ( 'repeat-controls' !== config.comparisonMode ) return;

	if ( candidates.length !== config.candidates.length )
		throw new Error( 'Repeat-control preparation must succeed for every declared candidate.' );

	const primary = candidates.find( item => item.id === config.baselineCandidate );
	const identity = item => JSON.stringify( [ item.slug, item.mainFile, item.version, item.archiveSha256, item.mainFileSha256, item.phpSourceSha256, item.mounts, item.extraPlugins || [] ] );
	for ( const item of candidates.filter( candidate => candidate.negativeControl ) ) {
		if ( identity( item ) !== identity( primary ) )
			throw new Error( `${item.id}: negative control must use the identical inactive package, mounts and companions as ${primary.id}.` );
	}
}

/**
 * Rotates a fresh-install round without changing source order or identities.
 *
 * @param {Object[]} candidates
 * @param {number} round
 * @return {Object[]}
 */
function candidateOrder( candidates, round ) {

	const offset = round % candidates.length;

	return candidates.slice( offset ).concat( candidates.slice( 0, offset ) );
}

/**
 * Widens observed round envelopes by the largest same-round control difference.
 * Missing controls block factors; no raw sample or signed difference is changed.
 *
 * @param {Object[]} rows
 * @param {Object} manifest
 * @return {Object[]}
 */
function assessControls( rows, manifest ) {

	const config = manifest.config;
	const controls = ( config.candidates || [] ).filter( item => item.negativeControl ).map( item => item.id );
	const result = [];
	for ( const row of rows ) {
		row.negativeControl = controls.includes( row.candidate );
		row.comparisonMode = config.comparisonMode || 'standard';
		row.controlsComplete = false;
		row.controlAssessment = 'Not assessed with repeat controls.';
		row.controlMinimumSpreadMs = null;
		row.controlMedianSpreadMs = null;
		if ( 'repeat-controls' !== config.comparisonMode ) continue;

		const primary = rows.find( item => item.candidate === config.baselineCandidate && item.cohort === row.cohort && item.eligible );
		const repeats = controls.map( id => rows.find( item => item.candidate === id && item.cohort === row.cohort && item.eligible ) );
		const all = [ row, primary, ...repeats ];
		const complete = all.every( item => item?.eligible && 'valid' === item.status && item.roundMetrics?.length === config.rounds && new Set( item.roundMetrics.map( round => round.round ) ).size === config.rounds && item.roundMetrics.every( round => Number.isInteger( round.round ) && round.round >= 1 && round.round <= config.rounds && round.valid === config.samples / config.rounds && Number.isFinite( round.minimumMs ) && Number.isFinite( round.medianMs ) ) );
		if ( ! complete || ! row.baselineCandidate ) {
			row.controlAssessment = 'Unresolved: incomplete or unmatched repeat controls.';
			continue;
		}
		const differences = repeats.flatMap( repeat => repeat.roundMetrics.map( round => {
			const control = primary.roundMetrics.find( item => item.round === round.round );

			return { candidate: repeat.candidate, round: round.round, minimumMs: round.minimumMs - control.minimumMs, medianMs: round.medianMs - control.medianMs };
		} ) );
		row.controlMinimumSpreadMs = Math.max( ...differences.map( item => Math.abs( item.minimumMs ) ) );
		row.controlMedianSpreadMs = Math.max( ...differences.map( item => Math.abs( item.medianMs ) ) );
		row.baselineDeltaLowMs -= row.controlMinimumSpreadMs;
		row.baselineDeltaHighMs += row.controlMinimumSpreadMs;
		row.baselineMedianDeltaLowMs -= row.controlMedianSpreadMs;
		row.baselineMedianDeltaHighMs += row.controlMedianSpreadMs;
		row.controlsComplete = true;
		row.controlAssessment = row.baseline
			? ( row.negativeControl ? 'Negative control; no SEO plugin active.' : 'Primary WordPress control.' )
			: ( row.baselineDeltaHighMs < 0 && row.baselineMedianDeltaHighMs < 0
				? 'Lower in every observed round beyond repeat-control spread; descriptive, not causal proof.'
				: ( row.baselineDeltaLowMs > 0 && row.baselineMedianDeltaLowMs > 0
					? 'Higher in every observed round beyond repeat-control spread; descriptive, not causal proof.'
					: 'Unresolved: minimum/median evidence overlaps observed control variation.' ) );
		result.push( {
			candidate: row.candidate, wp: row.wp, php: row.php, scenario: row.scenario, cohort: row.cohort,
			primaryControl: primary.candidate, negativeControls: controls.join( '; ' ),
			controlMinimumSpreadMs: row.controlMinimumSpreadMs, controlMedianSpreadMs: row.controlMedianSpreadMs,
			minimumDeltaMs: row.baselineDeltaMs, minimumLowMs: row.baselineDeltaLowMs, minimumHighMs: row.baselineDeltaHighMs,
			medianDeltaMs: row.baselineMedianDeltaMs, medianLowMs: row.baselineMedianDeltaLowMs, medianHighMs: row.baselineMedianDeltaHighMs,
			assessment: row.controlAssessment, controlDifferences: differences,
		} );
	}

	return result;
}

module.exports = { normalizeConfig, validateDesign, validatePreparedControls, candidateOrder, assessControls };
