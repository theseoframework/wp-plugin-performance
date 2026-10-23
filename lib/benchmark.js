/**
 * Measures isolated versions of one plugin through wp-plugin-regression.
 *
 * Usage: node benchmark.js --config <plan.json> [--smoke|--prepare|--session <file>]
 */

const crypto = require( 'crypto' );
const fs     = require( 'fs' );
const http   = require( 'http' );
const os     = require( 'os' );
const path   = require( 'path' );
const {
	ROOT, SKILL, allowedPath, engineDirectory, assertPerformanceEngine, engineCommand,
	resolvePHP, compareVersion, phpFingerprint, prepareCandidate, stopSession,
} = require( './engine' );
const { request, validate } = require( './measure' );
const { readTemperature }   = require( './temperature' );
const { readCPUCounters, cpuLoad } = require( './cpu' );
const { readCPUClock } = require( './clock' );
const { saveBlock, report } = require( './report' );
const { normalizeConfig, validateDesign, validatePreparedControls, candidateOrder } = require( './controls' );
const { collectCacheSnapshots, assessCacheWorkers, validateCacheProfile } = require( './cache' );

/**
 * Parses named command arguments without shell interpretation.
 *
 * @param {string[]} argv
 * @return {Object}
 */
function argumentsFrom( argv ) {

	const args = {};
	for ( let index = 0; index < argv.length; ++index ) {
		const match = /^--([a-z-]+)(?:=(.*))?$/.exec( argv[index] );
		if ( ! match ) throw new Error( `Unexpected argument: ${argv[index]}` );

		args[match[1]] = match[2] ?? ( argv[index + 1] && ! argv[index + 1].startsWith( '--' ) ? argv[++index] : true );
	}

	return args;
}

/**
 * Loads a plan and applies explicit smoke/matrix/sample overrides.
 *
 * @param {string} file
 * @param {Object} args
 * @return {Object}
 */
function configuration( file, args ) {

	const input = normalizeConfig( JSON.parse( fs.readFileSync( allowedPath( file ), 'utf8' ) ) );
	const config = {
		wp: [ 'latest' ], php: [ 'auto' ], samples: 100, rounds: 1,
		warmups: 12, workers: 6, fastestCount: 1000, opcacheMode: 'auto',
		outlierReference: 'median', outlierFraction: 0.8,
		timeoutMs: 30000, maxInvalid: 3,
		...input,
	};
	if ( args.smoke ) Object.assign( config, { samples: 3, rounds: 1, warmups: 6 } );

	for ( const key of [ 'samples', 'rounds', 'warmups' ] ) {
		if ( args[key] ) config[key] = Number( args[key] );
	}
	for ( const key of [ 'wp', 'php' ] ) {
		if ( args[key] ) config[key] = String( args[key] ).split( ',' );
	}
	if ( args.scenarios ) config.scenarios = String( args.scenarios ).split( ',' );
	if ( args['opcache-mode'] ) config.opcacheMode = args['opcache-mode'];
	if ( ! [ 'auto', 'memory', 'file', 'off' ].includes( config.opcacheMode ) )
		throw new Error( 'opcacheMode must be auto, memory, file or off. PHP JIT is unavailable in PHP-WASM.' );
	if ( args.fairness && args['comparison-mode'] && args.fairness !== args['comparison-mode'] )
		throw new Error( 'Conflicting comparison-mode flags.' );

	if ( args['comparison-mode'] || args.fairness ) config.comparisonMode = args['comparison-mode'] || args.fairness;
	if ( args['baseline-candidate'] ) config.baselineCandidate = args['baseline-candidate'];
	if ( args.candidate ) config.candidates = config.candidates.filter( item => item.id === args.candidate );

	if (
		   ! Array.isArray( config.candidates ) || ! config.candidates.length
		|| ! Array.isArray( config.wp ) || ! config.wp.length
		|| ! Array.isArray( config.php ) || ! config.php.length
	)
		throw new Error( 'Plan needs candidates, WordPress versions, and PHP versions.' );
	if ( args.smoke || args.prepare || args.session ) {
		config.comparisonMode = 'standard';
		if ( ! config.candidates.some( item => item.id === config.baselineCandidate ) ) delete config.baselineCandidate;
	}

	if ( config.scenarios && ( ! Array.isArray( config.scenarios ) || ! config.scenarios.length ) )
		throw new Error( 'Select at least one scenario.' );

	for ( const name of [ 'temperatureCommand', 'clockCommand' ] ) {
		if ( config[name] && ( ! Array.isArray( config[name] ) || ! config[name].length || config[name].some( item => 'string' !== typeof item ) ) )
			throw new Error( `${name} must be a non-empty command/argument string array.` );
	}

	if ( config.playgroundCli )
		config.playgroundCli = allowedPath( path.resolve( ROOT, config.playgroundCli ) );

	if ( new Set( config.candidates.map( item => item.id ) ).size !== config.candidates.length )
		throw new Error( 'Candidate IDs must be unique.' );

	for ( const key of [ 'samples', 'rounds', 'warmups', 'workers', 'fastestCount', 'timeoutMs', 'maxInvalid' ] ) {
		if ( ! Number.isInteger( config[key] ) || config[key] < 1 )
			throw new Error( `${key} must be a positive integer.` );
	}
	if ( config.rounds > config.samples ) throw new Error( 'Each round needs at least one measured sample.' );

	if ( ! [ 'mean', 'median' ].includes( config.outlierReference ) || ! Number.isFinite( config.outlierFraction ) || config.outlierFraction <= 0 )
		throw new Error( 'Invalid high-outlier policy.' );

	for ( const candidate of config.candidates ) {
		if ( ! /^[a-z0-9-]+$/.test( candidate.id ) || ! candidate.mainFile || ! candidate.slug )
			throw new Error( 'Each candidate needs a safe id, slug, and mainFile.' );
	}
	validateDesign( config );
	require( './plugin-scope' ).pluginScope( config.candidates );

	return config;
}

