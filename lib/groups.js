/**
 * Equal-weight scenario averages over one common, exact workload set.
 * Admin GET pages and authenticated save requests are separate populations.
 */

const GROUPS = {
	'front-end': { label: 'Front end (HTML)', scenarios: [ 'home-blog', 'home-static', 'blog-page', 'post', 'page', 'category', 'tag', 'search', '404' ] },
	'back-end': { label: 'Back end', scenarios: [ 'dashboard', 'posts-list', 'pages-list', 'post-editor', 'page-editor' ] },
	saving: { label: 'Save operations', scenarios: [ 'editor-save' ] },
};

const GROUP_METRICS = {
	leadingMs: { value: 'averageLeadingMs', delta: 'baselineDeltaMs', label: 'Mean of scenario minima' },
	medianMs: { value: 'averageMedianMs', delta: 'baselineMedianDeltaMs', label: 'Mean of scenario medians' },
	meanMs: { value: 'averageRequestMs', delta: 'baselineRequestDeltaMs', label: 'Mean request time, equal scenario weight' },
};

/**
 * Returns an arithmetic mean only when the whole nonempty set is numeric.
 *
 * @param {number[]} values
 * @return {number|null}
 */
function average( values ) {

	if ( ! values.length || ! values.every( Number.isFinite ) ) return null;

	return values.reduce( ( sum, value ) => sum + value, 0 ) / values.length;
}

/**
 * Uses the intersection of eligible scenarios across all intended candidates.
 * Missing candidates, unlike deferred ones, cannot silently disappear.
 *
 * @param {Object[]} summaries
 * @param {Object} manifest
 * @return {Object[]}
 */
function aggregateGroups( summaries, manifest ) {

	const requested = manifest.config.scenarios;
	const declared = manifest.candidates?.map( item => item.id );
	const candidates = [ ...new Set( declared?.length ? declared : summaries.map( row => row.candidate ) ) ];
	const deferred = new Set( ( manifest.exclusions || [] ).filter( item => ! item.scenario ).map( item => item.candidate ) );
	const participants = candidates.filter( id => ! deferred.has( id ) );
	const runtimeGroups = [ ...new Set( summaries.filter( row => row.runtimeGroup && JSON.parse( row.runtimeGroup ).length > 2 ).map( row => row.runtimeGroup ) ) ];
	const output = [];
	for ( const runtimeGroup of runtimeGroups ) {
		const rows = summaries.filter( row => row.runtimeGroup === runtimeGroup );
		const runtime = rows[0];
		for ( const [ group, definition ] of Object.entries( GROUPS ) ) {
			const planned = definition.scenarios.filter( scenario => ! Array.isArray( requested ) || requested.includes( scenario ) );
			const common = planned.filter( scenario => {
				const matches = participants.map( candidate => rows.filter( row => row.candidate === candidate && row.scenario === scenario ) );

				return matches.length > 0
					&& matches.every( items => 1 === items.length && items[0].eligible && [ items[0].leadingMs, items[0].medianMs, items[0].meanMs ].every( Number.isFinite ) )
					&& 1 === new Set( matches.map( items => items[0].cohort ) ).size;
			} );
			for ( const candidate of participants ) {
				const record = rows.find( row => row.candidate === candidate ) || manifest.candidates?.find( item => item.id === candidate );
				const members = common.map( scenario => rows.find( row => row.candidate === candidate && row.scenario === scenario ) );
				const ids = new Set( members.map( row => row.baselineCandidate ).filter( Boolean ) );
				const controlId = members.length && members.every( row => row.baselineCandidate ) && 1 === ids.size ? [ ...ids ][0] : '';
				const controls = controlId ? members.map( row => rows.find( item => item.candidate === controlId && item.cohort === row.cohort && item.baseline && item.eligible ) ) : [];
				const matched = controls.length === members.length && members.length > 0 && controls.every( Boolean );
				const leading = average( members.map( row => row.leadingMs ) );
				const median = average( members.map( row => row.medianMs ) );
				const mean = average( members.map( row => row.meanMs ) );
				const coreLeading = matched ? average( controls.map( row => row.leadingMs ) ) : null;
				const coreMedian = matched ? average( controls.map( row => row.medianMs ) ) : null;
				const coreMean = matched ? average( controls.map( row => row.meanMs ) ) : null;
				const measured = members.reduce( ( sum, row ) => sum + row.valid, 0 );
				output.push( {
					candidate, pluginVersion: record?.pluginVersion || record?.version || 'unresolved', baseline: !! record?.baseline,
					wp: runtime.wp, php: runtime.php, runtimeGroup, group, groupLabel: definition.label,
					eligible: common.length > 0,
					status: ! common.length ? 'unavailable' : ( common.length < planned.length ? 'partial coverage' : ( members.some( row => 'provisional' === row.status ) ? 'provisional' : 'valid' ) ),
					scenarioCount: common.length, requestedScenarioCount: planned.length,
					measuredCalls: measured, attemptedCalls: members.reduce( ( sum, row ) => sum + row.attempted, 0 ),
					warmupCalls: members.reduce( ( sum, row ) => sum + row.warmupValid, 0 ),
					saveCalls: 'saving' === group ? measured : 0,
					averageLeadingMs: leading, averageMedianMs: median, averageRequestMs: mean,
					baselineCandidate: matched ? controlId : '', baselineLeadingMs: coreLeading, baselineMedianMs: coreMedian, baselineRequestMs: coreMean,
					baselineDeltaMs: matched ? leading - coreLeading : null,
					baselineMedianDeltaMs: matched ? median - coreMedian : null,
					baselineRequestDeltaMs: matched ? mean - coreMean : null,
					scenarios: common.join( '; ' ), excludedScenarios: planned.filter( scenario => ! common.includes( scenario ) ).join( '; ' ),
					participants: participants.join( '; ' ), memberCohorts: members.map( row => row.cohort ),
					note: ! planned.length ? 'No scenario in this group was requested.' : ( ! common.length ? 'No common eligible workload across all intended candidates.' : 'Equal weight per included scenario; saves excluded from back end. Feature endpoints stay separate. Descriptive fixture average, not a traffic model.' ),
				} );
			}
		}
	}

	return output;
}

module.exports = { GROUPS, GROUP_METRICS, average, aggregateGroups };
