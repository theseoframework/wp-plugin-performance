<?php
/**
 * Local Playground fixture and keyed benchmark control plane.
 *
 * @package WP_Plugin_Performance
 */

defined( 'ABSPATH' ) or die;

// Keep diagnostics on the disposable site rather than on a mounted plugin tree.
ini_set( 'log_errors', '1' );
ini_set( 'display_errors', '0' );
ini_set( 'error_log', WP_CONTENT_DIR . '/wpr-performance-errors.log' );
error_reporting( E_ALL );

add_action( 'init', 'wpr_performance_request', -999 );
add_action( 'set_logged_in_cookie', 'wpr_performance_sync_cookie' );
add_action( 'template_redirect', 'wpr_performance_route', -999 );
add_action( 'current_screen', 'wpr_performance_admin_route' );
add_filter( 'query', 'wpr_performance_check_query', PHP_INT_MIN );
add_action( 'shutdown', 'wpr_performance_sql_diagnostics', PHP_INT_MAX );

/**
 * Captures the previous query's suppressed error before WordPress resets it.
 *
 * @since 0.1.0
 *
 * @param string $query Next query.
 * @return string Unchanged query.
 */
function wpr_performance_check_query( $query ) {
	wpr_performance_sql_diagnostics();
	return $query;
}

/**
 * Keeps HTTP 200 responses with failed SQL out of accepted performance blocks.
 *
 * @since 0.1.0
 */
function wpr_performance_sql_diagnostics() {

	global $wpdb;
	if ( empty( $_SERVER['HTTP_X_WPR_PERF_TOKEN'] ) || empty( $wpdb->last_error ) ) return;

	static $seen = [];
	$hash = hash( 'sha256', $wpdb->last_error . $wpdb->last_query );
	if ( isset( $seen[ $hash ] ) ) return;

	$seen[ $hash ] = true;
	$error = preg_replace( '/\s+/', ' ', strip_tags( $wpdb->last_error ) );
	error_log( 'WPR performance SQL error [' . $_SERVER['HTTP_X_WPR_PERF_TOKEN'] . ']: ' . $error );
}

/**
 * Reports native WordPress query identity, detecting homepage rewrite fallbacks.
 *
 * @since 0.1.0
 */
function wpr_performance_route() {

	if ( empty( $_SERVER['HTTP_X_WPR_PERF_TOKEN'] ) ) return;

	if ( is_404() ) {
		$route = '404';
	} elseif ( is_feed() ) {
		$route = 'feed';
	} elseif ( is_robots() ) {
		$route = 'robots';
	} elseif ( is_home() ) {
		$route = is_front_page() ? 'home-blog' : 'posts-page';
	} elseif ( is_singular() ) {
		$route = get_post_type() . ':' . get_queried_object_id();
	} elseif ( is_category() ) {
		$route = 'category:' . get_queried_object()->slug;
	} elseif ( is_tag() ) {
		$route = 'tag:' . get_queried_object()->slug;
	} elseif ( is_search() ) {
		$route = 'search:' . get_search_query( false );
	} else {
		$route = 'other';
	}
	header( "X-WPR-Perf-Route: $route" );
}

/**
 * Records the native admin screen identity outside the page's HTML.
 *
 * @since 0.1.0
 *
 * @param WP_Screen $screen Current admin screen.
 */
function wpr_performance_admin_route( $screen ) {
	if ( ! empty( $_SERVER['HTTP_X_WPR_PERF_TOKEN'] ) )
		header( 'X-WPR-Perf-Route: admin:' . $screen->id );
}

/**
 * Makes a newly issued login cookie available when creating the REST nonce.
 *
 * @since 0.1.0
 *
 * @param string $cookie Logged-in cookie.
 */
function wpr_performance_sync_cookie( $cookie ) {
	$_COOKIE[ LOGGED_IN_COOKIE ] = $cookie;
}

/**
 * Echoes a per-request execution token and handles authenticated setup commands.
 * Normal benchmark requests use WordPress's real authentication cookies.
 *
 * @since 0.1.0
 */
