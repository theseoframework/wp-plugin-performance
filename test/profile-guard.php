<?php
/** Uses installed WordPress hooks and HTTP blocking; never sends a request/mail. */
if ( empty( $argv[1] ) || empty( $argv[2] ) ) exit( 2 );

define( 'ABSPATH', rtrim( $argv[1], '/\\' ) . '/' );
define( 'WPINC', 'wp-includes' );
require ABSPATH . 'wp-includes/compat.php';
require ABSPATH . 'wp-includes/plugin.php';
require ABSPATH . 'wp-includes/class-wp-error.php';
require ABSPATH . 'wp-includes/class-wp-http.php';
require ABSPATH . 'wp-includes/PHPMailer/Exception.php';

function __return_true() { return true; }
function __return_false() { return false; }
function get_option( $name ) { return 'http://fixture.invalid'; }

if ( 'conflict-http' === $argv[2] ) define( 'WP_HTTP_BLOCK_EXTERNAL', false );
if ( 'conflict-hosts' === $argv[2] ) define( 'WP_ACCESSIBLE_HOSTS', '*.invalid' );

try {
	require dirname( __DIR__ ) . '/mu-plugin/wpr-hotspots.php';
	if ( 'normal' !== $argv[2] ) throw new LogicException( 'Unsafe constants were accepted.' );
} catch ( RuntimeException $error ) {
	if ( 'normal' === $argv[2] ) throw $error;

	echo json_encode( array( 'rejected' => true, 'message' => $error->getMessage() ) );
	exit;
}

// Reproduce a plugin resuming transport after the probe's short-circuit callback.
add_filter( 'pre_http_request', '__return_false', PHP_INT_MAX );
$pre = apply_filters( 'pre_http_request', false, array(), 'https://outbound.invalid/' );
$http = new WP_Http();
$blocked = array();
foreach ( array( 'https://outbound.invalid/', 'http://fixture.invalid/', 'http://localhost/' ) as $url )
	$blocked[] = $http->block_request( $url );

add_filter( 'pre_wp_mail', function () { return null; }, PHP_INT_MAX );
$mail_pre = apply_filters( 'pre_wp_mail', null, array() );
$mail_blocked = false;
try {
	// This action runs before PHPMailer invokes its transport.
	do_action( 'phpmailer_init', new stdClass() );
} catch ( \PHPMailer\PHPMailer\Exception $error ) {
	$mail_blocked = true;
}
echo json_encode( array( 'httpPre' => $pre, 'blocked' => $blocked, 'mailPre' => $mail_pre, 'mailBlocked' => $mail_blocked ) );
