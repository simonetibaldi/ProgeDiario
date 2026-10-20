'use strict';

// ---------------------------------------------------------------------------
// Archivio (IndexedDB)
//
// Un post ha questa forma:
//   { id, data: 'AAAA-MM-GG', ora: 'HH:MM', testo, tags: ['Viaggi', ...], foto: [File, ...],
//     creato: timestamp, modificato: timestamp }
// L'ora è '' se non è indicata.
// Il nome di ogni File è quello che la foto ha nella cartella photos/.
//
// Nell'archivio le foto non sono File ma { nome, dati: ArrayBuffer }: Safari
// perde le foto se si rimette nell'archivio un Blob letto dall'archivio stesso.
// La conversione avviene solo qui (perArchivio, daArchivio); il resto dell'app
// vede sempre dei File, che vivono in memoria.
//
// Un ricordo eliminato non sparisce dall'archivio: al suo posto resta il
// segnaposto { id, eliminato: true, modificato }, che serve a far arrivare
// l'eliminazione anche agli altri dispositivi (vedi sincronizza).
// ---------------------------------------------------------------------------

const DB_NOME = 'diario';
const DB_VERSIONE = 4;
const STORE = 'posts';

const dbPronto = new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NOME, DB_VERSIONE);
  // Le versioni cambiano solo la forma dei post, che non vengono riscritti: li adatta daArchivio quando li legge.
  req.onupgradeneeded = (e) => {
    if (e.oldVersion < 1) req.result.createObjectStore(STORE, { keyPath: 'id' });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function conStore(modo, operazione) {
  const db = await dbPronto;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, modo);
    const req = operazione(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

async function perArchivio(post) {
  const foto = await Promise.all(post.foto.map(async (f) => ({ nome: f.name, dati: await f.arrayBuffer() })));
  return { ...post, foto };
}

function daArchivio(salvato) {
  if (salvato.eliminato) return salvato;
  const foto = salvato.foto.map((f, i) => (f instanceof Blob
    // versioni 1 e 2: Blob o File salvati direttamente, i più vecchi senza nome
    ? new File([f], f.name || `${salvato.data}_${salvato.id}_${i + 1}.jpg`, { type: 'image/jpeg' })
    : new File([f.dati], f.nome, { type: 'image/jpeg' })));
  return { ...salvato, ora: salvato.ora || '', foto };
}

const leggiPosts = async () => (await conStore('readonly', (s) => s.getAll())).map(daArchivio);

// I byte delle foto vanno letti prima di aprire la transazione, che non aspetta.
async function salvaPost(post) {
  const daSalvare = post.eliminato ? post : await perArchivio(post);
  return conStore('readwrite', (s) => s.put(daSalvare));
}

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

const FOTO_LATO_MAX = 1600;
const FOTO_QUALITA = 0.85;

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...figli) {
  const nodo = Object.assign(document.createElement(tag), props);
  nodo.append(...figli);
  return nodo;
}

function nuovoId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// I tag cominciano sempre con la maiuscola: "viaggi" diventa "Viaggi".
function maiuscolaIniziale(testo) {
  return testo.charAt(0).toLocaleUpperCase('it') + testo.slice(1);
}

// I ricordi con tag scritti prima di questa regola vengono corretti e salvati come
// modificati, così la correzione arriva anche al deposito e agli altri dispositivi.
// Restituisce quanti ne ha corretti; se uno non si riesce a salvare resta com'è.
async function correggiTag(tutti) {
  let corretti = 0;
  for (const p of tutti) {
    if (p.eliminato || p.tags.every((t) => t === maiuscolaIniziale(t))) continue;
    try {
      await salvaPost({ ...p, tags: [...new Set(p.tags.map(maiuscolaIniziale))], modificato: Date.now() });
      corretti++;
    } catch (err) {
      console.error('Tag non corretti per il ricordo ' + p.id, err);
    }
  }
  return corretti;
}

// 'AAAA-MM-GG' da anno, mese (0 = gennaio) e giorno
function dataDa(anno, mese, giorno) {
  const due = (n) => String(n).padStart(2, '0');
  return `${anno}-${due(mese + 1)}-${due(giorno)}`;
}

function oggi() {
  const d = new Date();
  return dataDa(d.getFullYear(), d.getMonth(), d.getDate());
}

function oraAdesso() {
  return new Date().toTimeString().slice(0, 5);
}

function dataLeggibile(data) {
  return new Date(data + 'T00:00').toLocaleDateString('it-IT', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

// Riduce la foto a FOTO_LATO_MAX sul lato lungo e la converte in JPEG.
function ridimensionaFoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scala = Math.min(1, FOTO_LATO_MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scala);
      canvas.height = Math.round(img.naturalHeight * scala);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Conversione foto fallita'))),
        'image/jpeg',
        FOTO_QUALITA,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Foto non leggibile: ' + file.name));
    };
    img.src = url;
  });
}

