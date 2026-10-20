'use strict';

// ---------------------------------------------------------------------------
// Archivio (IndexedDB)
//
// Un post ha questa forma:
//   { id, data: 'AAAA-MM-GG', ora: 'HH:MM', testo, tags: ['Viaggi', ...], umore: 'Felice',
//     foto: [File, ...], creato: timestamp, modificato: timestamp }
// L'ora e l'umore sono '' se non sono indicati.
//
// Nello stesso archivio stanno le giornate (le attività di un giorno, vedi
// "Giornata"), che viaggiano come i ricordi:
//   { id: 'giornata-AAAA-MM-GG', tipo: 'giornata', data, attivita: [{ nome, ore }],
//     foto: [], creato, modificato }        ore è un numero oppure null
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
const DB_VERSIONE = 5;
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
  if (salvato.eliminato || salvato.tipo === 'giornata') return salvato;
  const foto = salvato.foto.map((f, i) => (f instanceof Blob
    // versioni 1 e 2: Blob o File salvati direttamente, i più vecchi senza nome
    ? new File([f], f.name || `${salvato.data}_${salvato.id}_${i + 1}.jpg`, { type: 'image/jpeg' })
    : new File([f.dati], f.nome, { type: 'image/jpeg' })));
  return { ...salvato, ora: salvato.ora || '', umore: salvato.umore || '', foto };
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
    if (p.eliminato || p.tipo === 'giornata' || p.tags.every((t) => t === maiuscolaIniziale(t))) continue;
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
let giornate = []; // le attività segnate giorno per giorno
let filtroTag = null;

// Stato del modulo aperto
let inModifica = null; // post in modifica, oppure null se è nuovo
let formFoto = [];
let formTags = [];
let formUmore = '';

// URL temporanei delle immagini mostrate, da liberare a ogni ridisegno
let urlTimeline = [];
let urlAnteprime = [];

// Map(tag -> in quanti ricordi compare)
function contaTag(elenco) {
  const conteggio = new Map();
  for (const p of elenco) for (const t of p.tags) conteggio.set(t, (conteggio.get(t) || 0) + 1);
  return conteggio;
}

// Tutti i tag, dal più usato
function tuttiITags() {
  const conteggio = contaTag(posts);
  return [...conteggio.keys()].sort((a, b) => conteggio.get(b) - conteggio.get(a) || a.localeCompare(b, 'it'));
}

