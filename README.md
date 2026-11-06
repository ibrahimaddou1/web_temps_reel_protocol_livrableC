# TP WebSocket et P2P

## Tracker HTTP — Livrable B

Démarrer le tracker dans un terminal :

```bash
npm run tracker -- 4000
```

Dans un autre terminal, annoncer un serveur WebSocket (exemples pour Bash/WSL) :

```bash
curl -i -X POST http://localhost:4000/announce -H 'Content-Type: application/json' -d '{"id":"serveur-ibrahim","wsUrl":"ws://localhost:3000/ws"}'
```

Consulter les pairs en ligne :

```bash
curl http://localhost:4000/peers
```

`POST /announce` renvoie 201 à la création, 200 au renouvellement, 400 pour un format invalide et 409 si un identifiant actif désigne une autre URL. `GET /peers` renvoie 200 avec la liste dans `peers`.

Une annonce reste valide pendant 30 secondes. La renouveler avant expiration, par exemple toutes les 10 secondes. Sans renouvellement, le pair disparaît de la liste. Les données sont conservées en mémoire. À ce stade, l’annonce se fait manuellement avec curl.

## Installation

Installer Node.js et npm, puis exécuter dans le dossier du projet :

```bash
npm install
```

## Connexion WebSocket — Étape A

Dans un premier terminal, démarrer le serveur :

```bash
npm start -- http://localhost:3000
```

Dans un deuxième terminal, démarrer le client :

```bash
npm run client -- ws://localhost:3000/ws
```

Le client affiche `Connecté au serveur WebSocket`. Le serveur affiche `Client WebSocket connecté`.

Les connexions, les déconnexions et les erreurs WebSocket sont affichées dans le terminal.

Le serveur envoie un ping WebSocket toutes les 5 secondes lorsqu’aucun pong n’est en attente. Le client répond automatiquement. Sans pong sous 15 secondes, le serveur ferme la connexion. Le client ferme aussi la connexion s’il ne reçoit aucun ping pendant 20 secondes. Un message indique la connexion perdue.

Utiliser Ctrl+C pour arrêter le client ou le serveur.

Pour tester depuis un autre ordinateur, remplacer `localhost` dans les deux commandes par l’IPv4 de l’ordinateur qui héberge le serveur. Le port 3000 doit être accessible depuis cet ordinateur.

## Protocole HTTP entre camarades

Les échanges HTTP sont implémentés dans `serveur.js`.

Chaque camarade démarre son serveur avec sa propre IPv4, par exemple :

```bash
npm start -- http://172.20.10.2:3000
```

Dans ce même terminal, se connecter au serveur du camarade, par exemple :

```text
connect http://172.20.10.4:3001
```

Après la poignée de main, la console affiche `Connexion établie avec` le nom du camarade ou son URL. Les noms sont renseignés dans la Map `noms` de `serveur.js`.

Pour envoyer un message à tous les camarades connectés :

```text
message {"action":"bonjour","payload":{"texte":"Salut !"}}
```

Le destinataire affiche `Message reçu de` avec le nom ou l’URL de l’expéditeur et le message.


## Enregistrement automatique et messages privés — Livrable B

Démarrer le tracker :

```bash
npm run tracker -- 4000
```

Dans un autre terminal, démarrer le serveur avec son URL, l’URL du tracker et son identifiant :

```bash
npm start -- http://localhost:3000 http://localhost:4000 serveur-ibrahim
```

Le serveur renouvelle automatiquement son annonce toutes les 10 secondes. Vérifier sa présence avec :

```bash
curl http://localhost:4000/peers
```

Démarrer deux clients dans deux terminaux :

```bash
npm run client -- ws://localhost:3000/ws ibrahim
npm run client -- ws://localhost:3000/ws imal
```

Chaque client envoie un message register avec son identifiant. Le serveur confirme avec registered. Deux clients connectés ne peuvent pas utiliser le même identifiant.

Une fois identifié, chaque client voit qui est en ligne. Par exemple, quand Imal se connecte, son terminal affiche `alice est en ligne` si Alice était déjà connectée. De son côté, le terminal d’Alice affiche `imal est en ligne`.