// Dà un nome alle foto appena aggiunte nel modulo; quelle che ce l'hanno restano com'erano.
function conNome(foto, data) {
  return foto.map((f) => (f.name ? f : new File([f], `${data}_${nuovoId()}.jpg`, { type: 'image/jpeg' })));
}

// ---------------------------------------------------------------------------
// Stato
// ---------------------------------------------------------------------------

let posts = [];
let eliminati = []; // segnaposto dei ricordi eliminati
let filtroTag = null;

// Stato del modulo aperto
let inModifica = null; // post in modifica, oppure null se è nuovo
let formFoto = [];
let formTags = [];

// URL temporanei delle immagini mostrate, da liberare a ogni ridisegno
let urlTimeline = [];
let urlAnteprime = [];

function tuttiITags() {
  const conteggio = new Map();
  for (const p of posts) for (const t of p.tags) conteggio.set(t, (conteggio.get(t) || 0) + 1);
  return [...conteggio.keys()].sort((a, b) => conteggio.get(b) - conteggio.get(a) || a.localeCompare(b, 'it'));
}

async function ricarica() {
  const tutti = await leggiPosts();
  if (await correggiTag(tutti)) return ricarica();
  eliminati = tutti.filter((p) => p.eliminato);
  posts = tutti.filter((p) => !p.eliminato);
  posts.sort((a, b) => b.data.localeCompare(a.data) || b.ora.localeCompare(a.ora) || b.creato - a.creato);
  if (filtroTag && !tuttiITags().includes(filtroTag)) filtroTag = null;
  disegnaFiltri();
  disegnaTimeline();
  aggiornaStatoBackup();
  codaCopia = codaCopia.then(sincronizza);
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function disegnaFiltri() {
  const tags = tuttiITags();
  const chip = (etichetta, valore) => el('button', {
    className: 'chip' + (filtroTag === valore ? ' attivo' : ''),
    textContent: etichetta,
    onclick: () => { filtroTag = valore; disegnaFiltri(); disegnaTimeline(); },
  });
  $('filtri').replaceChildren(...(tags.length ? [chip('Tutti', null), ...tags.map((t) => chip(t, t))] : []));
}

function disegnaTimeline() {
  urlTimeline.forEach((u) => URL.revokeObjectURL(u));
  urlTimeline = [];

  const visibili = filtroTag ? posts.filter((p) => p.tags.includes(filtroTag)) : posts;
  if (!visibili.length) {
    $('timeline').replaceChildren(el('p', {
      className: 'vuoto',
      textContent: 'Ancora nessun ricordo. Tocca + per scrivere il primo.',
    }));
    return;
  }

  // Un riquadro per giorno, con dentro i ricordi di quel giorno (i post sono già in ordine).
  const giorni = new Map();
  for (const p of visibili) giorni.set(p.data, [...(giorni.get(p.data) || []), p]);
  $('timeline').replaceChildren(...[...giorni].map(([data, delGiorno]) => el('section', { className: 'giorno', id: 'giorno-' + data },
    el('div', { className: 'giorno-testa' },
      el('h2', { className: 'giorno-data', textContent: dataLeggibile(data) }),
      el('button', { className: 'btn-testo', textContent: '+ Aggiungi', onclick: () => apriModulo(null, data) }),
    ),
    ...delGiorno.map(disegnaPost),
  )));
}

function disegnaPost(post) {
  const articolo = el('article', { className: 'post' });

  if (post.foto.length) {
    const griglia = el('div', { className: 'post-foto' + (post.foto.length === 1 ? ' singola' : '') });
    for (const blob of post.foto) {
      const url = URL.createObjectURL(blob);
      urlTimeline.push(url);
      griglia.append(el('img', { src: url, alt: '', loading: 'lazy', onclick: () => apriFoto(url) }));
    }
    articolo.append(griglia);
  }

  const corpo = el('div', { className: 'post-corpo' },
    el('div', { className: 'post-testa' },
      el('span', { className: 'post-ora', textContent: post.ora }),
      el('button', { className: 'btn-testo', textContent: 'Modifica', onclick: () => apriModulo(post) }),
    ),
  );
  if (post.testo) corpo.append(el('p', { className: 'post-testo', textContent: post.testo }));
  if (post.tags.length) {
    corpo.append(el('div', { className: 'chips' },
      ...post.tags.map((t) => el('span', { className: 'chip', textContent: t }))));
  }
  articolo.append(corpo);
  return articolo;
}

function apriFoto(url) {
  $('foto-grande').src = url;
  $('dlg-foto').showModal();
}

// ---------------------------------------------------------------------------
// Modulo nuovo / modifica
// ---------------------------------------------------------------------------

// Senza post è un ricordo nuovo, per oggi o per il giorno indicato.
function apriModulo(post = null, giorno = oggi()) {
  inModifica = post;
  formFoto = post ? [...post.foto] : [];
  formTags = post ? [...post.tags] : [];

  $('dlg-titolo').textContent = post ? 'Modifica ricordo' : 'Nuovo ricordo';
  $('campo-data').value = post ? post.data : giorno;
  $('campo-ora').value = post ? post.ora : (giorno === oggi() ? oraAdesso() : '');
  $('campo-testo').value = post ? post.testo : '';
  $('campo-tag').value = '';
  $('btn-elimina').hidden = !post;
  $('btn-cartella').hidden = !cartella;

  disegnaAnteprime();
  disegnaTagModulo();
  $('dlg-post').showModal();
}

function chiudiModulo() {
  $('dlg-post').close();
  urlAnteprime.forEach((u) => URL.revokeObjectURL(u));
  urlAnteprime = [];
}

function disegnaAnteprime() {
  urlAnteprime.forEach((u) => URL.revokeObjectURL(u));
  urlAnteprime = [];
  $('anteprime').replaceChildren(...formFoto.map((blob, i) => {
    const url = URL.createObjectURL(blob);
    urlAnteprime.push(url);
    return el('div', { className: 'anteprima' },
      el('img', { src: url, alt: '' }),
      el('button', {
        type: 'button',
        textContent: '×',
        ariaLabel: 'Rimuovi foto',
        onclick: () => { formFoto.splice(i, 1); disegnaAnteprime(); },
      }),
    );
  }));
}

function disegnaTagModulo() {
  $('tag-scelti').replaceChildren(...formTags.map((t) => el('button', {
    type: 'button',
    className: 'chip attivo',
    textContent: t + ' ×',
    onclick: () => { formTags = formTags.filter((x) => x !== t); disegnaTagModulo(); },
  })));

  const bozza = $('campo-tag').value.trim().toLowerCase();
  const suggeriti = tuttiITags().filter((t) => !formTags.includes(t) && t.toLowerCase().includes(bozza));
  $('tag-suggeriti').replaceChildren(...suggeriti.map((t) => el('button', {
    type: 'button',
    className: 'chip',
    textContent: '+ ' + t,
    onclick: () => { aggiungiTag(t); },
  })));
}

// Aggiunge un tag al modulo; se esiste già scritto diversamente (maiuscole) riusa quello.
function aggiungiTag(grezzo) {
  const nome = maiuscolaIniziale(grezzo.trim().replace(/\s+/g, ' '));
  if (nome) {
    const uguale = (t) => t.toLowerCase() === nome.toLowerCase();
    if (!formTags.some(uguale)) formTags.push(tuttiITags().find(uguale) || nome);
  }
  $('campo-tag').value = '';
  disegnaTagModulo();
}

async function salvaModulo() {
  aggiungiTag($('campo-tag').value); // un tag scritto ma non confermato vale comunque

  const testo = $('campo-testo').value.trim();
  if (!testo && !formFoto.length) {
    alert('Scrivi qualcosa o aggiungi almeno una foto.');
    return;
  }

  const adesso = Date.now();
  const data = $('campo-data').value || oggi();
  await salvaPost({
    id: inModifica ? inModifica.id : nuovoId(),
    data,
    ora: $('campo-ora').value,
    testo,
    tags: formTags,
    foto: conNome(formFoto, data),
    creato: inModifica ? inModifica.creato : adesso,
    modificato: adesso,
  });
  chiudiModulo();
  await ricarica();
}

// ---------------------------------------------------------------------------
// Calendario
//
// I mesi uno sotto l'altro, dal più vecchio in alto al corrente in fondo; si
// apre in fondo e si scorre in su per andare indietro. I giorni con ricordi
// sono cerchiati; quelli futuri non si toccano.
// ---------------------------------------------------------------------------

const NOMI_GIORNI = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];
const MESI_IN_PIU = 12; // quanti mesi aggiunge "Mesi precedenti"

