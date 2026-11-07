const axios = require('axios');
const WebSocket = require('ws');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
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

function chargerIdentite() {
  const dossier = path.join(__dirname, 'keys');
  const fichier = path.join(dossier, `${id.replace(/[^\w.-]/g, '_')}.json`);
  if (fs.existsSync(fichier)) {
    const { privateKey } = JSON.parse(fs.readFileSync(fichier, 'utf8'));
    const cle = crypto.createPrivateKey(privateKey);
    const publique = crypto.createPublicKey(cle).export({ type: 'spki', format: 'der' }).toString('base64');
    return { privateKey: cle, publicKey: publique };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(dossier, { recursive: true });
  fs.writeFileSync(fichier, JSON.stringify({
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }), { mode: 0o600 });
  return { privateKey, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}
const identite = chargerIdentite();

const clesConnues = new Map();
const sessions = new Map();

const VERSION = 'p2p-v1';
const transcript = (role, idPair, ephemeralKey, nonce) =>
  Buffer.from([VERSION, role, idPair, ephemeralKey, nonce].join('|'));
const cleDepuisBase64 = b64 => crypto.createPublicKey({
  key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki',
});
const estBase64 = v => typeof v === 'string' && v.length > 0 && v.length < 512;

function ivDepuisCompteur(compteur) {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(BigInt(compteur), 4);
  return iv;
}
const aad = compteur => Buffer.from(`${VERSION}|${compteur}`);

function envoyerChiffre(connexion, message) {
  const session = sessions.get(connexion);
  if (!session || connexion.readyState !== WebSocket.OPEN) return false;
  const compteur = ++session.envoye;
  const chiffreur = crypto.createCipheriv('aes-256-gcm', session.cleEnvoi, ivDepuisCompteur(compteur));
  chiffreur.setAAD(aad(compteur));
  const chiffre = Buffer.concat([chiffreur.update(JSON.stringify(message), 'utf8'), chiffreur.final()]);
  connexion.send(JSON.stringify({
    action: 'secure',
    payload: {
      counter: compteur,
      ciphertext: chiffre.toString('base64'),
      tag: chiffreur.getAuthTag().toString('base64'),
    },
  }));
  return true;
}

function dechiffrer(session, payload) {
  const { counter, ciphertext, tag } = payload || {};
  if (!Number.isSafeInteger(counter) || counter <= session.recu) throw new Error('Rejeu ou compteur invalide');
  if (!estBase64(tag) || typeof ciphertext !== 'string') throw new Error('Message chiffré invalide');
  const dechiffreur = crypto.createDecipheriv('aes-256-gcm', session.cleReception, ivDepuisCompteur(counter));
  dechiffreur.setAAD(aad(counter));
  dechiffreur.setAuthTag(Buffer.from(tag, 'base64'));
  const clair = Buffer.concat([dechiffreur.update(Buffer.from(ciphertext, 'base64')), dechiffreur.final()]);
  session.recu = counter; // mis à jour seulement après authentification réussie
  return JSON.parse(clair.toString('utf8'));
}

function securiser(connexion, role, idAttendu) {
  const roleDistant = role === 'initiator' ? 'responder' : 'initiator';
  const ephemere = crypto.generateKeyPairSync('x25519');
  const ephemerePublic = ephemere.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const maNonce = crypto.randomBytes(16).toString('base64');
  const session = { pret: false, envoye: 0, recu: 0 };

  const delai = setTimeout(() => {
    if (!session.pret) {
      console.error('Handshake expiré');
      connexion.terminate();
    }
  }, 10000);
  connexion.on('close', () => {
    clearTimeout(delai);
    sessions.delete(connexion);
  });
  connexion.on('error', err => console.error('Erreur de connexion :', err.message));

  function envoyerHello() {
    connexion.send(JSON.stringify({
      action: 'hello',
      payload: {
        id,
        identityKey: identite.publicKey,
        ephemeralKey: ephemerePublic,
        nonce: maNonce,
        signature: crypto.sign(null, transcript(role, id, ephemerePublic, maNonce), identite.privateKey)
          .toString('base64'),
      },
    }));
  }

  function traiterHello(p) {
    if (!p || typeof p.id !== 'string' || !p.id || !estBase64(p.identityKey) ||
        !estBase64(p.ephemeralKey) || !estBase64(p.nonce) || !estBase64(p.signature)) {
      throw new Error('hello invalide');
    }
    if (idAttendu && p.id !== idAttendu) throw new Error(`Identité inattendue : ${p.id}`);
    if (p.id === id) throw new Error('Identité identique à la nôtre');

    const cleIdentite = cleDepuisBase64(p.identityKey);
    const signatureValide = crypto.verify(null,
      transcript(roleDistant, p.id, p.ephemeralKey, p.nonce),
      cleIdentite, Buffer.from(p.signature, 'base64'));
    if (!signatureValide) throw new Error('Signature invalide');

    const connue = clesConnues.get(p.id);
    if (connue && connue !== p.identityKey) throw new Error(`Clé publique modifiée pour ${p.id}`);
    clesConnues.set(p.id, p.identityKey);

    const secret = crypto.diffieHellman({
      privateKey: ephemere.privateKey,
      publicKey: cleDepuisBase64(p.ephemeralKey),
    });
    const initiateur = role === 'initiator';
    const salt = Buffer.concat([
      Buffer.from(initiateur ? maNonce : p.nonce, 'base64'),
      Buffer.from(initiateur ? p.nonce : maNonce, 'base64'),
    ]);
    const cles = Buffer.from(crypto.hkdfSync('sha256', secret, salt, `${VERSION} session`, 64));
    session.cleEnvoi = initiateur ? cles.subarray(0, 32) : cles.subarray(32);
    session.cleReception = initiateur ? cles.subarray(32) : cles.subarray(0, 32);
    session.peerId = p.id;
    session.pret = true;
    sessions.set(connexion, session);

    console.log(`Handshake sécurisé terminé avec ${p.id}`);
    envoyerChiffre(connexion, { action: 'message', payload: { texte: `Canal sécurisé établi par ${id}` } });
  }

  function traiterSecure(payload) {
    const message = dechiffrer(session, payload);
    console.log(`[chiffré] ${session.peerId} :`, message.payload?.texte ?? message);
  }

  connexion.on('message', data => {
    try {
      const message = JSON.parse(data.toString());
      if (message.action === 'hello' && !session.pret) traiterHello(message.payload);
      else if (message.action === 'secure' && session.pret) traiterSecure(message.payload);
      else throw new Error('Message inattendu (non chiffré ou handshake incomplet)');
    } catch (err) {
      console.error('Pair rejeté :', err.message);
      connexion.terminate();
    }
  });

  if (connexion.readyState === WebSocket.OPEN) envoyerHello();
  else connexion.on('open', envoyerHello);
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

serveur.on('connection', connexion => {
  securiser(connexion, 'responder');
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
              if (id > pair.id) continue;
      const connexion = new WebSocket(pair.wsUrl, { handshakeTimeout: 15000 });
      connexionsSortantes.set(pair.id, connexion);
      securiser(connexion, 'initiator', pair.id);
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
  console.log('Clé publique :', identite.publicKey);
  console.log('Écris un texte pour l\'envoyer chiffré à tous les pairs connectés');
  actualiser();
  intervalle = setInterval(actualiser, 10000);
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', texte => {
  if (!texte.trim()) return;
  let envoyes = 0;
  for (const connexion of sessions.keys()) {
    if (envoyerChiffre(connexion, { action: 'message', payload: { texte } })) envoyes++;
  }
  console.log(`Message chiffré envoyé à ${envoyes} pair(s)`);
});

process.on('SIGINT', () => {
  arret = true;
  clearInterval(intervalle);
  rl.close();
  for (const connexion of connexionsSortantes.values()) connexion.terminate();
  for (const connexion of serveur.clients) connexion.terminate();
  serveur.close();
});