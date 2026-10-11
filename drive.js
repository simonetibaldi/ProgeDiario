'use strict';

// ---------------------------------------------------------------------------
// Google Drive
//
// Permette al diario pubblicato (senza server.py) di salvare i ricordi nel
// Drive di chi lo usa, in una cartella "Diario" con dentro ricordi/ e photos/.
// Il permesso chiesto (drive.file) riguarda solo i file creati dal diario:
// il resto del Drive non si vede.
//
// L'accesso passa per una pagina di Google e torna qui con un permesso che
// dura un'ora. Quando scade, il diario prova a rinnovarlo da solo passando di
// nuovo da Google senza chiedere niente; se Google vuole una conferma, serve
// toccare "Collega Google Drive" nella finestra Backup.
//
// Va caricato prima di app.js, che usa depositoDrive.
// ---------------------------------------------------------------------------

// Identificativo dell'app presso Google (Google Cloud → Clients). Non è un segreto.
const DRIVE_CLIENT_ID = '514507817658-7ddda3tobnbetigl3969tqhdsurj3c49.apps.googleusercontent.com';
const DRIVE_PERMESSO = 'https://www.googleapis.com/auth/drive.file';
const DRIVE_CARTELLA = 'Diario';
const DRIVE_FILE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_CARICA = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_ACCESSO = 'https://accounts.google.com/o/oauth2/v2/auth';
const DRIVE_PAUSA_TENTATIVI = 10 * 60 * 1000;
const TIPO_CARTELLA = 'application/vnd.google-apps.folder';

// In localStorage: { collegato, token, scade, attesa, tentato, daRicollegare, salvatoFino }
const CHIAVE_DRIVE = 'diario.drive';

function driveStato() {
  try {
    return JSON.parse(localStorage.getItem(CHIAVE_DRIVE)) || {};
  } catch {
    return {};
  }
}

function driveRicorda(cambi) {
  try {
    localStorage.setItem(CHIAVE_DRIVE, JSON.stringify({ ...driveStato(), ...cambi }));
  } catch { /* senza localStorage Drive resta scollegato */ }
}

// Google accetta di tornare solo su HTTPS o su localhost.
const driveDisponibile = () => !!DRIVE_CLIENT_ID && (location.protocol === 'https:' || location.hostname === 'localhost');
const driveCollegato = () => driveDisponibile() && !!driveStato().collegato;
const driveTokenValido = () => driveStato().scade > Date.now() + 60000;

// Manda la pagina da Google, che poi torna qui (vedi driveRientro).
// Con chiede = false Google non mostra niente: o rinnova il permesso o risponde con un errore.
function driveAccedi(chiede) {
  const attesa = Math.random().toString(36).slice(2);
  driveRicorda({ attesa, tentato: Date.now() });
  const parametri = new URLSearchParams({
    client_id: DRIVE_CLIENT_ID,
    redirect_uri: location.origin + location.pathname.replace(/index\.html$/, ''),
    response_type: 'token',
    scope: DRIVE_PERMESSO,
    state: attesa,
  });
  if (!chiede) parametri.set('prompt', 'none');
  location.assign(`${DRIVE_ACCESSO}?${parametri}`);
}

