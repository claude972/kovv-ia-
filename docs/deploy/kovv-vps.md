---
title: Déploiement VPS Hostinger
summary: Guide complet pour auto-héberger Kovv-ia sur un VPS Hostinger avec Docker Compose
---

# Déployer Kovv-ia sur un VPS Hostinger

Ce guide vous aide à déployer Kovv-ia (Paperclip) sur un VPS Hostinger (KVM, Ubuntu/Debian) avec Docker Compose et accès HTTPS public via Caddy.

## Prérequis

- **VPS Hostinger (KVM)** : Ubuntu 22.04/24.04 ou Debian 12+ avec au moins 2–4 Go RAM (pour la compilation du build Docker). Le plan KVM 2 (2 vCPU / 8 Go) est confortable pour le build ; KVM 1 (1 vCPU / 4 Go) suffit mais le premier build sera plus lent.
  - Astuce : dans le hPanel Hostinger, lors de la création/réinstallation du VPS, vous pouvez choisir le template **« Ubuntu 24.04 with Docker »** — Docker et Compose sont alors déjà installés et vous pouvez sauter l'étape 1.
- **Domaine** : un domaine pointant vers l'IP publique du VPS (ex. `paperclip.example.com`)
  - A record configuré dans votre DNS (hPanel Hostinger si le domaine est chez Hostinger, sinon chez votre registrar)
