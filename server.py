#!/usr/bin/env python3
"""Ghost Nav dev server with API proxies (fixes iOS mixed-content blocking)"""
import http.server
import urllib.request
import urllib.parse
import json
import os

PORT = 8766
DIR = os.path.dirname(os.path.abspath(__file__))

class GhostHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)
    
    def _proxy(self, url, timeout=15):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'GhostNav/1.0 (privacy-navigation-research)'
            })
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = resp.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(data)
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def do_GET(self):
        if self.path.startswith('/proxy/nominatim?'):
            query = self.path.split('?', 1)[1]
            self._proxy(f'https://nominatim.openstreetmap.org/search?{query}')
            return
        
        if self.path.startswith('/proxy/census?'):
            query = self.path.split('?', 1)[1]
            self._proxy(f'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?{query}', timeout=10)
            return
        
        if self.path.startswith('/proxy/osrm/'):
            osrm_path = self.path.replace('/proxy/osrm/', '')
            self._proxy(f'https://router.project-osrm.org/{osrm_path}')
            return

        if self.path.startswith('/proxy/overpass?'):
            query = self.path.split('?', 1)[1]
            self._proxy(f'https://overpass-api.de/api/interpreter?{query}', timeout=30)
            return
        
        super().do_GET()

if __name__ == '__main__':
    server = http.server.HTTPServer(('0.0.0.0', PORT), GhostHandler)
    print(f'Ghost Nav server on http://0.0.0.0:{PORT}')
    server.serve_forever()
