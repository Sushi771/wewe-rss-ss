import { createDispatchOwner, ownsDispatch, readSelfStartIdentity } from './xhs-dispatch-owner';
import child = require('node:child_process');
describe('dispatch owner system identity', () => {
 afterEach(() => jest.restoreAllMocks());
 it('reads the real current Windows process start identity twice consistently', () => {
   if (process.platform !== 'win32') { expect(readSelfStartIdentity()).toBeUndefined(); return; }
   const first = readSelfStartIdentity();
   expect(first).toMatch(/^[0-9]{15,20}$/);
   expect(readSelfStartIdentity()).toBe(first);
   const a = createDispatchOwner(), b = createDispatchOwner();
   expect(a?.nonce).not.toBe(b?.nonce);
   expect(ownsDispatch(a,a)).toBe(true);
   expect(ownsDispatch({...a!,nonce:b!.nonce},a)).toBe(false);
 });
 it('refuses legacy identity and another PID', () => {
   expect(ownsDispatch(undefined,undefined)).toBe(false);
   expect(ownsDispatch({pid: -1, nonce: '00000000-0000-4000-8000-000000000001', startIdentity:'123'},undefined)).toBe(false);
 });
 it('treats an inaccessible or malformed system result as unknown', () => {
   jest.spyOn(child, 'execFileSync').mockImplementation(() => { throw new Error('synthetic denied'); });
   expect(createDispatchOwner()).toBeUndefined();
 });
 it('rejects a reused PID with a different system start identity', () => {
   jest.spyOn(child, 'execFileSync').mockReturnValue('638000000000000000');
   const owner = createDispatchOwner();
   jest.spyOn(child, 'execFileSync').mockReturnValue('638000000000000001');
   expect(ownsDispatch(owner,owner)).toBe(false);
 });
});
