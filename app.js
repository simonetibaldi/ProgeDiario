'use strict';

// ---------------------------------------------------------------------------
// Archivio (IndexedDB)
//
// Un post ha questa forma:
//   { id, data: 'AAAA-MM-GG', ora: 'HH:MM', testo, tags: ['Viaggi', ...], umore: 'Felice',
//     foto: [File, ...], creato: timestamp, modificato: timestamp }
// L'ora e l'umore sono '' se non sono indicati. Un ricordo dell'archivio (vedi "Archivio")
// ha in più raccolta: 'Libri' e campi: { Titolo: '...', Giudizio: 8 }; gli altri non li hanno.
//
// Nello stesso archivio stanno altri due tipi di record (vedi "Oggi"), che
// viaggiano come i ricordi:
//   { id: 'giornata-AAAA-MM-GG', tipo: 'giornata', data, stella: true,
//     scelte: { Hobby: ['Musical'], 'Come sto': { Energia: 6 }, Sigarette: { Sigarette: 3 } },
//     foto: [], creato, modificato }
//   { id: 'impostazioni-gruppi', tipo: 'gruppi', gruppi: [{ nome, tipo, opzioni: [...], estremi }],
//     offerti: [...], collegamenti: { Outfit: { gruppo, voce } }, foto: [], creato, modificato }
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
const DB_VERSIONE = 8;
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
  if (salvato.tipo === 'giornata') return { ...salvato, scelte: scelteDi(salvato) };
  if (salvato.eliminato || salvato.tipo) return salvato;
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
    if (p.eliminato || p.tipo || p.tags.every((t) => t === maiuscolaIniziale(t))) continue;
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
let giornate = []; // quello che è stato segnato giorno per giorno
let impostazioniGruppi = null; // i gruppi personalizzati; null finché si usano quelli di base
let filtroTag = null;

// Stato del modulo aperto
let inModifica = null; // post in modifica, oppure null se è nuovo
let formFoto = [];
let formTags = [];
let formUmore = '';
let formRaccolta = '';
let formCampi = {};

// URL temporanei delle immagini mostrate, da liberare a ogni ridisegno
let urlTimeline = [];
let urlAnteprime = [];

