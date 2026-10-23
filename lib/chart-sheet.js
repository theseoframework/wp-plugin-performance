/**
 * Editable workbook comparisons, linked to Summary rather than chart constants.
 */

const assert = require( 'assert/strict' );

/**
 * Builds one chart view with runtime/workload and fastest/median selectors.
 * Checks both selectors against recorded data before restoring the opening view.
 *
 * @param {Object} workbook
 * @param {Object[]} rows
 * @param {Object} manifest
 * @return {Object}
 */
function addCharts( workbook, rows, manifest = {} ) {

	const sheet = workbook.worksheets.add( 'Impact charts' );
	const cohorts = [ ...new Set( rows.map( row => row.cohort ) ) ];
	const candidates = [ ...new Set( rows.map( row => row.candidate ) ) ];
	const baselineIds = [ ...new Set( rows.map( row => row.baselineCandidate ).filter( Boolean ) ) ];
	const primary = manifest.config?.baselineCandidate || ( 1 === baselineIds.length ? baselineIds[0] : '' );
	const repeats = ( manifest.candidates || [] ).filter( item => item.baseline && item.negativeControl ).map( item => item.id );
	const role = candidate => rows.some( row => row.candidate === candidate && row.baseline ) ? ( candidate === primary ? 'baseline' : ( repeats.includes( candidate ) ? 'repeat check' : 'control' ) ) : '';
	const last = rows.length + 1;
	const registry = Math.max( 46, candidates.length + 15 );
	sheet.showGridLines = false;
	sheet.getRange( 'A1:U44' ).format.font = { name: 'Arial', size: 10, color: '#172B40' };
	sheet.getRange( 'A1:U44' ).format.rowHeight = 23;
	sheet.getRange( 'A:A' ).format.columnWidth = 25;
	sheet.getRange( 'B:D' ).format.columnWidth = 17;
	sheet.getRange( 'E:E' ).format.columnWidth = 28;
	sheet.getRange( 'F:F' ).format.columnWidth = 3;
	sheet.getRange( 'G:U' ).format.columnWidth = 9;
	sheet.getRange( 'A2' ).values = [ [ 'WordPress baseline impact' ] ];
	sheet.getRange( 'A2' ).format.font = { name: 'Arial', size: 14, bold: true };
	sheet.getRange( 'A3:B4' ).values = [ [ 'Cohort number', 1 ], [ 'Metric number', 1 ] ];
	sheet.getRange( 'B3:B4' ).format.fill = '#FFF1C2';
	sheet.getRange( 'B3' ).dataValidation = { rule: { type: 'whole', operator: 'between', formula1: 1, formula2: cohorts.length || 1 } };
	sheet.getRange( 'B4' ).dataValidation = { rule: { type: 'list', values: [ '1', '2' ] } };
	sheet.getRange( 'D3' ).values = [ [ `Choose 1–${cohorts.length}; workload key below row ${registry}.` ] ];
	sheet.getRange( 'D4' ).values = [ [ '1 = fastest validated response; 2 = raw median.' ] ];
	sheet.getRange( 'A6' ).values = [ [ 'Positive = added time; negative = observed savings. Blank = unavailable, never zero.' ] ];
	sheet.getRange( 'A7' ).values = [ [ 'Independent point estimates. See Summary qualifications and repeat controls. Features need matched work.' ] ];
	sheet.getRange( 'A8' ).values = [ [ primary ? `Subtraction baseline: ${primary}. ${repeats.length ? `Repeat check: ${repeats.join( ', ' )}; not subtracted or averaged into the baseline.` : 'No separate repeat check.'}` : 'Subtraction baseline varies or is unavailable; see the selected workload and Summary.' ] ];
	sheet.getRange( 'A6:A7' ).format.font = { name: 'Arial', size: 10, italic: true, color: '#52657A' };
	sheet.getRange( 'A9:E9' ).values = [ [ 'Candidate', 'Full response (ms)', 'Core control (ms)', 'Added time (ms)', 'Availability' ] ];
	sheet.getRange( 'A9:E9' ).format.fill = '#243B53';
	sheet.getRange( 'A9:E9' ).format.font = { name: 'Arial', size: 10, bold: true, color: '#FFFFFF' };
	sheet.getRange( 'A9:E9' ).format.wrapText = true;
	sheet.getRange( 'A9:E9' ).format.rowHeight = 36;
	sheet.getRange( 'A9:E9' ).format.horizontalAlignment = 'center';
	const count = ( index, extra = '' ) => `COUNTIFS('Summary'!$A$2:$A$${last},$A${index},'Summary'!$W$2:$W$${last},$B$3,'Summary'!$V$2:$V$${last},1${extra})`;
	const sum = ( index, column ) => `SUMIFS('Summary'!$${column}$2:$${column}$${last},'Summary'!$A$2:$A$${last},$A${index},'Summary'!$W$2:$W$${last},$B$3,'Summary'!$V$2:$V$${last},1)`;
	candidates.forEach( ( candidate, offset ) => {
		const index = offset + 10;
		const availability = 'baseline' === role( candidate ) ? 'Primary baseline' : ( 'repeat check' === role( candidate ) ? `Repeat check vs ${primary}` : `Subtracted: ${primary || 'see Summary'}` );
		sheet.getRange( `A${index}` ).values = [ [ /^[=+\-@]/.test( candidate ) ? `'${candidate}` : candidate ] ];
		sheet.getRange( `B${index}:E${index}` ).formulas = [ [
			`=IF(AND(${count( index )}=1,OR($B$4=1,$B$4=2)),IF($B$4=1,${sum( index, 'H' )},${sum( index, 'I' )}),"")`,
			`=IF(AND(${count( index, `,'Summary'!$X$2:$X$${last},1` )}=1,OR($B$4=1,$B$4=2)),IF($B$4=1,${sum( index, 'Q' )},${sum( index, 'S' )}),"")`,
			`=IF(AND(ISNUMBER(B${index}),ISNUMBER(C${index})),B${index}-C${index},"")`,
			`=IF(ISNUMBER(B${index}),IF(ISNUMBER(C${index}),"${availability.replace( /"/g, '""' )}","Endpoint timing only"),"n/a; see Summary")`,
		] ];
	} );
	if ( candidates.length ) {
		sheet.getRange( `B10:D${9 + candidates.length}` ).setNumberFormat( '0.000' );
		sheet.getRange( `B10:D${9 + candidates.length}` ).format.horizontalAlignment = 'right';
		const delta = sheet.getRange( `D10:D${9 + candidates.length}` );
		delta.conditionalFormats.add( 'cellIs', { operator: 'lessThan', formula: 0, format: { font: { color: '#087F8C' } } } );
	}
	const labels = cohorts.map( ( cohort, index ) => {
		const row = rows.find( row => row.cohort === cohort );
		const ids = [ ...new Set( rows.filter( item => item.cohort === cohort ).map( item => item.baselineCandidate ).filter( Boolean ) ) ];

		return [ index + 1, row.wp, row.php, row.scenario, `${row.frame}${row.featureDocument ? ` / ${row.featureDocument}` : ''}; ${1 === ids.length ? `baseline: ${ids[0]}` : 'no matched baseline'}` ];
	} );
	sheet.getRangeByIndexes( registry - 1, 0, 1, 5 ).values = [ [ 'Cohort number', 'WordPress', 'PHP', 'Scenario', 'Workload detail' ] ];
	sheet.getRangeByIndexes( registry - 1, 0, 1, 5 ).format.font = { name: 'Arial', size: 10, bold: true };
	if ( labels.length ) sheet.getRangeByIndexes( registry, 0, labels.length, 5 ).values = labels;
	sheet.getRange( 'A5' ).formulas = [ [ `=IF(AND(B3>=1,B3<=${cohorts.length},B3=INT(B3)),"Selected: WP "&INDEX(B${registry + 1}:B${registry + cohorts.length},B3)&" / PHP "&INDEX(C${registry + 1}:C${registry + cohorts.length},B3)&" / "&INDEX(D${registry + 1}:D${registry + cohorts.length},B3)&" ("&INDEX(E${registry + 1}:E${registry + cohorts.length},B3)&")","Invalid cohort number")` ] ];
	// Native Excel charts treat formula-empty strings inconsistently. NA() makes
	// an unavailable plotted point explicit while the reader's table stays blank.
	const plotStart = registry + cohorts.length + 4;
	sheet.getRangeByIndexes( plotStart - 1, 0, 1, 4 ).values = [ [ 'Chart source', 'Full response (ms)', 'Net impact (ms)', 'Zero-axis reference; not a measurement' ] ];
	candidates.forEach( ( candidate, offset ) => {
		const tableRow = offset + 10;
		const label = role( candidate );
		sheet.getRange( `A${plotStart + offset + 1}:D${plotStart + offset + 1}` ).formulas = [ [ `=A${tableRow}${label ? `&" (${label})"` : ''}`, `=IF(ISNUMBER(B${tableRow}),B${tableRow},NA())`, `=IF(ISNUMBER(D${tableRow}),D${tableRow},NA())`, '=0' ] ];
	} );
	const charts = [];
	if ( candidates.length ) {
		for ( const [ column, title, position, color ] of [
			[ 'C', `Added time vs ${primary || 'WordPress'} (ms)`, [ 'G9', 'U24' ], '#087F8C' ],
			[ 'B', 'Full response (ms)', [ 'G27', 'U42' ], '#3657A7' ],
		] ) {
			// A labeled zero reference keeps the automatic full-response axis honest.
			// It is a separate zero-height series, never a candidate's missing timing.
			const sources = [ sheet.getRange( `A${plotStart}:A${plotStart + candidates.length}` ), sheet.getRange( `${column}${plotStart}:${column}${plotStart + candidates.length}` ) ];
			if ( 'B' === column ) sources.push( sheet.getRange( `D${plotStart}:D${plotStart + candidates.length}` ) );
			const chart = sheet.charts.add( 'bar', sources );
			chart.title = title;
			chart.titleTextStyle.fontSize = 14;
			chart.titleTextStyle.typeface = 'Arial';
			chart.hasLegend = false;
			chart.barOptions.direction = 'column';
			chart.barOptions.grouping = 'clustered';
			chart.xAxis = { axisType: 'textAxis', textStyle: { typeface: 'Arial', fontSize: 11 } };
			chart.yAxis = { numberFormatCode: '0.0', numberFormatSourceLinked: false, textStyle: { typeface: 'Arial', fontSize: 11 } };
			chart.series.items[0].fill = color;
			chart.setPosition( ...position );
			charts.push( { title, valueFormula: chart.series.items[0].formula, categoryFormula: chart.series.items[0].categoryFormula, color, zeroAxisReference: 'B' === column } );
		}
	}
	let selectorChecks = 0;
	const checks = new Set( [ 0, cohorts.length - 1, ...rows.filter( row => row.baselineDeltaMs < 0 || ! row.eligible || null === row.baselineDeltaMs ).map( row => cohorts.indexOf( row.cohort ) ) ] );
	for ( const index of checks ) {
		if ( index < 0 ) continue;

		sheet.getRange( 'B3' ).values = [ [ index + 1 ] ];
		for ( const [ selector, key, baseline ] of [ [ 1, 'leadingMs', 'baselineLeadingMs' ], [ 2, 'medianMs', 'baselineMedianMs' ] ] ) {
			sheet.getRange( 'B4' ).values = [ [ selector ] ];
			workbook.recalculate();
			candidates.forEach( ( candidate, offset ) => {
				const row = rows.find( item => item.candidate === candidate && item.cohort === cohorts[index] && item.eligible );
				const actual = sheet.getRange( `B${offset + 10}:D${offset + 10}` ).values[0];
				const plotted = sheet.getRange( `B${plotStart + offset + 1}:C${plotStart + offset + 1}` ).values[0];
				const expected = row ? [ row[key], row[baseline], Number.isFinite( row[baseline] ) ? row[key] - row[baseline] : null ] : [ null, null, null ];
				expected.forEach( ( value, cell ) => {
					if ( ! Number.isFinite( value ) ) assert( null == actual[cell] || '' === actual[cell], `Missing chart value became ${actual[cell]}` );
					else assert( Number.isFinite( actual[cell] ) && Math.abs( actual[cell] - value ) < 1e-8, `Chart selector mismatch: ${candidate}, ${key}, actual=${actual[cell]}, expected=${value}` );
				} );
				for ( const [ cell, source ] of [ [ 0, 0 ], [ 1, 2 ] ] ) {
					if ( Number.isFinite( expected[source] ) ) assert( Math.abs( plotted[cell] - expected[source] ) < 1e-8 );
					else assert.equal( plotted[cell], '#N/A', 'Unavailable native chart point must remain a gap.' );
				}
			} );
			selectorChecks++;
		}
	}
	sheet.getRange( 'B3:B4' ).values = [ [ 1 ], [ 1 ] ];

	return { sheet, charts, selectorChecks, cohorts: cohorts.length, candidates: candidates.length, plotStart };
}

module.exports = { addCharts };