function wpr_performance_request() {

	$token = $_SERVER['HTTP_X_WPR_PERF_TOKEN'] ?? '';
	if ( preg_match( '/^[a-f0-9-]{1,64}$/', $token ) ) {
		header( "X-WPR-Perf-Token: $token" );
		header( 'X-WPR-Perf-User: ' . get_current_user_id() );
	}

	if ( empty( $_GET['wpr-performance'] ) ) return;

	$file = __DIR__ . '/wpr-performance.key';
	$key  = is_file( $file ) ? trim( file_get_contents( $file ) ) : '';
	$sent = $_SERVER['HTTP_X_WPR_PERF_KEY'] ?? '';
	if ( ! $key || ! hash_equals( $key, $sent ) )
		wpr_performance_reply( [ 'error' => 'Invalid benchmark key' ], 403 );

	$body = json_decode( file_get_contents( 'php://input' ), true );
	if ( ! is_array( $body ) )
		wpr_performance_reply( [ 'error' => 'Expected a JSON object' ], 400 );

	$user = get_user_by( 'login', 'admin' );
	if ( ! $user )
		wpr_performance_reply( [ 'error' => 'Playground admin missing' ], 500 );

	wp_set_current_user( $user->ID );
	switch ( $body['action'] ?? '' ) {
		case 'seed':
			wpr_performance_reply( wpr_performance_seed() );
			break;
		case 'manifest':
			wpr_performance_reply( wpr_performance_manifest() );
			break;
		case 'cache':
			wpr_performance_reply( wpr_performance_cache() );
			break;
		case 'login':
			wp_set_auth_cookie( $user->ID, false );
			wpr_performance_reply( [
				'userId' => $user->ID,
				'nonce'  => wp_create_nonce( 'wp_rest' ),
			] );
			break;
		case 'frame':
			$fixture = get_option( 'wpr_performance_fixture' );
			$frame   = $body['frame'] ?? '';
			if ( ! in_array( $frame, [ 'blog', 'static' ], true ) || ! $fixture )
				wpr_performance_reply( [ 'error' => 'Invalid frame or missing fixture' ], 400 );

			update_option( 'show_on_front', 'blog' === $frame ? 'posts' : 'page' );
			update_option( 'page_on_front', $fixture['frontId'] );
			update_option( 'page_for_posts', $fixture['blogId'] );
			wpr_performance_reply( [ 'frame' => $frame ] );
			break;
		case 'configure':
			foreach ( $body['options'] ?? [] as $name => $value )
				update_option( $name, $value );

			$fixture = get_option( 'wpr_performance_fixture' );
			foreach ( $body['redirectMeta'] ?? [] as $name => $value )
				update_post_meta( $fixture['redirectId'], $name, $value );

			wpr_performance_reply( [ 'ok' => true ] );
			break;
		case 'inspect':
			$fixture = get_option( 'wpr_performance_fixture' );
			$post    = get_post( $fixture['pageId'] );
			wpr_performance_reply( [
				'title'     => $post->post_title,
				'revisions' => count( wp_get_post_revisions( $post->ID ) ),
			] );
			break;
		default:
			wpr_performance_reply( [ 'error' => 'Unknown benchmark command' ], 400 );
	}
}

/**
 * Finishes a control request.
 *
 * @since 0.1.0
 *
 * @param array $data   Result.
 * @param int   $status HTTP status.
 */
function wpr_performance_reply( $data, $status = 200 ) {

	http_response_code( $status );
	header( 'Content-Type: application/json; charset=utf-8' );
	echo json_encode( $data );
	exit;
}

/**
 * Creates the same content, terms, URLs, and front-page frames for every plugin.
 * Defaults and plugin UI features are left to the plugin and its setup profile.
 *
 * @since 0.1.0
 *
 * @return array Fixture IDs and request paths.
 */