// Map(tag -> in quanti ricordi compare)
function contaTag(elenco) {
  const conteggio = new Map();
  for (const p of elenco) for (const t of tagArgomento(p)) conteggio.set(t, (conteggio.get(t) || 0) + 1);
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
  impostazioniGruppi = tutti.find((p) => p.tipo === 'gruppi') || null;
  posts = tutti.filter((p) => !p.eliminato && !p.tipo);
  posts.sort((a, b) => b.data.localeCompare(a.data) || b.ora.localeCompare(a.ora) || b.creato - a.creato);
  if (filtroTag && !tuttiITags().includes(filtroTag)) filtroTag = null;
  disegnaFiltri();
  disegnaPagina();
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
  // Senza filtro compaiono anche i giorni che hanno solo scelte della pagina Oggi.
  const giorni = new Map();
  for (const p of visibili) giorni.set(p.data, [...(giorni.get(p.data) || []), p]);
  if (!filtroTag) {
    for (const g of giornate) if (giornataPiena(g) && !giorni.has(g.data)) giorni.set(g.data, []);
  }
  const date = [...giorni.keys()].sort((a, b) => b.localeCompare(a));

  const contenuto = [];
  if (!date.length) {
    contenuto.push(el('p', { className: 'vuoto', textContent: 'Ancora nessun ricordo. Tocca + per scrivere il primo.' }));
  }
  for (const data of date) {
    contenuto.push(el('section', { className: 'giorno', id: 'giorno-' + data },
      el('div', { className: 'giorno-testa' },
        el('h2', { className: 'giorno-data', textContent: dataLeggibile(data) + (giornataBella(data) ? ' ★' : '') }),
        el('button', { className: 'btn-testo', textContent: '+ Aggiungi', onclick: () => apriModulo(null, data) }),
      ),
      Object.keys(scelteDelGiorno(data)).length
        ? el('button', { className: 'giorno-attivita', textContent: testoScelte(scelteDelGiorno(data)), onclick: () => apriGiorno(data) })
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
      el('span', { className: 'post-ora', textContent: post.ora }),
      el('button', { className: 'btn-testo', textContent: 'Modifica', onclick: () => apriModulo(post) }),
    ),
  );
  // Un ricordo dell'archivio dice in che raccolta sta, e porta lì.
  if (post.raccolta) {
    corpo.append(el('p', { className: 'post-raccolta' },
      el('button', { className: 'btn-testo', textContent: post.raccolta + ' ›', onclick: () => apriRaccolta(post.raccolta) }),
      ' ' + descrizioneCampi(post)));
  }
  if (post.testo) corpo.append(el('p', { className: 'post-testo', textContent: post.testo }));
  // L'umore e i tag collegati alla pagina Oggi portano a quel giorno.
  const collegati = new Set(post.umore ? [post.umore] : []);
  for (const t of post.tags) if (opzioneDiOggi(t)) collegati.add(opzioneDiOggi(t).opzione);
  if (post.tags.length || collegati.size) {
    corpo.append(el('div', { className: 'chips' },
      ...tagArgomento(post).map((t) => el('span', { className: 'chip', textContent: t })),
      ...[...collegati].map((o) => el('button', {
        className: 'chip collegato',
        textContent: o + ' ↗',
        onclick: () => apriGiorno(post.data),
      }))));
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

// Senza post è un ricordo nuovo, per oggi o per il giorno indicato, e nella raccolta indicata.
function apriModulo(post = null, giorno = oggi(), raccolta = '') {
  inModifica = post;
  formFoto = post ? [...post.foto] : [];
  formTags = post ? [...post.tags] : [];
  formUmore = post ? post.umore : '';
  formRaccolta = post ? post.raccolta || '' : raccolta;
  formCampi = post ? { ...post.campi } : {};

  $('dlg-titolo').textContent = post ? 'Modifica ricordo' : 'Nuovo ricordo';
  $('campo-data').value = post ? post.data : giorno;
  $('campo-ora').value = post ? post.ora : (giorno === oggi() ? oraAdesso() : '');
  $('campo-testo').value = post ? post.testo : '';
  $('campo-tag').value = '';
  $('campo-umore').value = '';
  $('btn-elimina').hidden = !post;
  $('btn-cartella').hidden = !cartella;

  disegnaAnteprime();
  disegnaRaccoltaModulo();
  disegnaTagModulo();
  disegnaUmoreModulo();
  $('dlg-post').showModal();
}

// La raccolta dell'archivio e i suoi campi; "Solo diario" vuol dire nessuna.
function disegnaRaccoltaModulo() {
  $('campo-raccolta').replaceChildren(
    el('option', { value: '', textContent: 'Solo diario' }),
    ...RACCOLTE.map((r) => el('option', { value: r.nome, textContent: r.nome })),
  );
  $('campo-raccolta').value = formRaccolta;
  const raccolta = raccoltaChiamata(formRaccolta);
  $('campi-raccolta').replaceChildren(...(raccolta ? raccolta.campi : []).map((campo) => {
    if (campo.tipo === 'voto') {
      const cambia = (n) => {
        formCampi[campo.nome] = n;
        disegnaRaccoltaModulo();
      };
      return creaSlider({ nome: campo.nome, valore: formCampi[campo.nome], parole: SCALA.map(() => ''), scegli: cambia, togli: () => cambia(undefined) });
    }
    return el('label', {}, campo.nome, el('input', {
      type: campo.tipo === 'data' ? 'date' : 'text',
      value: formCampi[campo.nome] || '',
      autocapitalize: 'sentences',
      oninput: (e) => { formCampi[campo.nome] = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter') e.preventDefault(); }, // Invio qui non salva il ricordo
    }));
  }));
}

// I campi compilati della raccolta scelta; quelli di un'altra raccolta si lasciano.
function campiCompilati() {
  const raccolta = raccoltaChiamata(formRaccolta);
  const campi = {};
  for (const { nome } of raccolta ? raccolta.campi : []) {
    const valore = typeof formCampi[nome] === 'string' ? formCampi[nome].trim() : formCampi[nome];
    if (valore) campi[nome] = valore;
  }
  return campi;
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
  // Le opzioni della pagina Oggi si propongono solo quando si comincia a scrivere: sono tante.
  const proposti = bozza ? tagProposti() : tuttiITags();
  const suggeriti = proposti.filter((t) => !formTags.includes(t) && t.toLowerCase().includes(bozza));
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
    if (!formTags.some(uguale)) formTags.push(tagProposti().find(uguale) || nome);
  }
  $('campo-tag').value = '';
  disegnaTagModulo();
}

// Umori già pronti: all'inizio il gruppo Umore di Oggi ha questi. Quel gruppo e l'umore dei
// ricordi sono la stessa cosa: un umore nuovo scritto in un ricordo entra nel gruppo.
const UMORI_DI_BASE = ['Felice', 'Sereno', 'Entusiasta', 'Grato', 'Innamorato', 'Nostalgico', 'Annoiato', 'Ansioso', 'Triste', 'Arrabbiato'];

// Gli umori dei ricordi, dal più usato
function umoriUsati() {
  const conteggio = new Map();
  for (const p of posts) if (p.umore) conteggio.set(p.umore, (conteggio.get(p.umore) || 0) + 1);
  return [...conteggio.keys()].sort((a, b) => conteggio.get(b) - conteggio.get(a));
}

// Gli umori da proporre in un ricordo: le opzioni del gruppo Umore. Un umore tolto dal gruppo
// resta nei ricordi che lo hanno, ma non si propone più. Senza gruppo, quelli già usati.
function tuttiGliUmori() {
  const gruppo = gruppiAttuali().find((g) => g.nome === GRUPPO_UMORE);
  return gruppo ? gruppo.opzioni : umoriUsati();
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
  const campi = campiCompilati();
  if (!testo && !formFoto.length && !Object.keys(campi).length) {
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
    ...(formRaccolta ? { raccolta: formRaccolta, campi } : {}),
    foto: conNome(formFoto, data),
    creato: inModifica ? inModifica.creato : adesso,
    modificato: adesso,
  });
  aggiungiAlGruppoUmore(formUmore);
  chiudiModulo();
  await ricarica();
}

// ---------------------------------------------------------------------------
// Oggi
//
// La prima pagina: per un giorno, le opzioni di ogni gruppo (Umore, Dormito...)
// da scegliere con un tocco. Ogni tocco si salva da solo; in un gruppo se ne
// possono scegliere più di una. I gruppi e le opzioni sono dati, non codice:
// quelli creati dall'app stanno solo nell'archivio e sul Drive, non su GitHub,
// che è pubblico. Per questo in GRUPPI_DI_BASE non vanno messe cose private.
//
// Un gruppo può essere di tre tipi:
//   - a scelte (senza `tipo`): nel giorno è un elenco delle opzioni scelte;
//   - 'scala': ogni opzione ha un valore da 1 a 9 e in `estremi` cosa vogliono dire 1 e 9;
//   - 'conteggio': ogni opzione è un numero (sigarette, unità di alcol...).
// Per gli ultimi due nel giorno c'è { opzione: numero }.
// ---------------------------------------------------------------------------

const GRUPPO_UMORE = 'Umore';
// 5 è una giornata come al solito; 1 e 9 sono rari, tra le peggiori e le migliori.
const SCALA = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const SCALA_NORMALE = 5;
const GRUPPI_DI_BASE = [
  { nome: GRUPPO_UMORE, opzioni: UMORI_DI_BASE },
  { nome: 'Attività fisica', opzioni: ['Niente', 'Palestra', 'Calisthenics'] },
  { nome: 'Hobby', opzioni: ['Musical', 'Uncinetto', 'Tromba', 'Leggere'] },
  {
    nome: 'Come sto',
    tipo: 'scala',
    opzioni: ['Felicità', 'Soddisfazione di oggi', 'Serenità', 'Energia', 'Motivazione', 'Connessione', 'Realizzazione'],
    estremi: {
      Felicità: ['Triste, giù', 'Felicissimo'],
      'Soddisfazione di oggi': ['Giornata da dimenticare', 'Giornata come la volevo'],
      Serenità: ['Agitato, in ansia', 'Tranquillo, leggero'],
      Energia: ['Spento, stanco', 'Carico'],
      Motivazione: ['Nessuna voglia di fare', 'Voglia di fare tutto'],
      Connessione: ['Solo, distante', 'Vicino agli altri'],
      Realizzazione: ['Non ho combinato niente', 'Ho fatto qualcosa che conta'],
    },
  },
  // Le ore sono un numero da scrivere; il riposo è come ci si sente al risveglio.
  {
    nome: 'Sonno',
    tipo: 'scala',
    opzioni: ['Ore dormite', 'Riposo'],
    numeri: ['Ore dormite'],
    estremi: { Riposo: ['Distrutto', 'Riposatissimo'] },
  },
];
// I gruppi di base arrivati quando qualcuno aveva già i suoi: gli compaiono in fondo,
// e se li toglie non tornano, perché salvaGruppi li segna in `offerti`.
const GRUPPI_AGGIUNTI_DOPO = ['Come sto', 'Sonno'];

// I gruppi stanno in sezioni, ognuna un riquadro. Quelle di chi usa il diario sono nelle
// impostazioni (`sezioni`), e ogni gruppo ha la sua in `sezione`.
const SEZIONI_DI_BASE = ['Salute mentale', 'Salute fisica', 'Attività'];
const SEZIONE_ALTRO = 'Altro'; // in fondo, per i gruppi senza sezione
const sezioniAttuali = () => (impostazioniGruppi && impostazioniGruppi.sezioni) || SEZIONI_DI_BASE;

// La sezione scelta dall'app; per i gruppi mai spostati, una pensata a partire dal tipo.
function sezioneDi(gruppo) {
  const sezioni = sezioniAttuali();
  if (sezioni.includes(gruppo.sezione)) return gruppo.sezione;
  const proposta = gruppo.nome === GRUPPO_UMORE || (gruppo.tipo === 'scala' && gruppo.nome !== 'Sonno') ? 'Salute mentale'
    : gruppo.tipo === 'conteggio' || ['Sonno', 'Dormito', 'Attività fisica'].includes(gruppo.nome) ? 'Salute fisica'
    : gruppo.nome === 'Hobby' ? 'Attività'
    : SEZIONE_ALTRO;
  return sezioni.includes(proposta) ? proposta : SEZIONE_ALTRO;
}

// Il gruppo Umore si chiama così nei dati (ci sono legati i ricordi), ma si mostra così.
const nomeMostrato = (gruppo) => (gruppo.nome === GRUPPO_UMORE ? 'Umore generale' : gruppo.nome);
const ID_GRUPPI = 'impostazioni-gruppi';
const PAUSA_PRIMA_DI_SINCRONIZZARE = 2000;

let giornoMostrato = null; // la data mostrata nella pagina Oggi; null vuol dire oggi
let modificaGruppi = false; // true mentre si tolgono gruppi e opzioni
const gruppiAperti = new Set(); // i gruppi che mostrano tutte le opzioni invece di una riga sola
const sezioniAperte = new Set(); // le sezioni aperte; le altre mostrano una riga di riassunto
const COLORI_GRUPPI = 6; // quanti colori ci sono in style.css (.colore-0, .colore-1...), uno per sezione
let codaSalvataggi = Promise.resolve(); // i tocchi si salvano uno alla volta, nell'ordine
let attesaSincronizzazione = null;

const giornataDel = (data) => giornate.find((g) => g.data === data);
const recordDellaGiornata = () => [...giornate, ...(impostazioniGruppi ? [impostazioniGruppi] : [])];
const stessoNome = (a, b) => a.toLowerCase() === b.toLowerCase();
const giornataPiena = (giornata) => !!giornata && (Object.keys(giornata.scelte).length > 0 || !!giornata.stella);
const giornataBella = (data) => !!(giornataDel(data) || {}).stella;
const numeroLeggibile = (n) => String(n).replace('.', ',');

function gruppiAttuali() {
  if (!impostazioniGruppi) return GRUPPI_DI_BASE;
  const { gruppi, offerti = [] } = impostazioniGruppi;
  const nuovi = GRUPPI_DI_BASE.filter((g) => GRUPPI_AGGIUNTI_DOPO.includes(g.nome)
    && !offerti.includes(g.nome) && !gruppi.some((x) => stessoNome(x.nome, g.nome)));
  return [...gruppi, ...nuovi];
}

// Il gruppo con quel nome. Se è stato tolto dall'elenco, uno fatto apposta per mostrare
// quello che resta nei giorni in cui era segnato.
function gruppoChiamato(nome, segnato) {
  return gruppiAttuali().find((g) => g.nome === nome)
    || { nome, opzioni: [], ...(segnato && !Array.isArray(segnato) ? { tipo: 'conteggio' } : {}) };
}

// I valori di un gruppo a scala o a conteggio in un giorno: { opzione: numero }.
// Un gruppo diventato conteggio ha i giorni segnati quando era a scelte: lì vale 1.
// Uno diventato slider lì non ha valori (le parole di prima le mostra disegnaScale).
function valoriDi(gruppo, segnato) {
  if (Array.isArray(segnato)) return segnato.length && gruppo.tipo === 'conteggio' ? { [gruppo.nome]: 1 } : {};
  return segnato || {};
}

// Le giornate di prima dei gruppi avevano `attivita`: qui diventano scelte. Il campo
// vecchio, con le ore, resta nel file e non si usa più.
function scelteDi(giornata) {
  if (giornata.scelte) return giornata.scelte;
  const scelte = {};
  for (const { nome } of giornata.attivita || []) {
    const gruppo = { Palestra: 'Attività fisica', Calisthenics: 'Attività fisica', Musical: 'Hobby', Uncinetto: 'Hobby', Tromba: 'Hobby' }[nome] || 'Altro';
    scelte[gruppo] = [...(scelte[gruppo] || []), nome];
  }
  return scelte;
}

// Un tag di un ricordo uguale a un'opzione di Oggi non è un argomento: segna quell'opzione
// per il giorno del ricordo. Il legame si calcola ogni volta e non è salvato: nel post resta
// il tag, così togliendolo (o eliminando il ricordo, o togliendo l'opzione) tutto torna da sé.
// Restituisce { gruppo, opzione }, oppure undefined se il tag è un argomento normale.
function opzioneDiOggi(tag) {
  for (const gruppo of gruppiAttuali()) {
    if (gruppo.tipo) continue; // scale e conteggi hanno numeri, non si segnano con un tag
    const opzione = gruppo.opzioni.find((o) => stessoNome(o, tag));
    if (opzione) return { gruppo: gruppo.nome, opzione };
  }
  return undefined;
}

const tagArgomento = (post) => post.tags.filter((t) => !opzioneDiOggi(t));

// I tag da proporre nel modulo: gli argomenti già usati e tutte le opzioni di Oggi
function tagProposti() {
  return [...new Set([...tuttiITags(), ...gruppiAttuali().filter((g) => !g.tipo).flatMap((g) => g.opzioni)])];
}

// Map(gruppo -> Map(opzione -> i ricordi che la segnano)) per un giorno:
// li segnano l'umore del ricordo e i tag uguali a un'opzione.
function scelteDaRicordi(data) {
  const scelte = new Map();
  const segna = (gruppo, opzione, post) => {
    if (!scelte.has(gruppo)) scelte.set(gruppo, new Map());
    const opzioni = scelte.get(gruppo);
    if (!opzioni.has(opzione)) opzioni.set(opzione, []);
    if (!opzioni.get(opzione).includes(post)) opzioni.get(opzione).push(post);
  };
  for (const post of posts) {
    if (post.data !== data) continue;
    if (post.umore) segna(GRUPPO_UMORE, post.umore, post);
    for (const tag of post.tags) {
      const collegata = opzioneDiOggi(tag);
      if (collegata) segna(collegata.gruppo, collegata.opzione, post);
    }
  }
  return scelte;
}

// Un umore scritto in un ricordo diventa un'opzione del gruppo (se il gruppo c'è ancora).
function aggiungiAlGruppoUmore(umore) {
  const gruppo = gruppiAttuali().find((g) => g.nome === GRUPPO_UMORE);
  if (!umore || !gruppo || gruppo.opzioni.some((o) => stessoNome(o, umore))) return;
  salvaGruppi(gruppiAttuali().map((g) => (g === gruppo ? { ...g, opzioni: [...g.opzioni, umore] } : g)));
}

// Il voto di una raccolta dell'archivio (per esempio Outfit) può segnare una scala di Oggi:
// si sceglie dall'archivio e sta in impostazioniGruppi.collegamenti. Il verso è uno solo:
// segnare la scala a mano non crea niente nell'archivio.
// Restituisce Map(voce -> il ricordo che la segna) per quel gruppo in quel giorno.
function valoriDaArchivio(data, nomeGruppo) {
  const collegamenti = (impostazioniGruppi && impostazioniGruppi.collegamenti) || {};
  const segnate = new Map();
  for (const post of posts) {
    const collegata = post.data === data && post.raccolta && collegamenti[post.raccolta];
    const voto = collegata && votoDi(post);
    if (voto && collegata.gruppo === nomeGruppo && !segnate.has(collegata.voce)) segnate.set(collegata.voce, post);
  }
  return segnate;
}

// Tutto ciò che è segnato in un giorno, a mano o dai ricordi: { gruppo: [opzioni] o { opzione: numero } }
function scelteDelGiorno(data) {
  const giornata = giornataDel(data);
  const scelte = { ...(giornata ? giornata.scelte : {}) };
  for (const [gruppo, opzioni] of scelteDaRicordi(data)) {
    scelte[gruppo] = [...new Set([...(scelte[gruppo] || []), ...opzioni.keys()])];
  }
  for (const { gruppo } of Object.values((impostazioniGruppi && impostazioniGruppi.collegamenti) || {})) {
    const daArchivio = valoriDaArchivio(data, gruppo);
    if (!daArchivio.size) continue;
    scelte[gruppo] = { ...valoriDi(gruppoChiamato(gruppo, scelte[gruppo]), scelte[gruppo]) };
    for (const [voce, post] of daArchivio) scelte[gruppo][voce] = votoDi(post);
  }
  return scelte;
}

// "Hobby: Musical · Come sto: Energia 6, Serenità 4 · Sigarette: 3"
function testoScelte(scelte) {
  return Object.entries(scelte).map(([nome, segnato]) => {
    const gruppo = gruppoChiamato(nome, segnato);
    const titolo = nomeMostrato(gruppo);
    // Uno slider appena convertito mostra le parole scelte prima (vedi disegnaScale).
    if (!gruppo.tipo || (Array.isArray(segnato) && gruppo.tipo === 'scala')) return `${titolo}: ${segnato.join(', ')}`;
    const valori = Object.entries(valoriDi(gruppo, segnato));
    if (valori.length === 1 && valori[0][0] === nome) return `${titolo}: ${numeroLeggibile(valori[0][1])}`;
    return `${titolo}: ${valori.map(([voce, n]) => `${voce} ${numeroLeggibile(n)}`).join(', ')}`;
  }).join(' · ');
}

// Salva subito in memoria e nell'archivio; verso il deposito parte poco dopo l'ultimo tocco.
function registra(record) {
  codaSalvataggi = codaSalvataggi.then(() => salvaPost(record)).catch(mostraErrore);
  clearTimeout(attesaSincronizzazione);
  attesaSincronizzazione = setTimeout(() => { codaCopia = codaCopia.then(sincronizza); }, PAUSA_PRIMA_DI_SINCRONIZZARE);
}

// cambi: { gruppi } o { collegamenti }; il resto delle impostazioni resta com'è.
function salvaImpostazioni(cambi) {
  const adesso = Date.now();
  impostazioniGruppi = {
    ...impostazioniGruppi,
    id: ID_GRUPPI,
    tipo: 'gruppi',
    gruppi: gruppiAttuali(),
    offerti: GRUPPI_AGGIUNTI_DOPO,
    foto: [],
    creato: impostazioniGruppi ? impostazioniGruppi.creato : adesso,
    ...cambi,
    modificato: adesso,
  };
  registra(impostazioniGruppi);
  disegnaPagina();
}

function salvaGruppi(gruppi) {
  salvaImpostazioni({ gruppi });
}

// Cambia il gruppo con quel nome (che deve essere nell'elenco).
function cambiaGruppo(nome, modifica) {
  salvaGruppi(gruppiAttuali().map((g) => (g.nome === nome ? modifica(g) : g)));
}

// cambi: { scelte } o { stella }. Una giornata svuotata si salva lo stesso, così lo
// svuotamento arriva agli altri dispositivi.
function salvaGiornata(data, cambi) {
  const adesso = Date.now();
  const nuova = {
    ...(giornataDel(data) || { id: 'giornata-' + data, tipo: 'giornata', data, scelte: {}, foto: [], creato: adesso }),
    ...cambi,
    modificato: adesso,
  };
  giornate = [...giornate.filter((g) => g.data !== data), nuova];
  registra(nuova);
  disegnaOggi();
}

// Scrive quello che è segnato per un gruppo in un giorno; se è vuoto lo toglie.
function scriviGiornata(data, nomeGruppo, segnato) {
  const giornata = giornataDel(data);
  const scelte = { ...(giornata ? giornata.scelte : {}) };
  if (Object.keys(segnato).length) scelte[nomeGruppo] = segnato;
  else delete scelte[nomeGruppo];
  salvaGiornata(data, { scelte });
}

function cambiaScelta(data, gruppo, opzione) {
  const giornata = giornataDel(data);
  const elenco = (giornata && giornata.scelte[gruppo]) || [];
  scriviGiornata(data, gruppo, elenco.includes(opzione) ? elenco.filter((o) => o !== opzione) : [...elenco, opzione]);
}

// Per scale e conteggi: cambi è { opzione: numero }, dove null toglie il valore.
function cambiaValori(data, gruppo, cambi) {
  const giornata = giornataDel(data);
  const valori = { ...valoriDi(gruppo, giornata && giornata.scelte[gruppo.nome]) };
  for (const [voce, n] of Object.entries(cambi)) {
    if (n === null) delete valori[voce];
    else valori[voce] = n;
  }
  scriviGiornata(data, gruppo.nome, valori);
}

// Per correggere un conteggio, o segnare mezza unità: si scrive il numero.
function scriviConteggio(data, gruppo, voce, attuale) {
  const scritto = prompt(`${voce}: quante?`, numeroLeggibile(attuale || 0));
  if (scritto === null) return;
  const n = Number(scritto.replace(',', '.'));
  if (!(n >= 0)) return;
  cambiaValori(data, gruppo, { [voce]: n || null });
}

// Chiede un nome; restituisce null se non è stato scritto niente.
function chiediNome(domanda) {
  const nome = (prompt(domanda) || '').trim().replace(/\s+/g, ' ');
  return nome ? maiuscolaIniziale(nome) : null;
}

function aggiungiOpzione(data, nomeGruppo) {
  const nome = chiediNome(`Nuova opzione per ${nomeGruppo}`);
  if (!nome) return;
  const gruppi = gruppiAttuali();
  const gruppo = gruppi.find((g) => g.nome === nomeGruppo);
  const esistente = gruppo && gruppo.opzioni.find((o) => stessoNome(o, nome));
  if (!esistente) {
    // Un gruppo che esiste solo nelle scelte di un giorno (per esempio Altro) entra nell'elenco.
    salvaGruppi(gruppo
      ? gruppi.map((g) => (g === gruppo ? { ...g, opzioni: [...g.opzioni, nome] } : g))
      : [...gruppi, { nome: nomeGruppo, opzioni: [nome] }]);
  }
  const giornata = giornataDel(data);
  const scelta = esistente || nome;
  if (!(giornata && (giornata.scelte[nomeGruppo] || []).includes(scelta))) cambiaScelta(data, nomeGruppo, scelta);
}

// tipo: undefined (a scelte), 'scala' o 'conteggio'
function nuovoGruppo(tipo) {
  const nome = chiediNome(tipo === 'scala' ? 'Nome del nuovo gruppo di slider' : tipo === 'conteggio' ? 'Cosa vuoi contare?' : 'Nome del nuovo gruppo');
  if (!nome) return;
  if (gruppiAttuali().some((g) => stessoNome(g.nome, nome))) {
    alert(`Il gruppo ${nome} esiste già.`);
    return;
  }
  // Un conteggio nuovo conta una cosa sola, col nome del gruppo; altre si aggiungono da Modifica.
  if (tipo === 'conteggio') {
    salvaGruppi([...gruppiAttuali(), { nome, tipo, opzioni: [nome] }]);
    return;
  }
  // Le opzioni si possono scrivere subito, separate da virgole, o aggiungere dopo.
  const domanda = tipo === 'scala'
    ? `Cosa misurare in ${nome}, separate da virgole (per esempio Energia, Serenità)`
    : `Opzioni per ${nome}, separate da virgole (facoltative)`;
  const opzioni = [];
  for (const grezza of (prompt(domanda) || '').split(',')) {
    const opzione = maiuscolaIniziale(grezza.trim().replace(/\s+/g, ' '));
    if (opzione && !opzioni.some((o) => stessoNome(o, opzione))) opzioni.push(opzione);
  }
  salvaGruppi([...gruppiAttuali(), tipo ? { nome, tipo, opzioni, estremi: {} } : { nome, opzioni }]);
}

// Una voce in più in un gruppo di slider o di conteggi. In un gruppo di slider può essere
// uno slider da 1 a 9 o una casella dove scrivere un numero (ore dormite...).
function aggiungiVoce(gruppo, numero = false) {
  const domanda = gruppo.tipo === 'conteggio' ? `Cos'altro contare in ${gruppo.nome}?`
    : numero ? `Che numero scrivere in ${gruppo.nome}? (per esempio Ore dormite)` : `Cosa misurare in ${gruppo.nome}?`;
  const nome = chiediNome(domanda);
  if (!nome || gruppo.opzioni.some((o) => stessoNome(o, nome))) return;
  cambiaGruppo(gruppo.nome, (g) => ({ ...g, opzioni: [...g.opzioni, nome], ...(numero ? { numeri: [...(g.numeri || []), nome] } : {}) }));
  if (gruppo.tipo === 'scala' && !numero) cambiaParole(gruppo.nome, nome);
}

const eNumero = (gruppo, voce) => (gruppo.numeri || []).includes(voce);

// Le parole dei 9 punti di uno slider ('' dove non c'è). I gruppi fatti prima delle parole
// avevano solo `estremi`, cioè le parole di 1 e di 9.
function paroleDi(gruppo, voce) {
  const parole = (gruppo.parole || {})[voce];
  if (parole) return SCALA.map((n) => parole[n - 1] || '');
  const [basso, alto] = (gruppo.estremi || {})[voce] || [];
  return SCALA.map((n) => (n === 1 ? basso || '' : n === 9 ? alto || '' : ''));
}

// Si scrivono tutte insieme separate da /, dove i punti senza parola restano vuoti:
// "Distrutto / / / / Normale / / / / Riposatissimo". Con due parole sole sono 1 e 9.
function cambiaParole(nomeGruppo, voce) {
  const gruppo = gruppiAttuali().find((g) => g.nome === nomeGruppo);
  const scritte = prompt(`${voce}: le parole per 1, 2… 9, separate da /. Con due parole sole valgono per 1 e 9.`, paroleDi(gruppo, voce).join(' / '));
  if (scritte === null) return;
  let pezzi = scritte.split('/').map((p) => p.trim());
  if (pezzi.length === 2) pezzi = [pezzi[0], '', '', '', '', '', '', '', pezzi[1]];
  const parole = SCALA.map((n) => pezzi[n - 1] || '');
  cambiaGruppo(nomeGruppo, (g) => ({ ...g, parole: { ...g.parole, [voce]: parole } }));
}

// Un gruppo a scelte diventa uno slider o un conteggio col suo nome. I giorni già segnati non
// vengono riscritti: in un conteggio valgono 1, in uno slider resta scritto cosa si era scelto.
function converti(nomeGruppo, tipo) {
  const avviso = tipo === 'conteggio'
    ? `${nomeGruppo} diventa un numero da contare. Le sue opzioni spariscono e nei giorni già segnati vale 1, da correggere a mano.`
    : `${nomeGruppo} diventa uno slider da 1 a 9. Le sue opzioni spariscono; nei giorni già segnati resta scritto cosa avevi scelto, finché non sposti lo slider.`;
  if (!confirm(avviso)) return;
  cambiaGruppo(nomeGruppo, (g) => ({ nome: g.nome, tipo, opzioni: [g.nome], ...(g.sezione ? { sezione: g.sezione } : {}) }));
}

// Più opzioni diventano una sola: nel gruppo, nei giorni segnati e nei ricordi (umore e tag).
// Giorni e ricordi vengono riscritti, così il cambio arriva anche al Drive.
async function unisciOpzioni(nomeGruppo) {
  const gruppo = gruppiAttuali().find((g) => g.nome === nomeGruppo);
  const scritte = (prompt(`Quali opzioni di ${nomeGruppo} vuoi unire? Scrivile separate da virgole`) || '').split(',').map((o) => o.trim()).filter(Boolean);
  if (!scritte.length) return;
  const unite = gruppo.opzioni.filter((o) => scritte.some((s) => stessoNome(s, o)));
  if (unite.length < 2) {
    alert('Servono almeno due opzioni del gruppo.');
    return;
  }
  const scritto = (prompt(`Con quale nome restano ${unite.join(', ')}?`, unite[0]) || '').trim().replace(/\s+/g, ' ');
  if (!scritto) return;
  const nome = maiuscolaIniziale(scritto);
  const unita = (t) => unite.some((o) => stessoNome(o, t));
  const sostituisci = (elenco) => [...new Set(elenco.map((t) => (unita(t) ? nome : t)))];
  const giorni = giornate.filter((g) => Array.isArray(g.scelte[nomeGruppo]) && g.scelte[nomeGruppo].some(unita));
  const ricordi = posts.filter((p) => (nomeGruppo === GRUPPO_UMORE && p.umore && unita(p.umore)) || p.tags.some(unita));
  if (!confirm(`${unite.join(', ')} diventano ${nome}. Cambiano ${nRicordi(ricordi.length)} e ${giorni.length === 1 ? '1 giorno' : giorni.length + ' giorni'}. Se vuoi poter tornare indietro, fai prima un backup.`)) return;

  cambiaGruppo(nomeGruppo, (g) => ({ ...g, opzioni: sostituisci(g.opzioni) }));
  const adesso = Date.now();
  for (const g of giorni) await salvaPost({ ...g, scelte: { ...g.scelte, [nomeGruppo]: sostituisci(g.scelte[nomeGruppo]) }, modificato: adesso });
  for (const p of ricordi) {
    const umore = nomeGruppo === GRUPPO_UMORE && p.umore && unita(p.umore) ? nome : p.umore;
    await salvaPost({ ...p, umore, tags: sostituisci(p.tags), modificato: adesso });
  }
  await ricarica();
}

// Togliere un gruppo o un'opzione non tocca i giorni già segnati.
function togliOpzione(nomeGruppo, opzione) {
  salvaGruppi(gruppiAttuali().map((g) => (g.nome === nomeGruppo ? { ...g, opzioni: g.opzioni.filter((o) => o !== opzione) } : g)));
}

function togliGruppo(nomeGruppo) {
  if (!confirm(`Togliere il gruppo ${nomeGruppo}? I giorni già segnati restano com'erano.`)) return;
  salvaGruppi(gruppiAttuali().filter((g) => g.nome !== nomeGruppo));
}

function nuovaSezione() {
  const nome = chiediNome('Nome della nuova sezione');
  if (!nome) return;
  if ([...sezioniAttuali(), SEZIONE_ALTRO].some((s) => stessoNome(s, nome))) {
    alert(`La sezione ${nome} esiste già.`);
    return;
  }
  salvaImpostazioni({ sezioni: [...sezioniAttuali(), nome] });
}

function togliSezione(nome) {
  if (!confirm(`Togliere la sezione ${nome}? I suoi gruppi restano e passano in un'altra sezione.`)) return;
  salvaImpostazioni({ sezioni: sezioniAttuali().filter((s) => s !== nome) });
}

// Un'opzione segnata da un ricordo si cambia da lì: se i ricordi sono più d'uno, si va al giorno.
function apriRicordiCollegati(data, ricordi) {
  if (ricordi.length === 1) apriModulo(ricordi[0]);
  else vaiAlGiorno(data);
}

function apriOChiudi(insieme, nome) {
  if (insieme.has(nome)) insieme.delete(nome);
  else insieme.add(nome);
  disegnaOggi();
}

// In Modifica, sotto il nome del gruppo: dove sta, in cosa si trasforma, e come toglierlo.
function disegnaComandiGruppo(gruppo) {
  const inElenco = gruppiAttuali().some((g) => g.nome === gruppo.nome);
  const sezione = el('select', {
    ariaLabel: 'Sezione',
    onchange: (e) => cambiaGruppo(gruppo.nome, (g) => ({ ...g, sezione: e.target.value })),
  }, ...[...sezioniAttuali(), SEZIONE_ALTRO].map((s) => el('option', { value: s, textContent: 'In ' + s })));
  sezione.value = sezioneDi(gruppo);
  const pulsante = (testo, azione) => el('button', { type: 'button', className: 'btn-testo', textContent: testo, onclick: azione });
  const aScelte = !gruppo.tipo && gruppo.nome !== GRUPPO_UMORE;
  return el('div', { className: 'gruppo-comandi' },
    inElenco ? sezione : '',
    aScelte ? pulsante('Diventa slider', () => converti(gruppo.nome, 'scala')) : '',
    aScelte ? pulsante('Diventa conteggio', () => converti(gruppo.nome, 'conteggio')) : '',
    !gruppo.tipo && inElenco ? pulsante('Unisci opzioni', () => unisciOpzioni(gruppo.nome)) : '',
    pulsante('Togli gruppo', () => togliGruppo(gruppo.nome)));
}

function disegnaGruppo(data, gruppo, scelte) {
  // Le scelte da chiuse stanno su una riga; slider e conteggi sono sempre aperti (li chiude la sezione).
  const aperto = modificaGruppi || gruppiAperti.has(gruppo.nome) || !!gruppo.tipo;
  const freccia = el('button', { type: 'button', className: 'btn-testo gruppo-freccia', textContent: aperto ? '▴' : '▾', ariaLabel: 'Mostra o nascondi le opzioni', onclick: () => apriOChiudi(gruppiAperti, gruppo.nome) });
  // Un gruppo con uno slider solo che si chiama come lui (Libido) non ripete il nome: basta la riga.
  const soloSlider = !modificaGruppi && gruppo.tipo === 'scala' && gruppo.opzioni.length === 1 && gruppo.opzioni[0] === gruppo.nome;
  const testa = soloSlider ? '' : el('div', { className: 'gruppo-testa' }, el('h3', { textContent: nomeMostrato(gruppo) }));
  if (!modificaGruppi && !gruppo.tipo) testa.append(freccia);
  const contenuto = gruppo.tipo === 'scala' ? disegnaScale(data, gruppo, scelte)
    : gruppo.tipo === 'conteggio' ? disegnaConteggi(data, gruppo, scelte)
    : disegnaScelte(data, gruppo, scelte, aperto);
  return el('div', {
    className: `gruppo gruppo-${gruppo.tipo || 'scelte'}${aperto ? '' : ' chiuso'}`,
    // Toccare il gruppo fuori dai pulsanti fa lo stesso della freccia.
    onclick: (e) => {
      if (!modificaGruppi && freccia.isConnected && !freccia.hidden && !e.target.closest('button')) apriOChiudi(gruppiAperti, gruppo.nome);
    },
  }, testa, modificaGruppi ? disegnaComandiGruppo(gruppo) : '', contenuto);
}

function disegnaScelte(data, gruppo, scelte, aperto) {
  const collegate = scelteDaRicordi(data).get(gruppo.nome) || new Map();
  const scelteQui = [...new Set([...collegate.keys(), ...(scelte[gruppo.nome] || [])])];
  // Da chiuso si vede una riga sola: le opzioni scelte stanno davanti, così restano visibili.
  const opzioni = aperto
    ? [...new Set([...gruppo.opzioni, ...scelteQui])]
    : [...new Set([...scelteQui, ...gruppo.opzioni])];
  return el('div', { className: 'chips' },
    ...opzioni.map((o) => el('button', {
      type: 'button',
      className: 'chip' + (scelteQui.includes(o) ? ' attivo' : '') + (collegate.has(o) ? ' collegato' : ''),
      textContent: modificaGruppi ? o + ' ×' : (collegate.has(o) ? o + ' ↗' : o),
      onclick: () => {
        if (modificaGruppi) togliOpzione(gruppo.nome, o);
        else if (collegate.has(o)) apriRicordiCollegati(data, collegate.get(o));
        else cambiaScelta(data, gruppo.nome, o);
      },
    })),
    modificaGruppi ? '' : el('button', { type: 'button', className: 'chip chip-aggiungi', textContent: '+', ariaLabel: 'Nuova opzione', onclick: () => aggiungiOpzione(data, gruppo.nome) }),
  );
}

// In Modifica: le voci di un gruppo di slider o di conteggi, da togliere o aggiungere.
function disegnaVociInModifica(gruppo) {
  const inElenco = gruppiAttuali().some((g) => g.nome === gruppo.nome);
  const aggiungi = (testo, numero) => el('button', { type: 'button', className: 'chip chip-aggiungi', textContent: testo, onclick: () => aggiungiVoce(gruppo, numero) });
  return el('div', { className: 'voci' },
    ...gruppo.opzioni.map((voce) => el('div', { className: 'voce' },
      el('span', { className: 'voce-nome', textContent: voce + (eNumero(gruppo, voce) ? ' (numero)' : '') }),
      gruppo.tipo === 'scala' && !eNumero(gruppo, voce)
        ? el('button', { type: 'button', className: 'btn-testo', textContent: 'Parole', ariaLabel: 'Le parole dei punti da 1 a 9', onclick: () => cambiaParole(gruppo.nome, voce) })
        : '',
      el('button', { type: 'button', className: 'btn-testo', textContent: '×', ariaLabel: 'Togli', onclick: () => togliOpzione(gruppo.nome, voce) }))),
    inElenco
      ? el('div', { className: 'chips' },
        ...(gruppo.tipo === 'scala' ? [aggiungi('+ Slider', false), aggiungi('+ Numero', true)] : [aggiungi('+ Aggiungi', false)]))
      : '',
  );
}

// Uno slider da 1 a 9 su una riga: il nome, un pallino per ogni numero, il valore.
// Si tocca un punto o si trascina; toccare di nuovo il punto scelto lo toglie.
// Finché non si tocca è spento: non segnato non vuol dire 5. Serve in Oggi e nei voti dell'archivio.
//   parole: le 9 parole dei punti ('' dove non c'è): quella scelta compare sotto il nome
//   scegli(n), togli(): chiamate quando si lascia il dito
//   apri(): se c'è, il valore non si cambia qui (viene dall'archivio, da `da`) e toccare apre
function creaSlider({ nome, valore, parole, scegli, togli, apri, da = '' }) {
  const scritta = el('span', { className: 'slider-valore' });
  const dettaglio = el('span', { className: 'slider-parola' });
  const punti = SCALA.map((n) => el('span', { className: 'slider-punto' + (n === SCALA_NORMALE ? ' normale' : ''), style: `--i: ${n - 1}` }));
  const binario = el('div', { className: 'slider' }, el('span', { className: 'slider-linea' }), ...punti);
  const mostra = (n) => {
    punti.forEach((p, i) => p.classList.toggle('attivo', i + 1 === n));
    binario.classList.toggle('vuoto', !n);
    binario.style.setProperty('--valore', n ? n - 1 : 0);
    scritta.textContent = (n || '–') + (apri ? ' ↗' : '');
    dettaglio.textContent = apri ? 'da ' + da : (n && parole[n - 1]) || '';
  };
  mostra(valore);

  if (apri) {
    binario.onclick = apri;
  } else {
    let scelto = null;
    let mosso = false;
    const punto = (e) => {
      const r = binario.getBoundingClientRect();
      return Math.min(9, Math.max(1, Math.round(((e.clientX - r.left - 14) / (r.width - 28)) * 8) + 1));
    };
    binario.onpointerdown = (e) => {
      binario.setPointerCapture(e.pointerId);
      scelto = punto(e);
      mosso = false;
      mostra(scelto);
    };
    binario.onpointermove = (e) => {
      if (scelto === null || punto(e) === scelto) return;
      scelto = punto(e);
      mosso = true;
      mostra(scelto);
    };
    binario.onpointerup = () => {
      if (scelto === valore && !mosso) togli();
      else if (scelto !== null && scelto !== valore) scegli(scelto);
      scelto = null;
    };
    // Succede quando il dito scorre la pagina in verticale: non si sceglie niente.
    binario.onpointercancel = () => {
      scelto = null;
      mostra(valore);
    };
  }
  return el('div', { className: 'slider-voce' },
    el('div', { className: 'slider-nome' }, el('span', { textContent: nome }), dettaglio),
    binario,
    scritta,
    parole[0] || parole[8]
      ? el('div', { className: 'scala-estremi' }, el('span', { textContent: parole[0] }), el('span', { textContent: parole[8] }))
      : '');
}

function disegnaSlider(data, gruppo, voce, valore, post) {
  return creaSlider({
    nome: voce,
    valore,
    parole: paroleDi(gruppo, voce),
    scegli: (n) => cambiaValori(data, gruppo, { [voce]: n }),
    togli: () => cambiaValori(data, gruppo, { [voce]: null }),
    // Il valore viene da una voce dell'archivio: si cambia da lì.
    apri: post ? () => apriModulo(post) : null,
    da: post ? post.raccolta : '',
  });
}

// Una casella dove si scrive un numero, anche con la virgola (7,5 ore). Vuota toglie il valore.
function disegnaCasella(data, gruppo, voce, valore) {
  return el('label', { className: 'voce' },
    el('span', { className: 'voce-nome', textContent: voce }),
    el('input', {
      type: 'text',
      inputMode: 'decimal',
      className: 'casella-numero',
      placeholder: '–',
      value: valore === undefined ? '' : numeroLeggibile(valore),
      onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
      onchange: (e) => {
        const scritto = e.target.value.trim();
        const n = Number(scritto.replace(',', '.'));
        if (!scritto) cambiaValori(data, gruppo, { [voce]: null });
        else if (n >= 0) cambiaValori(data, gruppo, { [voce]: n });
        else disegnaOggi(); // non è un numero: torna quello di prima
      },
    }));
}

function disegnaScale(data, gruppo, scelte) {
  if (modificaGruppi) return disegnaVociInModifica(gruppo);
  // Un voto dell'archivio vale più di quello segnato a mano, e si cambia da lì.
  const daArchivio = valoriDaArchivio(data, gruppo.nome);
  const segnato = scelte[gruppo.nome];
  const valori = { ...valoriDi(gruppo, segnato) };
  for (const [voce, post] of daArchivio) valori[voce] = votoDi(post);
  const voci = [...new Set([...gruppo.opzioni, ...Object.keys(valori)])];
  const slider = voci.filter((v) => !eNumero(gruppo, v));
  const vuoti = slider.filter((v) => !(v in valori));
  return el('div', { className: 'voci' },
    // Un gruppo appena diventato slider: nei giorni di prima resta cosa si era scelto.
    Array.isArray(segnato) && segnato.length ? el('p', { className: 'nota', textContent: 'Segnato prima: ' + segnato.join(', ') }) : '',
    ...voci.map((v) => (eNumero(gruppo, v)
      ? disegnaCasella(data, gruppo, v, valori[v])
      : disegnaSlider(data, gruppo, v, valori[v], daArchivio.get(v)))),
    vuoti.length && slider.length > 1
      ? el('button', {
        type: 'button',
        className: 'btn-secondario btn-come-al-solito',
        textContent: vuoti.length === slider.length ? 'Tutto come al solito (5)' : 'Gli altri come al solito (5)',
        onclick: () => cambiaValori(data, gruppo, Object.fromEntries(vuoti.map((v) => [v, SCALA_NORMALE]))),
      })
      : '',
  );
}

function disegnaConteggi(data, gruppo, scelte) {
  if (modificaGruppi) return disegnaVociInModifica(gruppo);
  const valori = valoriDi(gruppo, scelte[gruppo.nome]);
  const voci = [...new Set([...gruppo.opzioni, ...Object.keys(valori)])];
  return el('div', { className: 'voci' },
    ...voci.map((v) => el('div', { className: 'voce' },
      el('span', { className: 'voce-nome', textContent: v }),
      el('button', {
        type: 'button',
        className: 'conta-pulsante',
        textContent: '−',
        ariaLabel: 'Uno in meno',
        disabled: !valori[v],
        onclick: () => cambiaValori(data, gruppo, { [v]: valori[v] > 1 ? valori[v] - 1 : null }),
      }),
      el('button', {
        type: 'button',
        className: 'conta-valore' + (valori[v] ? ' attivo' : ''),
        textContent: numeroLeggibile(valori[v] || 0),
        ariaLabel: 'Scrivi il numero',
        onclick: () => scriviConteggio(data, gruppo, v, valori[v]),
      }),
      el('button', {
        type: 'button',
        className: 'conta-pulsante',
        textContent: '+',
        ariaLabel: 'Uno in più',
        onclick: () => cambiaValori(data, gruppo, { [v]: (valori[v] || 0) + 1 }),
      }))),
  );
}

// Una sezione (Salute mentale...) è un riquadro col suo colore che contiene dei gruppi.
// Da chiusa mostra una riga con quello che è segnato; toccandola si apre.
function disegnaSezione(data, nome, gruppiSezione, scelte, posizione) {
  const aperta = modificaGruppi || sezioniAperte.has(nome);
  const tutte = scelteDelGiorno(data);
  const riassunto = testoScelte(Object.fromEntries(gruppiSezione.filter((g) => g.nome in tutte).map((g) => [g.nome, tutte[g.nome]])));
  const testa = el('div', { className: 'sezione-testa' },
    el('h2', { textContent: nome }),
    modificaGruppi
      ? (nome !== SEZIONE_ALTRO ? el('button', { type: 'button', className: 'btn-testo', textContent: 'Togli sezione', onclick: () => togliSezione(nome) }) : '')
      : el('span', { className: 'gruppo-freccia', textContent: aperta ? '▴' : '▾' }));
  return el('section', {
    className: `sezione colore-${posizione % COLORI_GRUPPI}${aperta ? '' : ' chiusa'}`,
    onclick: (e) => {
      if (!modificaGruppi && !e.target.closest('button, input, select, .gruppo')) apriOChiudi(sezioniAperte, nome);
    },
  }, testa,
    ...(aperta
      ? gruppiSezione.map((g) => disegnaGruppo(data, g, scelte))
      : [el('p', { className: 'sezione-riassunto', textContent: riassunto || 'Niente segnato' })]));
}

function disegnaOggi() {
  const data = giornoMostrato || oggi();
  const giornata = giornataDel(data);
  const scelte = giornata ? giornata.scelte : {};
  // Anche i gruppi tolti dall'elenco si vedono, nei giorni in cui erano stati scelti.
  const gruppi = [...gruppiAttuali()];
  const nomiSegnati = [...Object.keys(scelte), ...scelteDaRicordi(data).keys()];
  for (const nome of nomiSegnati) if (!gruppi.some((g) => g.nome === nome)) gruppi.push(gruppoChiamato(nome, scelte[nome]));
  const perSezione = new Map([...sezioniAttuali(), SEZIONE_ALTRO].map((s) => [s, []]));
  for (const g of gruppi) perSezione.get(sezioneDi(g)).push(g);

  const spostati = (giorni) => {
    const d = new Date(data + 'T00:00');
    d.setDate(d.getDate() + giorni);
    const nuova = dataDa(d.getFullYear(), d.getMonth(), d.getDate());
    giornoMostrato = nuova === oggi() ? null : nuova;
    disegnaOggi();
  };

  $('pagina-oggi').replaceChildren(
    el('div', { className: 'oggi-giorno' },
      el('button', { type: 'button', className: 'btn-testo', textContent: '‹', ariaLabel: 'Giorno prima', onclick: () => spostati(-1) }),
      el('div', { className: 'oggi-titolo' },
        el('h2', { textContent: data === oggi() ? 'Oggi' : dataLeggibile(data) }),
        el('button', {
          type: 'button',
          className: 'btn-testo btn-stella' + (giornataBella(data) ? ' attiva' : ''),
          textContent: giornataBella(data) ? '★' : '☆',
          ariaLabel: 'Giornata particolarmente bella',
          onclick: () => salvaGiornata(data, { stella: !giornataBella(data) }),
        })),
      el('button', { type: 'button', className: 'btn-testo', textContent: '›', ariaLabel: 'Giorno dopo', disabled: data >= oggi(), onclick: () => spostati(1) }),
    ),
    // Le sezioni vuote si vedono solo in Modifica, per poterci spostare dei gruppi.
    ...[...perSezione]
      .filter(([nome, gruppiSezione]) => gruppiSezione.length || (modificaGruppi && nome !== SEZIONE_ALTRO))
      .map(([nome, gruppiSezione], i) => disegnaSezione(data, nome, gruppiSezione, scelte, i)),
    el('div', { className: 'oggi-azioni' },
      modificaGruppi
        ? el('div', { className: 'nuovi-gruppi' },
          el('button', { type: 'button', className: 'btn-secondario', textContent: '+ Nuova sezione', onclick: nuovaSezione }),
          el('button', { type: 'button', className: 'btn-secondario', textContent: '+ Nuovo gruppo', onclick: () => nuovoGruppo() }),
          el('button', { type: 'button', className: 'btn-secondario', textContent: '+ Nuovi slider', onclick: () => nuovoGruppo('scala') }),
          el('button', { type: 'button', className: 'btn-secondario', textContent: '+ Nuovo conteggio', onclick: () => nuovoGruppo('conteggio') }))
        : '',
      el('button', {
        type: 'button',
        className: 'btn-secondario btn-modifica-gruppi',
        textContent: modificaGruppi ? 'Fine' : 'Modifica\nGruppi',
        onclick: () => { modificaGruppi = !modificaGruppi; disegnaOggi(); },
      }),
    ),
  );

  // La freccia serve solo se le opzioni non stanno in una riga: lo si sa dopo averle disegnate.
  for (const gruppo of $('pagina-oggi').querySelectorAll('.gruppo-scelte.chiuso')) {
    const chips = gruppo.querySelector('.chips');
    gruppo.querySelector('.gruppo-freccia').hidden = chips.scrollHeight <= chips.clientHeight + 1;
  }
}

// Le pagine della barra in basso, ognuna col suo elemento e la sua funzione di disegno.
// Si ridisegna solo quella mostrata, perché la timeline ha le foto.
const PAGINE = {
  oggi: { elemento: 'pagina-oggi', disegna: disegnaOggi },
  diario: { elemento: 'timeline', disegna: disegnaTimeline },
  archivio: { elemento: 'pagina-archivio', disegna: disegnaArchivio },
  calendario: { elemento: 'pagina-calendario', disegna: disegnaCalendario },
  statistiche: { elemento: 'pagina-statistiche', disegna: disegnaStatistiche },
};
let paginaAttuale = 'oggi';

function disegnaPagina() {
  PAGINE[paginaAttuale].disegna();
}

function mostraPagina(pagina) {
  paginaAttuale = pagina;
  for (const [nome, { elemento }] of Object.entries(PAGINE)) {
    $(elemento).hidden = nome !== pagina;
    $('btn-pagina-' + nome).classList.toggle('attiva', nome === pagina);
  }
  $('filtri').hidden = pagina !== 'diario';
  $('btn-nuovo').hidden = pagina !== 'diario';
  disegnaPagina();
  // Il calendario parte dal fondo, dove c'è il mese corrente.
  window.scrollTo(0, pagina === 'calendario' ? document.documentElement.scrollHeight : 0);
}

function apriGiorno(data) {
  giornoMostrato = data === oggi() ? null : data;
  mostraPagina('oggi');
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
  $('pagina-statistiche').replaceChildren(...contenuto);
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
  $('pagina-calendario').replaceChildren(
    el('button', { type: 'button', className: 'btn-secondario', textContent: 'Mesi precedenti', onclick: altriMesi }),
    ...mesi,
  );
}

// Aggiunge mesi in cima senza far saltare la vista.
function altriMesi() {
  const pagina = document.documentElement;
  const dalFondo = pagina.scrollHeight - window.scrollY;
  mesiIndietro += MESI_IN_PIU;
  disegnaCalendario();
  window.scrollTo(0, pagina.scrollHeight - dalFondo);
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

// Un giorno con ricordi o scelte: lo mostra nella timeline. Un giorno vuoto: apre un ricordo nuovo per quel giorno.
function vaiAlGiorno(data) {
  const delGiorno = posts.filter((p) => p.data === data);
  mostraPagina('diario');
  if (!delGiorno.length && !giornataPiena(giornataDel(data))) {
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
// Archivio
//
// Le cose da ritrovare per tipo: libri, film, idee... Ogni voce è un ricordo
// come gli altri (data, testo, foto, tag; compare nel diario nel suo giorno)
// che in più ha `raccolta` e i `campi` di quella raccolta. Le raccolte stanno
// nel codice, che è pubblico: qui solo nomi generici, il contenuto resta nei dati.
// "Giorni belli" non è una raccolta: sono i giorni con la stella nella pagina Oggi.
// ---------------------------------------------------------------------------

// Tipi di campo: testo (senza tipo), 'data', 'voto' (da 1 a 9, come le scale di Oggi).
// Il primo campo di testo fa da titolo. Le raccolte con `foto` si mostrano a griglia, e
// il loro voto si può collegare a una scala di Oggi (vedi valoriDaArchivio).
const RACCOLTE = [
  { nome: 'Libri', campi: [{ nome: 'Titolo' }, { nome: 'Autore' }, { nome: 'Iniziato il', tipo: 'data' }, { nome: 'Giudizio', tipo: 'voto' }] },
  { nome: 'Film', campi: [{ nome: 'Titolo' }, { nome: 'Voto', tipo: 'voto' }] },
  { nome: 'Persone nuove', campi: [{ nome: 'Nome' }, { nome: 'Dove o come' }] },
  { nome: 'Conversazioni', campi: [{ nome: 'Con chi' }] },
  { nome: 'Idee', campi: [{ nome: 'Titolo' }, { nome: 'Sviluppo' }] },
  { nome: 'Fantasie', campi: [{ nome: 'Titolo' }] },
  { nome: 'Intuizioni', campi: [{ nome: 'Titolo' }] },
  { nome: 'Scoperte', campi: [{ nome: 'Titolo' }, { nome: 'Fonte' }] },
  { nome: 'Ragionamenti', campi: [{ nome: 'Titolo' }, { nome: 'Conclusione' }] },
  { nome: 'Outfit', foto: true, campi: [{ nome: 'Voto', tipo: 'voto' }, { nome: 'Occasione' }] },
  { nome: 'Scatti', foto: true, campi: [{ nome: 'Voto', tipo: 'voto' }] },
];
const GIORNI_BELLI = 'Giorni belli';

let raccoltaAperta = null; // la raccolta mostrata; null vuol dire l'elenco delle raccolte
let urlArchivio = []; // URL temporanei delle foto della griglia

const raccoltaChiamata = (nome) => RACCOLTE.find((r) => r.nome === nome);
const vociDi = (nome) => posts.filter((p) => p.raccolta === nome);
const dataBreve = (data) => new Date(data + 'T00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });

// Il primo voto della raccolta, se è stato dato
function votoDi(post) {
  const raccolta = raccoltaChiamata(post.raccolta);
  const campo = raccolta && raccolta.campi.find((c) => c.tipo === 'voto');
  return campo ? (post.campi || {})[campo.nome] : undefined;
}

function titoloDi(post) {
  const raccolta = raccoltaChiamata(post.raccolta);
  const campo = raccolta && raccolta.campi.find((c) => !c.tipo);
  return (campo && (post.campi || {})[campo.nome]) || post.testo.split('\n')[0] || dataLeggibile(post.data);
}

// "Il nome della rosa · Autore: Eco · Giudizio 8"; senza titolo per gli elenchi, dove il titolo è a parte.
function descrizioneCampi(post, conTitolo = true) {
  const raccolta = raccoltaChiamata(post.raccolta);
  const campi = post.campi || {};
  if (!raccolta) return Object.entries(campi).map(([nome, valore]) => `${nome}: ${valore}`).join(' · ');
  const titolo = raccolta.campi.find((c) => !c.tipo);
  return raccolta.campi.filter((c) => campi[c.nome] && (conTitolo || c !== titolo)).map((c) => {
    if (c.tipo === 'voto') return `${c.nome} ${campi[c.nome]}`;
    if (c.tipo === 'data') return `${c.nome} ${dataBreve(campi[c.nome])}`;
    return c === titolo ? campi[c.nome] : `${c.nome}: ${campi[c.nome]}`;
  }).join(' · ');
}

function apriRaccolta(nome) {
  raccoltaAperta = nome;
  mostraPagina('archivio');
}

function disegnaArchivio() {
  urlArchivio.forEach((u) => URL.revokeObjectURL(u));
  urlArchivio = [];
  if (raccoltaAperta) {
    disegnaRaccolta(raccoltaAperta);
    return;
  }
  const elenco = [[GIORNI_BELLI, giornate.filter((g) => g.stella).length], ...RACCOLTE.map((r) => [r.nome, vociDi(r.nome).length])];
  $('pagina-archivio').replaceChildren(...elenco.map(([nome, n]) => el('button', {
    className: 'raccolta',
    onclick: () => apriRaccolta(nome),
  }, el('span', { textContent: nome }), el('span', { className: 'raccolta-numero', textContent: n || '' }))));
}

function disegnaRaccolta(nome) {
  const raccolta = raccoltaChiamata(nome);
  const testa = el('div', { className: 'archivio-testa' },
    el('button', { type: 'button', className: 'btn-testo', textContent: '‹ Archivio', onclick: () => { raccoltaAperta = null; mostraPagina('archivio'); } }),
    el('h2', { textContent: nome }),
    raccolta ? el('button', { type: 'button', className: 'btn-testo', textContent: '+ Aggiungi', onclick: () => apriModulo(null, oggi(), nome) }) : el('span'));

  let voci;
  if (nome === GIORNI_BELLI) {
    voci = giornate.filter((g) => g.stella).sort((a, b) => b.data.localeCompare(a.data)).map((g) => {
      const ricordi = posts.filter((p) => p.data === g.data).length;
      return el('button', { className: 'voce-archivio', onclick: () => vaiAlGiorno(g.data) },
        el('strong', { textContent: dataLeggibile(g.data) }),
        el('span', { className: 'voce-archivio-info', textContent: [ricordi ? nRicordi(ricordi) : '', testoScelte(scelteDelGiorno(g.data))].filter(Boolean).join(' · ') }));
    });
  } else if (raccolta && raccolta.foto) {
    voci = [el('div', { className: 'griglia-archivio' }, ...vociDi(nome).map((post) => {
      const casella = el('button', { className: 'foto-archivio', onclick: () => apriModulo(post) });
      if (post.foto.length) {
        const url = URL.createObjectURL(post.foto[0]);
        urlArchivio.push(url);
        casella.append(el('img', { src: url, alt: '', loading: 'lazy' }));
      } else {
        casella.append(el('span', { className: 'foto-archivio-testo', textContent: titoloDi(post) }));
      }
      casella.append(el('span', { className: 'foto-archivio-info', textContent: [dataBreve(post.data), votoDi(post)].filter(Boolean).join(' · ') }));
      return casella;
    }))];
  } else {
    voci = vociDi(nome).map((post) => el('button', { className: 'voce-archivio', onclick: () => apriModulo(post) },
      el('strong', { textContent: titoloDi(post) }),
      el('span', { className: 'voce-archivio-info', textContent: [dataBreve(post.data), descrizioneCampi(post, false)].filter(Boolean).join(' · ') }),
      post.testo ? el('span', { className: 'voce-archivio-testo', textContent: post.testo }) : ''));
  }
  const vuota = !(nome === GIORNI_BELLI ? giornate.some((g) => g.stella) : vociDi(nome).length);
  $('pagina-archivio').replaceChildren(testa,
    vuota
      ? el('p', { className: 'vuoto', textContent: nome === GIORNI_BELLI ? 'Nessun giorno con la stella: si mette nella pagina Oggi, accanto alla data.' : 'Ancora niente. Tocca + Aggiungi.' })
      : '',
    ...voci,
    raccolta && raccolta.foto ? disegnaCollegamento(nome) : '');
}

// Quale scala di Oggi segna il voto di questa raccolta. Si sceglie qui perché le scale
// sono di chi usa il diario e non stanno nel codice.
function disegnaCollegamento(nome) {
  const collegamenti = (impostazioniGruppi && impostazioniGruppi.collegamenti) || {};
  const scale = gruppiAttuali().filter((g) => g.tipo === 'scala').flatMap((g) => g.opzioni.map((voce) => ({ gruppo: g.nome, voce })));
  const chiave = (c) => (c ? c.gruppo + '\n' + c.voce : '');
  const scelta = el('select', {
    onchange: (e) => {
      const nuovi = { ...collegamenti };
      const collegata = scale.find((s) => chiave(s) === e.target.value);
      if (collegata) nuovi[nome] = collegata;
      else delete nuovi[nome];
      salvaImpostazioni({ collegamenti: nuovi });
    },
  }, el('option', { value: '', textContent: 'Nessuna' }), ...scale.map((s) => el('option', { value: chiave(s), textContent: `${s.gruppo} · ${s.voce}` })));
  scelta.value = chiave(collegamenti[nome]);
  return el('label', { className: 'collegamento' }, 'Il voto segna in Oggi la scala', scelta);
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
  const qui = [...posts, ...eliminati, ...recordDellaGiornata()];
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

const BACKUP_VERSIONE = 6; // la 1 non aveva l'ora nei post, la 2 né l'umore né le giornate, la 3 né scelte né gruppi, la 4 né scale né conteggi, la 5 né archivio né stelle
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
  const elenco = [...posts, ...recordDellaGiornata()].map((p) => {
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
  if (ricordo.tipo) return ricordo;
  const foto = [];
  for (const nome of ricordo.foto) {
    foto.push(new File([await leggiFoto(nome)], nome.split('/').pop(), { type: 'image/jpeg' }));
  }
  return { ...ricordo, ora: ricordo.ora || '', umore: ricordo.umore || '', foto };
}

// Aggiunge i ricordi che mancano; se uno esiste già (anche eliminato) vince la versione
// modificata più di recente.
async function unisci(ricordi, leggiFoto) {
  const esistenti = new Map([...posts, ...eliminati, ...recordDellaGiornata()].map((p) => [p.id, p]));
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
$('btn-pagina-oggi').onclick = () => { giornoMostrato = null; mostraPagina('oggi'); };
$('btn-pagina-diario').onclick = () => mostraPagina('diario');
// Toccare Archivio mentre si è dentro una raccolta riporta all'elenco delle raccolte.
$('btn-pagina-archivio').onclick = () => { if (paginaAttuale === 'archivio') raccoltaAperta = null; mostraPagina('archivio'); };
$('btn-pagina-calendario').onclick = () => mostraPagina('calendario');
$('btn-pagina-statistiche').onclick = () => mostraPagina('statistiche');
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

$('campo-raccolta').onchange = (e) => {
  formRaccolta = e.target.value;
  disegnaRaccoltaModulo();
};

$('dlg-foto').onclick = () => $('dlg-foto').close();

function mostraErrore(err) {
  console.error(err);
  alert('Qualcosa è andato storto: ' + (err && err.message ? err.message : err));
}

// Chiede al browser di non cancellare i dati del diario quando lo spazio scarseggia.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// Permette di aprire il diario senza rete. Esiste solo su HTTPS e su localhost.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);

mostraPagina('oggi');
ricarica().catch(mostraErrore);
