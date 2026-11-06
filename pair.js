const axios = require('axios');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;

const id = process.argv[2];
let adresse;
let tracker;
try {
  adresse = new URL(process.argv[3]);
  tracker = new URL(process.argv[4] || 'http://localhost:4000');
  if (!id || adresse.protocol !== 'ws:' || adresse.username || adresse.password ||
      adresse.search || adresse.hash || !['http:', 'https:'].includes(tracker.protocol)) {
    throw new Error('Arguments invalides');
  }
} catch {
  console.error('Usage : npm run pair -- identifiant ws://localhost:3001/ws http://localhost:4000');
  process.exit(1);
}

const connexionsSortantes = new Map();
const limitePairs = 2;
let actualisationEnCours = false;
let arret = false;
const serveur = new WebSocketServer({
  host: '0.0.0.0',
  port: Number(adresse.port || 80),
  path: adresse.pathname,
});

function ecouter(connexion) {
  connexion.on('message', data => {
    try {
      const message = JSON.parse(data.toString());
      if (message.action === 'hello' && typeof message.payload?.id === 'string') {
        console.log('Connexion directe avec', message.payload.id);
      }
    } catch {
      console.error('Message JSON invalide');
    }
  });
  connexion.on('error', err => console.error('Erreur de connexion :', err.message));
}

function saluer(connexion) {
  connexion.send(JSON.stringify({ action: 'hello', payload: { id } }));
}

serveur.on('connection', connexion => {
  ecouter(connexion);
  saluer(connexion);
  connexion.on('close', () => console.log('Connexion entrante fermée'));
});
serveur.on('error', err => console.error('Erreur serveur pair :', err.message));

async function actualiser() {
  if (actualisationEnCours || arret) return;
  actualisationEnCours = true;
  try {
    await axios.post(new URL('/announce', tracker).href, {
      id, wsUrl: adresse.href,
    }, { timeout: 15000 });
    const reponse = await axios.get(new URL('/peers', tracker).href, { timeout: 15000 });
    if (arret) return;
    const pairs = reponse.data.peers;
    if (!Array.isArray(pairs)) throw new Error('Liste de pairs invalide');
    for (const pair of pairs) {
      if (connexionsSortantes.size >= limitePairs) break;
      if (pair.id === id || pair.wsUrl === adresse.href || connexionsSortantes.has(pair.id)) continue;
      const connexion = new WebSocket(pair.wsUrl, { handshakeTimeout: 15000 });
      connexionsSortantes.set(pair.id, connexion);
      ecouter(connexion);
      connexion.on('open', () => saluer(connexion));
      connexion.on('close', () => {
        connexionsSortantes.delete(pair.id);
        console.log('Connexion sortante fermée avec', pair.id);
      });
    }
  } catch (err) {
    console.error('Découverte échouée :', err.message);
  } finally {
    actualisationEnCours = false;
  }
}

let intervalle;
serveur.on('listening', () => {
  console.log('Pair prêt', id, adresse.href);
  actualiser();
  intervalle = setInterval(actualiser, 10000);
});

process.on('SIGINT', () => {
  arret = true;
  clearInterval(intervalle);
  for (const connexion of connexionsSortantes.values()) connexion.terminate();
  for (const connexion of serveur.clients) connexion.terminate();
  serveur.close();
});
