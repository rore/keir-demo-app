import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const files=new Map([['/','index.html'],['/styles.css','styles.css'],['/prototype.mjs','prototype.mjs'],['/model.mjs','model.mjs'],['/verified-example.mjs','verified-example.mjs']]);
const server=createServer(async(req,res)=>{const name=files.get(new URL(req.url,'http://localhost').pathname);if(!name){res.writeHead(404);return res.end()};try{res.setHeader('Content-Type',name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(new URL(name,import.meta.url)))}catch{res.writeHead(503);res.end('The verified example is not ready yet.')}});
server.listen(0,'127.0.0.1',()=>console.log(`Design comparison: http://127.0.0.1:${server.address().port}`));
process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{if(data.trim()==='stop')server.close(()=>process.exit(0))});