- **Accès SSH** : connexion au VPS en tant que root ou avec `sudo` (le hPanel Hostinger fournit l'IP, l'utilisateur root et un terminal navigateur dans l'onglet du VPS)
- **Git** : pour cloner le dépôt Kovv-ia
- **Mac avec Claude Max** : pour générer un OAuth token pour les agents Claude

## Étape 1 : Installer Docker Engine et le plugin Compose

> Si vous avez choisi le template Hostinger **« Ubuntu with Docker »**, Docker est déjà présent. Vérifiez avec `docker --version && docker compose version` et passez directement à l'étape 2.

Connectez-vous au VPS en SSH (`ssh root@<IP_VPS>`) et exécutez le script officiel Docker, qui détecte automatiquement Ubuntu ou Debian :

```bash
# Installer Docker Engine + Compose (détecte la distro automatiquement)
curl -fsSL https://get.docker.com | sudo sh

# Vérifier l'installation
docker --version
docker compose version

# (optionnel, pour éviter sudo) ajouter votre utilisateur au groupe docker
sudo usermod -aG docker $USER
newgrp docker   # ou déconnectez-vous / reconnectez-vous
```

## Étape 2 : Configurer le domaine

Assurez-vous que le A record de votre domaine pointe vers l'adresse IP publique du VPS (visible dans le hPanel Hostinger, onglet du VPS).

Si votre domaine est géré par Hostinger :
1. Connectez-vous au hPanel Hostinger
2. Allez dans **Domaines → votre domaine → DNS / Zone DNS**
3. Ajoutez/mettez à jour un A record : `paperclip` (ou `@`) → `<IP_VPS>`, TTL faible (ex. 300)
4. Attendez quelques minutes pour la propagation DNS
5. Testez : `ping paperclip.example.com` (doit résoudre vers votre IP VPS)

Si votre domaine est ailleurs (Cloudflare, OVH, Gandi…), créez le même A record chez ce registrar. Pour un certificat HTTPS via le challenge HTTP-01 par défaut, laissez le proxy/CDN désactivé (chez Cloudflare : nuage gris, pas orange) le temps de l'émission initiale.

## Étape 3 : Cloner le dépôt Kovv-ia

> **Prérequis important** : la traduction française et le rebrand Kovv-ia vivent pour l'instant dans votre copie de travail locale (sur le Mac) et **ne sont pas encore poussés** sur le dépôt distant. Avant de cloner sur le VPS, committez et poussez ces changements vers votre fork `github.com/claude972/kovv-ia-` (branche `master`). Sinon le VPS récupérerait la version Paperclip d'origine en anglais.
>
> Ne committez jamais `docker/.env.prod` ni aucun token (vérifiez qu'ils sont bien dans `.gitignore`).

Une fois les changements poussés, sur le VPS :

```bash
cd /opt
sudo git clone https://github.com/claude972/kovv-ia-.git kovv-ia
sudo chown -R $USER:$USER /opt/kovv-ia
cd /opt/kovv-ia
```

## Étape 4 : Générer l'OAuth token Claude Max

Sur **votre Mac** (pas sur le VPS), où vous êtes déjà connecté à Claude Max, générez un OAuth token longue durée :

```bash
claude setup-token
```

La commande ouvre votre navigateur pour autoriser l'accès, puis **affiche le token directement dans le terminal** (une longue chaîne commençant par `sk-ant-oat...`). Copiez cette valeur — c'est elle que vous collerez dans `CLAUDE_CODE_OAUTH_TOKEN` à l'étape suivante.

> Ce token donne accès à votre abonnement Claude Max. Traitez-le comme un mot de passe : ne le commitez jamais, ne le partagez pas. Vous pourrez le révoquer/régénérer en relançant `claude setup-token`.

## Étape 5 : Configurer les variables d'environnement

Sur le VPS, dans `/opt/kovv-ia/docker/` :

```bash
cp .env.prod.example .env.prod
# Éditez .env.prod avec vos valeurs
nano .env.prod
```

Remplissez les champs suivants :

### `DOMAIN`
Votre domaine public, ex. `paperclip.example.com`

### `PAPERCLIP_PUBLIC_URL`
`https://` + votre domaine, ex. `https://paperclip.example.com`

### `BETTER_AUTH_SECRET`
Générez une clé secrète forte (obligatoire) :

```bash
openssl rand -base64 48
```

Copiez la sortie dans le fichier `.env.prod`.

### `CLAUDE_CODE_OAUTH_TOKEN`
Collez le token que vous avez obtenu à l'étape 4. Cela permet aux agents d'utiliser votre abonnement Claude Max.

Si vous laissez ce champ vide, les agents nécessiteront une `ANTHROPIC_API_KEY` (API payante) pour fonctionner.

### `OPENAI_API_KEY` (optionnel)
Si vous voulez utiliser des agents OpenAI, remplissez avec votre clé. Sinon, laissez vide.

### `CLOUDFLARE_API_TOKEN` (optionnel)
Si votre domaine utilise Cloudflare DNS, générez un token API Cloudflare avec la permission "Zone:Edit" pour les challenges DNS automatiques. Sinon, Caddy utilisera les challenges HTTP standard (plus lent mais fonctionnel).

**Important** : jamais ne commitez `.env.prod` dans le dépôt. Stockez ce fichier de manière sécurisée.

## Étape 6 : Démarrer les conteneurs

```bash
cd /opt/kovv-ia
docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.prod up -d --build
```

La première exécution peut prendre 5–10 minutes pour compiler le build multi-étapes.

Vérifiez l'état :

```bash
docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.prod ps
```

Vous devriez voir deux conteneurs : `paperclip-prod` et `caddy-prod`, tous deux en état "Up".

## Étape 7 : Vérifier le démarrage

```bash
# Consultez les logs
docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.prod logs -f paperclip

# Attendez le message "Listening on 0.0.0.0:3100"
# Quand c'est prêt, quittez avec Ctrl+C
```

Ensuite, testez Caddy :

```bash
docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.prod logs -f caddy
# Cherchez le message "Certifying..." ou "Cert already exists"
```

Une fois les deux conteneurs en place, accédez à votre domaine dans un navigateur :

```
https://paperclip.example.com
```

## Étape 8 : Créer le compte administrateur initial

Vous verrez l'écran de connexion de Better Auth.

1. Cliquez sur **"Sign up"**
2. Entrez un email et un mot de passe
3. Le premier utilisateur créé devient administrateur

## Étape 9 : Vérifier l'authentification Claude Max

Une fois connecté :

1. Allez dans **Agents** ou **Settings** (l'interface peut varier)
2. Essayez d'invoquer un agent Claude
3. L'agent devrait utiliser votre abonnement Claude Max (pas d'API key requise)

Si vous voyez une erreur d'authentification, vérifiez :
- `CLAUDE_CODE_OAUTH_TOKEN` est rempli et valide dans `.env.prod`
- `ANTHROPIC_API_KEY` n'est PAS défini (laissez-le vide)
- Les logs du conteneur : `docker logs paperclip-prod | grep -i token`

## Opérations courantes

### Consulter les logs en direct

```bash
docker compose -f docker/docker-compose.prod.yml logs -f --tail=50
```

### Mettre à jour le code et redémarrer

```bash
cd /opt/kovv-ia
git pull origin main
docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.prod up -d --build
```

### Sauvegarder le volume de données

Les données de l'instance (SQLite) sont dans le volume Docker `paperclip-data`.

```bash
# Créer une sauvegarde locale
docker run --rm -v paperclip-data:/data -v $(pwd)/backups:/backup \
  alpine tar czf /backup/paperclip-data-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .

# Ou si vous utilisez docker volume export (recommandé)
docker volume inspect paperclip-data # note le mount point
sudo tar czf /opt/backups/paperclip-data-$(date +%Y%m%d-%H%M%S).tar.gz \
  -C <mount-point> .
```

### Arrêter les conteneurs

```bash
docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.prod down
```

### Redémarrer proprement

```bash
docker compose -f docker/docker-compose.prod.yml --env-file docker/.env.prod restart
```

## Sécurité

### Firewall

N'exposez que les ports **80** et **443** au public (et **22** pour SSH). Le port 3100 de Kovv-ia n'est jamais publié sur l'hôte : il reste interne au réseau Docker et seul Caddy y accède.

Hostinger propose **deux niveaux** de firewall — configurez de préférence les deux :

1. **Firewall Hostinger (hPanel)** — dans l'onglet du VPS → **Firewall**, créez/activez un jeu de règles autorisant uniquement les ports 22, 80 et 443 en entrée. C'est le filtrage en amont de la machine.

2. **UFW sur le VPS** (défense en profondeur) :

```bash
sudo ufw allow 22/tcp      # SSH
sudo ufw allow 80/tcp      # HTTP
sudo ufw allow 443/tcp     # HTTPS
sudo ufw default deny incoming
sudo ufw enable
```

> Si vous activez le firewall Hostinger, vérifiez bien que le port **22 reste ouvert** avant de fermer votre session SSH, sous peine de vous verrouiller dehors (vous garderez toujours le terminal navigateur du hPanel comme secours).

### Secrets sensibles

- **BETTER_AUTH_SECRET** : jamais ne mettez à jour après déploiement (invalidera les sessions).
- **CLAUDE_CODE_OAUTH_TOKEN** : c'est un credential sensible. Changer si vous soupçonnez une fuite. Stockez `.env.prod` dans un gestionnaire de secrets (1Password, Vault, etc.).
- **ANTHROPIC_API_KEY** : ne le définez PAS (il switche vers la facturation API payante).

### Certificats HTTPS

Caddy renouvelle automatiquement les certificats Let's Encrypt 30 jours avant expiration. Les certificats sont stockés dans le volume `caddy_data`. Ils persisteront entre redémarrages.

## Dépannage

### "Certificate authority unreachable" ou erreur de certificat

- Vérifiez que le domaine résout correctement : `nslookup paperclip.example.com`
- Attendez que le A record soit propagé (quelques minutes)
- Caddy va réessayer automatiquement

### Port 80/443 en conflit

```bash
# Vérifiez si quelque chose d'autre utilise ces ports
sudo netstat -tulpn | grep -E ':80|:443'
# Arrêtez ce service ou changez son port
```

### Conteneur paperclip refuse les connexions

```bash
# Vérifiez la santé
docker compose -f docker/docker-compose.prod.yml logs paperclip | tail -20
# Cherchez des erreurs de démarrage
```

### Les agents Claude ne fonctionnent pas

- Vérifiez que `CLAUDE_CODE_OAUTH_TOKEN` est défini dans `.env.prod`
- Confirmer qu'`ANTHROPIC_API_KEY` n'est PAS défini
- Consultez les logs : `docker logs paperclip-prod | grep -iE 'claude|auth'`

## Ressources supplémentaires

- [Vue d'ensemble des déploiements Paperclip](overview.md)
- [Variables d'environnement complètes](environment-variables.md)
- [Guide d'authentification Tailscale (accès privé)](tailscale-private-access.md)
