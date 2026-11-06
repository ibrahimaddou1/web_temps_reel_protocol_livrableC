const express = require('express');

const app = express();
const port = Number(process.argv[2] || 4000);
const pairs = new Map();
const dureePresence = 30000;
app.use(express.json());

function supprimerPairsExpires() {
  for (const [id, pair] of pairs) {
    if (Date.now() - pair.derniereAnnonce >= dureePresence) pairs.delete(id);
  }
}

app.post('/announce', (req, res) => {
  const { id, wsUrl } = req.body || {};
  if (typeof id !== 'string' || !id.trim() || typeof wsUrl !== 'string') {
    return res.sendStatus(400);
  }
  let url;
  try {
    url = new URL(wsUrl);
  } catch {
    return res.sendStatus(400);
  }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
    return res.sendStatus(400);
  }
  supprimerPairsExpires();
  const identifiant = id.trim();
  const connu = pairs.get(identifiant);
  if (connu && connu.wsUrl !== url.href) return res.sendStatus(409);
  pairs.set(identifiant, { wsUrl: url.href, derniereAnnonce: Date.now() });
  res.sendStatus(connu ? 200 : 201);
});

app.get('/peers', (req, res) => {
  supprimerPairsExpires();
  res.json({
    peers: [...pairs].map(([id, pair]) => ({ id, wsUrl: pair.wsUrl })),
  });
});

const nettoyage = setInterval(supprimerPairsExpires, 5000);
nettoyage.unref();

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.sendStatus(400);
  }
  console.error('Erreur tracker :', err.message);
  res.sendStatus(500);
});

app.listen(port, '0.0.0.0', () => console.log(`Tracker prêt sur le port ${port}`));
