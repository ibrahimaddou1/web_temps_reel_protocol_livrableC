const express = require('express');
const axios = require('axios');
const readline = require('node:readline');
const { WebSocketServer } = require('ws');

function origine(valeur) {
  try {
    const url = new URL(valeur);
    if (['http:', 'https:'].includes(url.protocol) && url.pathname === '/' &&
        !url.search && !url.hash && !url.username && !url.password) return url.origin;
  } catch {}
  return null;
}

const urlArgument = process.argv[2] === 'connect' ? undefined : process.argv[2];
const locale = origine(urlArgument || process.env.PUBLIC_URL ||
  `http://localhost:${process.env.PORT || 3000}`);
if (!locale) throw new Error('Usage : npm start -- http://IP_LOCALE:3000');
const urlLocale = new URL(locale);
const port = Number(urlLocale.port || (urlLocale.protocol === 'https:' ? 443 : 80));
if (urlLocale.protocol !== 'http:') throw new Error('Le serveur doit utiliser une URL http://');
const pairs = new Map();
const noms = new Map([
  ['http://172.20.10.2:3000', 'Ibrahim'],
  ['http://172.20.10.4:3001', 'Imal'],
  ['http://172.20.10.4:3000', 'Imal'],
  ['http://172.20.10.5:3001', 'Zack'],
]);
const messagesRecus = new Set();
const app = express();
app.use(express.json());
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function nouvelEtat(statut) {
  const etat = { statut, pings: 0, actions: new Set(), taches: new Set() };

  setTimeout(() => {
    if (etat.statut !== 'Ack') {
      for (const [pair, courant] of pairs) {
        if (courant === etat) oublier(pair, etat);
      }
    }
  }, 150000).unref();
  return etat;
}

function oublier(pair, etat) {
  if (pairs.get(pair) === etat) pairs.delete(pair);
}

async function appeler(pair, route, methode = 'post', body, code = 204) {
  const reponse = await axios({
    url: pair + route, method: methode, data: body,
    headers: { Origin: locale }, timeout: 15000, maxRedirects: 0,
  });
  if (reponse.status !== code) throw new Error(`${route} : statut ${reponse.status}`);
}

async function retenter(pair, etat, operation) {
  for (let essai = 0; essai <= 5; essai++) {
    if (pairs.get(pair) !== etat) return false;
    try {
      await operation();
      return pairs.get(pair) === etat;
    } catch (err) {
      console.error(pair, err.message);
      if (essai === 5) {
        oublier(pair, etat);
        return false;
      }
      await pause(1000 * 2 ** essai);
    }
  }
}

function lancer(pair, etat, nom, operation) {
  if (etat.taches.has(nom)) return;
  etat.taches.add(nom);
  setImmediate(async () => {
    try {
      await operation();
    } catch (err) {
      console.error(err.message);
      oublier(pair, etat);
    } finally {
      etat.taches.delete(nom);
    }
  });
}

async function connecter(pair) {
  if (pairs.has(pair)) return;
  const etat = nouvelEtat('contacté');
  etat.contacte = true;
  pairs.set(pair, etat); 
  try {
    await appeler(pair, '/syn', 'post', undefined, 202);
  } catch (err) {
    oublier(pair, etat);
    console.error(err.message);
  }
}

app.post('/syn', (req, res) => {
  const pair = origine(req.get('Origin'));
  if (!pair) return res.sendStatus(400);
  let etat = pairs.get(pair);
  if (!etat) {
    etat = nouvelEtat('syn');
    pairs.set(pair, etat);
  }
  etat.synRecu = true;
  res.sendStatus(202);
  lancer(pair, etat, 'syn-ack', () =>
    retenter(pair, etat, () => appeler(pair, '/syn-ack', 'post', undefined, 202)));
});

app.post('/syn-ack', (req, res) => {
  const pair = origine(req.get('Origin'));
  if (!pair) return res.sendStatus(400);
  const etat = pairs.get(pair);
  if (!etat?.contacte) return res.sendStatus(403);
  res.sendStatus(202);
  lancer(pair, etat, 'ack', async () => {
    if (await retenter(pair, etat, () => appeler(pair, '/ack'))) {
      if (etat.statut !== 'Ack') {
        console.log('Connexion établie avec', noms.get(pair) || pair, `(${pair})`);
      }
      etat.statut = 'Ack';
    }
  });
});

app.post('/ack', (req, res) => {
  const pair = origine(req.get('Origin'));
  if (!pair) return res.sendStatus(400);
  const etat = pairs.get(pair);
  //retry
  if (!etat?.synRecu) return res.sendStatus(403);
  if (etat.statut !== 'Ack') {
    console.log('Connexion établie avec', noms.get(pair) || pair, `(${pair})`);
  }
  etat.statut = 'Ack';
  res.sendStatus(204);
});

