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
  // Solo i file dell'app: le richieste a server.py (api/, photos/, ricordi/) vanno dritte in rete.
  if (e.request.method !== 'GET' || !INDIRIZZI.has(e.request.url)) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((risposta) => {
        if (risposta.ok) {
          const copia = risposta.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copia));
        }
        return risposta;
      })
      .catch(() => caches.match(e.request)),
  );
});