/**
 * Sends a keyed control request, outside measured request timing.
 *
 * @param {Object} session
 * @param {Object} body
 * @return {Promise<Object>}
 */
async function control( session, body ) {

	const key = fs.readFileSync( allowedPath( path.join( session.siteDirectory, 'mu-plugins/wpr-performance.key' ) ), 'utf8' ).trim();
	const response = await request( `${session.run.url}/?wpr-performance=1`, {
		agent: false,
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-WPR-Perf-Key': key },
		body: JSON.stringify( body ),
		timeoutMs: 'seed' === body.action ? 120000 : 30000,
	} );
	let data;
	try {
		data = JSON.parse( response.body );
	} catch {
		throw new Error( `Control ${body.action}: ${response.error || 'HTTP ' + response.status}; non-JSON: ${response.body.slice( 0, 500 )}` );
	}
	if ( 200 !== response.status || data.error ) throw new Error( data.error || `Control HTTP ${response.status}` );

	return { data, cookies: ( response.headers['set-cookie'] || [] ).map( item => item.split( ';' )[0] ).join( '; ' ) };
}

/**
 * Starts a fresh uniquely named site and records its exact process ownership.
 * Launch failures are cleaned up without stopping other chats' sites.
 *
 * @param {string} engine
 * @param {Object} candidate
 * @param {string} wp
 * @param {string} php
 * @param {Object} context
 * @return {Promise<Object>}
 */