function messageValide(message) {
  return message && typeof message === 'object' && !Array.isArray(message) &&
    typeof message.action === 'string' && message.action.trim().length > 0 &&
    (message.payload === undefined || (message.payload !== null &&
      typeof message.payload === 'object' && !Array.isArray(message.payload)));
}

app.post('/forget', (req, res) => {
  const pair = origine(req.get('Origin'));
  if (!pair || !messageValide(req.body) || req.body.action !== 'forget') return res.sendStatus(400);
  if (pairs.get(pair)?.statut !== 'Ack') return res.sendStatus(403);
  pairs.delete(pair);
  res.sendStatus(204);
});

function metadataValide(metadata) {
  return metadata && origine(metadata.source) && origine(metadata.target) &&
    typeof metadata.timestamp === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(metadata.timestamp) &&
    Number.isFinite(Date.parse(metadata.timestamp));
}

app.post('/ingress', (req, res) => {
  const pair = origine(req.get('Origin'));
  if (!pair || !messageValide(req.body) || !metadataValide(req.body.metadata)) {
    return res.sendStatus(400);
  }
  if (pairs.get(pair)?.statut !== 'Ack') return res.sendStatus(403);
  const { action, metadata } = req.body;
  // Convention : une action, source, destination et date identiques désignent le même message.
  const cle = JSON.stringify([action, metadata.source, metadata.target, metadata.timestamp]);
  if (messagesRecus.has(cle)) return res.sendStatus(208);
  console.log('Message reçu de', noms.get(pair) || pair, req.body);
  messagesRecus.add(cle);
  res.sendStatus(201);
});

app.get('/health', (req, res) => {
  if (req.get('Origin') === undefined) return res.sendStatus(204);
  const pair = origine(req.get('Origin'));
  if (!pair) return res.sendStatus(400);
  res.sendStatus(202);
  setImmediate(() => appeler(pair, '/pong').catch(err => console.error(err.message)));
});

app.post('/pong', (req, res) => {
  const etat = pairs.get(origine(req.get('Origin')));
  if (etat?.statut !== 'Ack') return res.sendStatus(403);
  etat.pings = 0;
  res.sendStatus(204);
});

setInterval(() => {
  for (const [pair, etat] of pairs) {
    if (etat.statut !== 'Ack') continue;
    lancer(pair, etat, 'health', () => retenter(pair, etat, async () => {
      if (etat.pings >= 5) {
        oublier(pair, etat);
        return;
      }
      etat.pings++;
      await appeler(pair, '/health', 'get', undefined, 202);
    }));
  }
}, 5000).unref();

async function diffuser(message) {
  if (!messageValide(message)) throw new Error('Message invalide');
  const timestamp = new Date().toISOString();
  await Promise.all([...pairs].filter(([, etat]) => etat.statut === 'Ack')
    .map(async ([pair]) => {
      try {
        await appeler(pair, '/ingress', 'post', {
          ...message,
          metadata: { source: locale, target: pair, timestamp },
        }, 201);
      } catch (err) {
        console.error('Envoi échoué vers', pair, err.message);
      }
    }));
}

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.sendStatus(400);
  console.error(err.message);
  res.sendStatus(500);
});

const trackerUrl = process.argv[3] || 'http://localhost:4000';
const serveurId = process.argv[4] || locale;
let annonceEnCours = false;

async function annoncer() {
  if (annonceEnCours) return;
  annonceEnCours = true;
  try {
    const reponse = await axios.post(trackerUrl + '/announce', {
      id: serveurId,
      wsUrl: locale.replace('http:', 'ws:') + '/ws',
    }, { timeout: 15000 });
    if (reponse.status === 201) console.log('Serveur enregistré auprès du tracker');
  } catch (err) {
    console.error('Annonce au tracker échouée :', err.message);
  } finally {
    annonceEnCours = false;
  }
}

const serveur = app.listen(port, '0.0.0.0', () => {
  console.log('Serveur prêt', locale);
  annoncer();
  setInterval(annoncer, 10000).unref();
  console.log('Commandes : connect URL ou message {"action":"bonjour","payload":{}}');
  if (process.argv[2] === 'connect') {
    const pair = origine(process.argv[3]);
    if (pair) connecter(pair);
    else console.error('URL du camarade invalide');
  }
});