// Il rinnovo silenzioso porta via la pagina per un attimo: si tenta solo se Google
// non ha già detto di no, non troppo spesso, e se Google è davvero raggiungibile
// (altrimenti si finirebbe su una pagina di errore del browser).
async function drivePuoRinnovare() {
  const stato = driveStato();
  if (stato.daRicollegare || Date.now() - (stato.tentato || 0) < DRIVE_PAUSA_TENTATIVI) return false;
  const limite = new AbortController();
  const sveglia = setTimeout(() => limite.abort(), 4000);
  try {
    await fetch('https://www.gstatic.com/generate_204', { mode: 'no-cors', cache: 'no-store', signal: limite.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(sveglia);
  }
}

// Al ritorno da Google l'indirizzo finisce con #access_token=... oppure #error=...
(function driveRientro() {
  const parametri = new URLSearchParams(location.hash.slice(1));
  const stato = driveStato();
  if (!parametri.has('state') || parametri.get('state') !== stato.attesa) return;
  history.replaceState(null, '', location.pathname);
  if (parametri.has('access_token')) {
    driveRicorda({
      collegato: true,
      token: parametri.get('access_token'),
      scade: Date.now() + Number(parametri.get('expires_in')) * 1000,
      attesa: null,
      daRicollegare: false,
    });
  } else {
    driveRicorda({ token: null, scade: 0, attesa: null, daRicollegare: true });
  }
})();

async function driveChiama(url, opzioni = {}) {
  const risposta = await fetch(url, {
    ...opzioni,
    headers: { ...opzioni.headers, Authorization: 'Bearer ' + driveStato().token },
  });
  if (risposta.status === 401) driveRicorda({ token: null, scade: 0 });
  if (!risposta.ok) throw new Error(`Google Drive ha risposto con l'errore ${risposta.status}`);
  return risposta;
}

// Contenuto di una cartella: Map(nome -> { id, modificato })
async function driveElenco(idCartella) {
  const voci = new Map();
  let pagina = '';
  do {
    const parametri = new URLSearchParams({
      q: `'${idCartella}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, appProperties)',
      pageSize: '1000',
    });
    if (pagina) parametri.set('pageToken', pagina);
    const dati = await (await driveChiama(`${DRIVE_FILE}?${parametri}`)).json();
    for (const f of dati.files) {
      voci.set(f.name, { id: f.id, modificato: Number((f.appProperties || {}).modificato) || 0 });
    }
    pagina = dati.nextPageToken;
  } while (pagina);
  return voci;
}

// Trova la cartella con quel nome, oppure la crea.
async function driveCartella(nome, idGenitore = 'root') {
  const parametri = new URLSearchParams({
    q: `name = '${nome}' and mimeType = '${TIPO_CARTELLA}' and '${idGenitore}' in parents and trashed = false`,
    fields: 'files(id)',
  });
  const trovate = (await (await driveChiama(`${DRIVE_FILE}?${parametri}`)).json()).files;
  if (trovate.length) return trovate[0].id;
  const creata = await driveChiama(DRIVE_FILE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nome, mimeType: TIPO_CARTELLA, parents: [idGenitore] }),
  });
  return (await creata.json()).id;
}

// Crea un file, oppure ne sostituisce il contenuto se si passa l'id di uno esistente.
async function driveCarica(idCartella, nome, contenuto, proprieta = {}, idEsistente = null) {
  const scheda = idEsistente
    ? { appProperties: proprieta }
    : { name: nome, parents: [idCartella], appProperties: proprieta };
  const corpo = new FormData();
  corpo.append('metadata', new Blob([JSON.stringify(scheda)], { type: 'application/json' }));
  corpo.append('file', contenuto);
  await driveChiama(`${DRIVE_CARICA}${idEsistente ? '/' + idEsistente : ''}?uploadType=multipart`, {
    method: idEsistente ? 'PATCH' : 'POST',
    body: corpo,
  });
}

// Le stesse operazioni di depositoMac (in app.js), fatte con le API di Drive.
const depositoDrive = {
  dove: 'su Google Drive',
  cartelle: null, // { ricordi, photos }: id delle due cartelle
  foto: new Map(),
  ricordi: new Map(),

  async prepara() {
    if (this.cartelle) return;
    const radice = await driveCartella(DRIVE_CARTELLA);
    this.cartelle = { ricordi: await driveCartella('ricordi', radice), photos: await driveCartella('photos', radice) };
  },

  async elencoFoto() {
    await this.prepara();
    this.foto = await driveElenco(this.cartelle.photos);
    return new Set(this.foto.keys());
  },

  async elencoRicordi() {
    await this.prepara();
    this.ricordi = await driveElenco(this.cartelle.ricordi);
    return Object.fromEntries([...this.ricordi].map(([nome, voce]) => [nome.replace(/\.json$/, ''), voce.modificato]));
  },

  async caricaFoto(file) {
    await driveCarica(this.cartelle.photos, file.name, file);
  },

  // Chiamare prima elencoRicordi: serve a sapere se il ricordo c'è già.
  async caricaRicordo(ricordo) {
    const nome = ricordo.id + '.json';
    const contenuto = new Blob([JSON.stringify(ricordo, null, 2)], { type: 'application/json' });
    const esistente = this.ricordi.get(nome);
    await driveCarica(this.cartelle.ricordi, nome, contenuto, { modificato: String(ricordo.modificato) }, esistente && esistente.id);
  },

  // Lo sposta nel cestino di Drive, che lo conserva per 30 giorni.
  async eliminaRicordo(id) {
    await this.elencoRicordi();
    const voce = this.ricordi.get(id + '.json');
    if (!voce) return;
    await driveChiama(`${DRIVE_FILE}/${voce.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  },

  // Chiamare prima elencoRicordi (per leggiRicordo) ed elencoFoto (per leggiFoto).
  async leggiRicordo(id) {
    return (await driveChiama(`${DRIVE_FILE}/${this.ricordi.get(id + '.json').id}?alt=media`)).json();
  },

  async leggiFoto(nome) {
    const voce = this.foto.get(nome);
    if (!voce) throw new Error('Su Google Drive manca la foto ' + nome);
    return (await driveChiama(`${DRIVE_FILE}/${voce.id}?alt=media`)).blob();
  },
};
