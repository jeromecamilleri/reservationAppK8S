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

Pour generer un trafic de demonstration dans le cluster, demarre un Pod de charge puis surveille les replicas et leur CPU :

```bash
kubectl run loadgen -n app-reservation --image=busybox:1.36 --restart=Never --command -- sh -c 'while true; do wget -q -O /dev/null http://backend-service:8080/events & wget -q -O /dev/null http://backend-service:8080/events & wget -q -O /dev/null http://backend-service:8080/events & wget -q -O /dev/null http://backend-service:8080/events & wget -q -O /dev/null http://backend-service:8080/events & wget -q -O /dev/null http://backend-service:8080/events & wget -q -O /dev/null http://backend-service:8080/events & wget -q -O /dev/null http://backend-service:8080/events & wait; done'
kubectl top pods -n app-reservation
kubectl get deployment backend-deployment -n app-reservation -w
```

Arrete le generateur avec `kubectl delete pod loadgen -n app-reservation`. Le HPA devrait ensuite reduire progressivement les replicas, jusqu'au minimum de deux.

## Construction des images sans Docker

Installe Podman sur ton poste Linux (ou sur le control plane si c'est plus pratique). Sur Ubuntu 24.04, Podman est disponible dans les depots officiels :

```bash
sudo apt update
sudo apt install podman
```

Le registre du labo tourne sur le control plane via les fichiers Quadlet `k8s/registry/`. Son stockage est un volume Podman persistant, hors du depot Git. L'unite est liee a l'adresse de labo `192.168.122.10:5000`; elle est en HTTP sans authentification, donc ne pas l'exposer hors du reseau isole. Les workers lisent `k8s/registry/containerd-hosts.toml` depuis `/etc/containerd/certs.d/192.168.122.10:5000/hosts.toml`.

Sur ce cluster containerd 2.2.1, le `config_path` genere contient deux chemins separes par `:`; le pull CRI ignore alors le `hosts.toml`. Il faut utiliser uniquement `/etc/containerd/certs.d` dans `[plugins.'io.containerd.cri.v1.images'.registry]`, puis redemarrer containerd sur les workers un par un et verifier un pull CRI. Le snapshot complet recupere du worker1 est archive en `k8s/registry/containerd-worker-config.toml`; ne le copie pas aveuglement sur des noeuds dont la configuration aurait diverge. Le changement de `hosts.toml` seul ne requiert pas de redemarrage. Voir la [documentation containerd](https://github.com/containerd/containerd/blob/main/docs/hosts.md) et le [cas containerd 2.2](https://github.com/containerd/containerd/issues/12636).

Pour reconstruire et publier, depuis la racine du projet (par exemple `cd ~/reservation-app-v2` sur le control plane), choisis un nouveau tag a chaque version :

```bash
# Sur le host, synchronise les sources vers la machine qui a Podman.
rsync -av --exclude=.git --exclude=node_modules --exclude=k8s/database-secret.yaml \
  /dataSSD/K8S/reservation-app/ camillej@192.168.122.10:reservation-app-v2/
```

Puis, sur le control plane :

```bash
cd ~/reservation-app-v2
podman build --platform linux/amd64 -t localhost/reservation-backend:2.0 ./backend
podman build --platform linux/amd64 -t localhost/reservation-frontend:2.0 ./frontend
podman tag localhost/reservation-backend:2.0 192.168.122.10:5000/reservation-backend:2.0
podman tag localhost/reservation-frontend:2.0 192.168.122.10:5000/reservation-frontend:2.0
podman push --tls-verify=false 192.168.122.10:5000/reservation-backend:2.0
podman push --tls-verify=false 192.168.122.10:5000/reservation-frontend:2.0
```

Apres avoir change les tags dans `k8s/backend.yaml` et `k8s/frontend.yaml`, applique le deploiement :

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

Installation initiale du registre sur le control plane (une seule fois), depuis `~/reservation-app-v2` :

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

Deploie ensuite Redis, puis les services applicatifs :

```bash
kubectl apply -f k8s/redis.yaml
kubectl apply -f k8s/backend.yaml
kubectl apply -f k8s/frontend.yaml
kubectl rollout status deployment/backend-deployment -n app-reservation
kubectl rollout status deployment/frontend-deployment -n app-reservation
kubectl rollout status deployment/redis-deployment -n app-reservation
kubectl get pods,svc -n app-reservation -o wide
```

Ouvre ensuite `http://192.168.122.11:30080` (ou `.12:30080` / `.13:30080`). Le frontend contacte l'API via le Service Kubernetes `backend-service`; les navigateurs n'ont pas besoin d'acceder directement aux IP des Pods.

## Donnees PostgreSQL

Les tables `events` et `reservations` sont creees par l'API. Le manifeste PostgreSQL fourni ne monte aucun volume : les donnees peuvent disparaitre si le Pod PostgreSQL est recree. Verifie la presence d'un stockage dynamique avant de configurer un PVC :

```bash
kubectl get storageclass
```

Redis est un Pod unique sans stockage persistant: une panne peut effacer les sessions et paniers, ce qui est acceptable pour ces donnees temporaires. Les commandes confirmees et le stock sont exclusivement dans PostgreSQL. Ce manifeste Redis n'active pas la haute disponibilite; Redis Sentinel/Cluster et une strategie de persistance peuvent etre etudies ensuite.

Un PVC seul ne stocke rien tant qu'aucune `StorageClass` ou aucun `PersistentVolume` ne peut le fournir. Pour un premier exercice, un provisioner local (par exemple local-path) conservera les fichiers lors du remplacement du Pod, mais le volume restera lie a un noeud : ce n'est pas une protection contre la panne de ce worker. Avant de monter un volume sur la base deja utilisee, faire un `pg_dump` et planifier la migration; un volume neuf demarre une base vide. Une vraie tolerance a la panne d'un worker demande du stockage replique (par exemple Longhorn) ou une base externe, ainsi que des sauvegardes testees.
