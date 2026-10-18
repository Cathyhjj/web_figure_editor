#!/usr/bin/env python3
"""Verify unchanged source media, pixel-exact crops and all PNG filter decoders."""
from pathlib import Path
import argparse,hashlib,json,zipfile,struct,zlib
from extract_pptx_example import decode_png_rgba,ROOT
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check-original',action='store_true',help='Also read and verify the original path recorded in the local manifest')
parser.add_argument('--report',type=Path,help='Optional output JSON report; omitted for a read-only check')
args=parser.parse_args()
base=ROOT/'examples'
manifest=base/'slide-04/conversion-manifest.json'
if not manifest.is_file(): parser.error('No local example manifest. This optional check requires locally preserved examples or a completed extraction.')
m=json.loads(manifest.read_text())
copied=ROOT/m['source']['copiedPath']
z=zipfile.ZipFile(copied)
results=[]
for obj in m['objects']:
    if 'sourceMedia' not in obj:continue
    raw=(ROOT/obj['originalCopy']).read_bytes()
    results.append({'check':'original image preserved byte for byte','shapeId':obj['pptShapeId'],'pass':hashlib.sha256(raw).hexdigest()==obj['sourceMediaSha256']==hashlib.sha256(z.read(obj['sourceMedia'])).hexdigest()})
    if 'cropPixels' not in obj:continue
    crop=obj['cropPixels'];derived=(ROOT/obj['derivedCopy']).read_bytes();w,h,rows,anc=decode_png_rgba(raw);dw,dh,drows,danc=decode_png_rgba(derived)
    expected=[row[crop['left']*4:crop['right']*4] for row in rows[crop['top']:crop['bottom']]]
    results.append({'check':'crop exact dimensions and unchanged RGBA pixels/color metadata','shapeId':obj['pptShapeId'],'pass':(dw,dh)==(crop['right']-crop['left'],crop['bottom']-crop['top']) and expected==drows and anc==danc})
results.append({'check':'preserved source copy unchanged','pass':hashlib.sha256(copied.read_bytes()).hexdigest()==m['source']['sha256']})
if args.check_original:
    results.append({'check':'original source file unchanged','pass':hashlib.sha256(Path(m['source']['localPath']).read_bytes()).hexdigest()==m['source']['sha256']})
# Encode known rows independently using each standard PNG filter.
expected=[bytes([11,80,121,255,18,89,141,99]),bytes([32,90,4,250,109,81,75,63])]
def chunk(k,d):return struct.pack('>I',len(d))+k+d+struct.pack('>I',zlib.crc32(k+d)&0xffffffff)
for f in range(5):
    encoded=[];prev=bytes(8)
    for row in expected:
        filtered=bytearray([f])
        for i,v in enumerate(row):
            a=row[i-4] if i>=4 else 0;b=prev[i];c=prev[i-4] if i>=4 else 0;p=a+b-c
            pred=[0,a,b,(a+b)//2,min([(abs(p-a),0,a),(abs(p-b),1,b),(abs(p-c),2,c)])[2]][f]
            filtered.append((v-pred)%256)
        encoded.append(bytes(filtered));prev=row
    png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',2,2,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(encoded)))+chunk(b'IEND',b'')
    results.append({'check':'PNG filter decode known sample','filter':f,'pass':decode_png_rgba(png)[2]==expected})
report={'allPassed':all(r['pass'] for r in results),'checks':results,'browserValidation':'Run tests/browser.html separately for browser decode and export checks.'}
if args.report:
    args.report.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
assert report['allPassed']
