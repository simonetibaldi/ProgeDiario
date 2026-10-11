'use strict';

// ---------------------------------------------------------------------------
// ZIP minimale per il backup: file non compressi (le foto sono già JPEG).
// Limiti del formato usato: 65.535 file e 4 GB in totale.
// ---------------------------------------------------------------------------

const ZIP_LOCALE = 0x04034b50;
const ZIP_CENTRALE = 0x02014b50;
const ZIP_FINE = 0x06054b50;
const ZIP_UTF8 = 0x0800;

const CRC_TABELLA = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABELLA[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// voci: [{ nome: 'cartella/file.jpg', blob }]  ->  Blob dello zip
async function creaZip(voci) {
  if (voci.length > 0xffff) throw new Error('Troppi file per un solo backup');

  const enc = new TextEncoder();
  const d = new Date();
  const ora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const giorno = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

  const corpo = [];
  const indice = [];
  let offset = 0;
  let dimIndice = 0;

  for (const { nome, blob } of voci) {
    const nomeB = enc.encode(nome);
    const crc = crc32(new Uint8Array(await blob.arrayBuffer()));

    const locale = new DataView(new ArrayBuffer(30));
    locale.setUint32(0, ZIP_LOCALE, true);
    locale.setUint16(4, 20, true);
    locale.setUint16(6, ZIP_UTF8, true);
    locale.setUint16(10, ora, true);
    locale.setUint16(12, giorno, true);
    locale.setUint32(14, crc, true);
    locale.setUint32(18, blob.size, true);
    locale.setUint32(22, blob.size, true);
    locale.setUint16(26, nomeB.length, true);
    corpo.push(locale, nomeB, blob);

    const centrale = new DataView(new ArrayBuffer(46));
    centrale.setUint32(0, ZIP_CENTRALE, true);
    centrale.setUint16(4, 20, true);
    centrale.setUint16(6, 20, true);
    centrale.setUint16(8, ZIP_UTF8, true);
    centrale.setUint16(12, ora, true);
    centrale.setUint16(14, giorno, true);
    centrale.setUint32(16, crc, true);
    centrale.setUint32(20, blob.size, true);
    centrale.setUint32(24, blob.size, true);
    centrale.setUint16(28, nomeB.length, true);
    centrale.setUint32(42, offset, true);
    indice.push(centrale, nomeB);

    offset += 30 + nomeB.length + blob.size;
    dimIndice += 46 + nomeB.length;
  }
  if (offset + dimIndice > 0xffffffff) throw new Error('Backup troppo grande (oltre 4 GB)');

  const fine = new DataView(new ArrayBuffer(22));
  fine.setUint32(0, ZIP_FINE, true);
  fine.setUint16(8, voci.length, true);
  fine.setUint16(10, voci.length, true);
  fine.setUint32(12, dimIndice, true);
  fine.setUint32(16, offset, true);

  return new Blob([...corpo, ...indice, fine], { type: 'application/zip' });
}

// File zip  ->  Map(nome -> Blob). Legge solo zip non compressi, come quelli di creaZip.
async function leggiZip(file) {
  const coda = new DataView(await file.slice(Math.max(0, file.size - 65557)).arrayBuffer());
  let p = coda.byteLength - 22;
  while (p >= 0 && coda.getUint32(p, true) !== ZIP_FINE) p--;
  if (p < 0) throw new Error('Il file non è un backup del diario');

  const quanti = coda.getUint16(p + 10, true);
  const dimIndice = coda.getUint32(p + 12, true);
  const inizioIndice = coda.getUint32(p + 16, true);
  const indice = new DataView(await file.slice(inizioIndice, inizioIndice + dimIndice).arrayBuffer());

  const dec = new TextDecoder();
  const voci = new Map();
  let q = 0;
  for (let i = 0; i < quanti; i++) {
    if (indice.getUint32(q, true) !== ZIP_CENTRALE) throw new Error('Backup danneggiato');
    if (indice.getUint16(q + 10, true) !== 0) {
      throw new Error('Questo zip è compresso: usa il file originale creato da Esporta');
    }
    const dim = indice.getUint32(q + 20, true);
    const lungNome = indice.getUint16(q + 28, true);
    const lungExtra = indice.getUint16(q + 30, true);
    const lungCommento = indice.getUint16(q + 32, true);
    const posizione = indice.getUint32(q + 42, true);
    const nome = dec.decode(new Uint8Array(indice.buffer, q + 46, lungNome));

    const locale = new DataView(await file.slice(posizione, posizione + 30).arrayBuffer());
    const inizioDati = posizione + 30 + locale.getUint16(26, true) + locale.getUint16(28, true);
    voci.set(nome, file.slice(inizioDati, inizioDati + dim));

    q += 46 + lungNome + lungExtra + lungCommento;
  }
  return voci;
}
