const fs=require("node:fs");
const index=fs.readFileSync("web/index.html","utf8");
const app=fs.readFileSync("web/app.js","utf8");
const cssRefs=[...index.matchAll(/href="\.\/([^"]+\.css)(?:\?[^"]*)?"/g)].map(m=>m[1]);
for(const file of cssRefs){if(!fs.existsSync("web/"+file))throw new Error("Missing stylesheet: "+file);}
if(cssRefs.includes("styles.css"))throw new Error("Legacy stylesheet styles.css is still referenced.");
const appScriptIsValid=index.includes('<script src="./app.js?v=20261004-18" defer></script>');
if(index.includes('<script src="./app.js?v=20261004-15" defer></script>>'))throw new Error("Malformed app.js script tag detected.");
if(!appScriptIsValid)throw new Error("app.js must load unconditionally with defer.");
if(index.includes("Telegram.WebApp.initData"))throw new Error("index.html must not gate app.js loading on Telegram initData.");
const dynamicContracts=[
  ['data-action="add"',"Dynamic create-search buttons must use data-action=add."],
  ['marketplace-grid',"Marketplace selector must exist."],
  ['data-source=',"Marketplace option action contract missing."],
  ['source,categoryId',"Monitor payload must include selected marketplace source."] ,
  ['catalog-phone-brand',"Kufar phone manufacturer control missing."],
  ['catalog-phone-model',"Kufar phone model control missing."],
  ['/api/catalog/phone-models',"Live Kufar phone model endpoint missing."],
  ['data-profile-close',"Profile modal close controls must have a close contract."],
  ['id="wellbot-monitor-submit"',"Monitor submit control missing."],
  ['id="wellbot-monitor-cancel"',"Monitor cancel control missing."],
  ['id="wellbot-monitor-x"',"Monitor modal close control missing."],
  ['data-toggle=',"Monitor toggle controls missing."],
  ['data-delete=',"Monitor delete controls missing."],
  ['data-recent-id=',"Recent-find controls missing."],
  ['class="hot-open"',"Hot-find open control missing."],
  ['id="deal-open"',"Deal open control missing."],
  ['id="deal-dismiss"',"Deal dismiss control missing."],
  ['id="deal-close"',"Deal close control missing."]
];
for(const [needle,message] of dynamicContracts)if(!app.includes(needle))throw new Error(message);
if(!app.includes('document.addEventListener("click"'))throw new Error("Global click delegation for dynamic actions is missing.");
if(!app.includes('querySelectorAll("[data-toggle]")')||!app.includes('querySelectorAll("[data-delete]")'))throw new Error("Monitor action handlers are missing.");
if(!app.includes('querySelectorAll("[data-recent-id]")'))throw new Error("Recent-find action handlers are missing.");
if(!app.includes('catalogs[source]'))throw new Error("Marketplace-specific catalog selection is missing.");

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
if(actions.filter(a=>a==='add').length!==1)throw new Error("There must be exactly one static primary add action.");
if(!app.includes('/api/catalog')||!app.includes('/api/monitors'))throw new Error("Marketplace monitor API contract missing.");
if(!app.includes('/api/catalog'))throw new Error("Official marketplace catalog API is missing.");
console.log("WellBOT web UI contract: OK ("+buttons.length+" static buttons, "+actions.length+" actions, marketplace wizard enabled).");
