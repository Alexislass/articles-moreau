<?php
/**
 * Plugin Name: Yoast meta via API REST (pour le robot de publication)
 * Description: Autorise l'écriture du meta title et de la meta description Yoast
 *              via l'API REST WordPress, pour la publication automatique d'articles.
 * Version: 1.0
 * Author: Crayon Digital
 *
 * --- COMMENT L'INSTALLER (au choix) ---
 *
 * Option A (la plus simple) — extension "Code Snippets" :
 *   1. Dans WordPress : Extensions → Ajouter → cherche "Code Snippets" → Installer → Activer.
 *   2. Snippets → Add New → colle UNIQUEMENT le bloc add_action(...) ci-dessous
 *      (sans la balise <?php ni l'en-tête de commentaire) → "Run snippet everywhere" → Save & Activate.
 *
 * Option B — en tant que mini-extension :
 *   1. Renomme ce fichier en "yoast-rest-meta.php".
 *   2. Dépose-le dans wp-content/mu-plugins/ (crée le dossier "mu-plugins" s'il n'existe pas)
 *      via le gestionnaire de fichiers de ton hébergeur OVH ou en FTP.
 *   3. C'est actif automatiquement (les "must-use plugins" n'ont pas besoin d'activation).
 */

add_action( 'init', function () {
	$cles = array( '_yoast_wpseo_title', '_yoast_wpseo_metadesc' );

	foreach ( $cles as $cle ) {
		register_post_meta( 'post', $cle, array(
			'type'          => 'string',
			'single'        => true,
			'show_in_rest'  => true,
			'auth_callback' => function () {
				return current_user_can( 'edit_posts' );
			},
		) );
	}
} );