let mesiIndietro = 12; // quanti mesi mostrare prima del corrente (almeno fino al primo ricordo)

function apriCalendario() {
  disegnaCalendario();
  $('dlg-calendario').showModal();
  $('dlg-calendario').scrollTop = $('dlg-calendario').scrollHeight; // il mese corrente è in fondo
}

function disegnaCalendario() {
  const adesso = new Date();
  const primo = posts.length ? posts[posts.length - 1].data : oggi(); // posts va dal più recente
  const [annoPrimo, mesePrimo] = primo.split('-').map(Number);
  const mesiDalPrimo = (adesso.getFullYear() - annoPrimo) * 12 + adesso.getMonth() + 1 - mesePrimo;
  mesiIndietro = Math.max(mesiIndietro, mesiDalPrimo);

  const conRicordi = new Set(posts.map((p) => p.data));
  const mesi = [];
  for (let i = mesiIndietro; i >= 0; i--) {
    mesi.push(disegnaMese(adesso.getFullYear(), adesso.getMonth() - i, conRicordi));
  }
  $('calendario-mesi').replaceChildren(
    el('button', { type: 'button', className: 'btn-secondario', textContent: 'Mesi precedenti', onclick: altriMesi }),
    ...mesi,
  );
}

// Aggiunge mesi in cima senza far saltare la vista.
function altriMesi() {
  const dlg = $('dlg-calendario');
  const dalFondo = dlg.scrollHeight - dlg.scrollTop;
  mesiIndietro += MESI_IN_PIU;
  disegnaCalendario();
  dlg.scrollTop = dlg.scrollHeight - dalFondo;
}

