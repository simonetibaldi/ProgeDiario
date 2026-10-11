#!/usr/bin/env python3
"""Server del diario: serve i file dell'app e tiene le cartelle photos/ e ricordi/.

Uso:  python3 server.py [porta]        (porta predefinita: 8000)

Oltre ai file della cartella risponde a:
  GET /api/foto          elenco JSON dei JPEG in photos/, dal più recente
  PUT /api/foto/<nome>   salva un JPEG in photos/; non sovrascrive mai
  GET /api/ricordi       JSON { id: modificato } dei ricordi in ricordi/
  PUT /api/ricordi/<id>  salva ricordi/<id>.json, se non ce n'è già uno più recente
  DELETE /api/ricordi/<id>   sposta il ricordo in ricordi/eliminati/ (non lo distrugge)
"""

import json
import os
import re
import sys
import unicodedata
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

RADICE = os.path.dirname(os.path.abspath(__file__))
PHOTOS = os.path.join(RADICE, 'photos')
RICORDI = os.path.join(RADICE, 'ricordi')
ELIMINATI = os.path.join(RICORDI, 'eliminati')
API_FOTO = '/api/foto'
API_RICORDI = '/api/ricordi'
ID_VALIDO = re.compile(r'[a-z0-9-]{1,60}')
PESO_MAX = 30 * 1024 * 1024
ESTENSIONI = ('.jpg', '.jpeg')


def nome_valido(nome):
    return (
        0 < len(nome) <= 200
        and nome == os.path.basename(nome)
        and '\\' not in nome
        and not nome.startswith('.')
        and nome.lower().endswith(ESTENSIONI)
    )


def elenco_foto():
    nomi = [n for n in os.listdir(PHOTOS) if nome_valido(n) and os.path.isfile(os.path.join(PHOTOS, n))]
    nomi.sort(key=lambda n: os.path.getmtime(os.path.join(PHOTOS, n)), reverse=True)
    # macOS può restituire le lettere accentate scomposte: il browser le confronta composte.
    return [unicodedata.normalize('NFC', n) for n in nomi]


def leggi_ricordo(percorso):
    with open(percorso, encoding='utf-8') as f:
        return json.load(f)


def elenco_ricordi():
    elenco = {}
    for nome in os.listdir(RICORDI):
        if nome.endswith('.json') and not nome.startswith('.'):
            try:
                ricordo = leggi_ricordo(os.path.join(RICORDI, nome))
                elenco[ricordo['id']] = ricordo['modificato']
            except (OSError, ValueError, KeyError, TypeError):
                pass  # file rovinato o non nostro: si ignora
    return elenco


# Scrive su un file provvisorio (nascosto, quindi fuori dagli elenchi) e poi lo rinomina:
# nella cartella non compare mai un file a metà.
def scrivi(cartella, nome, dati):
    provvisorio = os.path.join(cartella, '.' + nome + '.parte')
    with open(provvisorio, 'wb') as f:
        f.write(dati)
    os.replace(provvisorio, os.path.join(cartella, nome))


class Diario(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=RADICE, **kwargs)

    def end_headers(self):
        # Il browser deve chiedere ogni volta se un file è cambiato: altrimenti dopo una
        # modifica al codice può continuare a usare la copia vecchia.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def rispondi(self, stato, dati):
        corpo = json.dumps(dati).encode('utf-8')
        self.send_response(stato)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def do_GET(self):
        percorso = self.path.split('?')[0]
        if percorso == API_FOTO:
            self.rispondi(200, elenco_foto())
        elif percorso == API_RICORDI:
            self.rispondi(200, elenco_ricordi())
        else:
            super().do_GET()

    def do_PUT(self):
        percorso = self.path.split('?')[0]
        peso = int(self.headers.get('Content-Length') or 0)
        if not 0 < peso <= PESO_MAX:
            return self.rispondi(413, {'errore': 'Contenuto vuoto o troppo grande'})
        dati = self.rfile.read(peso)
        if len(dati) != peso:
            return self.rispondi(400, {'errore': 'Contenuto arrivato incompleto'})

        if percorso.startswith(API_FOTO + '/'):
            self.salva_foto(unquote(percorso[len(API_FOTO) + 1:]), dati)
        elif percorso.startswith(API_RICORDI + '/'):
            self.salva_ricordo(percorso[len(API_RICORDI) + 1:], dati)
        else:
            self.rispondi(404, {'errore': 'Indirizzo sconosciuto'})

    def salva_foto(self, nome, dati):
        if not nome_valido(nome):
            return self.rispondi(400, {'errore': 'Nome di foto non valido'})
        if os.path.exists(os.path.join(PHOTOS, nome)):
            return self.rispondi(409, {'errore': 'La foto esiste già'})
        scrivi(PHOTOS, nome, dati)
        self.rispondi(201, {'nome': nome})

    def salva_ricordo(self, id, dati):
        try:
            ricordo = json.loads(dati)
            valido = ID_VALIDO.fullmatch(id) and ricordo['id'] == id and isinstance(ricordo['modificato'], (int, float))
        except (ValueError, KeyError, TypeError):
            valido = False
        if not valido:
            return self.rispondi(400, {'errore': 'Ricordo non valido'})

        nome = id + '.json'
        try:
            if leggi_ricordo(os.path.join(RICORDI, nome))['modificato'] > ricordo['modificato']:
                return self.rispondi(409, {'errore': 'Nella cartella ce n\'è uno più recente'})
        except (OSError, ValueError, KeyError, TypeError):
            pass  # non c'è ancora, o è rovinato: si scrive
        scrivi(RICORDI, nome, json.dumps(ricordo, ensure_ascii=False, indent=2).encode('utf-8'))
        self.rispondi(201, {'id': id})

    def do_DELETE(self):
        percorso = self.path.split('?')[0]
        id = percorso[len(API_RICORDI) + 1:]
        if not percorso.startswith(API_RICORDI + '/') or not ID_VALIDO.fullmatch(id):
            return self.rispondi(404, {'errore': 'Indirizzo sconosciuto'})
        try:
            os.replace(os.path.join(RICORDI, id + '.json'), os.path.join(ELIMINATI, id + '.json'))
        except FileNotFoundError:
            return self.rispondi(404, {'errore': 'Ricordo non trovato'})
        self.rispondi(200, {'id': id})


if __name__ == '__main__':
    porta = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.makedirs(PHOTOS, exist_ok=True)
    os.makedirs(ELIMINATI, exist_ok=True)
    print(f'Diario su http://localhost:{porta}  (ricordi e foto in {RADICE})')
    print('Ctrl+C per fermare.')
    try:
        ThreadingHTTPServer(('', porta), Diario).serve_forever()
    except KeyboardInterrupt:
        print()
