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
    ...RACCOLTE.map((r) => el('option', { value: r.nome, textContent: conIcona(r.nome) })),
  );
  $('campo-raccolta').value = formRaccolta;
  const raccolta = raccoltaChiamata(formRaccolta);
  $('campi-raccolta').replaceChildren(...(raccolta ? raccolta.campi : []).map((campo) => {
    if (campo.tipo === 'voto') {
      const cambia = (n) => {
        formCampi[campo.nome] = n;
        disegnaRaccoltaModulo();
      };
      return creaVoto({ nome: campo.nome, valore: formCampi[campo.nome], parole: SCALA.map(() => ''), scegli: cambia, togli: () => cambia(undefined) });
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
// La seconda pagina, dopo la Home: per un giorno, le opzioni di ogni gruppo (Umore, Dormito...)
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
// Ogni gruppo di voti ha la sua scala: `minimo` e `massimo` (da 1 a 9 se non ci sono) e, se
// lo si sceglie, `normale`, il numero che vuol dire "come al solito" (la Libido da -1 a 2,
// normale 0). Senza normale la scala è dritta: il minimo vale 1, il massimo 9 e il resto in
// proporzione (da 1 a 4: 1 → 1, 2 → 3,7, 3 → 6,3, 4 → 9); "come al solito" è il numero di
// mezzo, se c'è (sulle scale pari no). Anche un oggetto con questi campi fa da scala (SCALA_BASE).
const SCALA_BASE = { minimo: 1, massimo: 9 };
const CASELLE_MAX = 11; // quante caselle stanno in una riga del telefono
const minimoDi = (scala) => scala.minimo ?? 1;
const massimoDi = (scala) => scala.massimo ?? 9;
const conNormale = (scala) => scala.normale !== undefined && scala.normale !== null;
// undefined se la scala non ce l'ha
function normaleDi(scala) {
  if (conNormale(scala)) return scala.normale;
  const mezzo = (minimoDi(scala) + massimoDi(scala)) / 2;
  return Number.isInteger(mezzo) ? mezzo : undefined;
}
const scalaDi = (scala) => Array.from({ length: massimoDi(scala) - minimoDi(scala) + 1 }, (_, i) => minimoDi(scala) + i);
const eScalaBase = (scala) => minimoDi(scala) === 1 && massimoDi(scala) === 9 && normaleDi(scala) === 5;
// "−1", "+2" sulle scale che vanno sotto lo zero; altrimenti il numero com'è.
const scriviSuScala = (n, scala) => (minimoDi(scala) < 0 && n > 0 ? '+' : '') + numeroLeggibile(Math.round(n * 10) / 10).replace('-', '−');
const descriviScala = (scala) => `da ${scriviSuScala(minimoDi(scala), scala)} a ${scriviSuScala(massimoDi(scala), scala)}`
  + (conNormale(scala) ? `, normale ${scriviSuScala(scala.normale, scala)}` : '');

// Un voto riportato da 1 a 9, per benessere e colori: il minimo vale 1 e il massimo 9. Con un
// normale scelto, quello vale 5 e il resto va in proporzione da ciascuna parte (Libido: -1 → 1,
// 0 → 5, 1 → 7, 2 → 9); senza, in proporzione su tutta la scala.
function suNove(n, scala) {
  const [min, max] = [minimoDi(scala), massimoDi(scala)];
  if (!conNormale(scala)) return Math.min(9, Math.max(1, 1 + ((n - min) * 8) / (max - min)));
  const normale = scala.normale;
  const v = n <= normale
    ? (normale === min ? 5 : 1 + ((n - min) * 4) / (normale - min))
    : (normale === max ? 5 : 5 + ((n - normale) * 4) / (max - normale));
  return Math.min(9, Math.max(1, v));
}
// Al contrario: da 1–9 a un numero intero della scala (per i voti dell'archivio e per cambiare scala).
function daNove(v, scala) {
  const [min, max] = [minimoDi(scala), massimoDi(scala)];
  let n;
  if (!conNormale(scala)) n = min + ((v - 1) * (max - min)) / 8;
  else n = v <= 5 ? min + ((v - 1) * (scala.normale - min)) / 4 : scala.normale + ((v - 5) * (max - scala.normale)) / 4;
  return Math.min(max, Math.max(min, Math.round(n)));
}
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
  const genitore = genitoreDi(gruppo);
  if (genitore) return sezioneDi(genitore);
  const sezioni = sezioniAttuali();
  if (sezioni.includes(gruppo.sezione)) return gruppo.sezione;
  const proposta = gruppo.nome === GRUPPO_UMORE || (gruppo.tipo === 'scala' && gruppo.nome !== 'Sonno') ? 'Salute mentale'
    : gruppo.tipo === 'conteggio' || ['Sonno', 'Dormito', 'Attività fisica'].includes(gruppo.nome) ? 'Salute fisica'
    : gruppo.nome === 'Hobby' ? 'Attività'
    : SEZIONE_ALTRO;
  return sezioni.includes(proposta) ? proposta : SEZIONE_ALTRO;
}

// Un gruppo può stare dentro un altro (`dentro`: il suo nome), per esempio dei conteggi dentro
// Vizi: si vede nel riquadro dell'altro, ma nei dati resta un gruppo a sé. Un livello solo: se
// l'altro non c'è più, o sta a sua volta dentro un gruppo, torna a stare da solo.
function genitoreDi(gruppo) {
  if (!gruppo.dentro || gruppo.dentro === gruppo.nome) return null;
  return gruppiAttuali().find((g) => g.nome === gruppo.dentro && !g.dentro) || null;
}

// Il gruppo Umore si chiama così nei dati (ci sono legati i ricordi), ma si mostra così.
const nomeMostrato = (gruppo) => (gruppo.nome === GRUPPO_UMORE ? 'Umore generale' : gruppo.nome);

// Ogni cosa può avere un'icona (un'emoji): sezioni, gruppi, opzioni, voci, raccolte.
// Qui ci sono solo quelle delle cose di base; le altre si scelgono in Modifica e stanno
// nelle impostazioni (`icone`, per nome in minuscolo), come i gruppi personali.
const ICONE_DI_BASE = Object.fromEntries(Object.entries({
  'Salute mentale': '🧠', 'Salute fisica': '💪', Attività: '🎨', Altro: '📌',
  Umore: '🙂', 'Attività fisica': '🏃', Hobby: '🎨', 'Come sto': '🌤️', Sonno: '😴',
  Felicità: '😊', 'Soddisfazione di oggi': '✅', Serenità: '🕊️', Energia: '⚡',
  Motivazione: '🚀', Connessione: '🤝', Realizzazione: '🏆', 'Ore dormite': '🛏️', Riposo: '🔋',
  Niente: '➖', Palestra: '🏋️', Calisthenics: '🤸', Musical: '🎭', Uncinetto: '🧶', Tromba: '🎺', Leggere: '📚',
  Felice: '😄', Sereno: '😌', Entusiasta: '🤩', Grato: '🙏', Innamorato: '😍', Nostalgico: '🥲',
  Annoiato: '😐', Ansioso: '😰', Triste: '😢', Arrabbiato: '😠',
  Libri: '📚', Film: '🎬', 'Persone nuove': '👋', Conversazioni: '💬', Idee: '💡', Fantasie: '🌈',
  Intuizioni: '✨', Scoperte: '🔍', Ragionamenti: '🧩', Outfit: '👕', Scatti: '📷', 'Giorni belli': '⭐',
}).map(([nome, icona]) => [nome.toLowerCase(), icona]));

// L'icona scelta vale più di quella di base; una scelta vuota vuol dire nessuna icona.
function iconaDi(nome) {
  const scelte = (impostazioniGruppi && impostazioniGruppi.icone) || {};
  const chiave = nome.toLowerCase();
  return chiave in scelte ? scelte[chiave] : ICONE_DI_BASE[chiave] || '';
}
const conIcona = (nome, mostrato = nome) => (iconaDi(nome) ? iconaDi(nome) + ' ' + mostrato : mostrato);

function cambiaIcona(nome) {
  const scritta = prompt(`Icona per ${nome} (un'emoji; vuoto per nessuna)`, iconaDi(nome));
  if (scritta === null) return;
  const icone = { ...((impostazioniGruppi && impostazioniGruppi.icone) || {}), [nome.toLowerCase()]: scritta.trim() };
  salvaImpostazioni({ icone });
}

// In Modifica, davanti a ogni nome: mostra l'icona e toccandolo la si cambia.
const pulsanteIcona = (nome) => el('button', {
  type: 'button',
  className: 'btn-icona' + (iconaDi(nome) ? '' : ' senza'),
  textContent: iconaDi(nome) || '+',
  ariaLabel: 'Icona di ' + nome,
  onclick: (e) => { e.stopPropagation(); cambiaIcona(nome); },
});
// Un titolo (sezione, gruppo, voce) con la sua icona; in Modifica l'icona si può cambiare.
const titoloConIcona = (tag, nome, mostrato = nome, props = {}) => (modificaGruppi
  ? el(tag, props, pulsanteIcona(nome), mostrato)
  : el(tag, { ...props, textContent: conIcona(nome, mostrato) }));
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
    const g = gruppoChiamato(gruppo, scelte[gruppo]);
    scelte[gruppo] = { ...valoriDi(g, scelte[gruppo]) };
    for (const [voce, post] of daArchivio) scelte[gruppo][voce] = daNove(votoDi(post), g);
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

// cambi: { gruppi }, { sezioni }, { icone } o { collegamenti }; il resto delle impostazioni resta com'è.
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
// dentro: il nome del gruppo in cui sta il nuovo (facoltativo)
function nuovoGruppo(tipo, dentro) {
  const nome = chiediNome(tipo === 'scala' ? 'Nome del nuovo gruppo di voti da 1 a 9' : tipo === 'conteggio' ? 'Cosa vuoi contare?' : 'Nome del nuovo gruppo');
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
  salvaGruppi([...gruppiAttuali(), { ...(tipo ? { nome, tipo, opzioni, estremi: {} } : { nome, opzioni }), ...(dentro ? { dentro } : {}) }]);
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

// In Modifica ogni gruppo ha gli stessi pulsanti per aggiungere: un'opzione, un voto, un numero,
// un conteggio. Se è del tipo del gruppo diventa una sua voce; altrimenti nasce un gruppo nuovo
// che sta dentro questo (o dentro il suo, se questo sta già dentro un altro).
//   cosa: 'opzione', 'voto', 'numero' o 'conteggio'
function aggiungiDentro(gruppo, cosa) {
  const tipo = { opzione: undefined, voto: 'scala', numero: 'scala', conteggio: 'conteggio' }[cosa];
  if (cosa === 'opzione' && !gruppo.tipo) return aggiungiOpzioneAlGruppo(gruppo.nome);
  if (cosa !== 'opzione' && gruppo.tipo === tipo) return aggiungiVoce(gruppo, cosa === 'numero');
  const dentro = (genitoreDi(gruppo) || gruppo).nome;
  if (cosa === 'opzione') return nuovoGruppo(undefined, dentro);
  const nome = chiediNome({
    voto: `Cosa votare in ${gruppo.nome}?`,
    numero: `Che numero scrivere in ${gruppo.nome}? (per esempio Ore dormite)`,
    conteggio: `Cosa contare in ${gruppo.nome}?`,
  }[cosa]);
  if (!nome) return;
  if (gruppiAttuali().some((g) => stessoNome(g.nome, nome))) {
    alert(`C'è già un gruppo che si chiama ${nome}.`);
    return;
  }
  salvaGruppi([...gruppiAttuali(), { nome, tipo, opzioni: [nome], ...(cosa === 'numero' ? { numeri: [nome] } : {}), dentro }]);
}

// Un'opzione nuova nel gruppo, senza segnarla in nessun giorno (in Modifica).
function aggiungiOpzioneAlGruppo(nomeGruppo) {
  const nome = chiediNome(`Nuova opzione per ${nomeGruppo}`);
  if (!nome) return;
  cambiaGruppo(nomeGruppo, (g) => (g.opzioni.some((o) => stessoNome(o, nome)) ? g : { ...g, opzioni: [...g.opzioni, nome] }));
}

// Le parole dei 9 punti di uno slider ('' dove non c'è). I gruppi fatti prima delle parole
// avevano solo `estremi`, cioè le parole di 1 e di 9.
function paroleDi(gruppo, voce) {
  const parole = (gruppo.parole || {})[voce];
  const quante = scalaDi(gruppo).length;
  if (parole) return Array.from({ length: quante }, (_, i) => parole[i] || '');
  const [basso, alto] = (gruppo.estremi || {})[voce] || [];
  return Array.from({ length: quante }, (_, i) => (i === 0 ? basso || '' : i === quante - 1 ? alto || '' : ''));
}

// Si scrivono tutte insieme separate da /, dove i punti senza parola restano vuoti:
// "Distrutto / / / / Normale / / / / Riposatissimo". Con due parole sole sono 1 e 9.
function cambiaParole(nomeGruppo, voce) {
  const gruppo = gruppiAttuali().find((g) => g.nome === nomeGruppo);
  const numeri = scalaDi(gruppo).map((n) => scriviSuScala(n, gruppo));
  const quante = numeri.length;
  const scritte = prompt(`${voce}: le parole per ${numeri.join(', ')}, separate da /. Con due parole sole valgono per ${numeri[0]} e ${numeri[quante - 1]}.`, paroleDi(gruppo, voce).join(' / '));
  if (scritte === null) return;
  let pezzi = scritte.split('/').map((p) => p.trim());
  if (pezzi.length === 2) pezzi = Array.from({ length: quante }, (_, i) => (i === 0 ? pezzi[0] : i === quante - 1 ? pezzi[1] : ''));
  const parole = Array.from({ length: quante }, (_, i) => pezzi[i] || '');
  cambiaGruppo(nomeGruppo, (g) => ({ ...g, parole: { ...g.parole, [voce]: parole } }));
}

// Un gruppo a scelte diventa uno slider o un conteggio col suo nome. I giorni già segnati non
// vengono riscritti: in un conteggio valgono 1, in uno slider resta scritto cosa si era scelto.
function converti(nomeGruppo, tipo) {
  const avviso = tipo === 'conteggio'
    ? `${nomeGruppo} diventa un numero da contare. Le sue opzioni spariscono e nei giorni già segnati vale 1, da correggere a mano.`
    : `${nomeGruppo} diventa un voto da 1 a 9. Le sue opzioni spariscono; nei giorni già segnati resta scritto cosa avevi scelto, finché non scegli un numero.`;
  if (!confirm(avviso)) return;
  cambiaGruppo(nomeGruppo, (g) => ({ nome: g.nome, tipo, opzioni: [g.nome], ...(g.sezione ? { sezione: g.sezione } : {}), ...(g.dentro ? { dentro: g.dentro } : {}) }));
}

// Un gruppo di voti passa a un'altra scala: si scrive "da, a, normale" (per esempio -1, 2, 0).
// I voti già segnati vengono portati sulla nuova in proporzione, passando dalla scala 1–9
// (il minimo resta minimo, il normale normale, il massimo massimo), e i giorni riscritti, così
// il cambio arriva anche al Drive. Delle parole dei punti restano quelle degli estremi.
async function cambiaScala(nomeGruppo) {
  const gruppo = gruppiAttuali().find((g) => g.nome === nomeGruppo);
  const attuale = [minimoDi(gruppo), massimoDi(gruppo), ...(conNormale(gruppo) ? [gruppo.normale] : [])].join(', ');
  const scritta = prompt(`Scala di ${nomeGruppo}: da, a e, se vuoi, il normale (il numero che vuol dire "come al solito"). Per esempio: 1, 4 oppure -1, 2, 0`, attuale);
  if (scritta === null) return;
  const numeri = scritta.replace(/−/g, '-').split(/[,;\s]+/).filter(Boolean).map(Number);
  const [minimo, massimo, normale] = numeri;
  if (numeri.length < 2 || numeri.length > 3 || !numeri.every(Number.isInteger) || minimo >= massimo
    || (normale !== undefined && (normale < minimo || normale > massimo)) || massimo - minimo + 1 > CASELLE_MAX) {
    alert(`Scrivi due o tre numeri interi: da, a e se vuoi il normale, con "da" più piccolo di "a", il normale in mezzo e al massimo ${CASELLE_MAX} numeri in tutto.`);
    return;
  }
  const dopo = { ...gruppo, minimo, massimo, normale: normale ?? null };
  if (descriviScala(dopo) === descriviScala(gruppo)) return;
  const eVoto = (voce) => !eNumero(gruppo, voce);
  const giorni = giornate.filter((g) => {
    const v = g.scelte[nomeGruppo];
    return v && !Array.isArray(v) && Object.keys(v).some(eVoto);
  });
  const converti = (n) => daNove(suNove(n, gruppo), dopo);
  const esempi = [...new Set([minimoDi(gruppo), normaleDi(gruppo), massimoDi(gruppo)])].filter((n) => n !== undefined)
    .map((n) => `${scriviSuScala(n, gruppo)} diventa ${scriviSuScala(converti(n), dopo)}`).join(', ');
  if (giorni.length && !confirm(`${nomeGruppo} passa alla scala ${descriviScala(dopo)}. I voti già segnati (${giorni.length === 1 ? '1 giorno' : giorni.length + ' giorni'}) vengono convertiti in proporzione: ${esempi}. Se vuoi poter tornare indietro, fai prima un backup.`)) return;
  const parole = Object.fromEntries(gruppo.opzioni.filter(eVoto).map((voce) => {
    const vecchie = paroleDi(gruppo, voce);
    const quante = scalaDi(dopo).length;
    return [voce, Array.from({ length: quante }, (_, i) => (i === 0 ? vecchie[0] : i === quante - 1 ? vecchie[vecchie.length - 1] : ''))];
  }));
  cambiaGruppo(nomeGruppo, (g) => ({ ...g, minimo, massimo, normale: normale ?? null, parole: { ...g.parole, ...parole } }));
  const adesso = Date.now();
  for (const g of giorni) {
    const valori = Object.fromEntries(Object.entries(g.scelte[nomeGruppo])
      .map(([voce, n]) => [voce, eVoto(voce) ? converti(n) : n]));
    await salvaPost({ ...g, scelte: { ...g.scelte, [nomeGruppo]: valori }, modificato: adesso });
  }
  if (giorni.length) await ricarica();
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
  // Dove sta: in una sezione, o dentro un altro gruppo (uno che non sta già dentro un altro,
  // e solo se questo non ne contiene a sua volta).
  const haDentro = gruppiAttuali().some((g) => g.dentro === gruppo.nome);
  const ospiti = haDentro ? [] : gruppiAttuali().filter((g) => g.nome !== gruppo.nome && !genitoreDi(g));
  const sezione = el('select', {
    ariaLabel: 'Dove sta',
    onchange: (e) => {
      const [tipo, nome] = [e.target.value[0], e.target.value.slice(2)];
      cambiaGruppo(gruppo.nome, ({ dentro, ...g }) => (tipo === 'g' ? { ...g, dentro: nome } : { ...g, sezione: nome }));
    },
  }, ...[...sezioniAttuali(), SEZIONE_ALTRO].map((s) => el('option', { value: 's:' + s, textContent: 'In ' + s })),
  ...ospiti.map((g) => el('option', { value: 'g:' + g.nome, textContent: 'Dentro ' + nomeMostrato(g) })));
  const genitore = genitoreDi(gruppo);
  sezione.value = genitore ? 'g:' + genitore.nome : 's:' + sezioneDi(gruppo);
  const pulsante = (testo, azione) => el('button', { type: 'button', className: 'btn-testo', textContent: testo, onclick: azione });
  const aScelte = !gruppo.tipo && gruppo.nome !== GRUPPO_UMORE;
  const scala = pulsante('Scala: ' + descriviScala(gruppo), () => cambiaScala(gruppo.nome).catch(mostraErrore));
  return el('div', { className: 'gruppo-comandi' },
    inElenco ? sezione : '',
    inElenco && gruppo.tipo === 'scala' && gruppo.opzioni.some((v) => !eNumero(gruppo, v)) ? scala : '',
    aScelte ? pulsante('Diventa voto 1–9', () => converti(gruppo.nome, 'scala')) : '',
    aScelte ? pulsante('Diventa conteggio', () => converti(gruppo.nome, 'conteggio')) : '',
    !gruppo.tipo && inElenco ? pulsante('Unisci opzioni', () => unisciOpzioni(gruppo.nome)) : '',
    pulsante('Togli gruppo', () => togliGruppo(gruppo.nome)));
}

// Fuori da Modifica ogni gruppo ha un "+" per aggiungere al volo una cosa del suo tipo: nei gruppi
// a scelte sta tra le opzioni (disegnaScelte, e l'opzione nuova si segna subito), negli altri qui
// sotto: un voto, un conteggio, o un numero se il gruppo ha solo numeri (Ore dormite).
function disegnaAggiungiAlVolo(gruppo) {
  if (!gruppo.tipo || !gruppiAttuali().some((g) => g.nome === gruppo.nome)) return '';
  const cosa = gruppo.tipo === 'conteggio' ? 'conteggio' : gruppo.opzioni.every((v) => eNumero(gruppo, v)) ? 'numero' : 'voto';
  return el('div', { className: 'chips gruppo-aggiungi' },
    el('button', { type: 'button', className: 'chip chip-aggiungi', textContent: '+', ariaLabel: 'Aggiungi a ' + gruppo.nome, onclick: () => aggiungiDentro(gruppo, cosa) }));
}

// In Modifica, in fondo a ogni gruppo: gli stessi pulsanti per tutti (vedi aggiungiDentro).
function disegnaAggiungi(gruppo) {
  if (!gruppiAttuali().some((g) => g.nome === gruppo.nome) || gruppo.nome === GRUPPO_UMORE) return '';
  const aggiungi = (testo, cosa) => el('button', { type: 'button', className: 'chip chip-aggiungi', textContent: testo, onclick: () => aggiungiDentro(gruppo, cosa) });
  return el('div', { className: 'chips gruppo-aggiungi' },
    aggiungi('+ Opzione', 'opzione'), aggiungi('+ Voto', 'voto'), aggiungi('+ Numero', 'numero'), aggiungi('+ Conteggio', 'conteggio'));
}

// figli: i gruppi che stanno dentro questo, disegnati nel suo riquadro dopo le sue voci.
function disegnaGruppo(data, gruppo, scelte, figli = []) {
  // Le scelte da chiuse stanno su una riga; slider e conteggi sono sempre aperti (li chiude la sezione).
  const aperto = modificaGruppi || gruppiAperti.has(gruppo.nome) || !!gruppo.tipo;
  const freccia = el('button', { type: 'button', className: 'btn-testo gruppo-freccia', textContent: aperto ? '▴' : '▾', ariaLabel: 'Mostra o nascondi le opzioni', onclick: () => apriOChiudi(gruppiAperti, gruppo.nome) });
  // Un gruppo con una voce sola che si chiama come lui (Libido, Alcool) non ripete il nome: basta la riga.
  const soloSlider = !modificaGruppi && !!gruppo.tipo && gruppo.opzioni.length === 1 && gruppo.opzioni[0] === gruppo.nome;
  const testa = soloSlider ? '' : el('div', { className: 'gruppo-testa' }, titoloConIcona('h3', gruppo.nome, nomeMostrato(gruppo)));
  if (!modificaGruppi && !gruppo.tipo) testa.append(freccia);
  const contenuto = gruppo.tipo === 'scala' ? disegnaScale(data, gruppo, scelte)
    : gruppo.tipo === 'conteggio' ? disegnaConteggi(data, gruppo, scelte)
    : disegnaScelte(data, gruppo, scelte, aperto);
  const corpo = corpoDelGruppo(data, gruppo, scelte, figli, contenuto, !!testa);
  return el('div', {
    className: `gruppo gruppo-${gruppo.tipo || 'scelte'}${aperto ? '' : ' chiuso'}`,
    // Toccare il gruppo fuori dai pulsanti fa lo stesso della freccia.
    onclick: (e) => {
      if (!modificaGruppi && freccia.isConnected && !freccia.hidden && !e.target.closest('button')
        && e.target.closest('.gruppo') === e.currentTarget) apriOChiudi(gruppiAperti, gruppo.nome);
    },
  }, testa, corpo);
}

// Quello che sta sotto il nome di un gruppo ha a sinistra una linea che lo lega al nome (vedi
// .gruppo-corpo); un gruppo senza nome (una voce sola, che si chiama come lui) non ce l'ha.
function corpoDelGruppo(data, gruppo, scelte, figli, contenuto, conNome) {
  return el('div', { className: 'gruppo-corpo' + (conNome ? ' con-nome' : '') },
    modificaGruppi ? disegnaComandiGruppo(gruppo) : '', contenuto,
    modificaGruppi ? disegnaAggiungi(gruppo) : disegnaAggiungiAlVolo(gruppo),
    figli.length ? el('div', { className: 'gruppo-dentro' }, ...figli.map((f) => disegnaGruppo(data, f, scelte))) : '');
}

function disegnaScelte(data, gruppo, scelte, aperto) {
  const collegate = scelteDaRicordi(data).get(gruppo.nome) || new Map();
  const scelteQui = [...new Set([...collegate.keys(), ...(scelte[gruppo.nome] || [])])];
  // Da chiuso si vede una riga sola: le opzioni scelte stanno davanti, così restano visibili.
  const opzioni = aperto
    ? [...new Set([...gruppo.opzioni, ...scelteQui])]
    : [...new Set([...scelteQui, ...gruppo.opzioni])];
  // In Modifica ogni opzione ha due pulsanti: l'icona, da cambiare, e il nome con ×, per toglierla.
  return el('div', { className: 'chips' },
    ...opzioni.map((o) => (modificaGruppi
      ? el('span', { className: 'chip chip-modifica' },
        pulsanteIcona(o),
        el('button', { type: 'button', textContent: o + ' ×', ariaLabel: 'Togli ' + o, onclick: () => togliOpzione(gruppo.nome, o) }))
      : el('button', {
        type: 'button',
        className: 'chip' + (scelteQui.includes(o) ? ' attivo' : '') + (collegate.has(o) ? ' collegato' : ''),
        textContent: conIcona(o) + (collegate.has(o) ? ' ↗' : ''),
        onclick: () => {
          if (collegate.has(o)) apriRicordiCollegati(data, collegate.get(o));
          else cambiaScelta(data, gruppo.nome, o);
        },
      }))),
    modificaGruppi ? '' : el('button', { type: 'button', className: 'chip chip-aggiungi', textContent: '+', ariaLabel: 'Nuova opzione', onclick: () => aggiungiOpzione(data, gruppo.nome) }),
  );
}

// In Modifica: le voci di un gruppo di slider o di conteggi, da togliere o aggiungere.
function disegnaVociInModifica(gruppo) {
  return el('div', { className: 'voci' },
    ...gruppo.opzioni.map((voce) => el('div', { className: 'voce' },
      titoloConIcona('span', voce, voce + (eNumero(gruppo, voce) ? ' (numero)' : ''), { className: 'voce-nome' }),
      gruppo.tipo === 'scala' && !eNumero(gruppo, voce)
        ? el('button', { type: 'button', className: 'btn-testo', textContent: 'Parole', ariaLabel: 'Le parole dei punti da 1 a 9', onclick: () => cambiaParole(gruppo.nome, voce) })
        : '',
      el('button', { type: 'button', className: 'btn-testo', textContent: '×', ariaLabel: 'Togli', onclick: () => togliOpzione(gruppo.nome, voce) }))),
  );
}

// Un voto da 1 a 9: sopra il nome e il numero scelto, sotto nove caselle colorate dal rosso
// (1) al verde (9). Toccare una casella la sceglie, toccare quella scelta la toglie; il numero
// scelto prende il colore della sua casella. Finché non si tocca niente non è segnato (non
// vale 5). Serve in Oggi e nei voti dell'archivio.
//   parole: le parole dei numeri, in ordine ('' dove non c'è): quella scelta compare accanto al nome
//   scegli(n), togli(): chiamate al tocco
//   apri(): se c'è, il valore non si cambia qui (viene dall'archivio, da `da`) e toccare apre
//   scala: { minimo, massimo, normale } (da 1 a 9 se non si dice); la casella del normale è segnata
function creaVoto({ nome, valore, parole, scegli, togli, apri, da = '', scala = SCALA_BASE }) {
  const segnato = valore !== undefined && valore !== null; // 0 è un voto vero
  const numeri = scalaDi(scala);
  const dettaglio = apri ? 'da ' + da : (segnato && parole[valore - minimoDi(scala)]) || '';
  return el('div', { className: 'voto' },
    el('div', { className: 'voto-nome' },
      el('span', { textContent: nome }),
      dettaglio ? el('span', { className: 'voto-parola', textContent: dettaglio }) : ''),
    segnato
      ? el('span', { className: 'voto-valore tinta', style: `--n: ${suNove(valore, scala)}`, textContent: scriviSuScala(valore, scala) + (apri ? ' ↗' : '') })
      : el('span'),
    el('div', { className: 'voto-caselle', style: `--caselle: ${numeri.length}` }, ...numeri.map((n) => el('button', {
      type: 'button',
      className: 'voto-casella tinta' + (n === valore ? ' scelta' : '') + (conNormale(scala) && n === scala.normale ? ' normale' : ''),
      style: `--n: ${suNove(n, scala)}`,
      textContent: scriviSuScala(n, scala),
      ariaLabel: `${nome}: ${n}`,
      onclick: apri || (() => (n === valore ? togli() : scegli(n))),
    }))),
    parole[0] || parole[numeri.length - 1]
      ? el('div', { className: 'scala-estremi' }, el('span', { textContent: parole[0] }), el('span', { textContent: parole[numeri.length - 1] }))
      : '');
}

function disegnaVoto(data, gruppo, voce, valore, post) {
  return creaVoto({
    nome: conIcona(voce),
    valore,
    parole: paroleDi(gruppo, voce),
    scala: gruppo,
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
    el('span', { className: 'voce-nome', textContent: conIcona(voce) }),
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
  for (const [voce, post] of daArchivio) valori[voce] = daNove(votoDi(post), gruppo);
  const voci = [...new Set([...gruppo.opzioni, ...Object.keys(valori)])];
  const voti = voci.filter((v) => !eNumero(gruppo, v));
  const vuoti = voti.filter((v) => !(v in valori));
  return el('div', { className: 'voci' },
    // Un gruppo appena diventato slider: nei giorni di prima resta cosa si era scelto.
    Array.isArray(segnato) && segnato.length ? el('p', { className: 'nota', textContent: 'Segnato prima: ' + segnato.join(', ') }) : '',
    ...voci.map((v) => (eNumero(gruppo, v)
      ? disegnaCasella(data, gruppo, v, valori[v])
      : disegnaVoto(data, gruppo, v, valori[v], daArchivio.get(v)))),
    vuoti.length && voti.length > 1 && normaleDi(gruppo) !== undefined
      ? el('button', {
        type: 'button',
        className: 'btn-secondario btn-come-al-solito',
        textContent: `${vuoti.length === voti.length ? 'Tutto' : 'Gli altri'} come al solito (${scriviSuScala(normaleDi(gruppo), gruppo)})`,
        onclick: () => cambiaValori(data, gruppo, Object.fromEntries(vuoti.map((v) => [v, normaleDi(gruppo)]))),
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
      el('span', { className: 'voce-nome', textContent: conIcona(v) }),
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
    titoloConIcona('h2', nome),
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
      ? gruppiSezione.filter((g) => !genitoreDi(g))
        .map((g) => disegnaGruppo(data, g, scelte, gruppiSezione.filter((f) => genitoreDi(f) && genitoreDi(f).nome === g.nome)))
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
          el('button', { type: 'button', className: 'btn-secondario', textContent: '+ Nuovi voti 1–9', onclick: () => nuovoGruppo('scala') }),
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
    const chips = gruppo.querySelector(':scope > .gruppo-corpo > .chips');
    gruppo.querySelector(':scope > .gruppo-testa > .gruppo-freccia').hidden = chips.scrollHeight <= chips.clientHeight + 1;
  }
}

// ---------------------------------------------------------------------------
// Home
//
// La pagina che si apre per prima. Mostra un periodo che finisce ieri (oggi è ancora da
// riempire): gli ultimi 7 giorni, e con un tocco gli ultimi 30 o l'anno; i riquadri restano
// gli stessi. In cima il benessere (la media pesata di tutti i voti del giorno, vedi
// benessereDi) con le sue colonne e, sotto, le righe dei gruppi che lo compongono; poi un
// riquadro per ogni gruppo messo "a sé"; in fondo ricordi e giorni registrati. Dove sta ogni
// gruppo si sceglie in Impostazioni (postoInHome). Regola: un riquadro c'è se risponde a una
// domanda vera ("quanto mi muovo?"), quindi mai "in quanti giorni ho segnato X".
// ---------------------------------------------------------------------------

const NIENTE = 'Niente'; // un'opzione che vuol dire "non l'ho fatto": non conta come fatta

const media = (numeri) => numeri.reduce((a, b) => a + b, 0) / numeri.length;
const arrotonda = (n) => Math.round(n * 10) / 10;

// Le date da `da` ad `a` comprese, 'AAAA-MM-GG'
function giorniTra(da, a) {
  const giorni = [];
  for (const d = new Date(da + 'T00:00'); ; d.setDate(d.getDate() + 1)) {
    const data = dataDa(d.getFullYear(), d.getMonth(), d.getDate());
    if (data > a) return giorni;
    giorni.push(data);
  }
}

function giornoPrima(data) {
  const d = new Date(data + 'T00:00');
  d.setDate(d.getDate() - 1);
  return dataDa(d.getFullYear(), d.getMonth(), d.getDate());
}

// Quello che è segnato in un giorno, messo in ordine per la Home:
//   umori: ['Sereno'], fatte: [[gruppo, opzione]], voti: [[gruppo, [[voce, voto]]]],
//   numeri: [[voce, numero]], conteggi: [[gruppo, totale]]
function riassuntoDelGiorno(data) {
  const scelte = scelteDelGiorno(data);
  const nomi = [...gruppiAttuali().map((g) => g.nome).filter((n) => n in scelte), ...Object.keys(scelte)];
  const r = { umori: [], fatte: [], voti: [], numeri: [], conteggi: [] };
  for (const nome of new Set(nomi)) {
    const segnato = scelte[nome];
    const gruppo = gruppoChiamato(nome, segnato);
    if (!gruppo.tipo) {
      if (!Array.isArray(segnato)) continue;
      if (nome === GRUPPO_UMORE) r.umori.push(...segnato);
      else r.fatte.push(...segnato.filter((o) => !stessoNome(o, NIENTE)).map((o) => [gruppo, o]));
      continue;
    }
    if (Array.isArray(segnato) && gruppo.tipo === 'scala') continue; // le parole di prima di un voto
    const valori = Object.entries(valoriDi(gruppo, segnato));
    if (gruppo.tipo === 'conteggio') {
      if (valori.length) r.conteggi.push([gruppo, valori.reduce((t, [, n]) => t + n, 0)]);
      continue;
    }
    const voti = valori.filter(([v]) => !eNumero(gruppo, v));
    if (voti.length) r.voti.push([gruppo, voti]);
    r.numeri.push(...valori.filter(([v]) => eNumero(gruppo, v)));
  }
  return r;
}

// Il peso di un voto nel benessere, scelto in Impostazioni (`impostazioniGruppi.pesi`, per
// "gruppo/voce"): 0 non conta, 1 (quello di partenza) normale, 2 doppio, 3 triplo.
const PESI = [0, 1, 2, 3];
const PESO_NORMALE = 1;
const chiavePeso = (gruppo, voce) => gruppo + '/' + voce;
function pesoDi(gruppo, voce) {
  const pesi = (impostazioniGruppi && impostazioniGruppi.pesi) || {};
  const chiave = chiavePeso(gruppo, voce);
  return chiave in pesi ? pesi[chiave] : PESO_NORMALE;
}

// La media pesata di tutti i voti del giorno, riportati da 1 a 9; undefined se non ce n'è nessuno che conta.
function benessereDi(riassunto) {
  let somma = 0;
  let pesi = 0;
  for (const [gruppo, voti] of riassunto.voti) {
    for (const [voce, n] of voti) {
      const peso = pesoDi(gruppo.nome, voce);
      somma += suNove(n, gruppo) * peso;
      pesi += peso;
    }
  }
  return pesi ? somma / pesi : undefined;
}

// Dove sta ogni gruppo nella Home, scelto in Impostazioni (`impostazioniGruppi.home`, per nome):
// 'benessere' (righe nel riquadro del benessere, solo per i gruppi di voti), 'riquadro' (uno
// suo) o 'nascosto'. Senza scelta i gruppi di voti stanno nel benessere, gli altri a sé.
const POSTI_HOME = { benessere: 'Nel benessere', riquadro: 'A sé', nascosto: 'Nascosto' };
function postiPossibili(gruppo) {
  return gruppo.tipo === 'scala' ? ['benessere', 'riquadro', 'nascosto'] : ['riquadro', 'nascosto'];
}
function postoInHome(gruppo) {
  const scelto = ((impostazioniGruppi && impostazioniGruppi.home) || {})[gruppo.nome];
  if (postiPossibili(gruppo).includes(scelto)) return scelto;
  return gruppo.tipo === 'scala' ? 'benessere' : 'riquadro';
}
function cambiaPostoInHome(nome, posto) {
  salvaImpostazioni({ home: { ...((impostazioniGruppi && impostazioniGruppi.home) || {}), [nome]: posto } });
}

// I periodi della Home, tutti fino a ieri. L'anno comincia il primo gennaio.
const PERIODI = {
  settimana: { nome: '7 giorni', titolo: 'Ultimi 7 giorni', giorni: 7 },
  mese: { nome: 'Mese', titolo: 'Ultimi 30 giorni', giorni: 30 },
  anno: { nome: 'Anno', titolo: "Quest'anno" },
};
let periodoHome = 'settimana';

function indietro(data, giorni) {
  const d = new Date(data + 'T00:00');
  d.setDate(d.getDate() - giorni);
  return dataDa(d.getFullYear(), d.getMonth(), d.getDate());
}
function giorniDelPeriodo(periodo, fine) {
  const { giorni } = PERIODI[periodo];
  return giorniTra(giorni ? indietro(fine, giorni - 1) : fine.slice(0, 4) + '-01-01', fine);
}

// Tutto quello che serve alla Home per dei giorni: per gruppo, i voti, i numeri, i conteggi e
// le volte di ogni opzione; il benessere di ogni giorno; ricordi e giorni registrati.
function statistiche(giorni) {
  const riassunti = giorni.map(riassuntoDelGiorno);
  const s = { giorni, voti: new Map(), numeri: new Map(), conteggi: new Map(), volte: new Map() };
  const aggiungi = (mappa, chiave, valori) => mappa.set(chiave, [...(mappa.get(chiave) || []), ...valori]);
  for (const r of riassunti) {
    for (const [g, v] of r.voti) aggiungi(s.voti, g.nome, v.map(([, n]) => n));
    for (const [voce, n] of r.numeri) aggiungi(s.numeri, voce, [n]);
    for (const [g, n] of r.conteggi) s.conteggi.set(g.nome, (s.conteggi.get(g.nome) || 0) + n);
    const scelte = [...r.fatte.map(([g, o]) => [g.nome, o]), ...r.umori.map((o) => [GRUPPO_UMORE, o])];
    for (const [g, o] of scelte) {
      if (!s.volte.has(g)) s.volte.set(g, new Map());
      s.volte.get(g).set(o, (s.volte.get(g).get(o) || 0) + 1);
    }
  }
  s.benessere = riassunti.map(benessereDi); // un valore per giorno, undefined dove non c'è
  const delPeriodo = posts.filter((p) => p.data >= giorni[0] && p.data <= giorni[giorni.length - 1]);
  s.registrati = giorni.filter((d) => giornataPiena(giornataDel(d)) || delPeriodo.some((p) => p.data === d)).length;
  s.ricordi = delPeriodo.filter((p) => !p.raccolta).length;
  s.archivio = delPeriodo.length - s.ricordi;
  s.belli = giorni.filter(giornataBella).length;
  return s;
}
const mediaSe = (valori) => (valori && valori.length ? media(valori) : undefined);
const benessereMedio = (s) => mediaSe(s.benessere.filter((v) => v !== undefined));

// "↑ 0,4" rispetto al periodo prima; niente se prima non c'era.
function freccia(adesso, prima) {
  if (adesso === undefined || prima === undefined) return '';
  const d = arrotonda(adesso - prima);
  return d > 0 ? '↑ ' + numeroLeggibile(d) : d < 0 ? '↓ ' + numeroLeggibile(-d) : '=';
}

// Il nome con cui si mostrano i voti di un gruppo: un gruppo con un voto solo (Sonno, che ha
// Ore dormite come numero e Riposo come voto) prende il nome e l'icona di quel voto.
function nomeDeiVoti(gruppo) {
  const voti = gruppo.opzioni.filter((v) => !eNumero(gruppo, v));
  return voti.length === 1 ? voti[0] : nomeMostrato(gruppo);
}
const scalaScritta = (gruppo) => (eScalaBase(gruppo) ? '' : `da ${scriviSuScala(minimoDi(gruppo), gruppo)} a ${scriviSuScala(massimoDi(gruppo), gruppo)}`);

// Un riquadro della Home: sopra l'icona e il nome, sotto il valore grande, e una nota piccola.
//   voto: se il valore è un voto da 1 a 9, prende il suo colore (dal rosso al verde)
function riquadro({ icona = '', nome, valore, nota = '', voto, onclick, largo = false }, ...altro) {
  return el(onclick ? 'button' : 'div', {
    className: 'riquadro' + (largo ? ' largo' : ''),
    ...(onclick ? { type: 'button', onclick } : {}),
  },
  el('span', { className: 'riquadro-nome', textContent: (icona ? icona + ' ' : '') + nome }),
  el('strong', {
    className: 'riquadro-valore' + (voto ? ' tinta' : ''),
    ...(voto ? { style: `--n: ${voto}` } : {}),
    textContent: valore,
  }),
  nota ? el('span', { className: 'riquadro-nota', textContent: nota }) : '',
  ...altro);
}
const scriviVoto = (n) => numeroLeggibile(arrotonda(n));

// Le colonne del benessere: colonne = [{ valore, etichetta }], alte quanto il voto e del suo
// colore. Il numero sopra si scrive solo quando le colonne sono poche.
function graficoBenessere(colonne) {
  const conNumeri = colonne.length <= 12;
  return el('div', { className: 'grafico' + (conNumeri ? '' : ' fitto'), style: `--colonne: ${colonne.length}` },
    ...colonne.map(({ valore, etichetta }) => el('div', { className: 'grafico-giorno' },
      conNumeri ? el('span', { className: 'grafico-numero', textContent: valore ? scriviVoto(valore) : '' }) : '',
      el('div', { className: 'grafico-spazio' },
        valore ? el('span', { className: 'grafico-colonna tinta', style: `--n: ${valore}; height: ${(valore / 9) * 100}%` }) : ''),
      el('span', { className: 'grafico-data', textContent: etichetta }))));
}

// Le colonne del periodo: una per giorno (nel mese l'etichetta ogni 7 giorni), una per mese nell'anno.
function colonneDelPeriodo(periodo, s) {
  if (periodo === 'anno') {
    const mesi = new Map();
    s.giorni.forEach((d, i) => { if (s.benessere[i] !== undefined) mesi.set(d.slice(5, 7), [...(mesi.get(d.slice(5, 7)) || []), s.benessere[i]]); });
    const ultimo = Number(s.giorni[s.giorni.length - 1].slice(5, 7));
    return Array.from({ length: ultimo }, (_, i) => {
      const mese = String(i + 1).padStart(2, '0');
      return { valore: mediaSe(mesi.get(mese)), etichetta: new Date(`${s.giorni[0].slice(0, 4)}-${mese}-01T00:00`).toLocaleDateString('it-IT', { month: 'narrow' }) };
    });
  }
  const fitto = s.giorni.length > 7;
  return s.giorni.map((d, i) => ({
    valore: s.benessere[i],
    etichetta: fitto
      ? ((s.giorni.length - 1 - i) % 7 === 0 ? String(Number(d.slice(8))) : '')
      : new Date(d + 'T00:00').toLocaleDateString('it-IT', { weekday: 'short' }),
  }));
}

// Una riga nel riquadro del benessere: nome, valore colorato e freccia rispetto a prima.
function rigaBenessere(icona, nome, valore, scritto, voto, prima) {
  return el('div', { className: 'benessere-riga' },
    el('span', { className: 'benessere-riga-nome', textContent: (icona ? icona + ' ' : '') + nome }),
    el('strong', { className: voto ? 'tinta' : '', style: voto ? `--n: ${voto}; color: var(--tinta)` : '', textContent: scritto }),
    el('span', { className: 'benessere-riga-freccia', textContent: freccia(valore, prima) }));
}

function disegnaHome() {
  const adesso = oggi();
  const ieri = giornoPrima(adesso);
  const periodo = periodoHome;
  const giorni = giorniDelPeriodo(periodo, ieri);
  const s = statistiche(giorni);
  const prima = statistiche(giorniTra(indietro(giorni[0], giorni.length), giornoPrima(giorni[0])));
  const gruppi = gruppiAttuali();
  const settimana = periodo === 'settimana';

  // Il riquadro del benessere: nella settimana il numero di ieri, negli altri periodi la media.
  const numero = settimana ? s.benessere[s.benessere.length - 1] : benessereMedio(s);
  const righe = [];
  for (const g of gruppi.filter((g) => postoInHome(g) === 'benessere')) {
    const v = mediaSe(s.voti.get(g.nome));
    if (v !== undefined) righe.push(rigaBenessere(iconaDi(nomeDeiVoti(g)) || iconaDi(g.nome), nomeDeiVoti(g), v, scriviSuScala(v, g), suNove(v, g), mediaSe(prima.voti.get(g.nome))));
    for (const voce of g.opzioni.filter((x) => eNumero(g, x))) {
      const n = mediaSe(s.numeri.get(voce));
      if (n !== undefined) righe.push(rigaBenessere(iconaDi(voce), voce, n, scriviVoto(n), undefined, mediaSe(prima.numeri.get(voce))));
    }
  }
  const benessere = riquadro({
    icona: '✨',
    nome: 'Benessere',
    valore: numero === undefined ? '–' : scriviVoto(numero),
    voto: numero,
    nota: settimana ? 'ieri' : `in media · ${freccia(numero, benessereMedio(prima)) || 'prima non c\'erano voti'}`,
    largo: true,
    onclick: settimana ? () => apriGiorno(ieri) : undefined,
  }, graficoBenessere(colonneDelPeriodo(periodo, s)), righe.length ? el('div', { className: 'benessere-righe' }, ...righe) : '');

  // Un riquadro per ogni gruppo messo a sé
  const riquadri = [];
  for (const g of gruppi.filter((g) => postoInHome(g) === 'riquadro')) {
    if (g.tipo === 'scala') {
      const v = mediaSe(s.voti.get(g.nome));
      if (v !== undefined) {
        riquadri.push(riquadro({
          icona: iconaDi(nomeDeiVoti(g)) || iconaDi(g.nome),
          nome: nomeDeiVoti(g),
          valore: scriviSuScala(v, g),
          voto: suNove(v, g),
          nota: ['in media', scalaScritta(g), freccia(v, mediaSe(prima.voti.get(g.nome)))].filter(Boolean).join(' · '),
        }));
      }
      for (const voce of g.opzioni.filter((x) => eNumero(g, x))) {
        const n = mediaSe(s.numeri.get(voce));
        if (n !== undefined) riquadri.push(riquadro({ icona: iconaDi(voce), nome: voce, valore: scriviVoto(n), nota: ['in media', freccia(n, mediaSe(prima.numeri.get(voce)))].filter(Boolean).join(' · ') }));
      }
    } else if (g.tipo === 'conteggio') {
      const totale = s.conteggi.get(g.nome);
      if (totale !== undefined) {
        const alGiorno = s.registrati ? numeroLeggibile(arrotonda(totale / s.registrati)) + ' al giorno · ' : '';
        riquadri.push(riquadro({ icona: iconaDi(g.nome), nome: g.nome, valore: numeroLeggibile(arrotonda(totale)), nota: `${alGiorno}prima ${numeroLeggibile(arrotonda(prima.conteggi.get(g.nome) || 0))}` }));
      }
    } else {
      // A scelte: quante volte ogni opzione, dalla più frequente. Per l'umore conta quello più frequente.
      const volte = [...(s.volte.get(g.nome) || new Map())].sort((a, b) => b[1] - a[1]);
      if (!volte.length) continue;
      const [primo, quante] = volte[0];
      riquadri.push(g.nome === GRUPPO_UMORE
        ? riquadro({ icona: iconaDi(primo) || iconaDi(g.nome), nome: 'Umore più frequente', valore: primo, nota: quante === 1 ? '1 volta' : quante + ' volte' },
          ...volte.slice(1, 4).map(([o, n]) => el('span', { className: 'riquadro-voce', textContent: `${conIcona(o)} ${n}` })))
        : riquadro({ icona: iconaDi(g.nome), nome: nomeMostrato(g), valore: String(volte.reduce((t, [, n]) => t + n, 0)), nota: volte.reduce((t, [, n]) => t + n, 0) === 1 ? 'volta' : 'volte' },
          ...volte.slice(0, 5).map(([o, n]) => el('span', { className: 'riquadro-voce', textContent: `${conIcona(o)} ${n}` }))));
    }
  }

  const lungo = (data, opzioni) => new Date(data + 'T00:00').toLocaleDateString('it-IT', opzioni);
  $('pagina-home').replaceChildren(
    el('div', { className: 'home-testa' },
      el('h2', { textContent: 'La mia vita' }),
      el('p', { className: 'home-data', textContent: lungo(adesso, { weekday: 'long', day: 'numeric', month: 'long' }) })),
    el('div', { className: 'home-periodi' }, ...Object.entries(PERIODI).map(([nome, p]) => el('button', {
      type: 'button',
      className: 'chip' + (nome === periodo ? ' attivo' : ''),
      textContent: p.nome,
      onclick: () => { periodoHome = nome; disegnaHome(); },
    }))),
    el('h3', { className: 'home-titolo', textContent: `${PERIODI[periodo].titolo}, fino a ieri` }),
    el('div', { className: 'riquadri' },
      benessere,
      ...riquadri,
      riquadro({ icona: '📖', nome: 'Ricordi', valore: String(s.ricordi) }),
      s.archivio ? riquadro({ icona: '🗂️', nome: 'Nell\'archivio', valore: String(s.archivio) }) : '',
      s.belli ? riquadro({ icona: '⭐', nome: 'Giorni belli', valore: String(s.belli) }) : ''),
    el('p', { className: 'home-piede', textContent: `Giorni registrati: ${s.registrati} su ${giorni.length}` }),
  );
}

// ---------------------------------------------------------------------------
// Impostazioni
//
// Una pagina con le scelte che valgono per tutto il diario. Per ora una sola: quanto pesa
// ogni voto da 1 a 9 nel benessere. Si salvano nelle impostazioni, quindi arrivano anche
// agli altri dispositivi.
// ---------------------------------------------------------------------------

function cambiaPeso(gruppo, voce, peso) {
  const pesi = { ...((impostazioniGruppi && impostazioniGruppi.pesi) || {}) };
  if (peso === PESO_NORMALE) delete pesi[chiavePeso(gruppo, voce)];
  else pesi[chiavePeso(gruppo, voce)] = peso;
  salvaImpostazioni({ pesi });
}

// ---------------------------------------------------------------------------
// PIN
//
// Un codice di 4 cifre chiesto all'apertura del diario. È una serratura, non una cassaforte:
// i ricordi nel browser e sul Drive non sono cifrati. Il PIN non è mai salvato com'è: nelle
// impostazioni (che viaggiano col Drive, così vale su tutti i dispositivi) c'è solo la sua
// impronta, cioè SHA-256 di sale + PIN. Se lo si dimentica, dalla console del browser:
// salvaImpostazioni({ pin: null }) e poi si ricarica la pagina.
// ---------------------------------------------------------------------------

const CIFRE_PIN = 4;
let pinScritto = '';

async function improntaDi(sale, pin) {
  const byte = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sale + ':' + pin));
  return [...new Uint8Array(byte)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// crypto.subtle esiste solo su HTTPS e su localhost: altrove (192.168…) niente PIN.
const pinAttivo = () => !!(impostazioniGruppi && impostazioniGruppi.pin && window.crypto && crypto.subtle);

async function scegliPin() {
  const primo = prompt(`Nuovo PIN (${CIFRE_PIN} cifre)`);
  if (primo === null) return;
  if (!new RegExp(`^\\d{${CIFRE_PIN}}$`).test(primo.trim())) {
    alert(`Il PIN deve essere di ${CIFRE_PIN} cifre.`);
    return;
  }
  if (prompt('Scrivilo di nuovo') !== primo) {
    alert('I due PIN non sono uguali: non è cambiato niente.');
    return;
  }
  const sale = nuovoId();
  salvaImpostazioni({ pin: { sale, impronta: await improntaDi(sale, primo.trim()) } });
}

function togliPin() {
  if (confirm('Togliere il PIN? Il diario si aprirà senza chiederlo, su tutti i dispositivi.')) salvaImpostazioni({ pin: null });
}

// La schermata col tastierino, sopra a tutto, finché non si scrive il PIN giusto.
function mostraBlocco() {
  pinScritto = '';
  const pallini = el('div', { className: 'blocco-pallini' });
  const disegnaPallini = () => pallini.replaceChildren(...Array.from({ length: CIFRE_PIN }, (_, i) => el('span', { className: i < pinScritto.length ? 'pieno' : '' })));
  const premi = async (tasto) => {
    if (tasto === '⌫') pinScritto = pinScritto.slice(0, -1);
    else if (pinScritto.length < CIFRE_PIN) pinScritto += tasto;
    disegnaPallini();
    if (pinScritto.length < CIFRE_PIN) return;
    const { sale, impronta } = impostazioniGruppi.pin;
    if (await improntaDi(sale, pinScritto) === impronta) {
      $('blocco').hidden = true;
      document.removeEventListener('keydown', tastiera);
      return;
    }
    pallini.classList.add('sbagliato');
    setTimeout(() => { pallini.classList.remove('sbagliato'); pinScritto = ''; disegnaPallini(); }, 500);
  };
  // Dal Mac si può scrivere anche con la tastiera.
  const tastiera = (e) => {
    if (/^\d$/.test(e.key)) premi(e.key);
    else if (e.key === 'Backspace') premi('⌫');
  };
  document.addEventListener('keydown', tastiera);
  disegnaPallini();
  $('blocco').replaceChildren(
    el('h2', { textContent: 'Diario' }),
    pallini,
    el('div', { className: 'blocco-tasti' },
      ...['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((t) => (t
        ? el('button', { type: 'button', textContent: t, ariaLabel: t === '⌫' ? 'Cancella' : t, onclick: () => premi(t) })
        : el('span')))));
  $('blocco').hidden = false;
}

function disegnaImpostazioni() {
  const ieri = giornoPrima(oggi());
  const benessereIeri = benessereDi(riassuntoDelGiorno(ieri));
  const gruppiDiVoti = gruppiAttuali().filter((g) => g.tipo === 'scala' && g.opzioni.some((v) => !eNumero(g, v)));
  $('pagina-impostazioni').replaceChildren(
    el('h2', { className: 'impostazioni-titolo', textContent: 'Impostazioni' }),
    el('section', { className: 'impostazione' },
      el('h3', { textContent: '🔒 PIN' }),
      el('p', { className: 'nota', textContent: pinAttivo()
        ? `Il diario chiede il PIN quando si apre, su tutti i dispositivi.`
        : `Senza PIN il diario si apre subito. Con il PIN chiede ${CIFRE_PIN} cifre all'apertura, su tutti i dispositivi.` }),
      el('div', { className: 'chips' },
        el('button', { type: 'button', className: 'btn-secondario', textContent: pinAttivo() ? 'Cambia PIN' : 'Scegli un PIN', onclick: () => scegliPin().catch(mostraErrore) }),
        pinAttivo() ? el('button', { type: 'button', className: 'btn-secondario', textContent: 'Togli PIN', onclick: togliPin }) : '')),
    el('section', { className: 'impostazione' },
      el('h3', { textContent: '🏠 Home' }),
      el('p', { className: 'nota', textContent: 'Dove compare ogni gruppo nella Home: nel riquadro del benessere (solo i gruppi di voti), in un riquadro a sé, oppure da nessuna parte. Nascondere un gruppo non cambia il calcolo del benessere: per quello ci sono i pesi qui sotto.' }),
      ...gruppiAttuali().map((g) => el('div', { className: 'peso' },
        el('span', { className: 'voce-nome', textContent: conIcona(g.nome, nomeMostrato(g)) }),
        el('div', { className: 'peso-scelte' }, ...postiPossibili(g).map((posto) => el('button', {
          type: 'button',
          className: 'chip' + (postoInHome(g) === posto ? ' attivo' : ''),
          textContent: POSTI_HOME[posto],
          onclick: () => cambiaPostoInHome(g.nome, posto),
        })))))),
    el('section', { className: 'impostazione' },
      el('h3', { textContent: '✨ Calcolo del benessere' }),
      el('p', { className: 'nota', textContent: 'Il benessere di un giorno è la media dei voti da 1 a 9 segnati quel giorno. Qui scegli quanto conta ognuno: 0 non conta, 1 normale, 2 il doppio, 3 il triplo.' }),
      el('p', { className: 'impostazione-anteprima' }, 'Ieri, con questi pesi: ',
        benessereIeri === undefined
          ? 'nessun voto'
          : el('strong', { className: 'tinta', style: `--n: ${benessereIeri}; color: var(--tinta)`, textContent: scriviVoto(benessereIeri) })),
      ...gruppiDiVoti.map((g) => el('div', { className: 'pesi-gruppo' },
        el('h4', { textContent: conIcona(g.nome, nomeMostrato(g)) }),
        ...g.opzioni.filter((v) => !eNumero(g, v)).map((voce) => el('div', { className: 'peso' },
          el('span', { className: 'voce-nome', textContent: conIcona(voce) }),
          el('div', { className: 'peso-scelte' }, ...PESI.map((n) => el('button', {
            type: 'button',
            className: 'chip' + (pesoDi(g.nome, voce) === n ? ' attivo' : ''),
            textContent: String(n),
            ariaLabel: `Peso di ${voce}: ${n}`,
            onclick: () => cambiaPeso(g.nome, voce, n),
          })))))))),
  );
}

// ---------------------------------------------------------------------------
// Pagine e menu
//
// Ogni pagina ha il suo elemento e la sua funzione di disegno. Si ridisegna solo quella
// mostrata, perché la timeline ha le foto. Le pagine principali stanno sia nella barra in
// basso sia nel menu laterale (☰); calendario e impostazioni solo nel menu.
// ---------------------------------------------------------------------------

const PAGINE = {
  home: { elemento: 'pagina-home', disegna: disegnaHome, nome: 'Home', icona: '🏠' },
  oggi: { elemento: 'pagina-oggi', disegna: disegnaOggi, nome: 'Oggi', icona: '☀️' },
  diario: { elemento: 'timeline', disegna: disegnaTimeline, nome: 'Diario', icona: '📖' },
  archivio: { elemento: 'pagina-archivio', disegna: disegnaArchivio, nome: 'Archivio', icona: '🗂️' },
  statistiche: { elemento: 'pagina-statistiche', disegna: disegnaStatistiche, nome: 'Statistiche', icona: '📊' },
  calendario: { elemento: 'pagina-calendario', disegna: disegnaCalendario, nome: 'Calendario', icona: '📅' },
  impostazioni: { elemento: 'pagina-impostazioni', disegna: disegnaImpostazioni, nome: 'Impostazioni', icona: '⚙️' },
};
const PAGINE_PRINCIPALI = ['home', 'oggi', 'diario', 'archivio', 'statistiche'];
let paginaAttuale = 'home';
const pulsantiPagine = []; // [nome della pagina, pulsante], sia della barra sia del menu

function disegnaPagina() {
  PAGINE[paginaAttuale].disegna();
}

function mostraPagina(pagina) {
  paginaAttuale = pagina;
  for (const [nome, { elemento }] of Object.entries(PAGINE)) $(elemento).hidden = nome !== pagina;
  for (const [nome, pulsante] of pulsantiPagine) pulsante.classList.toggle('attiva', nome === pagina);
  $('filtri').hidden = pagina !== 'diario';
  $('btn-nuovo').hidden = pagina !== 'diario';
  disegnaPagina();
  // Il calendario parte dal fondo, dove c'è il mese corrente.
  window.scrollTo(0, pagina === 'calendario' ? document.documentElement.scrollHeight : 0);
}

// Quello che succede toccando una pagina nella barra o nel menu.
function vaiA(pagina) {
  if (pagina === 'oggi') giornoMostrato = null;
  // Toccare Archivio mentre si è dentro una raccolta riporta all'elenco delle raccolte.
  if (pagina === 'archivio' && paginaAttuale === 'archivio') raccoltaAperta = null;
  if ($('dlg-menu').open) $('dlg-menu').close();
  mostraPagina(pagina);
}

function disegnaMenu() {
  const pulsante = (nome, className) => {
    const { nome: scritta, icona } = PAGINE[nome];
    const b = el('button', { type: 'button', className, onclick: () => vaiA(nome) },
      el('span', { className: 'pagina-icona', textContent: icona }), el('span', { textContent: scritta }));
    pulsantiPagine.push([nome, b]);
    return b;
  };
  $('barra-pagine').replaceChildren(...PAGINE_PRINCIPALI.map((n) => pulsante(n, '')));
  $('menu-voci').replaceChildren(
    ...PAGINE_PRINCIPALI.map((n) => pulsante(n, 'menu-voce')),
    el('hr'),
    ...Object.keys(PAGINE).filter((n) => !PAGINE_PRINCIPALI.includes(n)).map((n) => pulsante(n, 'menu-voce')));
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
  }, el('span', { textContent: conIcona(nome) }), el('span', { className: 'raccolta-numero', textContent: n || '' }))));
}

function disegnaRaccolta(nome) {
  const raccolta = raccoltaChiamata(nome);
  const testa = el('div', { className: 'archivio-testa' },
    el('button', { type: 'button', className: 'btn-testo', textContent: '‹ Archivio', onclick: () => { raccoltaAperta = null; mostraPagina('archivio'); } }),
    el('h2', { textContent: conIcona(nome) }),
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
$('btn-menu').onclick = () => $('dlg-menu').showModal();
// Toccare fuori dal menu (sull'ombra) lo chiude.
$('dlg-menu').onclick = (e) => { if (e.target === $('dlg-menu')) $('dlg-menu').close(); };
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

disegnaMenu();
mostraPagina('home');
// Finché non si sa se c'è un PIN la pagina resta nascosta (classe in-apertura, in index.html).
ricarica()
  .then(() => { if (pinAttivo()) mostraBlocco(); })
  .catch(mostraErrore)
  .finally(() => document.body.classList.remove('in-apertura'));