// mese può uscire da 0-11 (per esempio -3): Date lo riporta nell'anno giusto.
function disegnaMese(anno, mese, conRicordi) {
  const inizio = new Date(anno, mese, 1);
  anno = inizio.getFullYear();
  mese = inizio.getMonth();
  const oggiStr = oggi();

  const griglia = el('div', { className: 'mese-griglia' },
    ...NOMI_GIORNI.map((g) => el('span', { className: 'mese-intestazione', textContent: g })));
  const vuoti = (inizio.getDay() + 6) % 7; // la settimana comincia di lunedì
  for (let i = 0; i < vuoti; i++) griglia.append(el('span'));

  const giorniNelMese = new Date(anno, mese + 1, 0).getDate();
  for (let g = 1; g <= giorniNelMese; g++) {
    const data = dataDa(anno, mese, g);
    griglia.append(el('button', {
      type: 'button',
      className: 'giorno-cal' + (conRicordi.has(data) ? ' con-ricordi' : '') + (data === oggiStr ? ' oggi' : ''),
      textContent: g,
      disabled: data > oggiStr,
      onclick: () => vaiAlGiorno(data),
    }));
  }

  return el('section', { className: 'mese' },
    el('h3', { className: 'mese-titolo', textContent: inizio.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }) }),
    griglia);
}

// Un giorno con ricordi: lo mostra nella timeline. Un giorno vuoto: apre un ricordo nuovo per quel giorno.
function vaiAlGiorno(data) {
  $('dlg-calendario').close();
  const delGiorno = posts.filter((p) => p.data === data);
  if (!delGiorno.length) {
    apriModulo(null, data);
    return;
  }
  if (filtroTag && !delGiorno.some((p) => p.tags.includes(filtroTag))) {
    filtroTag = null; // il filtro lo nasconderebbe
    disegnaFiltri();
    disegnaTimeline();
  }
  const riquadro = document.getElementById('giorno-' + data);
  const sopra = document.querySelector('.testata').offsetHeight + 8; // la testata resta in cima e lo coprirebbe
  window.scrollTo({ top: riquadro.getBoundingClientRect().top + window.scrollY - sopra, behavior: 'smooth' });
  riquadro.classList.add('evidenziato');
  setTimeout(() => riquadro.classList.remove('evidenziato'), 1600);
}