function wpr_performance_seed() {

	$existing = get_option( 'wpr_performance_fixture' );
	if ( $existing ) {
		if ( empty( $existing['logoId'] ) ) {
			$existing = array_merge( $existing, wpr_performance_logo() );
			$existing['version'] = 2;
			update_option( 'wpr_performance_fixture', $existing, false );
		}
		return $existing;
	}

	update_option( 'blogname', 'WPR performance fixture' );
	update_option( 'blogdescription', 'Repeatable WordPress SEO performance fixture' );
	update_option( 'timezone_string', 'UTC' );
	update_option( 'posts_per_page', 10 );
	update_option( 'permalink_structure', '/%postname%/' );
	update_option( 'blog_public', 1 );
	delete_option( 'rewrite_rules' );

	$category = wp_insert_term( 'WPR performance category', 'category', [ 'slug' => 'wpr-perf-category' ] );
	$tag      = wp_insert_term( 'WPR performance tag', 'post_tag', [ 'slug' => 'wpr-perf-tag' ] );
	if ( is_wp_error( $category ) || is_wp_error( $tag ) )
		wpr_performance_reply( [ 'error' => 'Fixture terms failed' ], 500 );

	$content = '<!-- wp:paragraph --><p>WPRPERFBODY ';
	$content .= str_repeat( 'Search engines and readers need helpful pages with clear titles and consistent links. ', 40 );
	$content .= '</p><!-- /wp:paragraph -->';
	$ids      = [];
	foreach ( [ 'post' => 100, 'page' => 20 ] as $type => $count ) {
		for ( $index = 1; $index <= $count; ++$index ) {
			$number = str_pad( (string) $index, 3, '0', STR_PAD_LEFT );
			$id     = wp_insert_post( [
				'post_type'     => $type,
				'post_status'   => 'publish',
				'post_title'    => "WPR performance $type $number",
				'post_name'     => "wpr-perf-$type-$number",
				'post_content'  => $content,
				'post_excerpt'  => 'WPRPERFBODY Repeatable content for SEO performance measurements.',
				'post_date'     => '2024-01-01 12:00:00',
				'post_date_gmt' => '2024-01-01 12:00:00',
				'post_author'   => get_current_user_id(),
			], true );
			if ( is_wp_error( $id ) )
				wpr_performance_reply( [ 'error' => $id->get_error_message() ], 500 );

			$ids[ $type ][ $index ] = $id;
			if ( 'post' === $type ) {
				wp_set_post_categories( $id, [ $category['term_id'] ] );
				wp_set_post_terms( $id, [ $tag['term_id'] ], 'post_tag' );
			}
		}
	}

	$redirect = wp_insert_post( [
		'post_type'    => 'post',
		'post_status'  => 'publish',
		'post_title'   => 'WPR performance redirect',
		'post_name'    => 'wpr-perf-redirect',
		'post_content' => $content,
	], true );
	if ( is_wp_error( $redirect ) )
		wpr_performance_reply( [ 'error' => $redirect->get_error_message() ], 500 );

	$fixture = [
		'version'    => 2,
		'posts'      => 100,
		'pages'      => 20,
		'contentHash'=> hash( 'sha256', $content ),
		'pageId'     => $ids['page'][1],
		'postId'     => $ids['post'][1],
		'frontId'    => $ids['page'][19],
		'blogId'     => $ids['page'][20],
		'redirectId' => $redirect,
		'page'       => '/wpr-perf-page-001/',
		'post'       => '/wpr-perf-post-001/',
		'blog'       => '/wpr-perf-page-020/',
		'category'   => '/category/wpr-perf-category/',
		'tag'        => '/tag/wpr-perf-tag/',
		'redirect'   => '/wpr-perf-redirect/',
		'target'     => home_url( '/wpr-perf-page-002/' ),
	];
	$fixture = array_merge( $fixture, wpr_performance_logo() );
	update_option( 'wpr_performance_fixture', $fixture, false );

	return $fixture;
}

/**
 * Adds the same local logo to every site's media library for setup wizards.
 *
 * @since 0.1.0
 *
 * @return array Logo attachment and URL.
 */