async function launchSession( engine, candidate, wp, php, context ) {

	require( './plugin-scope' ).pluginScope( [ candidate ] );
	const { readRuns, siteDir } = require( path.join( engine, 'lib/state.js' ) );
	const id   = `perf-${crypto.randomUUID().slice( 0, 12 )}`;
	const file = path.join( context.output, `${id}.plugin.json` );
	const isolated = require( './snapshot' ).snapshotPlugin( candidate, path.join( context.output, `${id}.source` ) );
	const plugin = {
		slug: candidate.slug,
		mainFile: candidate.mainFile,
		dir: isolated.directory,
		activate: ! candidate.baseline,
		mounts: candidate.mounts,
		shims: [
			path.relative( ROOT, context.instrumentationShim || path.join( SKILL, 'mu-plugin/wpr-performance.php' ) ),
			...( context.extraShims || [] ).map( file => path.relative( ROOT, file ) ),
		],
	};
	fs.writeFileSync( file, JSON.stringify( plugin, null, '\t' ) + '\n' );
	const session = {
		kind: 'wp-performance-session-v1', root: ROOT, id,
		configFile: context.configFile, output: context.output,
		candidate, wp, php, round: context.round,
		sourceSnapshot: { directory: isolated.directory, phpSourceSha256: isolated.phpSourceSha256 },
		file: path.join( context.output, `${id}.session.json` ),
	};
	console.log( `Launching ${candidate.id}: WP ${wp}, PHP ${php}, round ${context.round + 1}` );
	try {
		const log = engineCommand( engine, [
			'launch', '--plugin-json', file, `--wp=${wp}`, `--php=${php}`,
			`--site=${id}`, `--workers=${context.config.workers}`,
			`--opcache-mode=${context.config.opcacheMode || 'auto'}`,
			...( context.config.playgroundCli ? [ `--cli=${allowedPath( context.config.playgroundCli )}` ] : [] ),
		], context.launchEnvironment );
		fs.writeFileSync( path.join( context.output, `${id}.launch.log` ), log );
		session.run = readRuns().find( run => run.site === id && run.root === ROOT );
		if ( ! session.run ) throw new Error( 'Engine did not register the fresh site.' );

		session.siteDirectory = allowedPath( siteDir( session.run.slug, session.run.wpVersion, id ) );
		const keyFile = path.join( session.siteDirectory, 'mu-plugins/wpr-performance.key' );
		fs.writeFileSync( keyFile, crypto.randomBytes( 32 ).toString( 'hex' ) + '\n', { mode: 0o600 } );
		session.fixture = ( await control( session, { action: 'seed' } ) ).data;
		session.runtime = ( await control( session, { action: 'manifest' } ) ).data;
		validateCacheProfile( session.runtime.opcache, context.config.opcacheMode, php );
		for ( const [ key, value ] of Object.entries( context.config.expectedRuntime || {} ) ) {
			if ( ! [ 'wp', 'php', 'theme', 'themeVersion', 'phpSapi', 'phpMemoryLimit' ].includes( key ) || session.runtime[key] !== value )
				throw new Error( `Pinned runtime mismatch: ${key}; expected ${value}, received ${session.runtime[key]}.` );
		}
		for ( const [ key, value ] of Object.entries( context.config.expectedFixture || {} ) ) {
			if ( ! [ 'version', 'posts', 'pages', 'contentHash' ].includes( key ) || session.runtime.fixture?.[key] !== value )
				throw new Error( `Pinned fixture mismatch: ${key}.` );
		}
		if ( ! session.runtime.php.startsWith( `${php}.` ) )
			throw new Error( `Requested PHP ${php}, running ${session.runtime.php}.` );

		if ( /^\d+\.\d+(?:\.\d+)?$/.test( context.expectedWP || '' ) && session.runtime.wp !== context.expectedWP )
			throw new Error( `Requested WordPress ${context.expectedWP}, running ${session.runtime.wp}.` );
		if ( ! candidate.baseline && candidate.requiresPHP && compareVersion( session.runtime.php, candidate.requiresPHP ) < 0 )
			throw new Error( `Plugin requires PHP ${candidate.requiresPHP}.` );

		if ( ! candidate.baseline && candidate.requiresWP && compareVersion( session.runtime.wp, candidate.requiresWP ) < 0 )
			throw new Error( `Plugin requires WordPress ${candidate.requiresWP}.` );

		const active = Object.keys( session.runtime.activePlugins );
		const expected = `${candidate.slug}/${candidate.mainFile}`;
		if ( candidate.baseline ? active.length : active.length !== 1 || active[0] !== expected )
			throw new Error( `Unexpected active plugin set: ${active.join( ', ' )}` );

		if ( ! candidate.baseline && session.runtime.activePlugins[expected] !== candidate.version )
			throw new Error( 'The activated plugin version differs from its prepared source.' );

		fs.writeFileSync( session.file, JSON.stringify( session, null, '\t' ) + '\n' );
		console.log( `Ready: ${session.run.url}` );

		return session;
	} catch ( error ) {
		session.run = session.run || readRuns().find( run => run.site === id && run.root === ROOT );
		if ( session.run ) {
			fs.writeFileSync( session.file, JSON.stringify( session, null, '\t' ) + '\n' );
			try {
				stopSession( engine, session );
			} catch ( cleanup ) {
				error.message += `; cleanup failed: ${cleanup.message}; owned session: ${session.file}`;
				error.cleanupFailed = true;
			}
		}

		throw error;
	}
}

/**
 * Applies a version-verified basic wizard profile, preserving default features.
 * TSF and the no-plugin baseline need no wizard to serve their default output.
 *
 * @param {Object} session
 * @param {Object} candidate
 * @return {Promise<Object>}
 */
async function setup( session, candidate ) {

	let profile = candidate.setup;
	if ( profile?.file )
		profile = JSON.parse( fs.readFileSync( allowedPath( path.resolve( ROOT, profile.file ) ), 'utf8' ) );

	if ( ! candidate.baseline && 'autodescription' !== candidate.slug && 'plugin-defaults' !== profile?.method ) {
		if (
			   ! profile || profile.version !== candidate.version
			|| true !== profile.defaultsPreserved || ! profile.evidence
			|| ! [ 'wizard-options', 'wizard-in-session' ].includes( profile.method )
		) {
			throw new Error( `${candidate.id}: needs a version-matched wizard setup profile with defaultsPreserved and evidence. Use --prepare.` );
		}
		const evidence = allowedPath( path.resolve( ROOT, profile.evidence ) );
		if ( ! fs.existsSync( evidence ) ) throw new Error( `Missing setup evidence: ${profile.evidence}` );

		if ( 'wizard-in-session' === profile.method && profile.sessionId !== session.id )
			throw new Error( 'Interactive wizard setup is valid only for its recorded session.' );
	}
	const redirectMeta = { ...( profile?.redirectMeta || {} ) };
	if ( 'autodescription' === candidate.slug && ! candidate.baseline )
		redirectMeta.redirect = session.fixture.target;

	for ( const key of Object.keys( redirectMeta ) ) {
		if ( '{{target}}' === redirectMeta[key] ) redirectMeta[key] = session.fixture.target;
	}
	await control( session, { action: 'configure', options: profile?.options || {}, redirectMeta } );

	return profile || { method: candidate.baseline ? 'no-plugin' : 'defaults', defaultsPreserved: true };
}