async function ricarica() {
  const tutti = await leggiPosts();
  if (await correggiTag(tutti)) return ricarica();
  eliminati = tutti.filter((p) => p.eliminato);
  giornate = tutti.filter((p) => p.tipo === 'giornata');
  posts = tutti.filter((p) => !p.eliminato && p.tipo !== 'giornata');
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

  // Un riquadro per giorno, con dentro i ricordi di quel giorno (i post sono già in ordine).
  // Senza filtro compaiono anche i giorni che hanno solo attività segnate.
  const giorni = new Map();
  for (const p of visibili) giorni.set(p.data, [...(giorni.get(p.data) || []), p]);
  if (!filtroTag) {
    for (const g of giornate) if (g.attivita.length && !giorni.has(g.data)) giorni.set(g.data, []);
  }
  const date = [...giorni.keys()].sort((a, b) => b.localeCompare(a));

  const contenuto = filtroTag ? [] : [disegnaOggi()];
  if (!date.length) {
    contenuto.push(el('p', { className: 'vuoto', textContent: 'Ancora nessun ricordo. Tocca + per scrivere il primo.' }));
  }
  for (const data of date) {
    const giornata = giornataDel(data);
    contenuto.push(el('section', { className: 'giorno', id: 'giorno-' + data },
      el('div', { className: 'giorno-testa' },
        el('h2', { className: 'giorno-data', textContent: dataLeggibile(data) }),
        el('button', { className: 'btn-testo', textContent: '+ Aggiungi', onclick: () => apriModulo(null, data) }),
      ),
      giornata && giornata.attivita.length
        ? el('button', { className: 'giorno-attivita', textContent: testoAttivita(giornata), onclick: () => apriGiornata(data) })
        : '',
      ...giorni.get(data).map(disegnaPost),
    ));
  }
  $('timeline').replaceChildren(...contenuto);
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
      el('span', { className: 'post-ora', textContent: [post.ora, post.umore].filter(Boolean).join(' · ') }),
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
  formUmore = post ? post.umore : '';

  $('dlg-titolo').textContent = post ? 'Modifica ricordo' : 'Nuovo ricordo';
  $('campo-data').value = post ? post.data : giorno;
  $('campo-ora').value = post ? post.ora : (giorno === oggi() ? oraAdesso() : '');
  $('campo-testo').value = post ? post.testo : '';
  $('campo-tag').value = '';
  $('campo-umore').value = '';
  $('btn-elimina').hidden = !post;
  $('btn-cartella').hidden = !cartella;

  disegnaAnteprime();
  disegnaTagModulo();
  disegnaUmoreModulo();
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

// Umori già pronti; quelli aggiunti a mano si ricavano dai post, come i tag.
const UMORI_DI_BASE = ['Felice', 'Sereno', 'Entusiasta', 'Grato', 'Innamorato', 'Nostalgico', 'Stanco', 'Annoiato', 'Ansioso', 'Triste', 'Arrabbiato'];

// Gli umori da proporre: prima quelli usati di più, poi quelli di base
function tuttiGliUmori() {
  const conteggio = new Map();
  for (const p of posts) if (p.umore) conteggio.set(p.umore, (conteggio.get(p.umore) || 0) + 1);
  const usati = [...conteggio.keys()].sort((a, b) => conteggio.get(b) - conteggio.get(a));
  return [...new Set([...usati, ...UMORI_DI_BASE])];
}

// Un umore solo per ricordo: toccarne un altro lo sostituisce, toccare quello scelto lo toglie.
function disegnaUmoreModulo() {
  const umori = [...new Set([...(formUmore ? [formUmore] : []), ...tuttiGliUmori()])];
  $('umore-scelte').replaceChildren(...umori.map((u) => el('button', {
    type: 'button',
    className: 'chip' + (u === formUmore ? ' attivo' : ''),
    textContent: u,
    onclick: () => { formUmore = formUmore === u ? '' : u; disegnaUmoreModulo(); },
  })));
}

// Un umore scritto a mano; se esiste già scritto diversamente (maiuscole) riusa quello.
function scegliUmore(grezzo) {
  const nome = maiuscolaIniziale(grezzo.trim().replace(/\s+/g, ' '));
  if (nome) formUmore = tuttiGliUmori().find((u) => u.toLowerCase() === nome.toLowerCase()) || nome;
  $('campo-umore').value = '';
  disegnaUmoreModulo();
}

async function salvaModulo() {
  aggiungiTag($('campo-tag').value); // un tag scritto ma non confermato vale comunque
  if ($('campo-umore').value.trim()) scegliUmore($('campo-umore').value); // lo stesso per l'umore

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
    umore: formUmore,
    foto: conNome(formFoto, data),
    creato: inModifica ? inModifica.creato : adesso,
    modificato: adesso,
  });
  chiudiModulo();
  await ricarica();
}

// ---------------------------------------------------------------------------
// Giornata
//
// Le attività di un giorno (Lavoro, Palestra...), ognuna con le ore se si
// vogliono indicare. Si segnano dalla striscia "Oggi" in cima alla timeline,
// o toccando la riga delle attività di un giorno; nella finestra si può anche
// cambiare data. Un giorno ha una sola giornata (id 'giornata-AAAA-MM-GG').
// ---------------------------------------------------------------------------

const ATTIVITA_DI_BASE = ['Lavoro', 'Smart', 'Ferie', 'Uncinetto', 'Tromba', 'Musical', 'Palestra', 'Calisthenics'];

