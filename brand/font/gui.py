"""
Font builder GUI: sliders over the build knobs, a live specimen, download buttons.

    python3 gui.py            # http://localhost:8787
    PORT=9000 python3 gui.py

Every change POSTs the knobs to /build, which runs build_serif.py and kern.py
with them as environment variables and returns the woff2. Nothing here draws a
glyph: edit a recipe in build_serif.py, save, press Rebuild.
"""
import base64, json, os, subprocess, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out", "gui")
PORT = int(os.environ.get("PORT", "8787"))
KNOBS = {"S", "HL", "ST", "EXT", "COND", "EMB", "SB", "CH", "WORN", "WEAR", "GRIT", "SEED", "FAMILY"}

def build(params):
    env = {**os.environ, "OUT_DIR": OUT}
    for k, v in params.items():
        if k in KNOBS: env[k] = str(v)
    t0 = time.time()
    r = subprocess.run([sys.executable, "build_serif.py"], cwd=HERE, env=env, capture_output=True, text=True)
    if r.returncode: return {"error": r.stderr[-3000:]}
    fam = env.get("FAMILY", "FrontierJS Serif") + (" Worn" if env.get("WORN") == "1" else "")
    slug = fam.replace(" ", "_") + "_Regular"
    ttf = os.path.join(OUT, slug + ".ttf")
    if params.get("KERN", True):
        r = subprocess.run([sys.executable, "kern.py"], cwd=HERE, env={**env, "FONTS": ttf}, capture_output=True, text=True)
        if r.returncode: return {"error": r.stderr[-3000:]}
    woff2 = open(os.path.join(OUT, slug + ".woff2"), "rb").read()
    return {"family": fam, "slug": slug, "ms": int((time.time() - t0) * 1000),
            "woff2": base64.b64encode(woff2).decode()}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body, ctype):
        self.send_response(code); self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path == "/":
            return self._send(200, open(os.path.join(HERE, "gui.html"), "rb").read(), "text/html; charset=utf-8")
        if self.path.startswith("/out/"):
            f = os.path.join(OUT, os.path.basename(self.path))
            if os.path.exists(f): return self._send(200, open(f, "rb").read(), "font/ttf" if f.endswith(".ttf") else "font/woff2")
        self._send(404, b"not found", "text/plain")
    def do_POST(self):
        if self.path != "/build": return self._send(404, b"", "text/plain")
        n = int(self.headers.get("Content-Length", 0))
        params = json.loads(self.rfile.read(n) or b"{}")
        self._send(200, json.dumps(build(params)).encode(), "application/json")

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    print(f"font builder at http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
