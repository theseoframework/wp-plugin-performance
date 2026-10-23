/**
 * Offline public-page metadata from verified saved responses, never extra calls.
 */

const fs = require( 'fs' );
const path = require( 'path' );
const crypto = require( 'crypto' );
const { allowedPath } = require( './engine' );

const HTML_SCENARIOS = [ 'home-blog', 'home-static', 'blog-page', 'post', 'page', 'category', 'tag', 'search', '404' ];
const REFERENCES = [
	[ 'Schema.org authors', 'https://schema.org/author' ],
	[ 'Schema.org publishers', 'https://schema.org/publisher' ],
	[ 'WebPage primary images', 'https://schema.org/primaryImageOfPage' ],
	[ 'Article meaning', 'https://schema.org/Article' ],
	[ 'Google description guidance', 'https://developers.google.com/search/docs/appearance/snippet' ],
];
const NOTES = [
	'Observed output, not a feature-capability or SEO-quality score. No means absent in this response; unavailable evidence never becomes No.',
	'Title, canonical and robots can already come from WordPress. Keep the no-plugin baseline visible. A robots tag without explicit index/follow does not imply noindex/nofollow.',
	'WordPress post type and Schema.org content type are different. Person can describe an author or publisher on a page. ImageObject can describe a logo or page image. Article describes article content; it is not restricted to WordPress posts.',
	'Nested objects and multi-typed entities count. URL only denotes a typed URL reference rather than a detailed definition. Roles come from local JSON-LD properties and @id references, without fetching contexts or remote entities.',
	'Explicit Twitter tags and available Open Graph values are reported separately; omission of a duplicate tag alone is not classified as a defect. Social-card rendering was not tested.',
	'Description lengths are observations, without fixed pass/fail cutoffs. Optional schema types and actions are not mandatory just because another candidate emits them. JSON syntax checks do not establish semantic validity or rich-result eligibility.',
	'Output comes from the fastest verified measured response in each exact candidate/runtime/scenario cell, with its round, route and body hash. It does not change with the timing metric selector or describe every response. Footer JSON-LD is included.',
];

/**
 * Decodes numeric and common named HTML references without external resources.
 * @param {string} text
 * @return {string}
 */
function decode( text ) {

	const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', copy: '\u00a9', reg: '\u00ae' };

	return String( text ).replace( /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, ( original, entity ) => {
		if ( '#' !== entity[0] ) return Object.hasOwn( named, entity ) ? named[entity] : original;

		const code = /^#x/i.test( entity ) ? parseInt( entity.slice( 2 ), 16 ) : Number( entity.slice( 1 ) );

		return code > 0 && code <= 0x10ffff && ! ( code >= 0xd800 && code <= 0xdfff ) ? String.fromCodePoint( code ) : '\ufffd';
	} );
}

/**
 * Reads quoted/unquoted attributes; a quoted greater-than sign stays in its tag.
 * @param {string} tag
 * @return {Object}
 */
