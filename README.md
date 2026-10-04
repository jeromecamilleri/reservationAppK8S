# Application de reservation de billets

Cette application remplace le backend echo-server et la page Nginx par defaut. Elle conserve les Services `frontend-service`, `backend-service` et `postgres-service` deja presents dans le namespace `app-reservation`.

## Fonctions

- Catalogue d'evenements avec filtre par categorie et recherche par ville ou nom.
- Inscription, connexion et deconnexion; mots de passe hashes avec Argon2id, sessions Redis et cookie HTTP-only.
- Jeton CSRF requis sur les mutations; limitation des tentatives de connexion et d'inscription.
- Panier par compte stocke dans Redis avec expiration de 24 h. Session expire apres 30 minutes d'inactivite.
- Validation de commande et decrementation atomique du stock dans PostgreSQL; Redis ne contient jamais les commandes confirmees.
- Historique et annulation des commandes par leur proprietaire, avec restitution transactionnelle des places.
- Les donnees du catalogue, comptes, commandes et stock sont geres dans PostgreSQL. Redis sert aux sessions et paniers temporaires.
- Les sondes Kubernetes distinguent processus actif et connexions pretes aux dependances.

Le paiement et l'envoi de billets par e-mail ne sont pas implementes. Ce projet est une base d'apprentissage, pas une billetterie exploitable en production. Pour une mise en ligne, activer HTTPS (`COOKIE_SECURE=true`), utiliser des secrets robustes, des sauvegardes PostgreSQL, et une strategie de haute disponibilite pour Redis et PostgreSQL.

## Acces stable et resilience

Le host PC distribue le trafic via HAProxy sur `192.168.122.1:8080`, adresse stable de sa passerelle libvirt. Le navigateur sur le host utilise `http://192.168.122.1:8080`; l'URL est limitee au reseau des VM et n'est pas publiee sur le LAN. HAProxy sonde `/health` sur les NodePort `.11/.12/.13:30080` et retire automatiquement un worker indisponible.

Installer/mettre a jour HAProxy sur Ubuntu depuis la racine du depot, apres installation du paquet `haproxy` :

```bash
sudo install -D -m 0644 ops/haproxy/reservation-app.cfg /etc/haproxy/haproxy.cfg
sudo install -D -m 0644 ops/haproxy/haproxy.service.d/override.conf /etc/systemd/system/haproxy.service.d/override.conf
sudo haproxy -c -f /etc/haproxy/haproxy.cfg
sudo systemctl daemon-reload
sudo systemctl enable --now haproxy
sudo systemctl restart haproxy
curl --fail http://192.168.122.1:8080/health
```

Frontend/backend ont trois replicas initiaux repartis entre workers; l'HPA du backend conserve un minimum de 3 et peut monter a 9. Le backend demande 100m CPU avec une limite a 400m; les timeouts des probes sont a 3s pour tolerer les pointes, sans redemarrer sur un retard bref. Seuls ces Deployments sans etat tolerent `not-ready`/`unreachable` pendant 30 secondes. PostgreSQL garde le delai Kubernetes par defaut: ne pas accelerer son eviction, car un worker partitionne qui revient pourrait avoir un processus PostgreSQL utilisant le meme PGDATA NFS.

En cas de perte de PostgreSQL, si le backend a deja charge le catalogue, `/api/events` sert son dernier instantane en lecture seule et le frontend affiche un bandeau. Authentification, panier et commandes requierent toujours Redis/PostgreSQL; aucune reservation n'est confirmee depuis le cache.

Charge et collecte les indicateurs depuis le host (Node.js 20+). Le script sauvegarde HPA, CPU/memoire des noeuds/pods, redemarrages, evenements, logs, compteurs PostgreSQL/Redis et `cpu.stat` cgroup dans `/tmp/reservation-load-*`. Le mode `catalog` teste seulement `GET /api/events`; le mode `booking` enchaine catalogue, connexion, panier, checkout PostgreSQL, annulation et verification des commandes. Il supporte un pool fixe jusqu'a 500 comptes, conserve les comptes entre tests et supprime les commandes annulees apres le test.

