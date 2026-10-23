/**
 * Auditable group means and counts linked to per-scenario Summary cells.
 */

const assert = require( 'assert/strict' );

/**
 * Builds the group table and checks that save edits cannot affect admin means.
 *
 * @param {Object} workbook
 * @param {Object} results
 * @param {Function} addSheet
 * @return {Object}
 */
function addGroupSheet( workbook, results, addSheet ) {

	const rows = results.groupSummaries;
	const sheet = addSheet( workbook, 'Group averages', rows, [
		{ key: 'candidate', label: 'Candidate', width: 24 },
		{ key: 'groupLabel', label: 'Request type', width: 21 },
		{ key: 'wp', label: 'WordPress', width: 14 },
		{ key: 'php', label: 'PHP', width: 14 },
		{ key: 'scenarioCount', label: 'Scenarios used', numeric: true, format: '0' },
		{ key: 'requestedScenarioCount', label: 'Scenarios requested', numeric: true, format: '0', width: 23 },
		{ key: 'measuredCalls', label: 'Measured calls used', numeric: true, format: '#,##0', width: 23 },
		{ key: 'warmupCalls', label: 'Warmup calls', numeric: true, format: '#,##0' },
		{ key: 'saveCalls', label: 'Measured saves', numeric: true, format: '#,##0', width: 21 },
		{ key: 'averageLeadingMs', label: 'Mean minima (ms)', numeric: true, format: '0.000', width: 22 },
		{ key: 'baselineLeadingMs', label: 'Core mean minima (ms)', numeric: true, format: '0.000', width: 25 },
		{ key: 'baselineDeltaMs', label: 'Added mean minima (ms)', numeric: true, format: '0.000', width: 26 },
		{ key: 'averageMedianMs', label: 'Mean medians (ms)', numeric: true, format: '0.000', width: 22 },
		{ key: 'baselineMedianMs', label: 'Core mean medians (ms)', numeric: true, format: '0.000', width: 25 },
		{ key: 'baselineMedianDeltaMs', label: 'Added mean medians (ms)', numeric: true, format: '0.000', width: 26 },
		{ key: 'averageRequestMs', label: 'Mean request (ms)', numeric: true, format: '0.000', width: 22 },
		{ key: 'baselineRequestMs', label: 'Core mean request (ms)', numeric: true, format: '0.000', width: 25 },
		{ key: 'baselineRequestDeltaMs', label: 'Added mean request (ms)', numeric: true, format: '0.000', width: 26 },
		{ key: 'status', label: 'Status', width: 23 },
		{ key: 'scenarios', label: 'Included scenarios', width: 60, wrap: true },
		{ key: 'excludedScenarios', label: 'Excluded scenarios', width: 45, wrap: true },
		{ key: 'note', label: 'Weighting and scope', width: 70, wrap: true },
		{ key: 'baselineCandidate', label: 'WordPress subtraction baseline', width: 30 },
	] );
	const source = workbook.worksheets.getItem( 'Summary' );
	const indexes = ( row, candidate ) => row.memberCohorts.map( cohort => {
		const index = results.summaries.findIndex( item => item.candidate === candidate && item.cohort === cohort );
		assert( index >= 0, 'Group source is absent from Summary.' );

		return index + 2;
	} );
	const formula = ( operation, column, indices ) => `=${operation}(${indices.map( index => `'Summary'!${column}${index}` ).join( ',' )})`;
	rows.forEach( ( row, offset ) => {
		if ( ! row.scenarioCount ) return;

		const target = offset + 2;
		const members = indexes( row, row.candidate );
		for ( const [ column, reference ] of [ [ 'G', 'G' ], [ 'H', 'Z' ] ] )
			sheet.getRange( `${column}${target}` ).formulas = [ [ formula( 'SUM', reference, members ) ] ];

		if ( 'saving' === row.group ) sheet.getRange( `I${target}` ).formulas = [ [ `=G${target}` ] ];

		for ( const [ column, reference ] of [ [ 'J', 'H' ], [ 'M', 'I' ], [ 'P', 'Y' ] ] )
			sheet.getRange( `${column}${target}` ).formulas = [ [ formula( 'AVERAGE', reference, members ) ] ];

		if ( row.baselineCandidate ) {
			const controls = indexes( row, row.baselineCandidate );
			for ( const [ column, reference ] of [ [ 'K', 'H' ], [ 'N', 'I' ], [ 'Q', 'Y' ] ] )
				sheet.getRange( `${column}${target}` ).formulas = [ [ formula( 'AVERAGE', reference, controls ) ] ];

			for ( const [ column, value, control ] of [ [ 'L', 'J', 'K' ], [ 'O', 'M', 'N' ], [ 'R', 'P', 'Q' ] ] )
				sheet.getRange( `${column}${target}` ).formulas = [ [ `=${value}${target}-${control}${target}` ] ];
		}
	} );
	workbook.recalculate();
	const save = rows.findIndex( row => 'saving' === row.group && row.scenarioCount && ! row.baseline );
	const admin = save < 0 ? -1 : rows.findIndex( row => 'back-end' === row.group && row.candidate === rows[save].candidate && row.runtimeGroup === rows[save].runtimeGroup && row.scenarioCount );
	let saveIsolationChecked = false;
	if ( save >= 0 && admin >= 0 ) {
		const index = indexes( rows[save], rows[save].candidate )[0];
		const original = source.getRange( `H${index}` ).values[0][0];
		const savingBefore = sheet.getRange( `J${save + 2}` ).values[0][0];
		const adminBefore = sheet.getRange( `J${admin + 2}` ).values[0][0];
		try {
			source.getRange( `H${index}` ).values = [ [ original + 17 ] ];
			workbook.recalculate();
			assert( Math.abs( sheet.getRange( `J${save + 2}` ).values[0][0] - savingBefore - 17 / rows[save].scenarioCount ) < 1e-8 );
			assert.equal( sheet.getRange( `J${admin + 2}` ).values[0][0], adminBefore );
			saveIsolationChecked = true;
		} finally {
			source.getRange( `H${index}` ).values = [ [ original ] ];
			workbook.recalculate();
		}
	}
	const columns = [ 'measuredCalls', 'warmupCalls', 'saveCalls', 'averageLeadingMs', 'baselineLeadingMs', 'baselineDeltaMs', 'averageMedianMs', 'baselineMedianMs', 'baselineMedianDeltaMs', 'averageRequestMs', 'baselineRequestMs', 'baselineRequestDeltaMs' ];
	rows.forEach( ( row, index ) => {
		const actual = sheet.getRange( `G${index + 2}:R${index + 2}` ).values[0];
		columns.forEach( ( key, column ) => {
			if ( null === row[key] ) assert( null == actual[column] || '' === actual[column], 'Missing group mean became numeric.' );
			else assert( Number.isFinite( actual[column] ) && Math.abs( actual[column] - row[key] ) < 1e-8, `Group formula mismatch: ${row.candidate}, ${row.group}, ${key}` );
		} );
	} );

	return { rowsChecked: rows.length, saveIsolationChecked };
}

module.exports = { addGroupSheet };