function attributes( tag ) {

	const result = Object.create( null );
	const pattern = /([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
	pattern.lastIndex = /^<\/?[a-z][\w:-]*/i.exec( tag )?.[0].length || 0;
	let match;
	while ( ( match = pattern.exec( tag ) ) ) {
		const key = match[1].toLowerCase();
		if ( ! Object.hasOwn( result, key ) ) result[key] = decode( match[2] ?? match[3] ?? match[4] ?? '' );
	}

	return result;
}

/**
 * Extracts inert SEO evidence, ignoring comments, templates and raw-text assets.
 * @param {string} body
 * @return {Object}
 */
function parseOutput( body ) {

	const tags = [], schemas = [], errors = [];
	let cursor = 0, head = false, inert = 0;
	while ( cursor < body.length ) {
		const start = body.indexOf( '<', cursor );
		if ( start < 0 ) break;
		if ( body.startsWith( '<!--', start ) ) {
			const close = body.indexOf( '-->', start + 4 );
			cursor = close < 0 ? body.length : close + 3;
			continue;
		}
		let quote = '', end = start + 1;
		for ( ; end < body.length; ++end ) {
			const character = body[end];
			if ( quote ) {
				if ( character === quote ) quote = '';
			} else if ( '"' === character || "'" === character ) quote = character;
			else if ( '>' === character ) break;
		}
		if ( end === body.length ) break;
		cursor = end + 1;
		const raw = body.slice( start, cursor );
		const name = /^<(\/?)([a-z][\w:-]*)\b/i.exec( raw );
		if ( ! name ) continue;
		const tag = name[2].toLowerCase(), closing = !! name[1];
		if ( 'head' === tag ) head = ! closing;
		if ( [ 'template', 'noscript' ].includes( tag ) ) inert = Math.max( 0, inert + ( closing ? -1 : 1 ) );
		if ( closing ) continue;
		const attrs = attributes( raw );
		if ( [ 'script', 'style', 'title', 'textarea', 'xmp' ].includes( tag ) ) {
			const close = new RegExp( `</${tag}\\s*>`, 'gi' );
			close.lastIndex = cursor;
			const ending = close.exec( body );
			const content = body.slice( cursor, ending ? ending.index : body.length );
			cursor = ending ? close.lastIndex : body.length;
			if ( inert ) continue;
			if ( 'title' === tag && head ) tags.push( { key: 'title', value: decode( content ), raw: body.slice( start, cursor ) } );
			if ( 'script' === tag && 'application/ld+json' === ( attrs.type || '' ).split( ';' )[0].trim().toLowerCase() ) {
				const entry = { location: head ? 'head' : 'body/footer', raw: body.slice( start, cursor ), json: null };
				try {
					if ( attrs.src ) throw new Error( 'External JSON-LD was not fetched.' );
					entry.json = JSON.parse( content.trim() );
					if ( ! entry.json || 'object' !== typeof entry.json ) throw new Error( 'JSON-LD is not an object or array.' );
				} catch ( error ) {
					entry.error = error.message.slice( 0, 240 );
					errors.push( entry.error );
				}
				schemas.push( entry );
			}
			continue;
		}
		if ( inert || ! head ) continue;
		if ( 'meta' === tag ) {
			const key = ( attrs.name || attrs.property || '' ).toLowerCase();
			if ( [ 'description', 'robots', 'googlebot', 'bingbot', 'keywords', 'author' ].includes( key ) || /^(og|article|twitter):/.test( key ) )
				tags.push( { key, value: attrs.content || '', raw } );
		} else if ( 'link' === tag ) {
			for ( const key of ( attrs.rel || '' ).toLowerCase().split( /\s+/ ) ) {
				if ( [ 'canonical', 'prev', 'next', 'publisher' ].includes( key ) ) tags.push( { key, value: attrs.href || '', raw } );
			}
		}
	}
	const entities = [], references = [];
	const visit = ( value, trail = '$', role = 'graph' ) => {
		if ( ! value || 'object' !== typeof value ) return;
		if ( Array.isArray( value ) ) {
			value.forEach( ( item, index ) => visit( item, `${trail}[${index}]`, role ) );
			return;
		}
		const types = ( Array.isArray( value['@type'] ) ? value['@type'] : [ value['@type'] ] ).filter( item => 'string' === typeof item ).map( item => item.replace( /^https?:\/\/(?:www\.)?schema\.org\//, '' ) );
		if ( types.length ) entities.push( { types, id: value['@id'] || '', path: trail, roles: [ role ], urlOnly: Object.keys( value ).every( key => [ '@type', '@id', 'url' ].includes( key ) ) } );
		if ( 'string' === typeof value['@id'] && 'graph' !== role ) references.push( { id: value['@id'], role } );
		for ( const [ key, child ] of Object.entries( value ) ) {
			if ( ! key.startsWith( '@' ) || '@graph' === key ) visit( child, `${trail}.${key}`, '@graph' === key ? 'graph' : key );
		}
	};
	schemas.forEach( ( script, index ) => visit( script.json, `$[${index}]` ) );
	for ( const entity of entities ) entity.roles = [ ...new Set( [ ...entity.roles, ...references.filter( item => entity.id && item.id === entity.id ).map( item => item.role ) ] ) ];

	return { tags, schemas, entities, errors };
}

/**
 * Builds generic comparison cells without product-specific expectations or scores.
 * @param {Object} parsed
 * @return {Object}
 */
function outputCells( parsed ) {

	const cells = {}, features = [];
	const add = ( id, label, group, value ) => { features.push( { id, label, group } ); cells[id] = value; };
	const values = key => parsed.tags.filter( tag => tag.key === key ).map( tag => tag.value );
	const present = key => values( key ).length ? ( values( key ).some( Boolean ) ? 'Yes' : 'Empty' ) : 'No';
	for ( const key of [ 'title', 'canonical', 'robots', 'description' ] ) add( key, 'description' === key ? 'HTML meta description' : key, 'Document metadata', present( key ) );
	add( 'description.characters', 'Description characters', 'Document metadata', values( 'description' ).length ? values( 'description' ).map( value => /&[a-z][a-z0-9]+;/i.test( value ) ? 'Unresolved HTML entities' : Array.from( value ).length ).join( ' / ' ) : 'No' );
	add( 'robots.value', 'Robots value', 'Document metadata', values( 'robots' ).join( ' / ' ) || 'No' );
	for ( const key of [ 'googlebot', 'bingbot', 'keywords', 'og:title', 'og:description', 'og:url', 'og:site_name', 'og:locale', 'og:image', 'twitter:title', 'twitter:description', 'twitter:image', 'article:published_time', 'article:modified_time', 'og:updated_time' ] )
		add( key, key, key.startsWith( 'og:' ) || key.startsWith( 'twitter:' ) || key.startsWith( 'article:' ) ? 'Social metadata' : 'Document metadata', present( key ) );
	for ( const key of [ 'og:type', 'twitter:card' ] ) add( `${key}.value`, key, 'Social metadata', values( key ).join( ' / ' ) || 'No' );
	for ( const key of [ 'title', 'description', 'image' ] ) add( `twitter.${key}.source`, `Twitter ${key} values`, 'Social metadata', 'Yes' === present( `twitter:${key}` ) ? 'Explicit' : ( 'Yes' === present( `og:${key}` ) ? 'Open Graph available' : 'No' ) );
	add( 'jsonld.location', 'JSON-LD location', 'JSON-LD', parsed.schemas.map( script => script.location ).join( ' / ' ) || 'No' );
	for ( const type of [ 'WebSite', 'WebPage', 'Organization', 'Person', 'BreadcrumbList', 'SearchAction', 'ReadAction', 'Article', 'ImageObject' ] ) {
		const found = parsed.entities.filter( entity => entity.types.includes( type ) );
		const absent = parsed.errors.length ? 'Unparsed JSON-LD' : 'No';
		add( `schema.${type}`, type, 'JSON-LD', found.length ? ( found.every( entity => entity.urlOnly ) ? 'URL only' : 'Yes' ) : absent );
		if ( [ 'Person', 'ImageObject' ].includes( type ) ) add( `schema.${type}.roles`, `${type} roles`, 'JSON-LD', found.length ? [ ...new Set( found.flatMap( entity => entity.roles ).filter( role => 'graph' !== role ) ) ].join( ' / ' ) || 'Graph; no local role link' : absent );
	}
	add( 'tags.count', 'Selected SEO tags', 'Evidence', parsed.tags.length );
	add( 'jsonld.count', 'JSON-LD scripts', 'Evidence', parsed.schemas.length );
	add( 'jsonld.errors', 'JSON-LD parse issues', 'Evidence', parsed.errors.length );
	add( 'duplicates', 'Duplicate SEO keys', 'Evidence', [ ...new Set( parsed.tags.map( tag => tag.key ) ) ].filter( key => values( key ).length > 1 ).join( ' / ' ) || 'No' );

	return { features, cells };
}

/**
 * Joins raw measured minima to exact saved bodies, keeping missing evidence explicit.
 * @param {string} output
 * @param {Object[]} summaries
 * @param {Object[]} blocks
 * @param {Map} minima
 * @return {Object}
 */
function outputComparisons( output, summaries, blocks, minima ) {

	const records = [];
	const features = outputCells( { tags: [], schemas: [], entities: [], errors: [] } ).features;
	for ( const summary of summaries.filter( row => HTML_SCENARIOS.includes( row.scenario ) ) ) {
		const record = {
			candidate: summary.candidate, pluginVersion: summary.pluginVersion, baseline: summary.baseline,
			wp: summary.wp, php: summary.php, scenario: summary.scenario, frame: summary.frame,
			cohort: summary.cohort, runtimeGroup: summary.runtimeGroup, status: 'unavailable', cells: {},
			context: 'post' === summary.scenario ? 'WordPress post' : ( [ 'page', 'home-static' ].includes( summary.scenario ) ? 'WordPress page' : 'public query/archive' ),
		};
		records.push( record );
		try {
			if ( ! summary.eligible ) throw new Error( 'Timing cell is ineligible; its output is not a confirmed comparison.' );
			const matching = blocks.filter( block => block.candidate === summary.candidate && block.wp === summary.wp && block.php === summary.php && block.scenario === summary.scenario );
			const chosen = matching.map( block => ( { block, row: minima.get( block.blockId ) } ) ).filter( item => item.row ).sort( ( a, b ) => a.row.elapsedMs - b.row.elapsedMs )[0];
			if ( ! chosen || chosen.row.elapsedMs !== summary.minimumMs ) throw new Error( 'No accepted raw minimum matches this cell.' );
			const { block, row } = chosen;
			if ( [ 'candidate', 'wp', 'php', 'scenario', 'round' ].some( key => row[key] !== block[key] ) ) throw new Error( 'Raw minimum belongs to a different block context.' );
			if ( ! /^[a-z0-9-]+$/i.test( block.blockId ) ) throw new Error( 'Unsafe saved response identifier.' );
			const source = `${block.blockId}.fastest.json`;
			const file = allowedPath( path.join( output, source ) );
			if ( ! fs.existsSync( file ) ) throw new Error( 'Saved fastest response is missing; no new request was made.' );
			const response = JSON.parse( fs.readFileSync( file, 'utf8' ) );
			if ( 'string' !== typeof response.body ) throw new Error( 'Saved response has no body.' );
			const hash = crypto.createHash( 'sha256' ).update( response.body ).digest( 'hex' );
			if ( response.sha256 !== hash || row.sha256 !== hash || row.elapsedMs !== response.elapsedMs
				|| ! row.executionToken || row.executionToken !== row.responseToken || response.executionToken !== row.responseToken
				|| '0' !== String( row.userId ) || '0' !== String( response.userId )
				|| row.route !== response.route || ! row.route || row.status !== response.status || row.contentType !== response.contentType
				|| ! /^text\/html(?:;|$)/i.test( response.contentType || '' ) ) throw new Error( 'Saved response failed hash, minimum, token, user, route, status or HTML checks.' );
			const parsed = parseOutput( response.body );
			Object.assign( record, { status: 'available', source, sha256: hash, round: block.round, blockId: block.blockId,
				route: response.route, elapsedMs: response.elapsedMs, responseStatus: response.status,
				cells: outputCells( parsed ).cells, ...parsed } );
		} catch ( error ) {
			record.reason = error.message;
		}
	}

	return { version: 1, htmlScenarios: HTML_SCENARIOS, features, records, notes: NOTES, references: REFERENCES };
}

/**
 * Writes a complete offline matrix by exact cohort, without executing raw markup.
 * @param {Object} comparison
 * @return {string}
 */
function outputMarkdown( comparison ) {

	const escape = value => String( value ).replace( /&/g, '&amp;' ).replace( /</g, '&lt;' ).replace( />/g, '&gt;' ).replace( /[\\|`*_[\]]/g, '\\$&' ).replace( /[\r\n]+/g, ' ' );
	const lines = [ '# Front-end output comparison', '', ...comparison.notes.map( note => `- ${note}` ), '' ];
	for ( const cohort of new Set( comparison.records.map( record => record.cohort ) ) ) {
		const records = comparison.records.filter( record => record.cohort === cohort );
		const first = records[0];
		lines.push( `## ${first.scenario}: WP ${first.wp} / PHP ${first.php}, ${first.frame}`, '',
			`| Output | ${records.map( record => escape( `${record.candidate} ${record.pluginVersion}${record.baseline ? ' (WordPress control)' : ''}` ) ).join( ' | ' )} |`,
			`| --- | ${records.map( () => '---' ).join( ' | ' )} |` );
		for ( const feature of comparison.features ) lines.push( `| ${escape( feature.label )} | ${records.map( record => escape( 'available' === record.status ? record.cells[feature.id] : 'Unavailable' ) ).join( ' | ' )} |` );
		lines.push( '' );
		for ( const record of records ) {
			lines.push( `### ${escape( record.candidate )}: ${record.context}`, '' );
			if ( 'available' !== record.status ) {
				lines.push( record.reason, '' );
				continue;
			}
			const markup = [ ...record.tags.map( tag => tag.raw ), ...record.schemas.map( script => script.raw ) ].join( '\n' );
			const fence = '`'.repeat( Math.max( 3, ...[ ...markup.matchAll( /`+/g ) ].map( match => match[0].length + 1 ) ) );
			lines.push( `Round ${record.round}; route ${record.route}; ${record.elapsedMs} ms. Body SHA-256: ${record.sha256}.`, '',
				`[Saved complete response](${record.source})`, '', `${fence}html`, markup, fence, '' );
		}
	}
	lines.push( '## Interpretation references', '', ...comparison.references.map( ( [ label, url ] ) => `- [${label}](${url})` ), '' );

	return lines.join( '\n' );
}

module.exports = { HTML_SCENARIOS, parseOutput, outputCells, outputComparisons, outputMarkdown };