// ---------------------------------------------------------------------------
// Deposito: la copia dei ricordi fuori dal browser
//
// L'archivio è IndexedDB; in più il diario si tiene allineato con un deposito,
// quando ce n'è uno raggiungibile: le foto in photos/, il resto in
// ricordi/ID.json (con i nomi delle foto al posto delle foto). Più dispositivi
// collegati allo stesso deposito mostrano così lo stesso diario.
//   depositoMac    server.py scrive nella cartella del progetto, sul Mac
//   depositoDrive  le API di Google Drive, cartella "Diario" (vedi drive.js)
// Hanno le stesse operazioni; senza deposito il diario funziona lo stesso e ci
// si riallinea alla prossima occasione.
// ---------------------------------------------------------------------------

const API_FOTO = 'api/foto';
const API_RICORDI = 'api/ricordi';
const URL_PHOTOS = 'photos/';
const URL_RICORDI = 'ricordi/';

let deposito = null; // quello in uso, oppure null
let cartella = null; // Set dei nomi in photos/ sul Mac, oppure null se server.py non risponde
let codaCopia = Promise.resolve(); // una copia alla volta

const nFoto = (n) => (n === 1 ? '1 foto' : `${n} foto`);

async function scarica(url) {
  const risposta = await fetch(url, { cache: 'no-store' });
  if (!risposta.ok) throw new Error(`Non riesco a leggere ${url} (errore ${risposta.status})`);
  return risposta;
}

async function carica(url, contenuto) {
  const risposta = await fetch(url, { method: 'PUT', body: contenuto });
  // 409: nella cartella c'è già (la foto) o ce n'è uno più recente (il ricordo)
  if (!risposta.ok && risposta.status !== 409) throw new Error(`${url} (errore ${risposta.status})`);
}

const depositoMac = {
  dove: 'nella cartella del Mac',
  elencoFoto: async () => new Set(await (await scarica(API_FOTO)).json()),
  elencoRicordi: async () => (await scarica(API_RICORDI)).json(), // { id: modificato }
  caricaFoto: (file) => carica(`${API_FOTO}/${encodeURIComponent(file.name)}`, file),
  caricaRicordo: (ricordo) => carica(`${API_RICORDI}/${ricordo.id}`, JSON.stringify(ricordo)),
  leggiRicordo: async (id) => (await scarica(`${URL_RICORDI}${id}.json`)).json(),
  leggiFoto: async (nome) => (await scarica(URL_PHOTOS + encodeURIComponent(nome))).blob(),
};

async function leggiCartella() {
  try {
    cartella = await depositoMac.elencoFoto();
  } catch {
    cartella = null;
  }
}

// Il Mac se server.py risponde, altrimenti Google Drive se è stato collegato.
async function scegliDeposito() {
  await leggiCartella();
  if (cartella) return depositoMac;
  return driveCollegato() ? depositoDrive : null;
}

function mostraStatoDeposito(testo) {
  $('cartella-stato').textContent = testo;
  // Il pulsante serve la prima volta e quando Google chiede di confermare di nuovo.
  $('btn-drive').hidden = !driveDisponibile() || deposito === depositoMac || driveTokenValido();
  $('btn-drive').textContent = driveCollegato() ? 'Ricollega Google Drive' : 'Collega Google Drive';
}

