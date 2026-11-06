import test from 'node:test';
import assert from 'node:assert/strict';
import {minerRetryDecision} from '../scripts/flop-miner-retry-policy.mjs';
const now=Date.parse('2026-11-06T18:30:00Z');
const valid=()=>({
 activeRun:false,registered:false,
 address:'5Ek2J6WSgcunfe8hLRpZRGnCa3aUmvZAMGM5ugfyJ2VhtrWw',
 genesis:'0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631',
 signerRootOwned:true,signerMode:'600',attemptsThisCheck:0,
 userAuthorizedPaidResume:true,instanceRunning:true,
 previous:{httpStatus:429,reason:'auto_miner_cap_full',action:'retry_later',retryAfterSeconds:3600,completedAt:now-3600000},
 limits:{network:'devnet',stale:false,asOf:new Date(now).toISOString(),
 sponsor:{miner:{status:'open',automatic:{open:true,uncalibrated:39,max:40}}}}
});
test('permits one attempt only with all gates satisfied',()=>assert.equal(minerRetryDecision(valid(),now).allowed,true));
const cases={
 activeRun:s=>s.activeRun=true,
 unknownRun:s=>delete s.activeRun,
 alreadyRegistered:s=>s.registered=true,
 unknownRegistration:s=>delete s.registered,
 wrongIdentity:s=>s.address='another',
 wrongGenesis:s=>s.genesis='another',
 unsafePermissions:s=>s.signerMode='644',
 unsafeOwner:s=>s.signerRootOwned=false,
 prematureRetry:s=>s.previous.completedAt=now-3599999,
 ambiguousTimeout:s=>s.previous.httpStatus=524,
 unexpectedError:s=>s.previous.reason='unknown',
 noWaitEvidence:s=>delete s.previous.retryAfterSeconds,
 capFull:s=>s.limits.sponsor.miner.automatic.uncalibrated=40,
 closed:s=>s.limits.sponsor.miner.status='automatic_full',
 stale:s=>s.limits.stale=true,
 oldLimits:s=>s.limits.asOf=new Date(now-180001).toISOString(),
 wrongNetwork:s=>s.limits.network='mainnet',
 attemptConsumed:s=>s.attemptsThisCheck=1,
 noRestartApproval:s=>s.userAuthorizedPaidResume=false,
 stoppedVM:s=>s.instanceRunning=false
};
for(const [name,mutate] of Object.entries(cases)) test('rejects '+name,()=>{const s=valid();mutate(s);assert.equal(minerRetryDecision(s,now).allowed,false);});
test('invalid state fails closed',()=>assert.equal(minerRetryDecision(null,now).allowed,false));
