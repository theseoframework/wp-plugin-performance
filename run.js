#!/usr/bin/env node
/**
 * WordPress plugin performance via Playground.
 * Copyright (C) 2026 Sybre Waaijer, CyberWire B.V. (https://cyberwire.nl/)
 * Licensed under the GNU General Public License version 3.
 */

const fs   = require( 'fs' );
const path = require( 'path' );

const USAGE = `Usage: node run.js <command> --root <consumer> [flags]

Commands:
  profile   Capture Xdebug profiles of one local plugin (--config).
  hotspots  Inspect saved Cachegrind or a profile run (--input, --output).
  prune     Preview raw-file cleanup for a completed run (--input, --apply).
  run       Optional unprofiled timing of the same plugin (--config).
  prepare   Leave one owned site running for native wizard setup.
  resume    Measure a prepared --session, then stop that site.
  stop      Stop only the exact owned --session.
  report    Rebuild CSV/Markdown/offline HTML from --input checkpoints.
  export    Export recorded --input with --modules <Artifact Tool node_modules>.
  doctor    Inspect permission and dependency locations without launching.
  test      Run synthetic validation, statistics, export and permission checks.

Run flags: --config <plan.json>, --smoke, --wp=latest,7.0, --php=auto,8.3,
           --samples=100, --rounds=1, --warmups=12, --scenarios=page,robots,
           --opcache-mode=auto|memory|file|off,
           --candidate=<id>, --regression-dir <wp-plugin-regression>, --output <new-dir>.
           --comparison-mode=repeat-controls requires a named baselineCandidate,
           an identical negativeControl baseline and complete balanced rounds.

Live commands require the consumer's .local/playground/permission.txt:
PLAYGROUND=True|False. Missing, invalid and False consent never launch or install.
No command installs dependencies, clones repositories or alters Git state.
Profile flags: --config <plan>, --warmups=3, --profiles=1, --output <new-dir>,
               --raw-retention=keep|prune.
Offline flags: --input <profile-or-run>, --output <new-dir>, --plugin-prefix <VFS-path>.
Playground diagnostics do not predict production performance. Confirm native
gains with profiling disabled. Inclusive costs overlap; call overhead is amplified.
`;

/**
 * Dispatches shared engine operations while keeping the consumer root explicit.
 *
 * @param {string[]} argv
 * @return {Promise<*>}
 */
async function main( argv = process.argv.slice( 2 ) ) {

	if ( ! argv.length || argv.includes( '--help' ) || 'help' === argv[0] ) {
		console.log( USAGE );

		return;
	}
	const command = argv[0].startsWith( '--' ) ? 'run' : argv.shift();
	const benchmark = require( './lib/benchmark' );
	const args = benchmark.argumentsFrom( argv );
	switch ( command ) {
		case 'profile':
			return require( './lib/profile' ).main( args );
		case 'hotspots':
			return require( './lib/profile' ).offline( args );
		case 'prune': {
			const result = require( './lib/raw-retention' ).prune( args );
			console.log( JSON.stringify( result, null, '\t' ) );
			return result;
		}
		case 'run':
			return benchmark.main( args );
		case 'prepare':
			return benchmark.main( { ...args, prepare: true } );
		case 'resume':
			if ( ! args.session ) throw new Error( 'resume requires --session <session.json>.' );

			return benchmark.main( args );
		case 'stop':
			if ( ! args.session && ! args['stop-session'] ) throw new Error( 'stop requires --session <session.json>; there is no stop-all command.' );

			return benchmark.main( { ...args, 'stop-session': args.session || args['stop-session'] } );
		case 'export':
			return require( './lib/export-xlsx' ).main( args );
		case 'report': {
			if ( ! args.input ) throw new Error( 'report requires --input <recorded run directory>.' );

			const { ROOT, allowedPath } = require( './lib/engine' );
			const output = allowedPath( path.resolve( ROOT, args.input ) );
			const manifest = JSON.parse( fs.readFileSync( path.join( output, 'manifest.json' ), 'utf8' ) );

			return require( './lib/report' ).report( output, manifest );
		}
		case 'test':
			return require( './test/smoke' ).main();
		case 'doctor': {
			const engine = require( './lib/engine' );
			const status = { root: engine.ROOT, performanceEngine: engine.ENGINE_ROOT };
			try {
				status.permission = engine.readPermission();
				status.regressionEngine = engine.engineDirectory();
				status.performanceAPI = engine.assertPerformanceEngine( status.regressionEngine );
				status.playgroundInstalled = fs.existsSync( path.join( status.regressionEngine, 'node_modules/@wp-playground/cli/package.json' ) );
			} catch ( error ) {
				status.reason = error.message;
			}
			console.log( JSON.stringify( status, null, '\t' ) );

			return status;
		}
		default:
			throw new Error( `Unknown command: ${command}` );
	}
}

if ( require.main === module ) {
	main().catch( error => {
		console.error( error.message );
		process.exitCode = 1;
	} );
}

module.exports = { main };
