import { createHmac } from 'node:crypto';
import { parseTelegramInitData } from './WebAppServer';

function sign(rawWithoutHash:string,token:string):string{
  const secret=createHmac('sha256','WebAppData').update(token).digest();
  return createHmac('sha256',secret).update(rawWithoutHash).digest('hex');
}

describe('Telegram Mini App authentication',()=>{
  const token='123456:TEST_TOKEN';
  const authDate=Math.floor(Date.now()/1000);
  test('accepts a correctly signed fresh payload',()=>{
    const user=JSON.stringify({id:42,username:'tester'});
    const data=`auth_date=${authDate}&user=${user}`;
    const raw=`${data}&hash=${sign(data,token)}`;
    expect(parseTelegramInitData(raw,token,authDate)).toEqual({user:{id:42,username:'tester'},authDate});
  });
  test('rejects tampering, stale timestamps and invalid users',()=>{
    const user=JSON.stringify({id:42});
    const data=`auth_date=${authDate}&user=${user}`;
    const hash=sign(data,token);
    expect(parseTelegramInitData(`${data}&hash=${'0'.repeat(64)}`,token,authDate)).toBeNull();
    expect(parseTelegramInitData(`${data}&hash=${hash}`,token,authDate+86401)).toBeNull();
    const badUser=JSON.stringify({id:0});
    const badData=`auth_date=${authDate}&user=${badUser}`;
    expect(parseTelegramInitData(`${badData}&hash=${sign(badData,token)}`,token,authDate)).toBeNull();
  });
});
