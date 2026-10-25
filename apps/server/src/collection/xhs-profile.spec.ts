import { parseXhsProfile } from './xhs-profile';

const AUTHOR = 'synthetic-author';
const sample = () => ({
  result: { success: true, code: 0, message: 'success' },
  basic_info: {
    nickname: ' Synthetic creator ',
    red_id: 'display-handle',
    images: 'https://unreviewed.example/avatar',
  },
  interactions: [],
});
describe('reviewed request-bound XHS profile parser (offline)', () => {
  it('uses the signed request ID and ignores display IDs and avatar URLs', () => {
    expect(parseXhsProfile(sample(), AUTHOR)).toMatchObject({
      id: AUTHOR,
      name: 'Synthetic creator',
      profileUrl: 'https://www.xiaohongshu.com/user/profile/' + AUTHOR,
    });
  });
  it('allows a returned stable ID only when it matches the requested author', () => {
    const raw = sample();
    Object.assign(raw.basic_info, { user_id: AUTHOR });
    expect(parseXhsProfile(raw, AUTHOR).id).toBe(AUTHOR);
    Object.assign(raw.basic_info, { user_id: 'other-author' });
    expect(() => parseXhsProfile(raw, AUTHOR)).toThrow('XHS_AUTHOR_MISMATCH');
    const root = { ...sample(), user_id: 'other-author' };
    expect(() => parseXhsProfile(root, AUTHOR)).toThrow('XHS_AUTHOR_MISMATCH');
  });
  it.each([
    null,
    [],
    {},
    { ...sample(), basic_info: [] },
    { ...sample(), result: { success: false, code: 0 } },
    { ...sample(), result: { success: true, code: 1 } },
    { ...sample(), result: { success: true, code: '0' } },
    { ...sample(), basic_info: { nickname: '', red_id: 'display' } },
    {
      ...sample(),
      basic_info: { nickname: 'a'.repeat(121), red_id: 'display' },
    },
    { ...sample(), basic_info: { nickname: 'name\n', red_id: 'display' } },
    { ...sample(), basic_info: { nickname: 'name', red_id: null } },
  ])('rejects unrecognized or unsuccessful profile data', (raw) => {
    expect(() => parseXhsProfile(raw, AUTHOR)).toThrow(
      'XHS_PROFILE_SCHEMA_UNRECOGNIZED',
    );
  });
  it('rejects invalid requested identity even when the nickname is valid', () => {
    expect(() => parseXhsProfile(sample(), 'bad/id')).toThrow(
      'XHS_PROFILE_SCHEMA_UNRECOGNIZED',
    );
  });
});
