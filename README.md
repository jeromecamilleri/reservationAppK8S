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

Depuis le dossier qui contient `reservation-app`, construis les images. Podman lit les Dockerfiles sans Docker Engine :

```bash
podman build --platform linux/amd64 -t localhost/reservation-backend:2.0 ./reservation-app/backend
podman build --platform linux/amd64 -t localhost/reservation-frontend:2.0 ./reservation-app/frontend
podman save --format docker-archive -o /tmp/reservation-backend-v2.tar localhost/reservation-backend:2.0
podman save --format docker-archive -o /tmp/reservation-frontend-v2.tar localhost/reservation-frontend:2.0
```

Transfere les deux archives sur chaque worker et importe-les dans le namespace `k8s.io` de containerd. Cela n'installe aucun moteur Docker et ne change pas le runtime Kubernetes :

```bash
for node in 192.168.122.11 192.168.122.12 192.168.122.13; do
  scp /tmp/reservation-backend-v2.tar /tmp/reservation-frontend-v2.tar camillej@$node:/tmp/
  ssh -t camillej@$node 'sudo ctr -n k8s.io images import /tmp/reservation-backend-v2.tar && sudo ctr -n k8s.io images import /tmp/reservation-frontend-v2.tar && sudo ctr -n k8s.io images list | grep reservation'
done
```

Copie ensuite le projet sur le control plane pour y appliquer les manifests :

```bash
scp -r reservation-app camillej@192.168.122.10:~/
```

Pour les reconstructions suivantes, incrémente le tag dans les commandes et dans les deux manifests, ou configure un registre local. L'import d'archives est simple pour commencer; un registre évite de recopier l'image sur chaque worker à chaque mise à jour.

## Deploiement

Le mot de passe PostgreSQL existant reste dans ton Secret `reservation-db-credentials`. Cree un Secret distinct pour Redis et la signature des sessions. La commande genere des valeurs aleatoires; conserver le Secret dans Kubernetes, pas dans Git. Le remplacer invalidera les sessions et paniers actuellement stockes dans Redis.

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