const websocket = new WebSocketServer({ server: serveur, path: '/ws' });
websocket.on('connection', connexion => {
  let attentePong;
  const intervalle = setInterval(() => {
    if (attentePong) return;
    attentePong = setTimeout(() => {
      console.log('Connexion WebSocket perdue : aucun pong reçu');
      connexion.terminate();
    }, 15000);
    connexion.ping();
  }, 5000);

  connexion.on('pong', () => {
    clearTimeout(attentePong);
    attentePong = undefined;
  });
  connexion.on('close', () => {
    clearInterval(intervalle);
    clearTimeout(attentePong);
  });
});
websocket.on('connection', connexion => {
  console.log('Client WebSocket connecté');
  connexion.on('close', () => {
    console.log('Client WebSocket déconnecté');
  });
  connexion.on('error', err => {
    console.error('Erreur WebSocket :', err.message);
  });
});
websocket.on('error', err => {
  console.error('Erreur serveur WebSocket :', err.message);
});
// Le broker associe un identifiant à chaque connexion cliente.
const clients = new Map();

function annoncerPresence(id, statut) {
  const message = JSON.stringify({ action: 'presence', payload: { id, statut } });
  for (const client of clients.values()) {
    if (client.readyState === 1) client.send(message);
  }
}

const filesMessages = new Map();
const livraisons = new Set();

async function livrerMessages(id) {
  if (livraisons.has(id)) return;
  livraisons.add(id);
  const file = filesMessages.get(id);
  try {
    while (file?.length) {
      const client = clients.get(id);
      if (!client || client.readyState !== 1) break;
      const message = file[0];
      await new Promise((resolve, reject) => {
        client.send(message, err => err ? reject(err) : resolve());
      });
      file.shift();
    }
    if (file?.length === 0) filesMessages.delete(id);
  } catch (err) {
    console.error('Livraison interrompue :', err.message);
  } finally {
    livraisons.delete(id);
  }
}

websocket.on('connection', connexion => {
  let clientId;
  connexion.on('close', () => {
    if (clients.get(clientId) === connexion) {
      clients.delete(clientId);
      annoncerPresence(clientId, 'offline');
    }
  });

  connexion.on('message', data => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      connexion.send(JSON.stringify({ type: 'error', message: 'JSON invalide' }));
      return;
    }
    if (!messageValide(message)) {
      connexion.send(JSON.stringify({ type: 'error', message: 'Format de message invalide' }));
      return;
    }
    if (message.action === 'register') {
      const id = message.payload?.id;
      if (clientId || typeof id !== 'string' || !id.trim() || id.trim() === '*' || clients.has(id.trim())) {
        connexion.send(JSON.stringify({ type: 'error', message: 'Identifiant invalide ou déjà utilisé' }));
        return;
      }
      clientId = id.trim();
      clients.set(clientId, connexion);
      connexion.send(JSON.stringify({ action: 'registered', payload: { id: clientId } }));
      for (const id of clients.keys()) {
        connexion.send(JSON.stringify({ action: 'presence', payload: { id, statut: 'online' } }));
      }
      const presence = JSON.stringify({ action: 'presence', payload: { id: clientId, statut: 'online' } });
      for (const [id, client] of clients) {
        if (id !== clientId && client.readyState === 1) client.send(presence);
      }
      livrerMessages(clientId);
      return;
    }
    if (!clientId) {
      connexion.send(JSON.stringify({ type: 'error', message: 'Identification requise' }));
      return;
    }
    // Conserver la confirmation des échanges simples du livrable A.
    if (message.action !== 'message') {
      connexion.send(JSON.stringify({ type: 'message', action: 'confirmation', payload: message.payload }));
      return;
    }
    const target = message.metadata?.target;
    if (typeof target !== 'string' || !target.trim()) {
      connexion.send(JSON.stringify({ type: 'error', message: 'Destinataire requis' }));
      return;
    }
    const messageSortant = JSON.stringify({
      action: 'message',
      metadata: { source: clientId, target, timestamp: new Date().toISOString() },
      payload: message.payload,
    });
    if (target === '*') {
      for (const [id, client] of clients) {
        if (id !== clientId && client.readyState === 1) client.send(messageSortant);
      }
      return;
    }
    if (!filesMessages.has(target)) filesMessages.set(target, []);
    filesMessages.get(target).push(messageSortant);
    const destinataire = clients.get(target);
    if (!destinataire || destinataire.readyState !== 1) {
      connexion.send(JSON.stringify({
        action: 'queued',
        payload: { target, texte: 'Message conservé en attente du destinataire' },
      }));
    }
    livrerMessages(target);
  });
});


readline.createInterface({ input: process.stdin }).on('line', async ligne => {
  try {
    if (ligne.startsWith('connect ')) {
      const pair = origine(ligne.slice(8).trim());
      if (!pair) throw new Error('URL invalide');
      await connecter(pair);
    } else if (ligne.startsWith('message ')) {
      await diffuser(JSON.parse(ligne.slice(8)));
    }
  } catch (err) {
    console.error(err.message);
  }
});


