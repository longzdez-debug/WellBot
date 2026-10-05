import { createHmac } from 'node:crypto';
import { parseTelegramInitData } from './WebAppServer';

function sign(dataCheckString:string,token:string):string{
  const secret=createHmac('sha256',token).update('WebAppData').digest();
  return createHmac('sha256',secret).update(dataCheckString).digest('hex');
}

describe('Telegram Mini App authentication',()=>{
  const token='123456:TEST_TOKEN';
  const authDate=Math.floor(Date.now()/1000);
  test('accepts a correctly signed fresh payload',()=>{
    const user=encodeURIComponent(JSON.stringify({id:42,username:'tester'}));
    const data=`auth_date=${authDate}&user=${JSON.stringify({id:42,username:'tester'})}`;
    const raw=`auth_date=${authDate}&user=${user}&hash=${sign(data,token)}`;
    expect(parseTelegramInitData(raw,token,authDate)).toEqual({user:{id:42,username:'tester'},authDate});
  });
  test('rejects tampering, stale timestamps and invalid users',()=>{
    const user=encodeURIComponent(JSON.stringify({id:42}));
    const data=`auth_date=${authDate}&user=${JSON.stringify({id:42})}`;
    const hash=sign(data,token);
    expect(parseTelegramInitData(`auth_date=${authDate}&user=${user}&hash=${'0'.repeat(64)}`,token,authDate)).toBeNull();
    expect(parseTelegramInitData(`auth_date=${authDate}&user=${user}&hash=${hash}`,token,authDate+86401)).toBeNull();
    const badUser=encodeURIComponent(JSON.stringify({id:0}));
    const badData=`auth_date=${authDate}&user=${JSON.stringify({id:0})}`;
    expect(parseTelegramInitData(`auth_date=${authDate}&user=${badUser}&hash=${sign(badData,token)}`,token,authDate)).toBeNull();
  });
});
