"""PPTX API uses the existing local origin/token boundary; no disk extraction."""
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server
from test_pptx_import import fixture


class PptxApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory=tempfile.TemporaryDirectory()
        cls.local=server.create_server(Path(cls.directory.name),0)
        cls.thread=threading.Thread(target=cls.local.serve_forever,daemon=True);cls.thread.start()
        cls.origin='http://127.0.0.1:'+str(cls.local.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.local.shutdown();cls.local.server_close();cls.thread.join();cls.directory.cleanup()

    def request(self,payload=None,headers=None,path='/api/pptx-import'):
        data=json.dumps(fixture() if payload is None else payload).encode()
        fields={'Origin':self.origin,'Content-Type':'application/json','X-Figure-Token':self.local.token,'Content-Length':str(len(data))}
        for key,value in (headers or {}).items():
            if value is None:fields.pop(key,None)
            else:fields[key]=value
        conn=http.client.HTTPConnection('127.0.0.1',self.local.server_port,timeout=5)
        with mock.patch.object(server.Handler,'log_message'):
            conn.request('POST',path,body=data,headers=fields)
            response=conn.getresponse();result=(response.status,json.loads(response.read()),dict(response.getheaders()))
        conn.close();return result

    def test_inspect_and_convert_selected_page_without_writing_files(self):
        status,listing,headers=self.request()
        self.assertEqual(status,200);self.assertEqual(len(listing['slides']),2)
        self.assertEqual(headers['Cache-Control'],'no-store')
        status,result,_=self.request({**fixture(),'slide':2})
        self.assertEqual(status,200);self.assertEqual(result['source']['slide'],2)
        self.assertEqual(list(Path(self.directory.name).iterdir()),[])

    def test_cross_origin_or_missing_token_is_rejected_before_parser(self):
        with mock.patch.object(server,'import_pptx') as convert:
            for headers in ({'Origin':None},{'Origin':'https://foreign.example'},{'X-Figure-Token':'wrong'},{'X-Figure-Token':None},{'Sec-Fetch-Site':'cross-site'}):
                self.assertEqual(self.request(headers=headers)[0],403)
            convert.assert_not_called()

    def test_size_and_content_type_rejected_before_parser(self):
        with mock.patch.object(server,'import_pptx') as convert:
            self.assertEqual(self.request({},headers={'Content-Length':str(server.MAX_PPTX_BODY+1)})[0],413)
            self.assertEqual(self.request({},headers={'Content-Type':'text/plain'})[0],400)
            convert.assert_not_called()

    def test_invalid_pptx_returns_json_error(self):
        status,result,_=self.request({'name':'bad.pptx','data':'YWJj'})
        self.assertEqual(status,422);self.assertIn('readable PPTX',result['error'])

    def test_clipboard_routes_require_origin_token_and_validate_before_read(self):
        with mock.patch.object(server,'read_powerpoint_clipboard',return_value=None) as read:
            for route in ('/api/pptx-clipboard','/api/pptx-paste'):
                self.assertEqual(self.request({},headers={'Origin':'https://elsewhere.example'},path=route)[0],403)
                self.assertEqual(self.request({},headers={'X-Figure-Token':None},path=route)[0],403)
            self.assertEqual(self.request({'previewSha256':None},path='/api/pptx-clipboard')[0],400)
            self.assertEqual(self.request({'file':'/private/data'},path='/api/pptx-clipboard')[0],400)
            read.assert_not_called()
            status,result,_=self.request({'previewSha256':'a'*64},path='/api/pptx-clipboard')
            self.assertEqual((status,result),(200,{'available':False}))
            read.assert_called_once_with('a'*64)

    def test_native_and_browser_clipboard_routes_convert_only_single_slide(self):
        from test_pptx_import import slide,text_shape
        import base64
        data=fixture([slide(text_shape())])['data']
        status,result,_=self.request({'data':data},path='/api/pptx-paste')
        self.assertEqual(status,200);self.assertEqual(result['items'][0]['type'],'textBlock')
        with mock.patch.object(server,'read_powerpoint_clipboard',return_value=base64.b64decode(data)):
            self.assertEqual(self.request({},path='/api/pptx-clipboard')[0],200)
        with mock.patch.object(server,'read_powerpoint_clipboard',side_effect=ValueError('Clipboard changed')):
            status,result,_=self.request({},path='/api/pptx-clipboard')
            self.assertEqual((status,result),(422,{'error':'Clipboard changed','nativeUnavailable':True}))


if __name__=='__main__':unittest.main()
