/** Shared one-plugin boundary for plans, saved reports and exports. */

/** Requires explicit identity rather than trusting display labels or old ranks. */
function pluginScope( candidates ) {

	if ( ! Array.isArray( candidates ) || ! candidates.length ) throw new Error( 'Explicit plugin identity metadata is required; cross-plugin reports are unsupported.' );

	const byId = new Map();
	for ( const item of candidates ) {
		if ( item.extraPlugins?.length ) throw new Error( 'Single-plugin diagnostics do not activate additional plugins.' );
		if ( ! item.id || ! /^[a-z0-9-]+$/.test( item.slug || '' ) || typeof item.mainFile !== 'string' || ! item.mainFile || byId.has( item.id ) )
			throw new Error( 'Each version needs a unique ID, plugin slug and mainFile.' );

		byId.set( item.id, item );
	}
	const first = candidates[0];
	if ( candidates.some( item => item.slug !== first.slug || item.mainFile !== first.mainFile ) )
		throw new Error( 'Cross-plugin comparisons are unsupported. Select versions of one plugin with the same slug and mainFile.' );

	return { slug: first.slug, mainFile: first.mainFile, byId };
}

/** Checks both declared and resolved identities before reading report samples. */
function manifestScope( manifest ) {

	const scope = pluginScope( manifest.config?.candidates || manifest.candidates );
	if ( manifest.candidates?.length ) {
		const resolved = pluginScope( manifest.candidates );
		if ( resolved.slug !== scope.slug || resolved.mainFile !== scope.mainFile ) throw new Error( 'Resolved plugin identity differs from the plan.' );

		for ( const item of manifest.candidates ) {
			const declared = scope.byId.get( item.id );
			if ( ! declared || !! item.baseline !== !! declared.baseline ) throw new Error( 'Resolved version is missing or inconsistent in the plan.' );
		}
	}
	return scope;
}

/** Rejects undeclared sample groups instead of comparing unknown products. */
function validateRows( scope, rows ) {
	for ( const row of rows ) {
		if ( Object.hasOwn( row, 'rank' ) ) throw new Error( 'Ranking fields are unsupported; rebuild a same-plugin report from raw checkpoints.' );
		const item = scope.byId.get( row.candidate );
		if ( ! item || !! row.baseline !== !! item.baseline ) throw new Error( 'Saved timing rows need matching one-plugin identity metadata.' );
	}
}

module.exports = { pluginScope, manifestScope, validateRows };
