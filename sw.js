'use strict';

// Service worker: tiene una copia dei file dell'app per aprirla anche senza rete.
// Se la rete c'è vince sempre la rete, così le modifiche al codice arrivano subito;
// la copia serve solo quando la rete manca. I ricordi non passano di qui: stanno in IndexedDB.
//
// Se si aggiunge un file all'app va aggiunto anche a FILE.

const CACHE = 'diario-app';
const FILE = [
  './',
  'index.html',
  'style.css',
  'zip.js',
  'drive.js',
  'app.js',
  'manifest.webmanifest',
  'icone/icona-180.png',
  'icone/icona-192.png',
  'icone/icona-512.png',
];
const INDIRIZZI = new Set(FILE.map((f) => new URL(f, self.location).href));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  // Solo l'apertura della pagina e i file dell'app: le richieste a server.py
  // (api/, photos/, ricordi/) vanno dritte in rete.
  const apertura = e.request.mode === 'navigate';
  if (e.request.method !== 'GET' || !(apertura || INDIRIZZI.has(e.request.url))) return;
  e.respondWith(rispondi(e.request.url, apertura));
});

async function rispondi(url, apertura) {
  const cache = await caches.open(CACHE);
  try {
    const risposta = await fetch(url, { cache: 'no-cache' });
    if (risposta.ok && INDIRIZZI.has(url)) await cache.put(url, risposta.clone());
    return risposta;
  } catch (err) {
    // Senza rete: la copia del file; per l'apertura va bene comunque la pagina dell'app.
    const copia = (await cache.match(url)) || (apertura && await cache.match('index.html'));
    if (copia) return copia;
    throw err;
  }
}