Pour vérifier la déconnexion, arrête le client d’Imal avec Ctrl+C. Alice voit alors :

```text
imal est hors ligne
```

Le client reçoit ces changements sous la forme d’un événement `presence` :

```json
{"action":"presence","payload":{"id":"imal","status":"online"}}
```

`status` vaut `online` quand le client s’inscrit et `offline` quand il se déconnecte. Seuls les clients déjà identifiés reçoivent ces notifications.

Dans le terminal d’Ibrahim, saisir :

```text
imal Salut !
```

Imal reçoit un message avec metadata.source, metadata.target, metadata.timestamp et payload.texte. Il peut répondre en saisissant ibrahim suivi de son texte. Le broker utilise l’identifiant de la connexion comme source. Un destinataire absent entraîne une mise en file avec confirmation queued. Les clients de ce test se connectent au même serveur.

## Broadcast WebSocket

Depuis un client identifié, envoyer un message à tous les autres clients identifiés et connectés au même broker :

```text
* Bonjour à tous !
```

La convention WebSocket est metadata.target = "*". L’expéditeur ne reçoit pas sa propre diffusion. L’identifiant "*" est réservé. Les messages privés fonctionnent avec le même format en indiquant l’identifiant du destinataire.

## File de messages privés

Si un destinataire est déconnecté, le broker conserve les messages privés dans une file en mémoire et répond à l’expéditeur avec l’action queued. Dès que le destinataire se reconnecte et s’identifie avec le même id, les messages sont envoyés dans leur ordre de réception.

Pour tester, fermer le client imal avec Ctrl+C. Depuis ibrahim, saisir deux messages :

```text
imal Premier message
imal Deuxième message
```

Relancer ensuite le client :

```bash
npm run client -- ws://localhost:3000/ws imal
```

Imal reçoit les deux messages dans l’ordre. La file est conservée tant que le broker tourne, sans limite de durée ni de taille. Un redémarrage efface les messages. Les broadcasts concernent uniquement les clients connectés. La livraison se base sur la réussite de l’envoi WebSocket, sans accusé de lecture du destinataire.

## Messages HTTP /ingress

Les messages exigent metadata.source et metadata.target sous forme d’origines HTTP, et metadata.timestamp au format ISO avec fuseau horaire. La commande message du serveur construit ces champs.

Le premier message est accepté avec 201. Le même quadruplet action, source, target et timestamp reçoit 208. Cette convention de doublon reste à valider avec la classe. La mémoire des doublons et les files sont effacées au redémarrage.

## Livrable C — Découverte et connexions directes

Chaque processus pair joue le rôle de serveur et de client WebSocket. Il s’annonce au tracker, récupère la liste des pairs et ouvre jusqu’à deux connexions sortantes vers d’autres pairs. Les annonces et la découverte sont renouvelées toutes les 10 secondes.

Depuis livrableC, démarrer le tracker dans un terminal :

```bash
npm run tracker -- 4000
```

Démarrer ensuite trois pairs dans trois terminaux distincts :

```bash
npm run pair -- ibrahim ws://localhost:3001/ws http://localhost:4000
npm run pair -- imal ws://localhost:3002/ws http://localhost:4000
npm run pair -- zack ws://localhost:3003/ws http://localhost:4000
```

Chaque terminal doit afficher Connexion directe avec suivi de l’identifiant du pair distant, au plus tard après le prochain cycle de découverte. Vérifier aussi la liste avec curl http://localhost:4000/peers.

Chaque connexion échange un message hello contenant l’identifiant déclaré. Deux pairs peuvent chacun ouvrir une connexion vers l’autre. La limite de deux concerne les connexions sortantes, les connexions entrantes sont acceptées séparément. Ctrl+C arrête un pair. Son annonce expire après 30 secondes.

Pour plusieurs ordinateurs, utiliser l’IP accessible de chaque pair et l’IP du tracker. Cette étape implémente la découverte et l’ouverture des connexions. Les identifiants échangés sont déclaratifs.