// Mette d'accordo il diario e il deposito: carica i ricordi nuovi o modificati qui
// (prima le foto, così un ricordo salvato non ne nomina mai una che non c'è) e prende
// quelli nuovi o modificati altrove. Vince sempre il `modificato` più recente; le
// eliminazioni viaggiano come segnaposto, quindi vale la stessa regola.
async function sincronizza() {
  deposito = await scegliDeposito();
  if (!deposito) {
    mostraStatoDeposito(driveDisponibile()
      ? 'I ricordi sono solo in questo browser. Collega Google Drive per salvarli lì da soli.'
      : 'Nessuna copia fuori dal browser: i ricordi sono solo qui.');
    return;
  }

  if (deposito === depositoDrive && !driveTokenValido()) {
    // Il rinnovo porta via la pagina per un attimo: mai mentre si scrive un ricordo.
    if (await drivePuoRinnovare() && !$('dlg-post').open) {
      driveAccedi(false); // la pagina passa da Google e torna: si riparte da lì
      return;
    }
    mostraStatoDeposito('Google Drive è scollegato per ora: i ricordi restano qui e partono appena si ricollega.');
    return;
  }

  const tutte = posts.flatMap((p) => p.foto);
  const qui = [...posts, ...eliminati];
  let presi = 0;
  try {
    const presenti = await deposito.elencoFoto();
    const fotoMancanti = tutte.filter((f) => !presenti.has(f.name));
    if (fotoMancanti.length) mostraStatoDeposito(`Copio ${nFoto(fotoMancanti.length)} ${deposito.dove}…`);
    for (const f of fotoMancanti) {
      await deposito.caricaFoto(f);
      presenti.add(f.name);
    }

    const salvati = await deposito.elencoRicordi(); // { id: modificato }
    for (const p of qui) {
      if (salvati[p.id] >= p.modificato) continue;
      await deposito.caricaRicordo(p.eliminato ? p : { ...p, foto: p.foto.map((f) => f.name) });
    }

    const modificatoQui = new Map(qui.map((p) => [p.id, p.modificato]));
    for (const id of Object.keys(salvati)) {
      if (!(salvati[id] > (modificatoQui.get(id) || 0))) continue;
      const ricordo = await deposito.leggiRicordo(id);
      await salvaPost(ricordo.eliminato
        ? { id: ricordo.id, eliminato: true, modificato: ricordo.modificato }
        : await daSalvato(ricordo, (nome) => deposito.leggiFoto(nome)));
      presi++;
    }
    mostraStatoDeposito(posts.length
      ? `Allineato con quello che c'è ${deposito.dove}: ${nRicordi(posts.length)} e ${nFoto(tutte.length)}.`
      : `Collegato: i ricordi verranno salvati ${deposito.dove}.`);
  } catch (err) {
    console.error(err);
    mostraStatoDeposito(`Non riesco ad allinearmi con quello che c'è ${deposito.dove}: ${navigator.onLine ? err.message : 'manca la rete'}. Riprovo alla prossima apertura.`);
  }
  // Ridisegna con i ricordi arrivati; la sincronizzazione che ne segue non trova più niente da fare.
  if (presi) await ricarica();
}

// Le foto in photos/ che non stanno in nessun post né nel modulo aperto.
function fotoLibere() {
  if (!cartella) return [];
  const usate = new Set([...posts.flatMap((p) => p.foto), ...formFoto].map((f) => f.name));
  return [...cartella].filter((nome) => !usate.has(nome));
}

async function apriCartella() {
  await leggiCartella(); // nel frattempo Drive può averne portate di nuove
  const libere = fotoLibere();
  $('cartella-griglia').replaceChildren(...libere.map((nome) => el('img', {
    src: URL_PHOTOS + encodeURIComponent(nome),
    alt: nome,
    loading: 'lazy',
    onclick: (e) => { e.target.remove(); prendiDaCartella(nome).catch(mostraErrore); },
  })));
  $('cartella-vuota').hidden = libere.length > 0;
  $('dlg-cartella').showModal();
}

// Nel browser va una copia ridotta con lo stesso nome; in photos/ resta l'originale.
async function prendiDaCartella(nome) {
  const originale = new File([await (await scarica(URL_PHOTOS + encodeURIComponent(nome))).blob()], nome);
  formFoto.push(new File([await ridimensionaFoto(originale)], nome, { type: 'image/jpeg' }));
  disegnaAnteprime();
}

// ---------------------------------------------------------------------------
// Backup
//
// Il backup è uno zip con dentro:
//   diario.json            i post; al posto delle foto ci sono i nomi dei file
//   foto/NOME.jpg          le foto, col nome che hanno nella cartella photos/
// ---------------------------------------------------------------------------

