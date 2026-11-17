"""Real offline renderer regression probes; requires Node.js and Chrome. Run directly."""
import base64, http.server, io, json, struct, sys, threading, time, zipfile, zlib
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from html_import import import_html

def zip_payload(files):
 b=io.BytesIO()
 with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:
  for p,v in files.items():z.writestr(p,v)
 return {'name':'synthetic.zip','data':base64.b64encode(b.getvalue()).decode()}
def html_payload(s):return {'name':'synthetic.html','data':base64.b64encode(s.encode()).decode()}
def png_pixels(url):
 data=base64.b64decode(url.split(',')[1]);pos=8;compressed=b''
 while pos<len(data):
  n=struct.unpack('>I',data[pos:pos+4])[0];kind=data[pos+4:pos+8];part=data[pos+8:pos+8+n];pos+=n+12
  if kind==b'IHDR':w,h,depth,color,*_=struct.unpack('>IIBBBBB',part)
  if kind==b'IDAT':compressed+=part
 assert depth==8 and color in (2,6),(depth,color)
 bpp=3 if color==2 else 4;stride=w*bpp;raw=zlib.decompress(compressed);rows=[];prev=bytearray(stride)
 for y in range(h):
  f=raw[y*(stride+1)];row=bytearray(raw[y*(stride+1)+1:(y+1)*(stride+1)])
  for x in range(stride):
   a=row[x-bpp] if x>=bpp else 0;b=prev[x];c=prev[x-bpp] if x>=bpp else 0
   if f==1:row[x]=(row[x]+a)&255
   elif f==2:row[x]=(row[x]+b)&255
   elif f==3:row[x]=(row[x]+((a+b)//2))&255
   elif f==4:
    p=a+b-c;pa=abs(p-a);pb=abs(p-b);pc=abs(p-c);v=a if pa<=pb and pa<=pc else b if pb<=pc else c
    row[x]=(row[x]+v)&255
  rows.append(row);prev=row
 return lambda x,y:tuple(rows[y][x*bpp:x*bpp+3])

results=[]
def check(name, value):
 assert value,name
 results.append(name);print('PASS',name,flush=True)

local=zip_payload({'site/index.html':'<!doctype html><html><head><title>Before</title><link rel="stylesheet" href="assets/site.css"><script src="assets/site.js" defer></script></head><body><figure><img src="assets/tile.svg"></figure></body></html>',
 'site/assets/site.css':'body,figure{margin:0}figure{width:320px;height:200px;background:rgb(0,180,0);position:relative}figure img{position:absolute;left:10px;top:10px;width:40px;height:40px}',
 'site/assets/site.js':'fetch("assets/data.json").then(r=>r.json()).then(d=>document.title=d.title)',
 'site/assets/data.json':'{"title":"Local resources loaded"}',
 'site/assets/tile.svg':'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#ff0000"/></svg>'})
r=import_html(local);c=next(c for c in r['candidates'] if c['figure']==0);px=png_pixels(c['preview'])
check('ZIP relative CSS sizes the Figure',(c['width'],c['height'])==(320,200))
check('ZIP relative script and JSON execute locally',c['title']=='Local resources loaded')
check('ZIP relative SVG and CSS render expected pixels',px(20,20)==(255,0,0) and px(100,100)==(0,180,0))
check('Self-contained ZIP has no resource warnings',not r['warnings'])

hits=[]
class Sink(http.server.BaseHTTPRequestHandler):
 def do_GET(self):hits.append(('GET',self.path));self.send_response(200);self.end_headers();self.wfile.write(b'probe')
 def do_POST(self):hits.append(('POST',self.path));self.send_response(200);self.end_headers()
 def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Sink);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();url='http://127.0.0.1:'+str(server.server_port)
probe=f'''<!doctype html><html><head><title>Probe</title></head><body><figure style="width:320px;height:200px">Isolation probe<img src="{url}/image"><img src="https://example.invalid/image"><img src="/constructor"></figure><script>
Promise.allSettled([fetch('{url}/fetch'),fetch('https://example.invalid/fetch'),fetch('/constructor')]).then(r=>document.title='Rejected '+r.filter(x=>x.status==='rejected').length);
try{{navigator.sendBeacon('{url}/beacon','synthetic')}}catch{{}}
try{{window.open('{url}/popup')}}catch{{}}
try{{new WebSocket('ws://127.0.0.1:{server.server_port}/socket')}}catch{{}}
</script><iframe srcdoc="&lt;img src='{url}/nested-image'&gt;"></iframe></body></html>'''
t=time.monotonic();r=import_html(html_payload(probe));elapsed=time.monotonic()-t
server.shutdown();server.server_close();thread.join()
check('Loopback fetch/image/beacon/popup/socket/frame made zero requests',not hits)
check('External/loopback/constructor fetches rejected',r['candidates'][0]['title']=='Rejected 3')
check('/constructor does not stall rendering',elapsed<8)
check('/constructor missing-resource warning returned',any('/constructor' in w for w in r['warnings']))
print('Security duration',round(elapsed,2),'seconds; warnings',r['warnings'],flush=True)

first='<!doctype html><html><head><title>Repeated title</title></head><body><figure style="width:300px;height:150px"><h2>FIRST CONTENT</h2></figure></body></html>'
second=first.replace('FIRST CONTENT','SECOND CONTENT')
gallery='<!doctype html><html><title>Gallery</title><script>const pages='+json.dumps([first,second]).replace('</script>','<\\/script>')+';</script></html>'
r=import_html(zip_payload({'one.html':first,'gallery.html':gallery}));figs=[c for c in r['candidates'] if c['figure']==0]
check('Same-title distinct gallery page retained',len(figs)==2 and {c['heading'] for c in figs}=={'FIRST CONTENT','SECOND CONTENT'})
check('Matching actual embedded page is deduplicated',sum(c['heading']=='FIRST CONTENT' for c in figs)==1)
external=import_html(html_payload('<!doctype html><html><figure style="width:300px;height:200px"><img src="https://example.invalid/image.png"></figure></html>'))
check('CSP-only blocked resources are reported', any('blocked resources' in warning for warning in external['warnings']))
print(json.dumps({'checks':results,'total':len(results)}),flush=True)
