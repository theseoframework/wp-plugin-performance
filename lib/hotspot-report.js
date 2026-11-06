/** Offline per-request function diagnostics; no product leaderboard. */
const fs = require( 'fs' );
const path = require( 'path' );
const { csvField } = require( './report' );
const disclaimer = require( './disclaimer' );

/** Escapes profile-derived names and source paths before HTML rendering. */
function html( value ) {
	return String( value ).replace( /[&<>"']/g, character => ( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } )[character] );
}

/** Makes serialized profile data safe inside an HTML script element. */
function embedJSON( json ) {
	return json.replace( /[<>&\u2028\u2029]/g, character => '\\u' + character.charCodeAt( 0 ).toString( 16 ).padStart( 4, '0' ) );
}

/** Browses each captured request independently, with direct caller/callee edges. */
function browser() {
	const data = JSON.parse( document.getElementById( 'data' ).textContent );
	const select = document.getElementById( 'profile' ), search = document.getElementById( 'search' );
	const scope = document.getElementById( 'plugin' ), sort = document.getElementById( 'sort' );
	const body = document.getElementById( 'functions' ), details = document.getElementById( 'edges' );
	for ( const [ index, item ] of data.profiles.entries() ) {
		const option = document.createElement( 'option' );
		option.value = index; option.textContent = item.label; select.append( option );
	}
	scope.checked = data.profiles[0]?.nodes.some( node => node.plugin ) || false;
	function draw() {
		body.replaceChildren(); details.textContent = '';
		const profile = data.profiles[select.value || 0];
		if ( ! profile ) return;

		document.getElementById( 'context' ).textContent = `${profile.creator}; profiled request ${profile.totalMs.toFixed( 3 )} ms. This is instrumented time, not user latency.`;
		const nodes = profile.nodes.filter( node => ( ! scope.checked || node.plugin ) && `${node.function} ${node.file}`.toLowerCase().includes( search.value.toLowerCase() ) );
		nodes.sort( ( a, b ) => b[sort.value] - a[sort.value] );
		const names = new Map( profile.nodes.map( node => [ node.key, node.function ] ) );
		for ( const node of nodes ) {
			const row = document.createElement( 'tr' );
			for ( const value of [ node.function, node.file, node.calls, node.selfMs.toFixed( 4 ), node.inclusiveMs.toFixed( 4 ) ] ) {
				const cell = document.createElement( 'td' ); cell.textContent = value; row.append( cell );
			}
			row.tabIndex = 0;
			const show = () => {
				const lines = [ node.function, 'Direct caller/callee edges (inclusive costs overlap):' ];
				for ( const edge of profile.edges.filter( edge => edge.caller === node.key || edge.callee === node.key ) )
					lines.push( `${names.get( edge.caller )} → ${names.get( edge.callee )}: ${edge.calls} calls, ${edge.inclusiveMs.toFixed( 4 )} ms` );
				details.textContent = lines.join( '\n' );
			};
			row.onclick = show;
			row.onkeydown = event => { if ( event.key === 'Enter' || event.key === ' ' ) { event.preventDefault(); show(); } };
			body.append( row );
		}
	}
	for ( const element of [ select, search, scope, sort ] ) element.addEventListener( 'input', draw );
	draw();
}

/** Writes lossless function/edge JSON and CSV plus a self-contained HTML viewer. */
function write( output, profiles, metadata = {} ) {

	fs.mkdirSync( output, { recursive: true } );
	const data = { kind: 'wp-hotspot-report-v1', disclaimer, ...metadata, profiles };
	const json = JSON.stringify( data, null, '\t' );
	const provenance = JSON.stringify( {
		environment: metadata.environment ?? 'Not recorded', runtime: metadata.runtime ?? 'Not recorded',
		plugin: metadata.plugin ?? 'Not recorded', sourceSnapshot: metadata.sourceSnapshot ?? 'Not recorded',
		sourceManifestSha256: metadata.sourceManifestSha256 ?? 'Not recorded',
	}, null, 2 );
	fs.writeFileSync( path.join( output, 'provenance.json' ), JSON.stringify( { requestValidation: metadata.requestValidation || 'Not recorded', ...JSON.parse( provenance ) }, null, '\t' ) + '\n', { flag: 'wx' } );
	fs.writeFileSync( path.join( output, 'hotspots.json' ), json + '\n', { flag: 'wx' } );
	for ( const [ file, fields, values ] of [
		[ 'functions.csv', [ 'profile', 'file', 'function', 'plugin', 'calls', 'selfMs', 'inclusiveMs' ], profiles.flatMap( profile => profile.nodes.map( node => ( { profile: profile.label, ...node } ) ) ) ],
		[ 'edges.csv', [ 'profile', 'caller', 'callee', 'calls', 'inclusiveMs' ], profiles.flatMap( profile => profile.edges.map( edge => ( { profile: profile.label, ...edge } ) ) ) ],
	] ) fs.writeFileSync( path.join( output, file ), [ fields.join( ',' ), ...values.map( row => fields.map( field => csvField( row[field] ) ).join( ',' ) ) ].join( '\n' ) + '\n', { flag: 'wx' } );
	const embedded = embedJSON( json );
	const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>WordPress plugin hotspots</title>
<style>body{font:16px system-ui;max-width:1500px;margin:2rem auto;padding:0 1rem;color:#182233}aside{padding:1rem;background:#fff3cd}label{display:inline-block;margin:1rem}table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:.5rem;border-bottom:1px solid #ccd;text-align:left;overflow-wrap:anywhere}tr:focus,tr:hover{background:#edf5ff}pre{white-space:pre-wrap}input,select{font:inherit;max-width:100%}</style>
<h1>WordPress plugin hotspots</h1><aside>${html( disclaimer )}</aside><p>${html( metadata.requestValidation || 'Request qualification and source/runtime identity are recorded in manifest.json.' )}</p><p>Each profile is one instrumented request. Repeated requests remain separate. Calls count profiler entries; recursive and generator calls need interpretation. Click a function to inspect callers and callees. Raw Cachegrind files can also be opened in KCachegrind or QCachegrind.</p>
<nav><a href="hotspots.json">Complete JSON</a> · <a href="provenance.json">Runtime/source provenance</a> · <a href="functions.csv">Functions CSV</a> · <a href="edges.csv">Edges CSV</a> · <a href="report.md">Interpretation</a></nav>
<details open><summary>Recorded runtime and source identity</summary><pre id="provenance">${html( provenance )}</pre></details>
<label>Request <select id="profile"></select></label><label>Search <input id="search" type="search"></label><label><input id="plugin" type="checkbox" checked> Plugin functions only</label><label>Sort <select id="sort"><option value="selfMs">Self time</option><option value="inclusiveMs">Inclusive time</option><option value="calls">Calls</option></select></label><p id="context"></p>
<table><thead><tr><th>Function</th><th>File</th><th>Calls</th><th>Self ms</th><th>Inclusive ms</th></tr></thead><tbody id="functions"></tbody></table><pre id="edges" aria-live="polite"></pre>
<script id="data" type="application/json">${embedded}</script><script>(${browser.toString()})();</script></html>`;
	fs.writeFileSync( path.join( output, 'report.html' ), page, { flag: 'wx' } );
	fs.writeFileSync( path.join( output, 'report.md' ), `# WordPress plugin hotspots\n\n${disclaimer}\n\nSelf time excludes callees. Inclusive time includes them: do not add parent and child totals. Inspect call counts and edges, then benchmark the proposed change without Xdebug on representative native hosting. No competitor ranking or projected production saving is established.\n\nProfiles: ${profiles.length}. Raw evidence remains immutable. Review request validation, source hashes and runtime in manifest.json when present. The report includes WordPress and internal callees; the plugin filter selects the configured virtual directory.\n`, { flag: 'wx' } );
	// Indent untrusted manifest text so it remains literal Markdown code.
	fs.appendFileSync( path.join( output, 'report.md' ), `\nRecorded runtime and source identity (also in provenance.json):\n\n${JSON.stringify( { requestValidation: metadata.requestValidation || 'Not recorded', ...JSON.parse( provenance ) }, null, 2 ).split( '\n' ).map( line => '    ' + line ).join( '\n' )}\n` );
	return data;
}

module.exports = { write, html, embedJSON };
