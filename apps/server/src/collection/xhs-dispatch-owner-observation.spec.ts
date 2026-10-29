import { createDispatchOwner } from './xhs-dispatch-owner';
import { observeDispatchOwner } from './xhs-dispatch-owner-observation';
import child = require('node:child_process');
const systemPlatform=Object.getOwnPropertyDescriptor(process,'platform')!;
const usePlatform=(value:string)=>Object.defineProperty(process,'platform',{...systemPlatform,value});
describe('owner observation',()=>{
 afterEach(()=>{Object.defineProperty(process,'platform',systemPlatform);jest.restoreAllMocks();});
 it('observes real own process metadata only on a supported platform',()=>{const owner=createDispatchOwner();if(process.platform!=='win32'){expect(owner).toBeUndefined();expect(observeDispatchOwner({pid:process.pid,startIdentity:'638000000000000000',nonce:'00000000-0000-4000-8000-000000000001'})).toBe('unknown');return;}expect(owner).toBeDefined();expect(observeDispatchOwner(owner!)).toBe('alive');});
 it('treats unavailable system metadata as unknown',()=>{jest.spyOn(child,'execFileSync').mockImplementation(()=>{throw Error('synthetic denied')});expect(observeDispatchOwner({pid:process.pid,startIdentity:'638000000000000000',nonce:'00000000-0000-4000-8000-000000000001'})).toBe('unknown');});
 it.each([['638000000000000000','alive'],['638000000000000001','dead'],['absent','dead'],['malformed','unknown']])('classifies supported system evidence %s as %s', (evidence,expected)=>{usePlatform('win32');jest.spyOn(child,'execFileSync').mockReturnValue(evidence);expect(observeDispatchOwner({pid:process.pid,startIdentity:'638000000000000000',nonce:'00000000-0000-4000-8000-000000000001'})).toBe(expected);});
 it('keeps unsupported platforms unknown without probing or creating an owner',()=>{usePlatform('linux');const probe=jest.spyOn(child,'execFileSync');expect(createDispatchOwner()).toBeUndefined();expect(observeDispatchOwner({pid:process.pid,startIdentity:'638000000000000000',nonce:'00000000-0000-4000-8000-000000000001'})).toBe('unknown');expect(probe).not.toHaveBeenCalled();});
});
