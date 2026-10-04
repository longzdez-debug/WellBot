const fs=require("node:fs");
const index=fs.readFileSync("web/index.html","utf8");
const app=fs.readFileSync("web/app.js","utf8");
const cssRefs=[...index.matchAll(/href="\.\/([^"]+\.css)(?:\?[^"]*)?"/g)].map(m=>m[1]);
for(const file of cssRefs){if(!fs.existsSync("web/"+file))throw new Error("Missing stylesheet: "+file);}
if(cssRefs.includes("styles.css"))throw new Error("Legacy stylesheet styles.css is still referenced.");
const scriptRef=index.match(/src="\.\/app\.js\?v=([^"]+)"/)?.[1];
const build=app.match(/const WELLBOT_BUILD="([^"]+)"/)?.[1];
if(!scriptRef||!build)throw new Error("Could not determine Mini App build version.");
if(scriptRef.replace(/[^0-9a-z]/gi,"")!==build.replace(/[^0-9a-z]/gi,""))throw new Error("Mini App cache-buster and app build version are out of sync.");
const buttons=[...index.matchAll(/<button\b([^>]*)>/gi)].map(m=>m[1]);
const allowedAttrs=["data-action","data-scroll","data-filter"];
buttons.forEach((attrs,i)=>{if(!allowedAttrs.some(a=>new RegExp(a+"=").test(attrs)))throw new Error("Static button #"+(i+1)+" has no action contract.");});
const actions=[...index.matchAll(/data-action="([^"]+)"/g)].map(m=>m[1]);
const supported=["add","refresh","profile"];
for(const action of actions)if(!supported.includes(action))throw new Error("Unsupported static data-action: "+action);
for(const id of [...index.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1])){if(id==="global-search")continue;}
for(const target of [...index.matchAll(/data-scroll="([^"]+)"/g)].map(m=>m[1]))if(!new RegExp('id="'+target+'"').test(index))throw new Error("data-scroll target missing: "+target);
if(/Успешных покупок<\/span><b>247|Общий профит<\/span><b>\+312 450|Средняя маржа<\/span><b>\+34%/.test(index))throw new Error("Hardcoded fake business metrics detected.");
console.log("WellBOT web UI contract: OK ("+buttons.length+" static buttons, "+actions.length+" actions).");
