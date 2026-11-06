
const WebSocket = require('ws');
const readline = require('node:readline');
const adresse = process.argv[2] || 'ws://localhost:3000/ws';
const clientId = process.argv[3];
let identifie = false;
let connexion;
let attentePing;
let rl;

let tentative = 0;
let timerReconnexion;
let arretDemande = false;

function attendrePing() {
  clearTimeout(attentePing);
  attentePing = setTimeout(() => {
    console.log('Connexion WebSocket perdue : aucun ping reçu');
    connexion.terminate();
  }, 20000);
}
function programmerReconnexion() {
  if (arretDemande || timerReconnexion) return;

  const delai = Math.min(1000 * (2 ** tentative), 30000);
  tentative++;

  console.log(`Reconnexion dans ${delai / 1000} seconde(s)...`);

  timerReconnexion = setTimeout(() => {
    timerReconnexion = undefined;
    creerConnexion();
  }, delai);
}

function creerConnexion() {
  if (arretDemande) return;

  connexion = new WebSocket(adresse, {
    handshakeTimeout: 15000
  });

  ecouterConnexion();
}

function ecouterConnexion() {
  connexion.on('open', () => {
    console.log('Connecté au serveur WebSocket', adresse);
    identifie = false;
    if (clientId) {
      connexion.send(JSON.stringify({ action: 'register', payload: { id: clientId } }));
    }
    tentative = 0;
    attendrePing();

    if (!rl) {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      rl.on('line', (texte) => {
        if (connexion.readyState !== WebSocket.OPEN) {
          console.log('Connexion indisponible');
          return;
        }

        if (clientId) {
          if (!identifie) {
            console.log('Identification en cours ou refusée');
            return;
          }
          const separateur = texte.indexOf(' ');
          if (separateur < 1 || !texte.slice(separateur + 1).trim()) {
            console.log('Usage : destinataire texte du message');
            return;
          }
          connexion.send(JSON.stringify({
            action: 'message',
            metadata: { target: texte.slice(0, separateur) },
            payload: { texte: texte.slice(separateur + 1) },
          }));
          return;
        }
        const message = {
          action: 'bonjour',
          payload: {
            texte: texte
          }
        };

        connexion.send(JSON.stringify(message));
        console.log('Message envoyé :', message);
      });
    }

    console.log(clientId ? 'Écris : destinataire texte du message (ou * texte pour tous)' : 'Écris un message :');
  });

  connexion.on('ping', attendrePing);

  connexion.on('close', () => {
    clearTimeout(attentePing);

    console.log('Connexion WebSocket fermée');

    programmerReconnexion();
  });

  connexion.on('error', err => {
    console.error('Connexion WebSocket échouée :', err.message);
  });

  connexion.on('message', data => {
    try {
      const message = JSON.parse(data.toString());
      if (message.action === 'registered') identifie = true;
    } catch {}
    console.log('Message reçu du serveur :', data.toString());
  });
}
creerConnexion();
process.on('SIGINT', () => {
  arretDemande = true;

  clearTimeout(attentePing);
  clearTimeout(timerReconnexion);

  rl?.close();

  if (connexion) {
    connexion.terminate();
  }
  process.exit(0);
});
  