/**
 * Builds independently validated front-end, admin, feed, and feature requests.
 * Plugin feature routes are explicit; unsupported routes receive no timing.
 *
 * @param {Object} session
 * @param {Object} candidate
 * @return {Object[]}
 */
function scenarios( session, candidate ) {

	const fixture = session.fixture;
	const seo     = candidate.baseline ? [] : ( candidate.frontContains || ( 'autodescription' === candidate.slug ? [ 'The SEO Framework' ] : [] ) );
	if ( ! candidate.baseline && ! seo.length )
		throw new Error( 'A plugin timing plan needs frontContains markers proving its output is present.' );

	const html = { status: 200, type: 'text/html', minBytes: 500, contains: [ 'WPRPERFBODY', ...seo ] };
	const admin = { status: 200, type: 'text/html', minBytes: 1000, contains: [ 'wpbody-content' ], excludes: [ 'id="loginform"' ] };
	const sitemap = candidate.features?.sitemap || (
		candidate.baseline
			? { path: '/wp-sitemap.xml', contains: [ 'sitemapindex' ] }
			: ( 'autodescription' === candidate.slug ? { path: '/sitemap.xml', contains: [ 'urlset', 'wpr-perf-post-001' ] } : null )
	);
	const redirect = candidate.features?.redirect || (
		'autodescription' === candidate.slug && ! candidate.baseline ? { status: 301 } : null
	);

	return [
		{ id: 'home-blog', path: '/', frame: 'blog', expect: { ...html, route: 'home-blog' } },
		{ id: 'home-static', path: '/', frame: 'static', expect: { ...html, route: `page:${fixture.frontId}`, contains: [ ...html.contains, 'WPR performance page 019' ] } },
		{ id: 'blog-page', path: fixture.blog, frame: 'static', expect: { ...html, route: 'posts-page' } },
		{ id: 'post', path: fixture.post, frame: 'static', expect: { ...html, route: `post:${fixture.postId}`, contains: [ ...html.contains, 'WPR performance post 001' ] } },
		{ id: 'page', path: fixture.page, frame: 'static', expect: { ...html, route: `page:${fixture.pageId}`, contains: [ ...html.contains, 'WPR performance page 001' ] } },
		{ id: 'category', path: fixture.category, frame: 'static', expect: { ...html, route: 'category:wpr-perf-category' } },
		{ id: 'tag', path: fixture.tag, frame: 'static', expect: { ...html, route: 'tag:wpr-perf-tag' } },
		{ id: 'search', path: '/?s=WPRPERFBODY', frame: 'static', expect: { ...html, route: 'search:WPRPERFBODY' } },
		{ id: '404', path: '/wpr-perf-missing-page/', frame: 'static', expect: { status: 404, type: 'text/html', route: '404', minBytes: 500, contains: [ '<html', '<title' ] } },
		{ id: 'rss', path: '/feed/', frame: 'blog', expect: { status: 200, type: '(rss|xml)', route: 'feed', contains: [ '<rss', '<item', 'WPRPERFBODY' ] } },
		{ id: 'robots', path: '/robots.txt', frame: 'static', expect: { status: 200, type: 'text/plain', route: 'robots', contains: candidate.features?.robots?.contains || [ 'User-agent:', 'wp-admin' ] } },
		{ id: 'sitemap', path: sitemap?.path, frame: 'static', unavailable: sitemap?.unavailable || ( sitemap ? null : 'No verified plugin sitemap endpoint' ), expect: { status: 200, type: 'xml', contains: sitemap?.contains || [ 'urlset|sitemapindex' ] } },
		{ id: 'redirect', path: fixture.redirect, frame: 'static', unavailable: redirect?.unavailable || ( redirect ? null : 'No configured native redirect in this edition' ), expect: { status: redirect?.status || 301, location: fixture.target, minBytes: 0 } },
		{ id: 'dashboard', path: '/wp-admin/index.php', frame: 'static', admin: true, expect: { ...admin, route: 'admin:dashboard' } },
		{ id: 'posts-list', path: '/wp-admin/edit.php', frame: 'static', admin: true, expect: { ...admin, route: 'admin:edit-post', contains: [ ...admin.contains, 'WPR performance post' ] } },
		{ id: 'pages-list', path: '/wp-admin/edit.php?post_type=page', frame: 'static', admin: true, expect: { ...admin, route: 'admin:edit-page', contains: [ ...admin.contains, 'WPR performance page' ] } },
		{ id: 'post-editor', path: `/wp-admin/post.php?post=${fixture.postId}&action=edit`, frame: 'static', admin: true, expect: { ...admin, route: 'admin:post', contains: [ 'WPR performance post 001', 'wp-edit-post|poststuff' ] } },
		{ id: 'page-editor', path: `/wp-admin/post.php?post=${fixture.pageId}&action=edit`, frame: 'static', admin: true, expect: { ...admin, route: 'admin:page', contains: [ 'WPR performance page 001', 'wp-edit-post|poststuff' ] } },
		{ id: 'editor-save', path: `/wp-json/wp/v2/pages/${fixture.pageId}?context=edit`, frame: 'static', admin: true, save: true, postId: fixture.pageId, expect: { status: 200, type: 'application/json', contains: [ 'WPR performance page 001' ] } },
	];
}