```bash
bash scripts/run-load-test.sh
# Reglages possibles: CONCURRENCY=300 DURATION_SECONDS=90 bash scripts/run-load-test.sh
```

Pour le parcours complet a 500 utilisateurs distincts, le lanceur cree un mot de passe aleatoire une fois dans `${XDG_CONFIG_HOME:-$HOME/.config}/reservation-app/loadtest-password` (permissions 0600, hors du depot Git) si `LOADTEST_PASSWORD` n'est pas fourni. Les 500 comptes sont crees une seule fois et restent en base :

```bash
SCENARIO=booking USER_POOL_SIZE=500 CONCURRENCY=500 DURATION_SECONDS=100 \
  AUTH_CONCURRENCY=3 LOADTEST_BOOTSTRAP=1 \
  bash scripts/run-load-test.sh
```

Les executions suivantes reutilisent ce meme pool sans `LOADTEST_BOOTSTRAP`. Pour un pool superieur a 10, le lanceur releve temporairement `AUTH_RATE_LIMIT` a 1000, attend le rollout puis restaure automatiquement la valeur initiale (10) apres la charge. Les comptes sont provisionnes par lots de trois pour limiter le cout Argon2. La fenetre de charge de 100 secondes commence apres la preparation des sessions. Une pause de 1000 ms entre parcours borne le volume des commandes.

```bash
SCENARIO=booking USER_POOL_SIZE=500 CONCURRENCY=500 DURATION_SECONDS=100 \
  bash scripts/run-load-test.sh
```

`CONCURRENCY` ne peut pas depasser le pool de 500. Chaque utilisateur virtuel conserve son cookie et sa session Redis; les comptes ne sont pas recrees. `THINK_TIME_MS` permet d'ajuster la pause. Le nettoyage restitue le stock et annule d'abord toute commande de test encore confirmee, puis supprime uniquement l'historique des commandes annulees associees aux emails `k8s-loadtest-*@reservation.invalid`. Les comptes persistent. Le detail des etapes est dans `TestsInjectionEtSurveillance.txt`.

Simulation prudente d'une perte frontend: le script cordonne worker1, supprime un seul pod frontend, attend son remplacement ailleurs, puis remet le worker schedulable. Il ne coupe pas une VM et ne touche jamais PostgreSQL :

```bash
bash scripts/simulate-frontend-failure.sh k8s-worker1
```

Le NodePort route sur chaque IP worker vers les endpoints du Service; HAProxy fournit ici l'IP stable cote host. Une adresse virtuelle annoncee sur le LAN necessiterait MetalLB ou un load balancer du LAN, non configure ici.

## Autoscaling du backend

Le cluster doit fournir Metrics Server pour que l'API `metrics.k8s.io` soit disponible. Pour Kubernetes 1.31, installe une version Metrics Server 0.8.x, puis verifie `kubectl top nodes`. La compatibilite officielle indique que Metrics Server 0.8.x supporte Kubernetes 1.31+.

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.8.1/components.yaml
kubectl -n kube-system rollout status deployment/metrics-server
kubectl top nodes
```

Sur ce cluster local, les kubelets ne presentent pas de certificats contenant leurs IP. Si les logs Metrics Server indiquent `cannot validate certificate` / `no IP SANs`, ajoute le contournement TLS de laboratoire :

```bash
kubectl patch deployment metrics-server -n kube-system --type=json \\
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
kubectl -n kube-system rollout status deployment/metrics-server
kubectl top nodes
```

Ce contournement desactive la verification des certificats kubelet; garde-le pour ce cluster d'apprentissage.

Applique ensuite le HPA. Le backend a deja une requete CPU de 100m; la cible de 60% correspond donc a environ 60m CPU par Pod en moyenne.

```bash
kubectl apply -f ~/reservation-app/k8s/backend-hpa.yaml
kubectl get hpa -n app-reservation -w
```

Verifie `kubectl top pods -n app-reservation`, les replicas du Deployment et les evenements HPA. Apres l'arret du generateur, la fenetre de stabilisation de 120 secondes limite les reductions trop rapides.

## Construction des images sans Docker

Dans ce labo, Podman est installe sur le control plane `192.168.122.10`; le host lui transfere les sources avec `rsync`, et les workers n'executent que containerd. Sur Ubuntu 24.04, Podman est disponible dans les depots officiels :

```bash
sudo apt update
sudo apt install podman
```

### Qui stocke et qui telecharge les images ?

Podman n'est installe que sur le control plane pour construire les images et faire tourner le registre prive. Il y a deux stockages distincts sur cette machine : le stockage local de Podman (images construites) et le volume persistant du registre (images publiees). Les workers ne voient pas le stockage local de Podman et n'ont pas besoin d'installer Podman.

```text
Control plane 192.168.122.10
  Podman build -> stockage local Podman
  Podman push  -> registre HTTP :5000 -> volume Podman persistant
                                      ^
                                      | pull HTTP (lorsque necessaire)
