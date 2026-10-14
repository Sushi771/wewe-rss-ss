import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  inspectRedbookDetail,
  mapRedbookPage,
  REDBOOK_RESPONSE_CONTRACT,
} from './redbook-response';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const redbookBindingSchema = z
  .object({
    creatorId: z.string().min(1).max(128),
    authorId: id,
    profileUrl: z.string().max(2048),
    review: z
      .object({
        contract: z.literal(REDBOOK_RESPONSE_CONTRACT),
        reviewedAt: z.number().int(),
        // These are explicit operator attestations to independently checked evidence,
        // not facts inferred by this program or a generic "enable" boolean.
        authorIdentityChecked: z.literal(true),
        fullTextChecked: z.literal(true),
        allImagesChecked: z.literal(true),
        publicationTimeChecked: z.literal(true),
        noteId: id,
        publishedAt: z.number().int(),
        textSha256: hash,
        imageUrlSha256s: z.array(hash).max(60),
        list: z.unknown(),
        detail: z.unknown(),
      })
      .strict(),
  })
  .strict();
export type RedbookBindingInput = z.infer<typeof redbookBindingSchema>;
export function reviewRedbookBinding(raw: RedbookBindingInput) {
  const binding = redbookBindingSchema.parse(raw);
  const expected = `https://www.xiaohongshu.com/user/profile/${binding.authorId}`;
  if (
    binding.profileUrl !== expected ||
    binding.review.reviewedAt > Date.now() + 300000 ||
    binding.review.reviewedAt < Date.now() - 7 * 86400000
  )
    throw new Error('REDBOOK_REVIEW_IDENTITY_OR_AGE');
  const page = mapRedbookPage(binding.review.list, binding.authorId);
  if (!page.notes.some((note) => note.noteId === binding.review.noteId))
    throw new Error('REDBOOK_REVIEW_NOTE_NOT_LISTED');
  const detail = inspectRedbookDetail(
    binding.review.detail,
    binding.authorId,
    binding.review.noteId,
  );
  const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex');
  if (
    detail.publishedAt !== binding.review.publishedAt ||
    digest(detail.text) !== binding.review.textSha256 ||
    JSON.stringify(detail.urls.map((url) => digest(url.href))) !==
      JSON.stringify(binding.review.imageUrlSha256s)
  )
    throw new Error('REDBOOK_REVIEW_REFERENCE_MISMATCH');
  return {
    creatorId: binding.creatorId,
    authorId: binding.authorId,
    profileUrl: binding.profileUrl,
    evidenceSha256: digest(JSON.stringify(binding)),
    reviewBasis: 'operator-supplied-evidence' as const,
  };
}
