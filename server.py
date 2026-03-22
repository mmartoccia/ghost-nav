#!/usr/bin/env python3
"""Ghost Nav dev server with Nominatim proxy (fixes iOS mixed-content blocking)"""
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
    
    def do_GET(self):
        if self.path.startswith('/proxy/nominatim?'):
            # Proxy geocoding requests to Nominatim
            query = self.path.split('?', 1)[1]
            url = f'https://nominatim.openstreetmap.org/search?{query}'
            try:
                req = urllib.request.Request(url, headers={
                    'User-Agent': 'GhostNav/1.0 (privacy-navigation-research)'
                })
                with urllib.request.urlopen(req, timeout=10) as resp:
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
            return
        
        if self.path.startswith('/proxy/osrm/'):
            # Proxy OSRM requests
            osrm_path = self.path.replace('/proxy/osrm/', '')
            url = f'https://router.project-osrm.org/{osrm_path}'
            try:
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req, timeout=15) as resp:
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
            return

        if self.path.startswith('/proxy/overpass?'):
            # Proxy Overpass API requests  
            query = self.path.split('?', 1)[1]
            url = f'https://overpass-api.de/api/interpreter?{query}'
            try:
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req, timeout=30) as resp:
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
            return
        
        super().do_GET()

if __name__ == '__main__':
    server = http.server.HTTPServer(('0.0.0.0', PORT), GhostHandler)
    print(f'Ghost Nav server on http://0.0.0.0:{PORT}')
    server.serve_forever()