const BACKUP_VERSIONE = 2; // la 1 non aveva l'ora nei post
const CHIAVE_ULTIMO_BACKUP = 'diario.ultimoBackup';
// I ricordi sono già copiati sul Drive: il promemoria si accende solo dopo un mese dall'ultimo backup.
const GIORNI_PROMEMORIA = 30;

let backupPronto = null; // { file, quando } in attesa di essere salvato dall'utente

const nRicordi = (n) => (n === 1 ? '1 ricordo' : `${n} ricordi`);

function ultimoBackup() {
  try {
    return Number(localStorage.getItem(CHIAVE_ULTIMO_BACKUP)) || 0;
  } catch {
    return 0;
  }
}

function aggiornaStatoBackup() {
  backupPronto = null;
  const ultimo = ultimoBackup();
  const daSalvare = posts.filter((p) => p.modificato > ultimo).length;

  let stato;
  if (!posts.length) {
    stato = 'Non c\'è ancora niente da salvare.';
  } else if (!ultimo) {
    stato = `Non hai ancora fatto un backup: ${nRicordi(posts.length)} da salvare.`;
  } else {
    const quando = new Date(ultimo).toLocaleString('it-IT', { dateStyle: 'long', timeStyle: 'short' });
    stato = `Ultimo backup: ${quando}. ` +
      (daSalvare ? `Da allora ${nRicordi(daSalvare)} tra nuovi e modificati.` : 'È tutto salvato.');
  }
  $('backup-stato').textContent = stato;
  const scaduto = Date.now() - ultimo > GIORNI_PROMEMORIA * 24 * 60 * 60 * 1000;
  $('btn-backup').classList.toggle('da-fare', daSalvare > 0 && scaduto);
  $('btn-esporta').textContent = 'Esporta backup';
  $('btn-esporta').disabled = !posts.length;
}

async function preparaBackup() {
  const quando = Date.now();
  const voci = [];
  const elenco = posts.map((p) => {
    const nomi = p.foto.map((blob) => {
      const nome = 'foto/' + blob.name;
      voci.push({ nome, blob });
      return nome;
    });
    return { ...p, foto: nomi };
  });
  const json = JSON.stringify({ versione: BACKUP_VERSIONE, esportato: new Date(quando).toISOString(), posts: elenco }, null, 2);
  voci.unshift({ nome: 'diario.json', blob: new Blob([json], { type: 'application/json' }) });

  const zip = await creaZip(voci);
  return { file: new File([zip], `diario-backup-${oggi()}.zip`, { type: 'application/zip' }), quando };
}

// Sul telefono apre il foglio di condivisione (Salva su File, Drive...), altrove scarica il file.
function puoCondividere(file) {
  return matchMedia('(pointer: coarse)').matches && !!navigator.canShare && navigator.canShare({ files: [file] });
}