Worker 1/2/3                            |
  kubelet -> CRI -> containerd -> registre
                   -> cache local containerd (namespace k8s.io)
```

Le lien se fait en deux parties, et non par un partage de fichiers entre machines :

1. **La reference d'image dans le YAML** indique le nom de l'image et l'adresse du registre, par exemple `192.168.122.10:5000/reservation-backend:2.5`. Kubernetes planifie le Pod sur un worker; son kubelet demande alors a containerd, via l'interface CRI, de preparer cette image.
2. **La configuration containerd sur chaque worker** associe l'adresse `192.168.122.10:5000` au serveur `http://192.168.122.10:5000` et autorise `pull` et `resolve`. Containerd lit cette configuration dans `/etc/containerd/certs.d/192.168.122.10:5000/hosts.toml`. C'est cette adresse reseau qui permet au worker de joindre le registre qui tourne sur le control plane.

Le manifeste [backend.yaml](k8s/backend.yaml) contient cette reference et utilise `imagePullPolicy: IfNotPresent`: le worker reutilise son cache local si l'image/tag y existe deja; sinon il la telecharge depuis le registre. Chaque worker a son propre cache containerd. Il n'y a donc ni image partagee directement depuis Podman, ni reference a maintenir vers le disque du control plane. Le registre est un service HTTP reseau, persiste dans le volume Podman du control plane.

Le registre du labo tourne sur le control plane via les fichiers Quadlet `k8s/registry/`. Son stockage est un volume Podman persistant, hors du depot Git. L'unite est liee a l'adresse de labo `192.168.122.10:5000`; elle est en HTTP sans authentification, donc ne pas l'exposer hors du reseau isole. Le fichier versionne `k8s/registry/containerd-hosts.toml` est a copier sur chaque worker sous le nom `hosts.toml` a l'emplacement ci-dessus.

Pour constater les deux cotes, sur le control plane `podman images` montre les images du stockage local Podman; `curl http://192.168.122.10:5000/v2/_catalog` interroge le registre et `curl http://192.168.122.10:5000/v2/reservation-backend/tags/list` affiche les tags publies. Sur un worker, `sudo crictl images` montre les images deja presentes dans le cache local containerd; il ne liste pas le contenu distant du registre. `kubectl get pods -n app-reservation -o wide` indique quel worker heberge chaque Pod. Pour une image donnee, `kubectl describe pod -n app-reservation <nom-du-pod>` affiche la reference demandee et l'`Image ID` utilisee.

Verification sur un worker (exemple worker1):

```bash
ssh camillej@192.168.122.11
curl http://192.168.122.10:5000/v2/
sudo grep -n 'config_path' /etc/containerd/config.toml
sudo cat /etc/containerd/certs.d/192.168.122.10:5000/hosts.toml
sudo crictl images | grep reservation
```

Si `crictl images` ne montre pas encore `reservation-backend:2.5`, verifie d'abord que le Pod est planifie sur ce worker (`kubectl get pods ... -o wide`) et que le registre contient le tag. Avec `IfNotPresent`, un worker telecharge l'image quand un Pod qui la demande y est planifie et qu'elle manque de son cache.