/**
 * Measures one scenario block. Exports and sensors stay outside timed calls.
 *
 * @param {Object} session
 * @param {Object} scenario
 * @param {Object} context
 * @param {Object} auth
 * @return {Promise<Object>}
 */
async function measureScenario( session, scenario, context, auth ) {

	const config = context.config;
	const rows   = [];
	const block = {
		blockId: `${session.id}-${scenario.id}`,
		candidate: session.candidate.id,
		pluginVersion: session.candidate.baseline ? 'none' : session.candidate.version,
		baseline: !! session.candidate.baseline,
		wp: session.runtime.wp, php: session.runtime.php,
		round: context.round + 1, scenario: scenario.id, frame: scenario.frame,
		unavailable: scenario.unavailable || null,
	};
	if ( scenario.unavailable ) {
		saveBlock( context.output, block, rows );

		return block;
	}
	console.log( `  ${scenario.id}: ${context.count} measured calls` );
	const agent = new http.Agent( { keepAlive: true, maxSockets: 1 } );
	const diagnostics = path.join( session.siteDirectory, 'wpr-performance-errors.log' );
	let minimum = null;
	let lastSavedTitle = null;
	let saveSequence = 0;
	try {
		await control( session, { action: 'frame', frame: scenario.frame } );
		for ( const phase of [ 'warmup', 'measure' ] ) {
			if ( 'measure' === phase ) {
				block.runtime = ( await control( session, { action: 'manifest' } ) ).data;
				block.cacheBefore = block.runtime.opcache;
				block.cacheBeforeWorkers = await collectCacheSnapshots(
					async () => ( await control( session, { action: 'cache' } ) ).data,
					config.workers, [ block.cacheBefore ],
				);

				for ( const snapshot of block.cacheBeforeWorkers )
					validateCacheProfile( snapshot, config.opcacheMode, session.php );
				if ( JSON.stringify( block.runtime.activePlugins ) !== JSON.stringify( session.runtime.activePlugins ) )
					throw new Error( 'Plugin activation/version changed after preparation.' );

				block.logStart = fs.existsSync( diagnostics ) ? fs.statSync( diagnostics ).size : 0;
				block.before = await readTemperature( config.temperatureCommand, { cwd: ROOT } );
				block.clockBefore = await readCPUClock( config.clockCommand, { cwd: ROOT } );
				block.cpu = { before: readCPUCounters() };
			}
			const count = 'warmup' === phase ? config.warmups : context.count;
			let invalid = 0;
			for ( let sequence = 0; sequence < count; ++sequence ) {
				const token   = crypto.randomUUID();
				const current = { ...scenario };
				const headers = { 'X-WPR-Perf-Token': token };
				if ( scenario.admin ) headers.Cookie = auth.cookies;

				if ( scenario.save ) {
					current.saveTitle = `WPR performance page 001 ${saveSequence++ % 2 ? 'B' : 'A'}`;
					headers['X-WP-Nonce'] = auth.data.nonce;
					headers['Content-Type'] = 'application/json';
					lastSavedTitle = current.saveTitle;
				}
				const response = await request( `${session.run.url}${scenario.path}`, {
					agent, headers, timeoutMs: config.timeoutMs,
					method: scenario.save ? 'POST' : 'GET',
					body: scenario.save ? JSON.stringify( { title: current.saveTitle } ) : undefined,
				} );
				const errors = validate(
					response, current, token, scenario.admin ? auth.data.userId : 0, session.run.url,
				);
				const row = {
					blockId: block.blockId, candidate: block.candidate,
					pluginVersion: block.pluginVersion, wp: block.wp, php: block.php,
					round: block.round, scenario: scenario.id, phase, sequence: sequence + 1,
					at: new Date().toISOString(), elapsedMs: response.elapsedMs, ttfbMs: response.ttfbMs,
					status: response.status, bytes: response.bytes, sha256: response.sha256,
					executionToken: token, responseToken: response.headers['x-wpr-perf-token'],
					userId: response.headers['x-wpr-perf-user'], route: response.headers['x-wpr-perf-route'],
					contentType: response.headers['content-type'], location: response.headers.location,
					valid: ! errors.length, reasons: errors.join( '; ' ),
				};
				rows.push( row );
				if ( ! errors.length && 'measure' === phase && ( ! minimum || response.elapsedMs < minimum.elapsedMs ) )
					minimum = response;

				if ( 'sitemap' === scenario.id && ! errors.length )
					block.featureDocument = /<sitemapindex\b/i.test( response.body ) ? 'sitemapindex' : 'urlset';

				if ( errors.length ) {
					const evidence = path.join( context.output, `${block.blockId}.rejected.json` );
					fs.writeFileSync( evidence, JSON.stringify( { row, body: response.body }, null, '\t' ) + '\n' );
					if ( 'warmup' === phase || ++invalid >= config.maxInvalid )
						throw new Error( errors.join( '; ' ) );
				}
			}
			if ( 'measure' === phase ) {
				block.cpu.after = readCPUCounters();
				block.clockAfter = await readCPUClock( config.clockCommand, { cwd: ROOT } );
				block.after = await readTemperature( config.temperatureCommand, { cwd: ROOT } );
				block.cacheAfterWorkers = await collectCacheSnapshots(
					async () => ( await control( session, { action: 'cache' } ) ).data, config.workers,
				);

				block.cacheAfter = block.cacheAfterWorkers[0];
				for ( const snapshot of block.cacheAfterWorkers )
					validateCacheProfile( snapshot, config.opcacheMode, session.php );

				block.cacheReuse = assessCacheWorkers( block.cacheBeforeWorkers, block.cacheAfterWorkers, config.workers );
			}
		}
		if ( scenario.save ) {
			block.savedState = ( await control( session, { action: 'inspect' } ) ).data;
			if ( block.savedState.title !== lastSavedTitle ) throw new Error( 'Final edit did not persist.' );
		}
	} catch ( error ) {
		block.error = error.message;
	} finally {
		if ( block.cpu?.before ) {
			block.cpu.after ||= readCPUCounters();
			block.cpu.load = cpuLoad( block.cpu.before, block.cpu.after );
		}
		block.clockAfter ||= await readCPUClock( config.clockCommand, { cwd: ROOT } );
		block.after ||= await readTemperature( config.temperatureCommand, { cwd: ROOT } );
		agent.destroy();
		if ( fs.existsSync( diagnostics ) ) {
			const log = fs.readFileSync( diagnostics, 'utf8' ).slice( block.logStart || 0 );
			if ( log.trim() ) {
				fs.writeFileSync( path.join( context.output, `${block.blockId}.php-errors.log` ), log );
				block.error = `${block.error ? block.error + '; ' : ''}PHP diagnostics emitted during this block`;
			}
		}
		if ( minimum ) {
			const evidence = {
				elapsedMs: minimum.elapsedMs, sha256: minimum.sha256, status: minimum.status,
				contentType: minimum.headers['content-type'], location: minimum.headers.location,
				executionToken: minimum.headers['x-wpr-perf-token'],
				userId: minimum.headers['x-wpr-perf-user'], route: minimum.headers['x-wpr-perf-route'],
				body: minimum.body,
			};
			fs.writeFileSync( path.join( context.output, `${block.blockId}.fastest.json` ), JSON.stringify( evidence, null, '\t' ) + '\n' );
		}
		saveBlock( context.output, block, rows );
	}

	return block;
}