async function consegnaBackup({ file, quando }) {
  if (puoCondividere(file)) {
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err.name === 'AbortError') return; // l'utente ha chiuso il foglio: backup non fatto
      throw err;
    }
  } else {
    const url = URL.createObjectURL(file);
    el('a', { href: url, download: file.name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  try {
    localStorage.setItem(CHIAVE_ULTIMO_BACKUP, String(quando));
  } catch { /* senza localStorage resta solo il promemoria sempre acceso */ }
  aggiornaStatoBackup();
}

async function esporta() {
  if (backupPronto) return consegnaBackup(backupPronto);

  const btn = $('btn-esporta');
  btn.disabled = true;
  btn.textContent = 'Preparo il backup…';
  try {
    const pronto = await preparaBackup();
    if (puoCondividere(pronto.file)) {
      // La condivisione deve partire da un tocco: serve un secondo tocco sul pulsante.
      backupPronto = pronto;
      btn.textContent = `Salva il file (${(pronto.file.size / 1048576).toFixed(1)} MB)`;
      btn.disabled = false;
    } else {
      await consegnaBackup(pronto);
    }
  } catch (err) {
    aggiornaStatoBackup();
    throw err;
  }
}

async function importa(file) {
  const voci = await leggiZip(file);
  if (!voci.has('diario.json')) throw new Error('Il file non è un backup del diario');
  const dati = JSON.parse(await voci.get('diario.json').text());
  if (!Array.isArray(dati.posts)) throw new Error('Il file non è un backup del diario');
  if (dati.versione > BACKUP_VERSIONE) throw new Error('Backup creato da una versione più recente dell\'app');

  if (!confirm(`Il backup contiene ${nRicordi(dati.posts.length)}.\n` +
    'Quelli che mancano vengono aggiunti; nessun ricordo viene cancellato. Procedo?')) return;

  await unisci(dati.posts, (nome) => {
    if (!voci.has(nome)) throw new Error('Nel backup manca la foto ' + nome);
    return voci.get(nome);
  });
}

// Da un ricordo salvato fuori dall'archivio (backup o deposito), dove `foto` è un elenco
// di nomi, a un post: leggiFoto(nome) restituisce il contenuto di una foto.
async function daSalvato(ricordo, leggiFoto) {
  const foto = [];
  for (const nome of ricordo.foto) {
    foto.push(new File([await leggiFoto(nome)], nome.split('/').pop(), { type: 'image/jpeg' }));
  }
  return { ...ricordo, ora: ricordo.ora || '', foto };
}

// Aggiunge i ricordi che mancano; se uno esiste già (anche eliminato) vince la versione
// modificata più di recente.
async function unisci(ricordi, leggiFoto) {
  const esistenti = new Map([...posts, ...eliminati].map((p) => [p.id, p]));
  let aggiunti = 0, aggiornati = 0, invariati = 0;
  for (const p of ricordi) {
    const attuale = esistenti.get(p.id);
    if (attuale && attuale.modificato >= p.modificato) { invariati++; continue; }

    await salvaPost(await daSalvato(p, leggiFoto));
    attuale && !attuale.eliminato ? aggiornati++ : aggiunti++;
  }
  await ricarica();
  alert(`Fatto: ${aggiunti} aggiunti, ${aggiornati} aggiornati, ${invariati} già presenti.`);
}

// ---------------------------------------------------------------------------
// Eventi
// ---------------------------------------------------------------------------

$('btn-backup').onclick = () => { aggiornaStatoBackup(); $('dlg-backup').showModal(); };
$('btn-chiudi-backup').onclick = () => $('dlg-backup').close();
$('btn-esporta').onclick = () => esporta().catch(mostraErrore);
$('campo-importa').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importa(file).catch(mostraErrore);
});

$('btn-nuovo').onclick = () => apriModulo();
$('btn-calendario').onclick = apriCalendario;
$('btn-chiudi-calendario').onclick = () => $('dlg-calendario').close();
$('btn-annulla').onclick = chiudiModulo;
$('dlg-post').addEventListener('cancel', (e) => { e.preventDefault(); chiudiModulo(); });

$('form-post').addEventListener('submit', (e) => {
  e.preventDefault();
  salvaModulo().catch(mostraErrore);
});

$('btn-elimina').onclick = async () => {
  if (!inModifica || !confirm('Eliminare questo ricordo? Non si può annullare.')) return;
  try {
    await salvaPost({ id: inModifica.id, eliminato: true, modificato: Date.now() });
    chiudiModulo();
    await ricarica();
  } catch (err) {
    mostraErrore(err);
  }
};

$('campo-foto').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const file of files) {
    try {
      formFoto.push(await ridimensionaFoto(file));
    } catch (err) {
      mostraErrore(err);
    }
  }
  disegnaAnteprime();
});

// Tornando sul diario da un'altra app o scheda ci si riallinea col deposito.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('dlg-post').open) codaCopia = codaCopia.then(sincronizza);
});
$('btn-drive').onclick = () => driveAccedi(true);
$('btn-cartella').onclick = () => apriCartella().catch(mostraErrore);
$('btn-chiudi-cartella').onclick = () => $('dlg-cartella').close();

$('campo-tag').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault(); // Invio qui aggiunge il tag, non salva il post
    aggiungiTag(e.target.value);
  }
});
$('campo-tag').addEventListener('input', disegnaTagModulo);

$('dlg-foto').onclick = () => $('dlg-foto').close();

function mostraErrore(err) {
  console.error(err);
  alert('Qualcosa è andato storto: ' + (err && err.message ? err.message : err));
}

// Chiede al browser di non cancellare i dati del diario quando lo spazio scarseggia.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// Permette di aprire il diario senza rete. Esiste solo su HTTPS e su localhost.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);

ricarica().catch(mostraErrore);
