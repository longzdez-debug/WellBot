export interface ProSubscriptionStateLike {
  status: string;
  expiresAt: Date;
}

const TERMINAL_STATUSES=new Set(['expired','revoked','refunded']);

export function hasProAccess(subscription:ProSubscriptionStateLike|null|undefined,now=Date.now()):boolean{
  if(!subscription)return false;
  return subscription.expiresAt.getTime()>now&&!TERMINAL_STATUSES.has(subscription.status);
}