Sur ce cluster containerd 2.2.1, le `config_path` genere contient deux chemins separes par `:`; le pull CRI ignore alors le `hosts.toml`. Il faut utiliser uniquement `/etc/containerd/certs.d` dans `[plugins.'io.containerd.cri.v1.images'.registry]`, puis redemarrer containerd sur les workers un par un et verifier un pull CRI. Le snapshot complet recupere du worker1 est archive en `k8s/registry/containerd-worker-config.toml`; ne le copie pas aveuglement sur des noeuds dont la configuration aurait diverge. Le changement de `hosts.toml` seul ne requiert pas de redemarrage. Voir la [documentation containerd](https://github.com/containerd/containerd/blob/main/docs/hosts.md) et le [cas containerd 2.2](https://github.com/containerd/containerd/issues/12636).

Pour reconstruire et publier, depuis la racine du projet (`cd ~/reservation-app` sur le control plane), choisis un nouveau tag a chaque version :

```bash
# Sur le host, synchronise les sources vers la machine qui a Podman.
rsync -av --exclude=.git --exclude=node_modules --exclude=k8s/database-secret.yaml \
  /dataSSD/K8S/reservation-app/ camillej@192.168.122.10:reservation-app/
```

Puis, sur le control plane :

```bash
cd ~/reservation-app
podman build --platform linux/amd64 -t localhost/reservation-backend:2.5 ./backend
podman build --platform linux/amd64 -t localhost/reservation-frontend:2.2 ./frontend
podman tag localhost/reservation-backend:2.5 192.168.122.10:5000/reservation-backend:2.5
podman tag localhost/reservation-frontend:2.2 192.168.122.10:5000/reservation-frontend:2.2
podman push --tls-verify=false 192.168.122.10:5000/reservation-backend:2.5
podman push --tls-verify=false 192.168.122.10:5000/reservation-frontend:2.2
```

Le manifest backend reference l'image `2.5` et le frontend `2.2` (limite d'authentification normale du backend: 10). Applique le deploiement :

```bash
kubectl apply -f k8s/backend.yaml -f k8s/frontend.yaml
kubectl rollout status deployment/backend-deployment -n app-reservation
kubectl rollout status deployment/frontend-deployment -n app-reservation
```

Les images ne sont pas stockees dans Git: le depot conserve le code, les Dockerfiles, le lockfile et les manifests; le registre conserve les artefacts OCI. Ne reutilise pas un tag existant: incremente-le ou utilise le commit Git comme tag. Pour une publication figee, un digest `sha256` peut remplacer le tag dans le YAML. Sauvegarde le volume Podman du registre separement du depot. Pour une sauvegarde coherente, arrete le registre le temps de l'export, puis redemarre-le :

```bash
systemctl --user stop reservation-registry.service
podman volume export reservation-registry-data -o ~/reservation-registry-data-backup.tar
systemctl --user start reservation-registry.service
```

Une copie de la premiere sauvegarde est gardee hors Git sur le host dans `/dataSSD/K8S/registry-backups/`.

Installation initiale du registre sur le control plane (une seule fois), depuis `~/reservation-app` :

```bash
mkdir -p ~/.config/containers/systemd
install -m 0644 k8s/registry/reservation-registry.container ~/.config/containers/systemd/
install -m 0644 k8s/registry/reservation-registry-data.volume ~/.config/containers/systemd/
sudo loginctl enable-linger camillej
systemctl --user daemon-reload
systemctl --user start reservation-registry.service
curl http://192.168.122.10:5000/v2/
```

Sur chacun des workers, copier `k8s/registry/containerd-hosts.toml` vers `/etc/containerd/certs.d/192.168.122.10:5000/hosts.toml`. Si `config_path` dans `/etc/containerd/config.toml` n'est pas exactement `/etc/containerd/certs.d`, sauvegarder le fichier, modifier uniquement cette valeur, puis redemarrer containerd un worker a la fois. Cordonner le worker avant l'operation, attendre son retour a `Ready`, puis le remettre schedulable. Ne pas remplacer aveuglement le fichier complet par le snapshot versionne: il peut contenir des reglages specifiques au noeud.

## Deploiement

Le mot de passe PostgreSQL existant reste dans ton Secret `reservation-db-credentials`. Cree un Secret distinct pour Redis et la signature des sessions. La commande genere des valeurs aleatoires; conserver le Secret dans Kubernetes, pas dans Git. Le remplacer invalidera les sessions et paniers actuellement stockes dans Redis.