/**
 * Runs selected scenarios on a prepared site with a real authenticated session.
 *
 * @param {Object} session
 * @param {Object} context
 * @return {Promise<void>}
 */
async function benchmarkSession( session, context ) {

	if ( ! session.sourceSnapshot ) throw new Error( 'Prepare a fresh site with an isolated plugin snapshot before measuring.' );
	if ( phpFingerprint( session.candidate ) !== session.candidate.phpSourceSha256 )
		throw Object.assign( new Error( 'Plugin PHP source changed before measurement.' ), { stage: 'source drift' } );

	const profile = await setup( session, session.candidate );
	fs.writeFileSync( path.join( context.output, `${session.id}.setup.json` ), JSON.stringify( profile, null, '\t' ) + '\n' );
	const auth = await control( session, { action: 'login' } );
	const all  = scenarios( session, session.candidate );
	const selected = context.config.scenarios || all.map( item => item.id );
	for ( const name of selected ) {
		const scenario = all.find( item => item.id === name );
		if ( ! scenario ) throw new Error( `Unknown scenario: ${name}` );

		if ( context.onBoundary ) await context.onBoundary( { phase: 'before', scenario: name } );
		const block = await measureScenario( session, scenario, context, auth );
		if ( context.onBoundary ) await context.onBoundary( { phase: 'after', scenario: name, block } );
	}
	if ( phpFingerprint( session.candidate ) !== session.candidate.phpSourceSha256 )
		throw Object.assign( new Error( 'Plugin PHP source changed during measurement.' ), { stage: 'source drift' } );
	if ( phpFingerprint( { ...session.candidate, directory: session.sourceSnapshot.directory } ) !== session.sourceSnapshot.phpSourceSha256 )
		throw Object.assign( new Error( 'Executed plugin snapshot changed during measurement.' ), { stage: 'source drift' } );
}

