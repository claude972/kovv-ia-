# Kovv-ia — Pont Telegram

Ce pont relie votre bot Telegram à l'agent IA de Kovv-ia. Chaque conversation Telegram correspond à un fil de travail (issue) dans Kovv-ia : l'agent reçoit vos messages et répond directement dans Telegram.

**Aucune dépendance npm.** Le pont utilise uniquement les modules intégrés de Node.js (v18+).

---

## Prérequis

- Node.js 18 ou plus récent (la version 26 est installée sur votre machine, parfait).
- Kovv-ia qui tourne localement sur `http://127.0.0.1:3100`.

---

## Étape 1 — Créer un bot Telegram avec @BotFather

1. Ouvrez Telegram et cherchez **@BotFather**.
2. Envoyez la commande `/newbot`.
3. Suivez les instructions : choisissez un nom et un nom d'utilisateur pour votre bot.
4. BotFather vous donnera un **token** qui ressemble à : `123456789:ABCDefGhIJKlMnOpQrStUvWxYz`
5. Copiez ce token — vous en aurez besoin dans le fichier `.env`.

---

## Étape 2 — Vérifier que Kovv-ia tourne

Avant de démarrer le pont, assurez-vous que Kovv-ia est lancé :

```bash
# Depuis la racine du projet
pnpm dev
```

Vérifiez que l'API répond :

```bash
curl http://127.0.0.1:3100/api/companies
```

Vous devriez voir une liste JSON d'entreprises.

---

## Étape 3 — Trouver les IDs (entreprise, agent, projet)

Le pont inclut une commande de découverte qui liste toutes les entités disponibles dans Kovv-ia. Vous n'avez pas besoin de configurer Telegram pour ça.

```bash
node tools/telegram-bridge/bridge.mjs --list
```

Résultat exemple :

```
┌─ Entreprise : Mon Entreprise
│  id         : clx1abc2def3ghi4
│
│  Agents :
│    • Assistant IA           id=agt_xyz123  rôle=assistant  statut=active
│
│  Projets :
│    • Projet Principal       id=prj_abc789
└─────────────────────────────────────────────────────────
```

Copiez les IDs qui vous intéressent dans votre fichier `.env`.

> Si Kovv-ia n'est pas encore démarré, cette commande affichera un message d'erreur explicite.

---

## Étape 4 — Configurer le fichier .env

Copiez le modèle fourni :

```bash
cp tools/telegram-bridge/.env.example tools/telegram-bridge/.env
```

Ouvrez `tools/telegram-bridge/.env` et renseignez au minimum ces trois valeurs :

```env
TELEGRAM_BOT_TOKEN=<votre-token-botfather>
KOVV_COMPANY_ID=<id-copié-depuis---list>
KOVV_AGENT_ID=<id-de-l-agent-choisi>
```

### Sécurité — liste blanche des utilisateurs autorisés

Pour que seules certaines personnes puissent utiliser votre bot, ajoutez leurs chat IDs dans `TELEGRAM_ALLOWED_CHAT_IDS`. Si ce champ est vide, **tout utilisateur Telegram** qui connaît le nom de votre bot pourra lui écrire.

Pour trouver votre chat ID : démarrez le bot, puis envoyez `/id`. Le bot vous répondra avec votre identifiant numérique.

```env
TELEGRAM_ALLOWED_CHAT_IDS=123456789,987654321
```

---

## Étape 5 — Lancer le pont

```bash
node --env-file tools/telegram-bridge/.env tools/telegram-bridge/bridge.mjs
```

Le pont démarre, charge l'état précédent s'il existe, et attend vos messages Telegram.

Pour arrêter proprement : **Ctrl+C**. L'état est sauvegardé automatiquement.

---

## Étape 6 — Utiliser le bot sur Telegram

Ouvrez votre bot sur Telegram et commencez à écrire. L'agent Kovv-ia vous répondra directement dans la conversation.

### Commandes disponibles

| Commande | Description |
|----------|-------------|
| `/start` ou `/aide` | Affiche le message d'accueil et la liste des commandes |
| `/nouveau` | Démarre une nouvelle conversation (le fil précédent est oublié) |
| `/id` | Affiche votre chat ID Telegram (utile pour la liste blanche) |

### Comment ça fonctionne

- **Premier message** : le pont crée une nouvelle issue dans Kovv-ia et l'assigne à votre agent. L'agent traite la demande et répond.
- **Messages suivants** : les messages s'ajoutent au fil existant comme des commentaires.
- **`/nouveau`** : réinitialise le fil. Votre prochain message créera une nouvelle issue.
- Quand l'agent termine une tâche (statut `done`), le bot vous en informe et vous invite à ouvrir un nouveau fil.

---

## Fichiers créés automatiquement

| Fichier | Description |
|---------|-------------|
| `tools/telegram-bridge/state.json` | Sauvegarde des conversations en cours et de l'offset Telegram. Supprimez ce fichier pour repartir de zéro. |

---

## Dépannage

**Le bot ne répond pas**
- Vérifiez que `TELEGRAM_BOT_TOKEN` est correct.
- Assurez-vous que votre chat ID est dans `TELEGRAM_ALLOWED_CHAT_IDS` (ou laissez le champ vide pour les tests).

**"Kovv-ia est injoignable"**
- Vérifiez que Kovv-ia tourne (`pnpm dev` depuis la racine).
- Testez : `curl http://127.0.0.1:3100/api/companies`

**L'agent ne répond pas**
- Vérifiez que `KOVV_AGENT_ID` correspond bien à un agent actif (relancez `--list`).
- Consultez les logs de Kovv-ia pour voir si l'issue a été créée.

**Relancer après un arrêt**
- Le fichier `state.json` conserve l'état. Relancez simplement la même commande — les conversations en cours reprennent où elles s'étaient arrêtées.
