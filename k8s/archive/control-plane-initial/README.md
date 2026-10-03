# Manifests initiaux du control plane

Copie du 03/10/2026 des quatre fichiers `~/backend.yaml`, `~/frontend.yaml`, `~/postgres.yaml` et `~/redis.yaml` recuperes sur le control plane.

Ces fichiers documentent l'etat initial (backend echo-server, frontend nginx, PostgreSQL 15, Redis 7); ils ne sont pas les manifests de la version actuelle et ne doivent pas etre appliques. Le mot de passe PostgreSQL en clair du fichier d'origine a ete remplace par une reference au Secret `reservation-db-credentials` pour ne pas remettre de secret dans Git.

Les copies autonomes d'origine dans `/home/camillej` ont ete supprimees apres verification qu'elles correspondaient a ces anciens manifests; cette archive versionnee est conservee comme historique.