/**
 * Runs a balanced sequential matrix and always writes partial results.
 *
 * @param {Object} args
 * @return {Promise<Object>}
 */
async function main( args = argumentsFrom( process.argv.slice( 2 ) ) ) {

	if ( args.help ) {
		console.log( 'node run.js run --root <consumer> --config <plan.json> [--regression-dir <engine>] [--smoke] [--wp=latest,7.0] [--php=auto,8.3] [--samples=100] [--rounds=1] [--warmups=12] [--opcache-mode=auto|memory|file|off] [--scenarios=home-blog,page] [--prepare --candidate=id] [--session <session.json>] [--stop-session <session.json>]' );

		return;
	}
	const engine = engineDirectory();
	if ( args['stop-session'] ) {
		const session = JSON.parse( fs.readFileSync( allowedPath( path.resolve( ROOT, args['stop-session'] ) ), 'utf8' ) );
		if ( 'wp-performance-session-v1' !== session.kind || session.root !== ROOT ) throw new Error( 'Unrecognized session ownership.' );

		stopSession( engine, session );

		return;
	}
	assertPerformanceEngine( engine );
	let resumed;
	if ( args.session ) {
		resumed = JSON.parse( fs.readFileSync( allowedPath( path.resolve( ROOT, args.session ) ), 'utf8' ) );
		if ( 'wp-performance-session-v1' !== resumed.kind || resumed.root !== ROOT ) throw new Error( 'Unrecognized session ownership.' );

		const { readRuns, pidAlive } = require( path.join( engine, 'lib/state.js' ) );
		if ( ! readRuns().some( run => run.pid === resumed.run.pid && run.site === resumed.id && run.root === ROOT && run.url === resumed.run.url && pidAlive( run.pid ) ) )
			throw new Error( 'Prepared benchmark session is no longer alive.' );
	}
	if ( ! args.config && ! resumed?.configFile ) throw new Error( 'Timing requires an explicit --config for versions of the same plugin.' );

	const configFile = allowedPath( path.resolve( ROOT, args.config || resumed.configFile ) );
	const config = configuration( configFile, resumed ? { ...args, candidate: resumed.candidate.id } : args );
	if ( resumed && 1 !== config.rounds ) throw new Error( 'Resume one prepared session with --rounds=1.' );

	const php = await resolvePHP( engine, config );
	const runtime = config.playgroundCli ? path.dirname( allowedPath( config.playgroundCli ) ) : engine;
	const wpPackage = require( require.resolve( '@wp-playground/wordpress', { paths: [ runtime ] } ) );
	const wp = [];
	for ( const requested of config.wp ) {
		const release = await wpPackage.resolveWordPressRelease( requested );
		wp.push( { requested, version: release.version, releaseUrl: release.releaseUrl } );
	}
	const candidates = [];
	const output = allowedPath( path.resolve( ROOT, args.output || path.join( ROOT, '.local/playground/performance', `${new Date().toISOString().replace( /[:.]/g, '-' )}-${crypto.randomUUID().slice( 0, 8 )}` ) ) );
	if ( fs.existsSync( output ) && fs.readdirSync( output ).length ) throw new Error( 'Output directory must be new or empty.' );

	fs.mkdirSync( output, { recursive: true } );
	const enginePackage = JSON.parse( fs.readFileSync( path.join( engine, 'package.json' ), 'utf8' ) );
	const manifest = {
		kind: 'wp-performance-run-v1', startedAt: new Date().toISOString(),
		smoke: !! args.smoke, exploratory: ! args.smoke && 1 === config.rounds,
		config, phpDecision: php, wpDecision: wp,
		candidates, failures: [],
		environment: {
			node: process.version, os: os.platform(), release: os.release(), arch: os.arch(),
			cpus: os.cpus().map( item => item.model ), totalMemory: os.totalmem(),
			playground: enginePackage.dependencies?.['@wp-playground/cli'],
			playgroundCli: config.playgroundCli || null,
			selectedPlaygroundVersion: config.playgroundCli
				? JSON.parse( fs.readFileSync( path.join( path.dirname( config.playgroundCli ), 'package.json' ), 'utf8' ) ).version
				: enginePackage.dependencies?.['@wp-playground/cli'],
			database: 'Playground SQLite', concurrency: 1, workers: config.workers,
		},
	};
	const manifestFile = path.join( output, 'manifest.json' );
	fs.writeFileSync( manifestFile, JSON.stringify( manifest, null, '\t' ) + '\n' );
	for ( const file of [ 'samples.ndjson', 'blocks.ndjson' ] ) fs.writeFileSync( path.join( output, file ), '' );

	for ( const candidate of config.candidates ) {
		try {
			candidates.push( await prepareCandidate( candidate ) );
		} catch ( error ) {
			manifest.failures.push( { candidate: candidate.id, wp: 'not launched', php: 'not launched', stage: 'package preparation', error: error.message } );
			console.error( `Preparation failed for ${candidate.id}: ${error.message}` );
		}
	}
	fs.writeFileSync( manifestFile, JSON.stringify( manifest, null, '\t' ) + '\n' );
	console.log( `Results: ${output}` );
	validatePreparedControls( config, candidates );
	if ( args.prepare && ( candidates.length !== 1 || wp.length !== 1 || php.versions.length !== 1 ) )
		throw new Error( '--prepare needs exactly one candidate, WordPress version, and PHP version.' );

	if ( resumed ) {
		const candidate = candidates.find( item => item.id === resumed.candidate.id );
		const identity = item => JSON.stringify( [
			item.directory, item.slug, item.mainFile, item.mounts, item.version,
			item.archiveSha256, item.mainFileSha256, item.phpSourceSha256,
		] );
		if ( ! candidate || identity( candidate ) !== identity( resumed.candidate ) )
			throw new Error( 'Prepared candidate changed.' );

		resumed.candidate = candidate;
		try {
			await benchmarkSession( resumed, { output, config, round: 0, count: config.samples } );
		} catch ( error ) {
			manifest.failures.push( { candidate: candidate.id, wp: resumed.wp, php: resumed.php, stage: error.stage || 'launch/setup', error: error.message } );
		} finally {
			try {
				stopSession( engine, resumed );
			} catch ( error ) {
				manifest.failures.push( { candidate: candidate.id, wp: resumed.wp, php: resumed.php, stage: 'cleanup', error: `${error.message}; owned session: ${resumed.file}` } );
			}
		}
	} else {
		let cleanupBlocked = false;
		matrix:
		for ( let round = 0; round < config.rounds; ++round ) {
			const order = candidateOrder( candidates, round );
			for ( const wordpress of wp ) {
				for ( const phpVersion of php.versions ) {
					for ( const candidate of order ) {
						let session;
						try {
							const context = {
								output, config, configFile, round, expectedWP: wordpress.version,
								count: Math.floor( config.samples / config.rounds ) + ( round < config.samples % config.rounds ? 1 : 0 ),
							};
							session = await launchSession( engine, candidate, wordpress.releaseUrl, phpVersion, context );
							if ( args.prepare ) {
								console.log( `Prepared session: ${session.file}\nComplete setup, record its version-specific evidence, then use --session with --rounds=1.` );

								return session;
							}
							await benchmarkSession( session, context );
						} catch ( error ) {
							manifest.failures.push( { candidate: candidate.id, wp: wordpress.version, php: phpVersion, round: round + 1, stage: error.stage || 'launch/setup', error: error.message } );
							console.error( `Cell failed: ${error.message}` );
							cleanupBlocked = !! error.cleanupFailed;
						} finally {
							if ( session && ! args.prepare ) {
								try {
									stopSession( engine, session );
								} catch ( error ) {
									manifest.failures.push( { candidate: candidate.id, wp: wordpress.version, php: phpVersion, stage: 'cleanup', error: `${error.message}; owned session: ${session.file}` } );
									cleanupBlocked = true;
								}
							}
						}
						fs.writeFileSync( manifestFile, JSON.stringify( manifest, null, '\t' ) + '\n' );
						if ( cleanupBlocked ) break matrix;
					}
				}
			}
		}
	}
	manifest.finishedAt = new Date().toISOString();
	fs.writeFileSync( manifestFile, JSON.stringify( manifest, null, '\t' ) + '\n' );
	const result = await report( output, manifest );
	console.log( `Report: ${path.join( output, 'report.md' )}` );
	if ( manifest.failures.length || result.summaries.some( item => 'invalid' === item.status ) ) process.exitCode = 1;

	return result;
}

if ( require.main === module ) {
	main().catch( error => {
		console.error( error.message );
		process.exitCode = 1;
	} );
}

module.exports = { argumentsFrom, configuration, control, launchSession, setup, scenarios, measureScenario, benchmarkSession, main };