let formAttivita = new Map(); // nome -> ore (numero) oppure null

const giornataDel = (data) => giornate.find((g) => g.data === data);

// 1.5 -> '1h30', 8 -> '8h', 0.25 -> '15min'
function testoOre(ore) {
  const h = Math.floor(ore);
  const m = Math.round((ore - h) * 60);
  if (!m) return `${h}h`;
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`;
}

function testoAttivita(giornata) {
  return giornata.attivita.map((a) => (a.ore ? `${a.nome} ${testoOre(a.ore)}` : a.nome)).join(' · ');
}

// La striscia in cima alla timeline
function disegnaOggi() {
  const giornata = giornataDel(oggi());
  return el('button', { className: 'oggi', onclick: () => apriGiornata(oggi()) },
    el('span', { className: 'oggi-titolo', textContent: 'Oggi' }),
    el('span', {
      className: 'oggi-attivita',
      textContent: giornata && giornata.attivita.length ? testoAttivita(giornata) : 'Cosa hai fatto? Tocca per segnarlo',
    }));
}

// Le attività da proporre: prima quelle usate più spesso, poi quelle di base
function tutteLeAttivita() {
  const conteggio = new Map();
  for (const g of giornate) for (const a of g.attivita) conteggio.set(a.nome, (conteggio.get(a.nome) || 0) + 1);
  const usate = [...conteggio.keys()].sort((a, b) => conteggio.get(b) - conteggio.get(a));
  return [...new Set([...usate, ...ATTIVITA_DI_BASE])];
}

function apriGiornata(data) {
  $('campo-giornata-data').max = oggi();
  $('campo-giornata-data').value = data;
  caricaGiornata(data);
  $('dlg-giornata').showModal();
}

function caricaGiornata(data) {
  const giornata = giornataDel(data);
  formAttivita = new Map(giornata ? giornata.attivita.map((a) => [a.nome, a.ore]) : []);
  $('campo-attivita').value = '';
  disegnaAttivitaModulo();
}

// Le ore da rimettere nel campo, in una forma che leggiOre rilegge: 8 -> '8', 0.25 -> '0h15'
function oreNelCampo(ore) {
  const h = Math.floor(ore);
  const m = Math.round((ore - h) * 60);
  return m ? `${h}h${String(m).padStart(2, '0')}` : String(h);
}

// "1,5", "1.5", "1h30" o "1:30" -> 1.5; vuoto o non valido -> null
function leggiOre(testo) {
  const oreMinuti = testo.trim().match(/^(\d+)\s*[h:]\s*(\d{1,2})$/i);
  const ore = oreMinuti ? Number(oreMinuti[1]) + Number(oreMinuti[2]) / 60 : parseFloat(testo.replace(',', '.'));
  return ore > 0 ? ore : null;
}

function disegnaAttivitaModulo() {
  const nomi = [...new Set([...formAttivita.keys(), ...tutteLeAttivita()])];
  $('elenco-attivita').replaceChildren(...nomi.map((nome) => {
    const scelta = formAttivita.has(nome);
    return el('div', { className: 'attivita-riga' },
      el('button', {
        type: 'button',
        className: 'chip' + (scelta ? ' attivo' : ''),
        textContent: nome,
        onclick: () => {
          if (scelta) formAttivita.delete(nome);
          else formAttivita.set(nome, null);
          disegnaAttivitaModulo();
        },
      }),
      scelta ? el('input', {
        type: 'text',
        inputMode: 'decimal',
        className: 'campo-ore',
        placeholder: 'ore (facoltative)',
        value: formAttivita.get(nome) ? oreNelCampo(formAttivita.get(nome)) : '',
        oninput: (e) => formAttivita.set(nome, leggiOre(e.target.value)),
      }) : '',
    );
  }));
}

// Un'attività scritta a mano; se esiste già scritta diversamente (maiuscole) riusa quella.
function aggiungiAttivita(grezzo) {
  const nome = maiuscolaIniziale(grezzo.trim().replace(/\s+/g, ' '));
  if (nome) {
    const esistente = [...formAttivita.keys(), ...tutteLeAttivita()].find((a) => a.toLowerCase() === nome.toLowerCase());
    if (!formAttivita.has(esistente || nome)) formAttivita.set(esistente || nome, null);
  }
  $('campo-attivita').value = '';
  disegnaAttivitaModulo();
}

async function salvaGiornata() {
  aggiungiAttivita($('campo-attivita').value); // un'attività scritta ma non confermata vale comunque
  const data = $('campo-giornata-data').value || oggi();
  const esistente = giornataDel(data);
  const attivita = [...formAttivita].map(([nome, ore]) => ({ nome, ore }));
  // Una giornata svuotata si salva lo stesso, così lo svuotamento arriva agli altri dispositivi.
  if (attivita.length || esistente) {
    const adesso = Date.now();
    await salvaPost({
      id: 'giornata-' + data,
      tipo: 'giornata',
      data,
      attivita,
      foto: [],
      creato: esistente ? esistente.creato : adesso,
      modificato: adesso,
    });
  }
  $('dlg-giornata').close();
  await ricarica();
}

// ---------------------------------------------------------------------------
// Statistiche
//
// Si ricalcolano dai post ogni volta che si apre la pagina: quanti ricordi ci
// sono, i tag (i più usati; per il tag scelto, mese per mese e con quali altri
// tag compare), le parole e i nomi più citati nei testi. I grafici sono fatti
// di semplici elementi HTML.
// ---------------------------------------------------------------------------

const TAG_IN_CLASSIFICA = 15;
const PAROLE_IN_CLASSIFICA = 15;
const MESI_NEL_GRAFICO = 12;

// Parole troppo comuni per dire qualcosa: non entrano nella classifica.
// Quelle di una o due lettere sono già escluse.
const PAROLE_VUOTE = new Set(`
  il lo la le gli una uno un del dello della dei degli delle dell nel nello nella nei negli nelle nell
  al allo alla ai agli alle all dal dallo dalla dai dagli dalle dall sul sullo sulla sui sugli sulle sull
  col coi con per tra fra che chi cui non come dove quando perché perche mentre anche ancora
  già gia poi dopo prima ora adesso sempre mai più piu meno molto molta molti molte tanto tanta tanti
  tante poco troppo tutto tutta tutti tutte altro altra altri altre stesso stessa questo questa questi
  queste quello quella quelli quelle quel ogni qualche nessuno niente cosa cose così cosi bene male
  solo sola però pero quindi oppure infatti invece insieme verso senza sotto sopra dentro fuori
  mio mia miei mie tuo tua tuoi tue suo sua suoi sue nostro nostra nostri nostre loro lui lei noi voi
  essi esse sono sei siamo siete era ero eri erano eravamo stato stata stati state essere sarà sara
  sarebbe fosse hai abbiamo avete hanno avuto avere avevo aveva avevamo avevano fatto fatta fatti
  fare faccio fa fanno facciamo andato andata andati andate andare vado andiamo stato sto stavo
  stavamo stare può puo posso possiamo devo deve dobbiamo voglio vuole volevo detto dire dice
  oggi ieri domani giorno giornata sera stasera mattina notte volta volte anno anni mese
  ecco qui qua lì li là sia nemmeno neanche proprio davvero
`.split(/\s+/).filter(Boolean));

let tagScelto = null; // il tag mostrato in dettaglio; si sceglie toccandolo

function apriStatistiche() {
  disegnaStatistiche();
  $('dlg-statistiche').showModal();
}

function scegliTag(tag) {
  tagScelto = tag;
  disegnaStatistiche();
}

// voci: [[nome, numero], ...] dal più grande. Con quandoTocchi le righe sono pulsanti.
function disegnaClassifica(voci, scelto = null, quandoTocchi = null) {
  const massimo = voci.length ? voci[0][1] : 1;
  return el('div', { className: 'stat-classifica' }, ...voci.map(([nome, numero]) => el(quandoTocchi ? 'button' : 'div', {
    type: 'button',
    className: 'stat-riga' + (nome === scelto ? ' scelta' : ''),
    onclick: quandoTocchi && (() => quandoTocchi(nome)),
  },
  el('span', { className: 'stat-riga-nome', textContent: nome }),
  el('span', { className: 'stat-riga-barra', style: `width: ${(numero / massimo) * 100}%` }),
  el('span', { className: 'stat-riga-numero', textContent: numero }))));
}

// Le N voci più grandi di una Map(nome -> numero)
function primi(conteggio, n) {
  return [...conteggio].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'it')).slice(0, n);
}

// Conta le parole dei testi. Le parole scritte in minuscolo vanno in `parole`; quelle con
// la maiuscola in mezzo a una frase vanno in `nomi` (persone, posti), purché non compaiano
// mai anche in minuscolo: così "Mare" scritto per enfasi non diventa un nome.
function analizzaTesti(elenco) {
  const parole = new Map();
  const maiuscole = new Map();
  for (const p of elenco) {
    for (const trovata of p.testo.matchAll(/\p{L}+/gu)) {
      const parola = trovata[0];
      if (parola.length < 3) continue;
      const minuscola = parola.toLocaleLowerCase('it');
      if (parola === minuscola) {
        if (!PAROLE_VUOTE.has(parola)) parole.set(parola, (parole.get(parola) || 0) + 1);
        continue;
      }
      // Maiuscola a inizio frase: non dice niente.
      const prima = p.testo.slice(0, trovata.index).trimEnd();
      if (!prima || /[.!?:\n]$/.test(prima)) continue;
      if (!PAROLE_VUOTE.has(minuscola)) maiuscole.set(parola, (maiuscole.get(parola) || 0) + 1);
    }
  }
  const nomi = new Map([...maiuscole].filter(([nome]) => !parole.has(nome.toLocaleLowerCase('it'))));
  return { parole, nomi };
}

function disegnaStatistiche() {
  const conteggio = contaTag(posts);
  const tags = tuttiITags();
  if (!tags.includes(tagScelto)) tagScelto = tags[0] || null;
  const { parole, nomi } = analizzaTesti(posts);

  const contenuto = [
    el('div', { className: 'stat-totale' },
      el('strong', { textContent: posts.length }),
      el('span', { textContent: posts.length === 1 ? 'ricordo' : 'ricordi' })),
  ];

  if (!tags.length) {
    contenuto.push(el('p', { className: 'stat-nota', textContent: 'Ancora nessun tag: le statistiche dei tag compaiono quando ne usi qualcuno.' }));
  } else {
    contenuto.push(
      el('h3', { className: 'stat-titolo', textContent: 'Tag più usati' }),
      disegnaClassifica(tags.slice(0, TAG_IN_CLASSIFICA).map((t) => [t, conteggio.get(t)]), tagScelto, scegliTag),
      ...disegnaTagScelto(tagScelto),
    );
  }

  contenuto.push(
    el('h3', { className: 'stat-titolo', textContent: 'Persone e posti più citati' }),
    nomi.size
      ? disegnaClassifica(primi(nomi, PAROLE_IN_CLASSIFICA))
      : el('p', { className: 'stat-nota', textContent: 'Compaiono qui i nomi scritti con la maiuscola nei testi.' }),
    el('h3', { className: 'stat-titolo', textContent: 'Parole più usate' }),
    parole.size
      ? disegnaClassifica(primi(parole, PAROLE_IN_CLASSIFICA))
      : el('p', { className: 'stat-nota', textContent: 'Ancora nessuna parola da contare.' }),
  );
  $('statistiche-contenuto').replaceChildren(...contenuto);
}

function disegnaTagScelto(tag) {
  const conTag = posts.filter((p) => p.tags.includes(tag));

  // Ricordi con il tag in ognuno degli ultimi mesi, dal più vecchio
  const adesso = new Date();
  const mesi = [];
  for (let i = MESI_NEL_GRAFICO - 1; i >= 0; i--) {
    const inizio = new Date(adesso.getFullYear(), adesso.getMonth() - i, 1);
    const prefisso = dataDa(inizio.getFullYear(), inizio.getMonth(), 1).slice(0, 8); // 'AAAA-MM-'
    mesi.push({
      nome: inizio.toLocaleDateString('it-IT', { month: 'short' }),
      quanti: conTag.filter((p) => p.data.startsWith(prefisso)).length,
    });
  }
  const massimo = Math.max(1, ...mesi.map((m) => m.quanti));

  const compagni = contaTag(conTag);
  compagni.delete(tag);
  const classificaCompagni = primi(compagni, 10);

  return [
    el('h3', { className: 'stat-titolo', textContent: `${tag} negli ultimi ${MESI_NEL_GRAFICO} mesi` }),
    el('div', { className: 'stat-mesi' }, ...mesi.map((m) => el('div', { className: 'stat-mese' },
      el('span', { className: 'stat-mese-numero', textContent: m.quanti || '' }),
      el('span', { className: 'stat-mese-pista' },
        el('span', { className: 'stat-mese-colonna', style: `height: ${(m.quanti / massimo) * 100}%` })),
      el('span', { className: 'stat-mese-nome', textContent: m.nome })))),
    el('h3', { className: 'stat-titolo', textContent: `Insieme a ${tag}` }),
    classificaCompagni.length
      ? el('div', { className: 'chips' }, ...classificaCompagni.map(([t, n]) => el('button', {
        type: 'button',
        className: 'chip',
        textContent: `${t} · ${n}`,
        onclick: () => scegliTag(t),
      })))
      : el('p', { className: 'stat-nota', textContent: 'Finora non è mai comparso insieme ad altri tag.' }),
  ];
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

// Un giorno con ricordi o attività: lo mostra nella timeline. Un giorno vuoto: apre un ricordo nuovo per quel giorno.
function vaiAlGiorno(data) {
  $('dlg-calendario').close();
  const delGiorno = posts.filter((p) => p.data === data);
  const giornata = giornataDel(data);
  if (!delGiorno.length && !(giornata && giornata.attivita.length)) {
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
  const qui = [...posts, ...eliminati, ...giornate];
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

const BACKUP_VERSIONE = 3; // la 1 non aveva l'ora nei post, la 2 né l'umore né le giornate
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
  const elenco = [...posts, ...giornate].map((p) => {
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
  if (ricordo.tipo === 'giornata') return ricordo;
  const foto = [];
  for (const nome of ricordo.foto) {
    foto.push(new File([await leggiFoto(nome)], nome.split('/').pop(), { type: 'image/jpeg' }));
  }
  return { ...ricordo, ora: ricordo.ora || '', umore: ricordo.umore || '', foto };
}

// Aggiunge i ricordi che mancano; se uno esiste già (anche eliminato) vince la versione
// modificata più di recente.
async function unisci(ricordi, leggiFoto) {
  const esistenti = new Map([...posts, ...eliminati, ...giornate].map((p) => [p.id, p]));
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
$('btn-statistiche').onclick = apriStatistiche;
$('btn-chiudi-statistiche').onclick = () => $('dlg-statistiche').close();
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

$('campo-umore').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault(); // Invio qui sceglie l'umore, non salva il post
    scegliUmore(e.target.value);
  }
});

$('btn-annulla-giornata').onclick = () => $('dlg-giornata').close();
$('campo-giornata-data').addEventListener('change', (e) => caricaGiornata(e.target.value || oggi()));
$('form-giornata').addEventListener('submit', (e) => {
  e.preventDefault();
  salvaGiornata().catch(mostraErrore);
});
$('campo-attivita').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault(); // Invio qui aggiunge l'attività, non salva
    aggiungiAttivita(e.target.value);
  }
});

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
