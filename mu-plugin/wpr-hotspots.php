<?php
/** Disposable profiling probe; never install on a production WordPress site. */
defined( 'ABSPATH' ) or die;

// WordPress checks these after pre_http_request, even if a later filter returns false.
if ( defined( 'WP_HTTP_BLOCK_EXTERNAL' ) && ! WP_HTTP_BLOCK_EXTERNAL )
	throw new RuntimeException( 'The disposable profile site must block external WordPress HTTP.' );
if ( defined( 'WP_ACCESSIBLE_HOSTS' ) && '' !== WP_ACCESSIBLE_HOSTS )
	throw new RuntimeException( 'The disposable profile site cannot allow external WordPress HTTP hosts.' );
defined( 'WP_HTTP_BLOCK_EXTERNAL' ) or define( 'WP_HTTP_BLOCK_EXTERNAL', true );
defined( 'WP_ACCESSIBLE_HOSTS' ) or define( 'WP_ACCESSIBLE_HOSTS', '' );
add_filter( 'block_local_requests', '__return_true', PHP_INT_MAX );

// Prevent plugin telemetry and mail in the disposable profiling fixture.
add_filter( 'pre_http_request', function () {
	return new WP_Error( 'wpr_profile_offline', 'Outbound WordPress HTTP is blocked in this profiling fixture.' );
}, PHP_INT_MAX );
add_filter( 'pre_wp_mail', '__return_false', PHP_INT_MAX );
// If another filter resumes mail, abort before PHPMailer reaches a transport.
add_action( 'phpmailer_init', function () {
	throw new \PHPMailer\PHPMailer\Exception( 'Mail is disabled in the disposable profiling fixture.' );
}, PHP_INT_MIN );

// The profiler starts before WordPress, only when the exact trigger is supplied.
add_action( 'init', function () {
	if ( empty( $_SERVER['HTTP_X_WPR_PERF_TOKEN'] ) ) return;

	$file = function_exists( 'xdebug_get_profiler_filename' ) ? xdebug_get_profiler_filename() : false;
	header( 'X-WPR-Profile-Available: ' . ( function_exists( 'xdebug_get_profiler_filename' ) ? '1' : '0' ) );
	if ( $file ) header( 'X-WPR-Profile-File: ' . basename( $file ) );
}, -1000 );
