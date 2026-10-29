import { createDispatchOwner } from './xhs-dispatch-owner';
import { observeDispatchOwner } from './xhs-dispatch-owner-observation';
import child = require('node:child_process');
describe('owner observation',()=>{
 afterEach(()=>jest.restoreAllMocks());
 it('observes only real own process metadata as alive',()=>{const owner=createDispatchOwner();expect(owner).toBeDefined();expect(observeDispatchOwner(owner!)).toBe('alive');});
 it('treats unavailable system metadata as unknown',()=>{jest.spyOn(child,'execFileSync').mockImplementation(()=>{throw Error('synthetic denied')});expect(observeDispatchOwner({pid:process.pid,startIdentity:'638000000000000000',nonce:'00000000-0000-4000-8000-000000000001'})).toBe('unknown');});
 it('distinguishes a different system start identity without considering it success',()=>{jest.spyOn(child,'execFileSync').mockReturnValue('638000000000000001');expect(observeDispatchOwner({pid:process.pid,startIdentity:'638000000000000000',nonce:'00000000-0000-4000-8000-000000000001'})).toBe('dead');});
});