Les quatre manifests originaux recuperes de `~/backend.yaml`, `~/frontend.yaml`, `~/postgres.yaml` et `~/redis.yaml` sont archives dans `k8s/archive/control-plane-initial/`. Ce sont des snapshots historiques, pas les manifests a appliquer. Le snapshot PostgreSQL a ete assaini pour ne pas inclure le mot de passe en clair.

Depuis `~/reservation-app` sur le control plane (une premiere fois) :

```bash
kubectl get secret reservation-app-secrets -n app-reservation >/dev/null 2>&1 || kubectl create secret generic reservation-app-secrets -n app-reservation \
  --from-literal=redis-password="$(openssl rand -hex 24)" \
  --from-literal=session-secret="$(openssl rand -hex 32)"
```

Pour appliquer sans erreur si le Secret existe deja, ne regenere pas les valeurs a l'aveugle. Pour mettre a jour ses valeurs, faire une sauvegarde des paniers a zero incident acceptable (les paniers sont temporaires), puis recreer la ressource via `kubectl create ... --dry-run=client -o yaml | kubectl apply -f -`.

Deploie le stockage et PostgreSQL, puis Redis et les services applicatifs :

```bash
kubectl apply -f k8s/nfs-storage.yaml -f k8s/postgres.yaml
kubectl rollout status deployment/postgres-deployment -n app-reservation
kubectl apply -f k8s/redis.yaml
kubectl apply -f k8s/backend.yaml
kubectl apply -f k8s/frontend.yaml
kubectl rollout status deployment/backend-deployment -n app-reservation
kubectl rollout status deployment/frontend-deployment -n app-reservation
kubectl rollout status deployment/redis-deployment -n app-reservation
kubectl get pods,svc -n app-reservation -o wide
```

Ouvre `http://192.168.122.1:8080`. Le frontend contacte l'API via le Service Kubernetes `backend-service`; les navigateurs n'accedent pas directement aux IP des Pods.

## Donnees PostgreSQL

PostgreSQL utilise le PVC statique `postgres-pvc`, lie au PV NFS `postgres-pv-nfs` (serveur `192.168.122.1`, export `/dataSSD/K8S/nfs-postgres`). Le PV/PVC est en `ReadWriteMany`, mais PostgreSQL reste strictement a une seule instance : le Deployment utilise `replicas: 1` et la strategie `Recreate`, qui evite le chevauchement de deux processus PostgreSQL lors d'une mise a jour. Ne monte pas ce meme repertoire sur une autre instance PostgreSQL et ne monte pas le nombre de replicas. Le repertoire partage doit appartenir a UID/GID `70:70` avec le mode `0700`, comme configure pour `postgres:15-alpine`.

Le stockage NFS permet au Pod d'etre reprogramme sur un autre worker, mais le serveur NFS unique reste un point de panne et une sauvegarde independante reste indispensable. L'export du laboratoire est configure en `no_root_squash`; garde le reseau isole et privilegie `root_squash` pour un usage plus strict, apres validation des permissions. Les fichiers de donnees PostgreSQL sont sur NFS pour ce laboratoire; pour la production, prefere un stockage officiellement supporte par PostgreSQL, teste en performance et en recuperation. Applique les manifests versionnes avec `kubectl apply -f k8s/nfs-storage.yaml -f k8s/postgres.yaml` et verifie `kubectl get pvc,pv -n app-reservation` ainsi que `kubectl rollout status deployment/postgres-deployment -n app-reservation`.

Avant une migration de donnees, sauvegarde la base avec `pg_dump` et conserve la sauvegarde hors du volume de donnees. Dans ce deploiement, le PVC NFS a ete monte apres export logique puis restauration; le fichier de sauvegarde utilise est conserve sur le control plane, hors de Git.

Redis reste un Pod unique sans stockage persistant: une panne peut effacer les sessions et paniers, ce qui est acceptable pour ces donnees temporaires. Les commandes confirmees et le stock sont exclusivement dans PostgreSQL. Ce manifeste Redis n'active pas la haute disponibilite; Redis Sentinel/Cluster et une strategie de persistance peuvent etre etudies ensuite.