function wpr_performance_logo() {

	$source = ABSPATH . 'wp-includes/images/w-logo-blue.png';
	$upload = wp_upload_bits( 'wpr-perf-logo.png', null, file_get_contents( $source ) );
	if ( ! empty( $upload['error'] ) )
		wpr_performance_reply( [ 'error' => $upload['error'] ], 500 );

	$id = wp_insert_attachment( [
		'post_mime_type' => 'image/png',
		'post_title'     => 'WPR performance fixture logo',
		'post_status'    => 'inherit',
	], $upload['file'], 0, true );
	if ( is_wp_error( $id ) )
		wpr_performance_reply( [ 'error' => $id->get_error_message() ], 500 );

	require_once ABSPATH . 'wp-admin/includes/image.php';
	wp_update_attachment_metadata( $id, wp_generate_attachment_metadata( $id, $upload['file'] ) );

	return [ 'logoId' => $id, 'logoUrl' => $upload['url'], 'attachments' => 1 ];
}

/**
 * Describes the running versions, active plugins, theme, PHP, and cache policy.
 *
 * @since 0.1.0
 *
 * @return array Runtime manifest.
 */
function wpr_performance_manifest() {

	require_once ABSPATH . 'wp-admin/includes/plugin.php';
	$plugins = [];
	foreach ( get_plugins() as $file => $data ) {
		if ( ! is_plugin_active( $file ) ) continue;

		$plugins[ $file ] = $data['Version'];
	}
	$theme = wp_get_theme();

	return [
		'wp'             => $GLOBALS['wp_version'],
		'php'            => PHP_VERSION,
		'phpSapi'        => PHP_SAPI,
		'theme'          => $theme->get_stylesheet(),
		'themeVersion'   => $theme->get( 'Version' ),
		'activePlugins'  => $plugins,
		'locale'         => get_locale(),
		'blogPublic'     => get_option( 'blog_public' ),
		'permalink'      => get_option( 'permalink_structure' ),
		'phpMemoryLimit' => ini_get( 'memory_limit' ),
		'opcache'        => wpr_performance_cache(),
		'fixture'        => get_option( 'wpr_performance_fixture' ),
	];
}

/**
 * Observes an actual cache instance. Called only by untimed keyed controls.
 * File-only caches may have no public statistics; keep that distinction.
 *
 * @return array
 */
function wpr_performance_cache() {

	$cache = function_exists( 'opcache_get_status' ) ? opcache_get_status( false ) : false;
	$stats = $cache['opcache_statistics'] ?? [];

	return [
		'enabled'          => ini_get( 'opcache.enable' ),
		'enableCli'        => ini_get( 'opcache.enable_cli' ),
		'maxFiles'         => ini_get( 'opcache.max_accelerated_files' ),
		'memoryMb'         => ini_get( 'opcache.memory_consumption' ),
		'jit'              => ini_get( 'opcache.jit' ),
		'fileOnly'         => ini_get( 'opcache.file_cache_only' ),
		'validateTimestamps' => ini_get( 'opcache.validate_timestamps' ),
		'revalidateFreq'   => ini_get( 'opcache.revalidate_freq' ),
		'running'          => (bool) ( $cache['opcache_enabled'] ?? false ),
		'full'             => $cache['cache_full'] ?? null,
		'cachedScripts'    => $stats['num_cached_scripts'] ?? null,
		'hits'             => $stats['hits'] ?? null,
		'misses'           => $stats['misses'] ?? null,
		'startTime'        => $stats['start_time'] ?? null,
		'lastRestartTime'  => $stats['last_restart_time'] ?? null,
		'oomRestarts'      => $stats['oom_restarts'] ?? null,
		'hashRestarts'     => $stats['hash_restarts'] ?? null,
		'manualRestarts'   => $stats['manual_restarts'] ?? null,
		'pid'              => getmypid(),
		'includedScripts'  => count( get_included_files() ),
		'jitStatus'        => $cache['jit'] ?? null,
	];
}
